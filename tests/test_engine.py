import asyncio

import cv2
import numpy as np

from src.server.cv.perception import Detection, Observation, PerceptionError
from src.server.engine import handle_frame
from src.server.notifier import Notifier
from src.server.session import Feed
from tests.fake_convex import FakeConvex


def image(changed=False):
    pixels = np.full((720, 1280, 3), 150, np.uint8)
    if changed:
        pixels[:90, :160] = 0
    return cv2.imencode(".jpg", pixels)[1].tobytes()


class Answers:
    """A model that says what the test tells it to, one list of states per call."""

    def __init__(self, *answers) -> None:
        self.answers, self.calls = list(answers), 0

    async def detect(self, jpeg, predicates):
        self.calls += 1
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return Detection([Observation(state, "seen") for state in answer])


async def test_watches_share_a_call_and_a_photo_and_state_survives_the_worker():
    convex = FakeConvex()
    convex.add("s", ("cat arrives", "cat", "rising"), ("door opens", "door", "rising"))
    model = Answers([True, True], [True, True], [False, True])
    sent = []

    class Spy(Notifier):
        async def notify(self, session_id, watch, event, chat_id):
            sent.append((watch.rule, event.text, event.image == image()))

    feed = Feed()
    assert (await handle_frame(feed, "s", image(), model, convex, Spy()))["sent"]
    await feed.task
    await asyncio.gather(*feed.notifications)
    # both rules fired on one frame: one model call, one upload, two events
    assert [e["rule"] for e in convex.events] == ["cat arrives", "door opens"]
    assert convex.photos == [image()]
    assert {e["storageId"] for e in convex.events} == {"photo1"}
    assert sent == [
        ("cat arrives", "cat - became true", True),
        ("door opens", "door - became true", True),
    ]
    # A restarted worker (a new Feed) rebuilds the trackers from Convex: the same
    # answer must not fire again, and a falling edge of a rising rule never does.
    for _ in range(2):
        feed = Feed()
        await handle_frame(feed, "s", image(), model, convex, Spy(), force=True)
        await feed.task
    assert len(convex.events) == 2 and model.calls == 3
    assert [w["state"] for w in convex.sessions["s"]["watches"]] == [False, True]


async def test_failure_retries_on_a_quiet_scene_and_force_asks_again():
    convex = FakeConvex()
    convex.add("s", ("arrives", "present", "rising"))
    model = Answers([False], PerceptionError("temporary"), [True])
    feed, notifier = Feed(), Notifier()
    await handle_frame(feed, "s", image(), model, convex, notifier)
    await feed.task
    # the scene is quiet now: the gate alone would not send
    assert not (await handle_frame(feed, "s", image(), model, convex, notifier))["sent"]
    assert (await handle_frame(feed, "s", image(), model, convex, notifier, True))[
        "sent"
    ]
    await feed.task
    assert (
        feed.retry
    )  # the model failed: the next frame goes out whatever the gate says
    convex.down = True
    assert (await handle_frame(feed, "s", image(), model, convex, notifier))["sent"]
    await feed.task
    assert feed.retry and model.calls == 2  # Convex down: no model call, still retrying
    convex.down = False
    assert (await handle_frame(feed, "s", image(), model, convex, notifier))["sent"]
    await feed.task
    assert not feed.retry and len(convex.events) == 1


async def test_stopped_or_expired_session_gets_no_model_calls():
    convex, model, notifier = FakeConvex(), Answers(), Notifier()
    convex.add("stopped", ("r", "p", "rising"))["status"] = "stopped"
    for session_id in ("stopped", "deleted"):
        feed = Feed()
        await handle_frame(feed, session_id, image(), model, convex, notifier)
        await feed.task
        status = await handle_frame(
            feed, session_id, image(True), model, convex, notifier
        )
        assert status["closed"] and not status["sent"]
    assert model.calls == 0 and not convex.usage


async def test_change_while_busy_is_detected_when_model_finishes():
    release = asyncio.Event()
    calls = []

    class Perception:
        async def detect(self, jpeg, predicates):
            calls.append(jpeg)
            if len(calls) == 1:
                await release.wait()
            return Detection([Observation(len(calls) > 1, "observed")])

    convex = FakeConvex()
    convex.add("s", ("arrives", "present", "rising"))
    feed, p, notifier = Feed(), Perception(), Notifier()
    await handle_frame(feed, "s", image(), p, convex, notifier)
    await handle_frame(feed, "s", image(True), p, convex, notifier)
    status = await handle_frame(feed, "s", image(True), p, convex, notifier)
    assert status["busy"] and not status["sent"]
    assert feed.latest_frame == image(True)  # kept fresh for Telegram even while busy
    release.set()
    await feed.task
    assert (await handle_frame(feed, "s", image(True), p, convex, notifier))["sent"]
    await feed.task
    assert calls == [image(), image(True)]
    assert len(convex.events) == 1


async def test_a_lost_response_is_retried_without_recording_the_answer_twice(
    monkeypatch,
):
    monkeypatch.setattr("src.server.engine.SAVE_BACKOFF", 0)
    convex = FakeConvex()
    convex.add("s", ("arrives", "present", "rising"))
    convex.lose_responses = 2
    feed = Feed()
    await handle_frame(feed, "s", image(), Answers([True]), convex, Notifier())
    await feed.task
    assert not feed.retry  # saved on the third attempt: no second model call needed
    assert len(convex.events) == 1 and len(convex.usage) == 1
    assert len(convex.photos) == 1  # the photo is uploaded once, not per attempt


async def test_a_rule_dropped_while_the_model_thinks_gets_no_alert(monkeypatch):
    monkeypatch.setattr("src.server.engine.SAVE_BACKOFF", 0)
    convex = FakeConvex()
    convex.add("s", ("cat arrives", "cat", "rising"), ("door opens", "door", "rising"))
    convex.lose_responses = 1  # the retry must name the same kept watches
    sent = []

    class Dropping(Answers):
        async def detect(self, jpeg, predicates):
            convex.sessions["s"]["watches"].pop(0)  # removed on the page meanwhile
            return await super().detect(jpeg, predicates)

    class Spy(Notifier):
        async def notify(self, session_id, watch, event, chat_id):
            sent.append(watch.rule)

    feed = Feed()
    await handle_frame(feed, "s", image(), Dropping([True, True]), convex, Spy())
    await feed.task
    await asyncio.gather(*feed.notifications)
    assert [e["rule"] for e in convex.events] == ["door opens"]
    assert sent == ["door opens"]
