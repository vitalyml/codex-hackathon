"""What the worker keeps in memory.

`Feed`/`Feeds`: per-session state that is safe to lose, because everything durable lives
in Convex. `Event`/`Watch` carry one fired event from the engine to the notifier."""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Optional

from src.server.cv.gate import Gate
from src.server.tracker import Tracker

FEED_TTL = 300.0  # seconds without a frame before a feed is forgotten


@dataclass
class Feed:
    """The frame stream of one session. Lost on a restart, rebuilt by the next frame."""

    gate: Gate = field(default_factory=Gate)
    busy: bool = False  # a model call is in flight
    retry: bool = False  # ask the model on the next frame even if the scene is quiet
    closed: bool = False  # Convex said: stopped or gone
    latest_frame: bytes = b""  # Telegram "snapshot" waits for a fresh one
    frame_at: str = ""
    frame_received: asyncio.Event = field(default_factory=asyncio.Event)
    last_seen: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(
        default_factory=asyncio.Lock
    )  # frames of one tab, in order
    task: Optional["asyncio.Task[None]"] = None  # keeps the background model call alive
    notifications: set[asyncio.Task] = field(default_factory=set)


class Feeds:
    def __init__(self, ttl: float = FEED_TTL) -> None:
        self.ttl = ttl
        self._feeds: dict[str, Feed] = {}

    def __len__(self) -> int:
        return len(self._feeds)

    def get(self, session_id: str) -> Optional[Feed]:
        feed = self._feeds.get(session_id)
        if feed is not None:
            feed.last_seen = time.monotonic()
        return feed

    def add(self, session_id: str) -> Feed:
        return self._feeds.setdefault(session_id, Feed())

    def all(self) -> list[Feed]:
        return list(self._feeds.values())

    def sweep(self, now: float | None = None) -> int:
        now = time.monotonic() if now is None else now
        dead = [k for k, f in self._feeds.items() if now - f.last_seen > self.ttl]
        for k in dead:
            feed = self._feeds.pop(k)
            if feed.task is not None:
                feed.task.cancel()
        return len(dead)


@dataclass
class Event:
    n: int
    at: str  # ISO-8601 UTC
    text: str
    image: bytes
    rule: str = ""  # the user's words for the watch that fired


@dataclass(eq=False)  # identity: a replaced watch with the same words is a new watch
class Watch:
    """One rule the user is waiting for. A session holds several; one model call per
    frame answers all of them."""

    rule: str
    predicate: str
    direction: str
    tracker: Tracker
    evidence: str = ""
    fired: bool = False  # an event fired, not yet reported in a FrameStatus
