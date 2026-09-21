import pytest

from src.server.cv.perception import Rule
from src.server.session import SessionFull, SessionStore

RULE = Rule("a cat is on the table", "rising", True)


def test_create_and_get():
    store = SessionStore(max_sessions=2, ttl=30)
    s = store.create(["the cat jumps on the table"], [RULE])
    assert store.get(s.id) is s
    (w,) = s.watches
    assert (w.predicate, w.direction, w.tracker.direction) == (
        RULE.predicate,
        "rising",
        "rising",
    )
    assert len(store) == 1


def test_cap():
    store = SessionStore(max_sessions=2, ttl=30)
    store.create(["a"], [RULE])
    store.create(["b"], [RULE])
    with pytest.raises(SessionFull):
        store.create(["c"], [RULE])


def test_ttl_frees_slot():
    store = SessionStore(max_sessions=1, ttl=30)
    s = store.create(["a"], [RULE])
    s.last_seen = 0.0
    assert store.sweep(now=31.0) == 1
    with pytest.raises(KeyError):
        store.get(s.id)
    store.create(["b"], [RULE])  # slot is free again


def test_create_sweeps_first():
    store = SessionStore(max_sessions=1, ttl=30)
    s = store.create(["a"], [RULE])
    s.last_seen = 0.0
    store.create(["b"], [RULE])  # would raise SessionFull without the sweep


def test_delete():
    store = SessionStore(max_sessions=1, ttl=30)
    s = store.create(["a"], [RULE])
    store.delete(s.id)
    assert len(store) == 0
    store.delete("missing")  # no error


def test_reads_expire_sessions_without_creating_another():
    for read in ("get", "all", "len"):
        store = SessionStore(1, 30)
        s = store.create(["a"], [RULE])
        s.last_seen = 0
        if read == "get":
            with pytest.raises(KeyError):
                store.get(s.id)
        elif read == "all":
            assert store.all() == []
        else:
            assert len(store) == 0


async def test_expiry_cancels_inflight_perception():
    import asyncio

    store = SessionStore(1, 30)
    s = store.create(["a"], [RULE])
    s.task = asyncio.create_task(asyncio.sleep(60))
    s.last_seen = 0
    store.sweep()
    with pytest.raises(asyncio.CancelledError):
        await s.task


def test_idle_feeds_are_forgotten_and_a_frame_keeps_one_alive():
    from src.server.session import Feeds

    feeds = Feeds(ttl=300)
    idle, busy = feeds.add("idle"), feeds.add("busy")
    assert feeds.add("idle") is idle  # two first frames at once share one feed
    idle.last_seen -= 301
    busy.last_seen -= 301
    assert feeds.get("busy") is busy  # a frame arrived
    assert feeds.sweep() == 1 and feeds.get("idle") is None and len(feeds) == 1
