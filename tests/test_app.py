from pathlib import Path

import cv2
import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from src.server.app import create_app
from src.server.cv.perception import Detection, Observation, Rule, Usage
from src.server.notifier import Notifier
from src.server.session import SessionStore, Subscribers
from src.server.telegram.bot import Bot

DATA = Path(__file__).resolve().parents[1] / "data"


class FakePerception:
    def __init__(self) -> None:
        self.answers: list[bool] = []
        self.calls = 0
        self.usage = (0, 0, 0)  # (prompt, completion, usd_ticks) billed per detect

    async def normalize(self, rule: str) -> Rule:
        if rule == "a cat":
            return Rule("a cat is visible", "rising", False)
        direction = "falling" if "leaves" in rule else "rising"
        return Rule("a cat is on the table", direction, True)

    async def detect(self, jpeg: bytes, predicates: list[str]) -> Detection:
        self.calls += 1
        answer = self.answers.pop(0)
        return Detection(
            [Observation(answer, "fake") for _ in predicates],
            Usage(*self.usage[:2], 1, self.usage[2]),
        )


class SpyNotifier(Notifier):
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def notify(self, session_id, watch, event) -> None:
        self.sent.append(event.text)


def jpeg(name: str, black_tile: bool = False) -> bytes:
    bgr = cv2.resize(cv2.imread(str(DATA / name)), (1280, 720))
    bgr = (30 + bgr.astype(np.float32) * 0.7).astype(np.uint8)
    if black_tile:
        bgr[:90, :160] = 0
    return cv2.imencode(".jpg", bgr)[1].tobytes()


@pytest.fixture
def world():
    perception, notifier = FakePerception(), SpyNotifier()
    app = create_app(perception, SessionStore(max_sessions=2, ttl=30), notifier)
    return TestClient(app), perception, notifier


def fake_bot() -> Bot:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True, "result": {"username": "cam_bot"}})

    bot = Bot("token")
    bot.client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://api.telegram.org/bottoken",
    )
    # TestClient is not used as a context manager here, so the lifespan - and with it
    # get_me(), which normally fills this in - never runs.
    bot.username = "cam_bot"
    return bot


@pytest.fixture
def bot_world():
    perception, store = FakePerception(), SessionStore(max_sessions=2, ttl=30)
    subs = Subscribers(max_subscribers=4, ttl=3600)
    app = create_app(perception, store, SpyNotifier(), fake_bot(), subs)
    return TestClient(app), store, subs


def post_frame(client, sid, data):
    files = {"frame": ("f.jpg", data, "image/jpeg")}
    return client.post(f"/session/{sid}/frame", files=files)


def new_session(client, rule="the cat jumps onto the table") -> str:
    return client.post("/session", json={"rules": [rule]}).json()["session_id"]


def test_health_create_reject_and_cap(world):
    client, _, _ = world
    assert client.get("/health").json() == {"ok": True, "sessions": 0}
    r = client.post("/session", json={"rules": ["the cat jumps onto the table"]})
    assert r.status_code == 201
    (w,) = r.json()["watches"]
    assert (w["predicate"], w["direction"]) == ("a cat is on the table", "rising")
    r = client.post("/session", json={"rules": ["the cat leaves", "a cat"]})
    assert (r.status_code, r.json()["error"]) == (400, "not_a_transition")
    assert "'a cat'" in r.json()["hint"]
    r = client.post("/session", json={"rules": ["", " "]})
    assert (r.status_code, r.json()["error"]) == (400, "empty_rule")
    r = client.post("/session", json={"rules": ["x happens"] * 6})
    assert (r.status_code, r.json()["error"]) == (400, "too_many_rules")
    new_session(client)
    r = client.post("/session", json={"rules": ["x happens"]})
    assert (r.status_code, r.json()["error"]) == (503, "full")


def test_frame_flow_fires_once(world):
    client, perception, notifier = world
    sid = new_session(client)
    perception.answers = [False, True, True]
    quiet, changed = jpeg("1.png"), jpeg("1.png", black_tile=True)

    # The model answers in a background task, so each answer shows on the NEXT status.
    s = post_frame(client, sid, quiet).json()  # first frame: sent, baseline
    state = lambda s: s["watches"][0]["state"]  # noqa: E731
    assert (s["gate"], s["sent"], state(s)) == ("first", True, None)
    s = post_frame(client, sid, quiet).json()  # same picture: skipped; baseline False
    assert (s["gate"], s["sent"], state(s)) == ("skip", False, False)
    assert post_frame(client, sid, changed).json()["sent"] is True  # -> True: fires
    s = post_frame(client, sid, changed).json()
    assert (s["fired"], state(s), s["events"]) == (True, True, 1)
    s = post_frame(client, sid, changed).json()  # == anchor: skip; fired reported once
    assert (s["gate"], s["fired"]) == ("skip", False)
    assert notifier.sent == ["a cat is on the table - became true"]
    assert perception.calls == 2

    view = client.get(f"/session/{sid}").json()
    assert view["events"][0]["n"] == 0 and view["watches"][0]["state"] is True
    assert view["events"][0]["rule"] == "the cat jumps onto the table"
    img = client.get(f"/session/{sid}/events/0.jpg")
    assert img.status_code == 200 and img.headers["content-type"] == "image/jpeg"
    ev = client.get(f"/session/{sid}/events/0").json()
    assert (ev["n"], ev["text"]) == (0, view["events"][0]["text"])
    assert ev["image"].startswith("data:image/jpeg;base64,")
    assert client.get(f"/session/{sid}/events/1").status_code == 404
    assert view["telegram"] is False  # nothing subscribed


