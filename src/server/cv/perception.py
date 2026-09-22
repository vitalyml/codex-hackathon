"""One call per frame to a vision model: every watch's predicate in one prompt. Port of notebooks/groq.ipynb, pointed at OpenAI.

Integration seam: depend on the `Perception` protocol, not on `OpenAIPerception`.
Tests inject a fake; the provider can be swapped without touching callers.
"""

import asyncio
import base64
import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

import httpx
from loguru import logger

from src.config import (
    OPENAI_ATTEMPT_TIMEOUT,
    OPENAI_BASE_URL,
    OPENAI_IMAGE_DETAIL,
    OPENAI_PRICE_CACHED,
    OPENAI_PRICE_IN,
    OPENAI_PRICE_OUT,
    OPENAI_REQUEST_TIMEOUT,
)

DETECT_PROMPT = (
    "You look at a single still frame from a fixed security camera.\n"
    "For EACH numbered statement answer only about THIS frame: is it true right now?\n"
    "{predicates}\n"
    "If the frame is too dark or unclear to tell, answer false.\n"
    'Reply with JSON only: {{"answers": [{{"state_now": true|false, '
    '"evidence": "<a few words on what you see>"}}, ...]}} '
    "- one object per statement, in the same order."
)

NORMALIZE_PROMPT = (
    "A user wants a camera to notify them when something HAPPENS. Their words:\n"
    "  {rule}\n"
    "Rewrite it as a STATE that is either true or false in a single still frame, "
    "plus the direction of the change the user is waiting for.\n"
    "- predicate: a short present-tense sentence about the scene, "
    "e.g. 'a cat is on the table'\n"
    "- direction: 'rising' if the user waits for the predicate to become true "
    "(appears, arrives, jumps on, turns on), 'falling' if they wait for it to "
    "become false (leaves, goes away, turns off)\n"
    "A bare object ('an apple', 'tell me if you see a dog') means waiting for it "
    "to appear: rising\n"
    'Reply with JSON only: {{"predicate": "...", "direction": "rising"|"falling"}}'
)


class PerceptionError(Exception):
    pass


@dataclass
class Usage:
    """Tokens spent and what they cost. Mutable accumulator: `total += call`.

    The API reports tokens, not money, so cost is an estimate: tokens times the
    per-million prices in config (1 tick = 1e-10 USD). `prompt_tokens` already counts
    image tokens and cached ones; cached tokens are billed at their own rate.
    """

    prompt: int = 0
    completion: int = 0
    calls: int = 0
    usd_ticks: int = 0

    def __iadd__(self, other: "Usage") -> "Usage":
        self.prompt += other.prompt
        self.completion += other.completion
        self.calls += other.calls
        self.usd_ticks += other.usd_ticks
        return self

    @property
    def usd(self) -> float:
        return self.usd_ticks / 10_000_000_000

    def wire(self) -> dict:
        """The shape Convex stores (convex/lib.ts usageValidator)."""
        return {
            "prompt": self.prompt,
            "completion": self.completion,
            "calls": self.calls,
            "usdTicks": self.usd_ticks,
        }

    def as_dict(self) -> dict:
        return {
            "prompt": self.prompt,
            "completion": self.completion,
            "total": self.prompt + self.completion,
            "calls": self.calls,
            "usd": round(self.usd, 6),
        }

    def __str__(self) -> str:
        return (
            f"{self.prompt}+{self.completion} tokens, "
            f"{self.calls} calls, ${self.usd:.4f}"
        )


@dataclass
class Rule:
    predicate: str
    direction: str  # rising | falling
    usage: Usage = field(default_factory=Usage)


@dataclass
class Observation:
    state: bool
    evidence: str


@dataclass
class Detection:
    """One model call: an observation per predicate asked, in order."""

    observations: list[Observation]
    usage: Usage = field(default_factory=Usage)


class Perception(Protocol):
    async def normalize(self, rule: str) -> Rule: ...

    async def detect(self, jpeg: bytes, predicates: list[str]) -> Detection: ...


def _usage(u: dict) -> Usage:
    prompt = int(u.get("prompt_tokens", 0))
    completion = int(u.get("completion_tokens", 0))
    cached = int((u.get("prompt_tokens_details") or {}).get("cached_tokens", 0))
    # $1 per 1M tokens = 1e-6 USD per token = 1e4 ticks
    ticks = (
        (prompt - cached) * OPENAI_PRICE_IN
        + cached * OPENAI_PRICE_CACHED
        + completion * OPENAI_PRICE_OUT
    ) * 10_000
    return Usage(prompt, completion, 1, round(ticks))


