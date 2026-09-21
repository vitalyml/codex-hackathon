from src.server.session import Feeds


def test_idle_feeds_are_forgotten_and_a_frame_keeps_one_alive():
    feeds = Feeds(ttl=300)
    idle, busy = feeds.add("idle"), feeds.add("busy")
    assert feeds.add("idle") is idle  # two first frames at once share one feed
    idle.last_seen -= 301
    busy.last_seen -= 301
    assert feeds.get("busy") is busy  # a frame arrived
    assert feeds.sweep() == 1 and feeds.get("idle") is None and len(feeds) == 1
