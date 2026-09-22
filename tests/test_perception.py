import httpx
import pytest

from src.server.cv.perception import OpenAIPerception, PerceptionError


def reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def make(handler) -> OpenAIPerception:
    p = OpenAIPerception(keys=["A", "B"], model="m")
    p.client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://api.openai.com/v1"
    )
    return p


async def test_detect_parses_json():
    async def handler(request):
        return reply('{"state_now": true, "evidence": "cat on table"}')

    (obs,) = (
        await make(handler).detect(b"jpegbytes", ["a cat is on the table"])
    ).observations
    assert (obs.state, obs.evidence) == (True, "cat on table")


async def test_detect_several_predicates_in_one_call():
    prompts = []

    async def handler(request):
        prompts.append(request.content.decode())
        return reply(
            '{"answers": [{"state_now": true, "evidence": "cat"}, '
            '{"state_now": false, "evidence": "door shut"}]}'
        )

    d = await make(handler).detect(b"jpeg", ["a cat is on the table", "door is open"])
    assert [(o.state, o.evidence) for o in d.observations] == [
        (True, "cat"),
        (False, "door shut"),
    ]
    assert len(prompts) == 1 and "1. a cat is on the table" in prompts[0]
    assert "2. door is open" in prompts[0]

    async def short(request):
        return reply("true")

    with pytest.raises(PerceptionError):
        await make(short).detect(b"jpeg", ["a", "b"])


async def test_normalize_rule():
    async def handler(request):
        return reply('{"predicate": "a cat is on the table", ' '"direction": "rising"}')

    rule = await make(handler).normalize("the cat jumps onto the table")
    assert (rule.predicate, rule.direction) == ("a cat is on the table", "rising")


async def test_retry_on_429_then_error():
    seen = []

    async def handler(request):
        seen.append(request.headers["authorization"][-1])
        return httpx.Response(429, json={"error": "slow down"})

    with pytest.raises(PerceptionError):
        await make(handler).detect(b"x", ["p"])
    assert seen == ["A", "B"]


async def test_failover_sticks_to_backup_key():
    seen = []

    async def handler(request):
        key = request.headers["authorization"][-1]
        seen.append(key)
        if key == "A":
            return httpx.Response(401, json={"error": "bad key"})
        return reply('{"state_now": false, "evidence": ""}')

    p = make(handler)
    await p.detect(b"x", ["p"])
    await p.detect(b"x", ["p"])  # stays on B, no retry through A
    assert seen == ["A", "B", "B"]


async def test_usage_is_priced_from_tokens(monkeypatch):
    monkeypatch.setattr("src.server.cv.perception.OPENAI_PRICE_IN", 2.5)
    monkeypatch.setattr("src.server.cv.perception.OPENAI_PRICE_CACHED", 1.25)
    monkeypatch.setattr("src.server.cv.perception.OPENAI_PRICE_OUT", 10.0)

    async def handler(request):
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"state_now": false}'}}],
                "usage": {
                    "prompt_tokens": 300,  # includes the cached ones
                    "completion_tokens": 12,
                    "prompt_tokens_details": {"cached_tokens": 100},
                },
            },
        )

    obs = await make(handler).detect(b"x", ["p"])
    assert obs.usage.as_dict() == {
        "prompt": 300,
        "completion": 12,
        "total": 312,
        "calls": 1,
        # (200 * 2.50 + 100 * 1.25 + 12 * 10.00) / 1M
        "usd": 0.000745,
    }


async def test_slow_key_fails_over_without_waiting_thirty_seconds(monkeypatch):
    import asyncio

    monkeypatch.setattr("src.server.cv.perception.OPENAI_ATTEMPT_TIMEOUT", 0.01)
    seen = []

    async def handler(request):
        key = request.headers["authorization"][-1]
        seen.append(key)
        if key == "A":
            await asyncio.sleep(60)
        return reply('{"state_now": true}')

    p = make(handler)
    try:
        result = await asyncio.wait_for(p.detect(b"jpeg", ["present"]), 1)
        assert result.observations[0].state and seen == ["A", "B"]
    finally:
        await p.aclose()


async def test_total_deadline_bounds_all_key_attempts(monkeypatch):
    import asyncio

    monkeypatch.setattr("src.server.cv.perception.OPENAI_REQUEST_TIMEOUT", 0.02)
    monkeypatch.setattr("src.server.cv.perception.OPENAI_ATTEMPT_TIMEOUT", 1)
    cancelled = asyncio.Event()

    async def handler(request):
        try:
            await asyncio.sleep(60)
        finally:
            cancelled.set()

    p = make(handler)
    try:
        with pytest.raises(PerceptionError, match="deadline"):
            await asyncio.wait_for(p.detect(b"jpeg", ["present"]), 1)
        assert cancelled.is_set()
    finally:
        await p.aclose()