def _json(raw: str) -> dict:
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        found = re.search(r"\{.*\}", raw, re.S)
        if found:
            try:
                return json.loads(found.group())
            except json.JSONDecodeError:
                pass
        return {}


class OpenAIPerception:
    def __init__(self, keys: list[str], model: str) -> None:
        if not keys:
            raise PerceptionError("no OPENAI_API_KEYS configured")
        self.model = model
        self._keys = keys
        self._active = 0  # sticky: the first key is primary, later ones are fallbacks
        self.client = httpx.AsyncClient(base_url=OPENAI_BASE_URL, timeout=30)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _ask(self, content: Any, max_tokens: int = 96) -> tuple[str, Usage]:
        try:
            return await asyncio.wait_for(
                self._ask_with_failover(content, max_tokens), OPENAI_REQUEST_TIMEOUT
            )
        except asyncio.TimeoutError as e:
            raise PerceptionError("OpenAI request deadline exceeded") from e

    async def _ask_with_failover(
        self, content: Any, max_tokens: int
    ) -> tuple[str, Usage]:
        payload = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": content}],
        }
        last: Optional[Exception] = None
        for _ in self._keys:  # try each key at most once per call
            key = self._keys[self._active]
            try:
                response = await asyncio.wait_for(
                    self.client.post(
                        "/chat/completions",
                        json=payload,
                        headers={"Authorization": f"Bearer {key}"},
                    ),
                    OPENAI_ATTEMPT_TIMEOUT,
                )
                if response.status_code in (429, 500, 502, 503):
                    last = PerceptionError(
                        f"openai {response.status_code}: {response.text[:120]}"
                    )
                    self._failover(last)
                    continue
                response.raise_for_status()
                body = response.json()
                usage = _usage(body.get("usage") or {})
                return body["choices"][0]["message"].get("content") or "", usage
            except (httpx.HTTPError, asyncio.TimeoutError) as e:
                last = e
                self._failover(e)
        raise PerceptionError(f"{type(last).__name__}: {last}" if last else "no keys")

    def _failover(self, error: Exception) -> None:
        if len(self._keys) == 1:
            logger.warning("openai key failed: {!r}", error)
            return
        self._active = (self._active + 1) % len(self._keys)
        logger.warning(
            "openai key failed: {!r}; switching to key #{}", error, self._active + 1
        )

    async def normalize(self, rule: str) -> Rule:
        raw, usage = await self._ask(NORMALIZE_PROMPT.format(rule=rule))
        data = _json(raw)
        direction = data.get("direction")
        if direction not in ("rising", "falling") or not data.get("predicate"):
            raise PerceptionError(f"cannot parse rule from: {raw[:120]}")
        return Rule(
            str(data["predicate"]),
            direction,
            usage,
        )

    async def detect(self, jpeg: bytes, predicates: list[str]) -> Detection:
        image = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        numbered = "\n".join(f"  {i + 1}. {p}" for i, p in enumerate(predicates))
        raw, usage = await self._ask(
            [
                {"type": "text", "text": DETECT_PROMPT.format(predicates=numbered)},
                {
                    "type": "image_url",
                    "image_url": {"url": image, "detail": OPENAI_IMAGE_DETAIL},
                },
            ],
            max_tokens=48 + 48 * len(predicates),
        )
        return Detection(_answers(raw, len(predicates)), usage)


def _answers(raw: str, n: int) -> list[Observation]:
    data = _json(raw)
    answers = data.get("answers")
    if n == 1 and "state_now" in data:  # the model skipped the list for one question
        answers = [data]
    if (
        isinstance(answers, list)
        and len(answers) == n
        and all(isinstance(a, dict) for a in answers)
    ):
        return [
            Observation(bool(a.get("state_now")), str(a.get("evidence", "")))
            for a in answers
        ]
    found = re.findall(r"true|false", raw.lower())
    if len(found) != n:
        raise PerceptionError(f"expected {n} verdicts in: {raw[:120]}")
    return [Observation(v == "true", "<unparsed>") for v in found]
