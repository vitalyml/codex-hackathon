"""What the worker keeps in memory.

`Feed`/`Feeds` is the real thing: per-session state that is safe to lose, because
everything durable lives in Convex. The classes below them are the old in-memory store,
kept only until the Telegram module moves to Convex."""

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Optional

from loguru import logger

from src.server.cv.gate import Gate
from src.server.cv.perception import Rule, Usage
from src.server.tracker import Tracker

FEED_TTL = 300.0  # seconds without a frame before a feed is forgotten


@dataclass
class Feed:
    """The frame stream of one session. Lost on a restart, rebuilt by the next frame."""

    gate: Gate = field(default_factory=Gate)
    busy: bool = False  # a model call is in flight
    retry: bool = False  # ask the model on the next frame even if the scene is quiet
    closed: bool = False  # Convex said: stopped, gone, or past the free limit
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


class SessionFull(Exception):
    pass


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


def new_watch(rule: str, spec: Rule) -> Watch:
    return Watch(rule, spec.predicate, spec.direction, Tracker(spec.direction))


# The three ways the rule set changes while a session runs (web page and Telegram share
# them). Synchronous on purpose: no await inside, so the list never changes under the
# engine, which snapshots it before every model call.


def add_watch(session: "Session", watch: Watch, limit: int) -> bool:
    if len(session.watches) >= limit:
        return False
    session.watches.append(watch)
    _rules_changed(session)
    return True


def replace_watch(session: "Session", i: int, watch: Watch) -> bool:
    if not 0 <= i < len(session.watches):
        return False
    session.watches[i] = watch
    _rules_changed(session)
    return True


def drop_watch(session: "Session", i: int) -> bool:
    """Never below one rule: a session with nothing to watch has no reason to exist."""
    if not 0 <= i < len(session.watches) or len(session.watches) == 1:
        return False
    del session.watches[i]
    _rules_changed(session)
    return True


def _rules_changed(session: "Session") -> None:
    session.retry = True  # ask the model again even if the scene is quiet
    session.revision += 1
    session.changed.set()


@dataclass
class Subscriber:
    """A browser that asked for Telegram alerts.

    Deliberately not part of Session: the chat is bound once, before any rule exists,
    and carries into every watch that browser starts afterwards."""

    token: str
    chat_id: Optional[int] = None  # Telegram chat bound via /start <token>
    muted: bool = False
    editing: Optional[str] = None  # rule entry in progress: "add" | "edit:<index>"
    last_seen: float = field(default_factory=time.monotonic)


@dataclass
class Session:
    id: str
    gate: Gate
    watches: list[Watch]
    events: list[Event] = field(default_factory=list)  # across all watches, in order
    busy: bool = False  # a model call is in flight
    subscriber: Optional[str] = None  # Subscriber.token to notify when an event fires
    latest_frame: bytes = b""
    frame_at: str = ""
    frame_received: asyncio.Event = field(default_factory=asyncio.Event)
    retry: bool = False  # retry failed perception on the next available frame
    usage: Usage = field(default_factory=Usage)  # API tokens spent by this session
    revision: int = 0
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False
    notifications: set[asyncio.Task] = field(default_factory=set)
    last_seen: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(
        default_factory=asyncio.Lock
    )  # frames of one tab, in order
    task: Optional["asyncio.Task[None]"] = None  # keeps the background model call alive


class SessionStore:
    def __init__(self, max_sessions: int, ttl: float) -> None:
        self.max_sessions = max_sessions
        self.ttl = ttl
        self._sessions: dict[str, Session] = {}

    def __len__(self) -> int:
        self.sweep()
        return len(self._sessions)

    def create(self, rules: list[str], specs: list[Rule]) -> Session:
        self.sweep()
        if len(self._sessions) >= self.max_sessions:
            raise SessionFull()
        session = Session(
            secrets.token_urlsafe(6),
            Gate(),
            [new_watch(rule, spec) for rule, spec in zip(rules, specs)],
        )
        for spec in specs:  # the normalize calls are billed to this session
            session.usage += spec.usage
        logger.info("session={} usage {} (normalize)", session.id, session.usage)
        self._sessions[session.id] = session
        return session

    def all(self) -> list[Session]:
        self.sweep()
        return list(self._sessions.values())

    def get(self, session_id: str) -> Session:
        self.sweep()
        return self._sessions[session_id]

    def touch(self, session: Session) -> None:
        session.last_seen = time.monotonic()

    def delete(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is not None:
            session.closed = True
            session.changed.set()
            if session.task is not None:
                session.task.cancel()
            for task in session.notifications:
                task.cancel()

    def sweep(self, now: float | None = None) -> int:
        now = time.monotonic() if now is None else now
        dead = [k for k, s in self._sessions.items() if now - s.last_seen > self.ttl]
        for k in dead:
            self.delete(k)
        return len(dead)


class Subscribers:
    """Browser -> Telegram chat, keyed by an opaque token the page keeps in localStorage.

    Outlives sessions, dies with the process - the same "nothing is stored between
    restarts" rule the sessions follow. A restart just means the page subscribes again.
    """

    def __init__(self, max_subscribers: int, ttl: float) -> None:
        self.max_subscribers = max_subscribers
        self.ttl = ttl
        self._subscribers: dict[str, Subscriber] = {}

    def __len__(self) -> int:
        return len(self._subscribers)

    def create(self) -> Subscriber:
        self.sweep()
        # Evict the stalest instead of refusing: subscribing costs nothing and a new
        # browser must always get a QR, unlike a session which holds a model budget.
        while len(self._subscribers) >= self.max_subscribers:
            stalest = min(self._subscribers.values(), key=lambda s: s.last_seen)
            del self._subscribers[stalest.token]
        subscriber = Subscriber(secrets.token_urlsafe(9))
        self._subscribers[subscriber.token] = subscriber
        return subscriber

    def __contains__(self, token: object) -> bool:
        return token in self._subscribers

    def get(self, token: str) -> Subscriber:
        """Raises KeyError. Touches: an open page polls, and polling keeps it alive."""
        subscriber = self._subscribers[token]
        subscriber.last_seen = time.monotonic()
        return subscriber

    def by_chat(self, chat_id: int) -> Optional[Subscriber]:
        # ponytail: linear scan, MAX_SUBSCRIBERS is small
        return next(
            (s for s in self._subscribers.values() if s.chat_id == chat_id), None
        )

    def sweep(self, now: float | None = None) -> int:
        now = time.monotonic() if now is None else now
        dead = [k for k, s in self._subscribers.items() if now - s.last_seen > self.ttl]
        for k in dead:
            del self._subscribers[k]
        return len(dead)