def test_subscribe_before_any_watch_then_link(bot_world):
    """The page can offer a QR with no session running, and one scan covers later watches."""
    client, store, subs = bot_world
    r = client.post("/subscriber")
    assert r.status_code == 201
    sub = r.json()
    token = sub["token"]
    assert sub["telegram_link"] == f"https://t.me/cam_bot?start={token}"
    assert sub["linked"] is False

    qr = client.get(f"/subscriber/{token}/qr.svg")
    assert (qr.status_code, qr.headers["content-type"]) == (200, "image/svg+xml")
    assert qr.content.startswith(b"<?xml") and b"<path" in qr.content

    # The page polls this; it is the only thing driving the QR's visibility.
    assert client.get(f"/subscriber/{token}").json()["linked"] is False
    subs.get(token).chat_id = 42  # what /start <token> does in the bot
    assert client.get(f"/subscriber/{token}").json()["linked"] is True

    # A watch started afterwards inherits the binding - no second scan.
    sid = client.post(
        "/session",
        json={"rules": ["the cat jumps onto the table"], "subscriber": token},
    ).json()["session_id"]
    assert store.get(sid).subscriber == token
    assert client.get(f"/session/{sid}").json()["telegram"] is True


def test_unknown_subscriber_is_404(bot_world):
    """A token from a previous process must fail cleanly so the page makes a new one."""
    client, store, _ = bot_world
    assert client.get("/subscriber/nope").status_code == 404
    assert client.get("/subscriber/nope/qr.svg").status_code == 404
    # An unknown token on /session is ignored rather than rejected: the watch still runs.
    sid = client.post(
        "/session",
        json={"rules": ["the cat jumps onto the table"], "subscriber": "nope"},
    ).json()["session_id"]
    assert store.get(sid).subscriber is None
    assert client.get(f"/session/{sid}").json()["telegram"] is False


def test_errors_and_delete(world):
    client, _, _ = world
    assert post_frame(client, "nope", jpeg("1.png")).status_code == 404
    assert client.get("/session/nope").status_code == 404
    sid = new_session(client, "x happens")
    assert post_frame(client, sid, b"not a jpeg").status_code == 400
    assert client.delete(f"/session/{sid}").status_code == 204
    assert client.get(f"/session/{sid}").status_code == 404


def test_usage_accumulates_per_session_and_resets(world):
    client, perception, _ = world
    perception.usage = (400, 10, 13_500_000)
    sid = new_session(client)
    assert client.get(f"/session/{sid}/usage").json()["total"] == 0
    perception.answers = [True]
    post_frame(client, sid, jpeg("1.png"))
    assert client.get(f"/session/{sid}/usage").json() == {
        "prompt": 400,
        "completion": 10,
        "total": 410,
        "calls": 1,
        "usd": 0.00135,  # 13_500_000 ticks * 1e-10
    }
    other = new_session(client)
    assert client.get(f"/session/{other}/usage").json()["total"] == 0
    assert client.post(f"/session/{sid}/usage/reset").json()["total"] == 0
    assert client.get(f"/session/{sid}").json()["usage"]["calls"] == 0


def test_empty_frame_and_negative_event_numbers(world):
    client, perception, _ = world
    sid = new_session(client)
    assert post_frame(client, sid, b"").status_code == 400
    for suffix in ("-1", "-1.jpg", "-999"):
        assert client.get(f"/session/{sid}/events/{suffix}").status_code == 404
    perception.answers = [True]
    post_frame(client, sid, jpeg("1.png"))
    assert client.get(f"/session/{sid}/events/0").status_code == 200
    assert client.get(f"/session/{sid}/events/-1").status_code == 404


async def test_capacity_reserved_before_normalizing_and_released_on_failure():
    import asyncio

    import httpx

    from src.server.cv.perception import PerceptionError

    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    class SlowPerception(FakePerception):
        async def normalize(self, rule):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            if calls == 1:
                raise PerceptionError("temporary failure")
            return await super().normalize(rule)

    app = create_app(SlowPerception(), SessionStore(1, 30), Notifier())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = asyncio.create_task(
            client.post("/session", json={"rules": ["arrives"]})
        )
        await entered.wait()
        assert (
            await client.post("/session", json={"rules": ["arrives"]})
        ).status_code == 503
        assert calls == 1
        release.set()
        assert (await first).status_code == 502
        assert (
            await client.post("/session", json={"rules": ["arrives"]})
        ).status_code == 201
        assert (
            await client.post("/session", json={"rules": ["arrives"]})
        ).status_code == 503
        assert calls == 2


async def test_lifespan_expires_sessions_without_requests():
    import asyncio

    store = SessionStore(1, 30)
    s = store.create(["arrives"], [Rule("present", "rising", True)])
    app = create_app(FakePerception(), store, Notifier())
    async with app.router.lifespan_context(app):
        s.last_seen = 0
        await asyncio.sleep(0)
        assert not store._sessions


async def test_sse_delivers_result_without_another_frame_and_closes_on_delete():
    import asyncio
    import json

    from src.server.engine import handle_frame

    store = SessionStore(1, 30)
    perception = FakePerception()
    perception.answers = [True]
    s = store.create(["arrives"], [Rule("present", "rising", True)])
    app = create_app(perception, store, Notifier())
    endpoint = next(
        r.endpoint
        for r in app.routes
        if getattr(r, "path", "") == "/session/{session_id}/updates"
    )
    response = await endpoint(s.id)
    stream = response.body_iterator
    assert response.media_type == "text/event-stream"
    first = json.loads((await anext(stream)).removeprefix("data: "))
    assert first["watches"][0]["state"] is None
    pending = asyncio.create_task(anext(stream))
    await handle_frame(s, jpeg("1.png"), perception, Notifier())
    await s.task
    status = json.loads((await asyncio.wait_for(pending, 1)).removeprefix("data: "))
    assert status["watches"][0]["state"] is True and status["events"] == 1
    assert status["revision"] == 1
    pending = asyncio.create_task(anext(stream))
    store.delete(s.id)
    assert "event: expired" in await asyncio.wait_for(pending, 1)
    await stream.aclose()


async def test_open_updates_stream_keeps_a_paused_session_alive():
    """A hidden tab stops uploading frames; only the stream is left to say it is still there."""
    import asyncio
    import time

    store = SessionStore(1, 30)
    s = store.create(["arrives"], [Rule("present", "rising", True)])
    app = create_app(FakePerception(), store, Notifier())
    endpoint = next(
        r.endpoint
        for r in app.routes
        if getattr(r, "path", "") == "/session/{session_id}/updates"
    )
    stream = (await endpoint(s.id)).body_iterator
    await anext(stream)
    s.last_seen -= (
        store.ttl + 1
    )  # a pause longer than the TTL, with no frames to touch it
    assert time.monotonic() - s.last_seen > store.ttl
    s.changed.set()  # skip the 15s keepalive wait; the next iteration is what touches
    await asyncio.wait_for(anext(stream), 1)
    assert store.sweep() == 0
    assert s.id in store._sessions
    await stream.aclose()


def test_add_and_drop_rules_on_a_running_session(world):
    client, perception, _ = world
    sid = new_session(client)
    r = client.post(f"/session/{sid}/watches", json={"rule": "the cat leaves"})
    assert r.status_code == 201
    assert [w["direction"] for w in r.json()["watches"]] == ["rising", "falling"]
    r = client.post(f"/session/{sid}/watches", json={"rule": "a cat"})
    assert (r.status_code, r.json()["error"]) == (400, "not_a_transition")
    assert client.delete(f"/session/{sid}/watches/1").status_code == 204
    assert client.delete(f"/session/{sid}/watches/0").status_code == 409  # last one
    assert client.delete(f"/session/{sid}/watches/7").status_code == 404
    assert len(client.get(f"/session/{sid}").json()["watches"]) == 1


def test_page_config_and_cross_origin_page(monkeypatch):
    """The page hosted on Convex learns where things are from config.js and may call the API."""
    site = "https://example.convex.site"
    monkeypatch.setattr("src.config.CONVEX_URL", "https://example.convex.cloud")
    monkeypatch.setattr("src.config.FRONTEND_ORIGIN", site)
    app = create_app(
        FakePerception(),
        SessionStore(2, 30),
        SpyNotifier(),
        fake_bot(),
        Subscribers(4, 3600),
    )
    client = TestClient(app)
    js = client.get("/static/config.js").text
    assert 'window.CONVEX_URL = "https://example.convex.cloud";' in js
    assert (
        'window.WORKER_URL = "";' in js
        and 'window.TELEGRAM_BOT_USERNAME = "cam_bot";' in js
    )
    ok = client.get("/health", headers={"origin": site})
    assert ok.headers["access-control-allow-origin"] == site
    other = client.get("/health", headers={"origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers
