import time

import httpx
from fastapi.testclient import TestClient

from src.server.app import create_app
from src.server.cv.perception import Detection, Observation, Rule, Usage
from src.server.notifier import Notifier
from src.server.session import Feeds
from src.server.telegram.bot import Bot
from tests.fake_convex import FakeConvex
from tests.test_engine import image


class FakePerception:
    calls = 0

    async def normalize(self, rule: str) -> Rule:
        if rule == "a cat":
            return Rule("a cat is visible", "rising", False)
        return Rule("a cat is on the table", "rising", True, Usage(120, 8, 1, 4500))

    async def detect(self, jpeg: bytes, predicates: list[str]) -> Detection:
        self.calls += 1
        return Detection([Observation(True, "fake") for _ in predicates])


def fake_bot() -> Bot:
    bot = Bot("token")
    bot.client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(500)),
        base_url="https://api.telegram.org/bottoken",
    )
    # TestClient is not used as a context manager here, so the lifespan - and with it
    # get_me(), which normally fills this in - never runs.
    bot.username = "cam_bot"
    return bot


def test_frames_reach_the_model_only_for_sessions_convex_knows():
    convex, perception = FakeConvex(), FakePerception()
    convex.add("s1", ("cat arrives", "cat", "rising"))
    convex.add("old", ("r", "p", "rising"))["status"] = "stopped"
    feeds = Feeds()
    with TestClient(create_app(perception, convex, Notifier(), None, feeds)) as client:
        post = lambda sid, data: client.post(  # noqa: E731
            f"/session/{sid}/frame", files={"frame": ("f.jpg", data, "image/jpeg")}
        )
        assert post("nope", image()).status_code == 404
        assert post("old", image()).status_code == 404
        assert client.get("/health").json() == {"ok": True, "feeds": 0}
        assert post("s1", b"not a jpeg").status_code == 400
        status = post("s1", image()).json()
        assert status["sent"] and not status["closed"]
        while feeds.get("s1").busy:  # the model call runs in the background
            time.sleep(0.01)
        convex.down = True  # the feed is known now: frames no longer ask Convex first
        assert post("s1", image()).status_code == 200
    assert perception.calls == 1
    assert [e["rule"] for e in convex.events] == ["cat arrives"]


def test_normalize_is_for_convex_only(monkeypatch):
    monkeypatch.setattr("src.config.WORKER_SECRET", "s3cret")
    client = TestClient(create_app(FakePerception(), FakeConvex(), Notifier()))
    body = {"rules": ["the cat jumps onto the table", "a cat"]}
    assert client.post("/internal/normalize", json=body).status_code == 401
    wrong = {"authorization": "Bearer nope"}
    assert (
        client.post("/internal/normalize", json=body, headers=wrong).status_code == 401
    )
    ok = client.post(
        "/internal/normalize", json=body, headers={"authorization": "Bearer s3cret"}
    )
    # the shape convex/lib.ts `Spec` expects
    assert ok.json()["specs"] == [
        {
            "predicate": "a cat is on the table",
            "direction": "rising",
            "isTransition": True,
            "usage": {"prompt": 120, "completion": 8, "calls": 1, "usdTicks": 4500},
        },
        {
            "predicate": "a cat is visible",
            "direction": "rising",
            "isTransition": False,
            "usage": {"prompt": 0, "completion": 0, "calls": 0, "usdTicks": 0},
        },
    ]
    # an unset secret must not mean "Bearer " opens the door
    monkeypatch.setattr("src.config.WORKER_SECRET", "")
    empty = {"authorization": "Bearer "}
    assert (
        client.post("/internal/normalize", json=body, headers=empty).status_code == 401
    )


def test_page_config_qr_and_cross_origin_page(monkeypatch):
    """The page hosted on Convex learns where things are from config.js and may call the API."""
    site = "https://example.convex.site"
    monkeypatch.setattr("src.config.CONVEX_URL", "https://example.convex.cloud")
    monkeypatch.setattr("src.config.FRONTEND_ORIGIN", site)
    client = TestClient(
        create_app(FakePerception(), FakeConvex(), Notifier(), fake_bot())
    )
    js = client.get("/static/config.js").text
    assert 'window.CONVEX_URL = "https://example.convex.cloud";' in js
    assert (
        'window.WORKER_URL = "";' in js
        and 'window.TELEGRAM_BOT_USERNAME = "cam_bot";' in js
    )
    qr = client.get("/subscriber/jh7cy0745xjrtc4jbrxp1zpn018ev0ej/qr.svg")
    assert (qr.status_code, qr.headers["content-type"]) == (200, "image/svg+xml")
    assert client.get("/subscriber/bad%20token/qr.svg").status_code == 422
    ok = client.get("/health", headers={"origin": site})
    assert ok.headers["access-control-allow-origin"] == site
    other = client.get("/health", headers={"origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers
