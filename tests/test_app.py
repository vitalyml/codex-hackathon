import json
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
            return Rule("a cat is visible", "rising")
        return Rule("a cat is on the table", "rising", Usage(120, 8, 1, 4500))

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
            "usage": {"prompt": 120, "completion": 8, "calls": 1, "usdTicks": 4500},
        },
        {
            "predicate": "a cat is visible",
            "direction": "rising",
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


def test_stt_token_goes_only_to_a_known_subscriber():
    asked = []

    def openai(request: httpx.Request) -> httpx.Response:
        asked.append(json.loads(request.content)["session"])
        return httpx.Response(200, json={"value": "ek_short", "expires_at": 1})

    stt = httpx.AsyncClient(
        transport=httpx.MockTransport(openai), base_url="https://api.openai.com/v1"
    )
    convex = FakeConvex()
    convex.subscribers["fresh"] = {"linked": False}
    quiet = create_app(FakePerception(), convex, Notifier())
    assert TestClient(quiet).post("/subscriber/fresh/stt-token").status_code == 404
    client = TestClient(create_app(FakePerception(), convex, Notifier(), stt=stt))
    assert client.post("/subscriber/nobody/stt-token").status_code == 404
    assert client.post("/subscriber/fresh/stt-token?lang=russian").status_code == 422
    assert asked == []
    assert client.post("/subscriber/fresh/stt-token?lang=ru").json() == {
        "value": "ek_short"
    }
    assert asked[0]["type"] == "transcription"
    assert asked[0]["audio"]["input"]["transcription"]["language"] == "ru"


def test_browser_normalization_requires_a_subscriber_and_does_not_persist_prompts():
    convex = FakeConvex()
    convex.subscribers["browser"] = {"linked": False}
    client = TestClient(create_app(FakePerception(), convex, Notifier()))
    assert (
        client.post(
            "/normalize", json={"subscriber": "unknown", "rules": ["a cat"]}
        ).status_code
        == 404
    )
    response = client.post(
        "/normalize", json={"subscriber": "browser", "rules": ["a cat"]}
    )
    assert response.status_code == 200
    assert response.json()["specs"][0]["predicate"] == "a cat is visible"
    assert not convex.sessions and not convex.events and not convex.usage
    for rules in ([], [""], ["x" * 4001]):
        assert (
            client.post(
                "/normalize", json={"subscriber": "browser", "rules": rules}
            ).status_code
            == 400
        )


def test_normalize_endpoints_share_validation_and_redacted_errors(monkeypatch):
    from src.server.cv.perception import PerceptionError

    monkeypatch.setattr("src.config.WORKER_SECRET", "secret")

    class Broken(FakePerception):
        async def normalize(self, rule):
            raise PerceptionError("private model output")

    convex = FakeConvex()
    convex.subscribers["browser"] = {"linked": False}
    client = TestClient(create_app(Broken(), convex, Notifier()))
    results = []
    for path, headers in [
        ("/normalize", {}),
        ("/internal/normalize", {"authorization": "Bearer secret"}),
    ]:
        response = client.post(
            path, headers=headers, json={"rules": ["r"], "subscriber": "browser"}
        )
        assert response.status_code == 502
        assert "private" not in response.text
        results.append(response.json())
        assert (
            client.post(
                path, headers=headers, json={"rules": [""], "subscriber": "browser"}
            ).status_code
            == 400
        )
    assert results[0] == results[1]
