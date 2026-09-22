"""One frame through the loop: gate -> model -> tracker -> Convex -> notifier.

Multi-user: many browser tabs post frames into one event loop. Two rules keep one user
from stalling the others: decode + gate (cv2/numpy, CPU-bound) run in a worker thread,
and the model call runs as a background task - POST /frame returns at once with
sent=True. The page learns the results from Convex live queries, not from here.

Nothing durable lives in this process. Before each model call the watches are read from
Convex; the tracker is rebuilt from the stored state, and one mutation writes the answer
back.
"""

import asyncio
import secrets
from datetime import datetime, timezone
from typing import Optional

from loguru import logger

from src.server.convex_client import Convex, ConvexError
from src.server.cv.gate import GateResult, decode
from src.server.cv.perception import Perception, PerceptionError
from src.server.notifier import Notifier
from src.server.session import Event, Feed, Watch
from src.server.tracker import Tracker

SAVE_ATTEMPTS = 3
SAVE_BACKOFF = 1.0  # seconds, times the attempt number


def _status(feed: Feed, gate: GateResult, call_id: Optional[str]) -> dict:
    """`callId` names the model call this frame started, if any: an event carries the
    same id, so the page can show the frame it kept next to the event."""
    return {
        "gate": gate.verdict,
        "streak": gate.streak,
        "sent": call_id is not None,
        "callId": call_id,
        "busy": feed.busy,
        "closed": feed.closed,
    }


async def handle_frame(
    feed: Feed,
    session_id: str,
    jpeg: bytes,
    perception: Perception,
    convex: Convex,
    notifier: Notifier,
    force: bool = False,
) -> dict:
    """`force`: the page changed the rules, so ask the model even if the scene is quiet."""
    async with feed.lock:  # gate state is per-session and not thread-safe
        frame = await asyncio.to_thread(decode, jpeg)  # raises ValueError on junk
        feed.latest_frame = jpeg
        feed.frame_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        feed.frame_received.set()
        gate = await asyncio.to_thread(feed.gate.observe, frame, not feed.busy)
        feed.retry = feed.retry or force
        skip = (
            "closed"
            if feed.closed
            else "busy" if feed.busy else None if gate.send or feed.retry else "gate"
        )
        logger.debug(
            "session={} frame gate={} streak={} {}",
            session_id,
            gate.verdict,
            gate.streak,
            f"skipped: {skip}" if skip else "-> model",
        )
        if skip:
            return _status(feed, gate, None)
        feed.retry = False
        feed.busy = True
        call_id = secrets.token_hex(8)
        feed.task = asyncio.create_task(
            perceive(feed, session_id, call_id, jpeg, perception, convex, notifier)
        )
        return _status(feed, gate, call_id)


async def perceive(
    feed: Feed,
    session_id: str,
    call_id: str,
    jpeg: bytes,
    perception: Perception,
    convex: Convex,
    notifier: Notifier,
) -> None:
    """Background: ask the model, update the trackers, record the answer. Never raises."""
    try:
        await _observe(feed, session_id, call_id, jpeg, perception, convex, notifier)
    except (PerceptionError, ConvexError) as e:
        # Not resubmitted: the next frame makes a fresh model call, so a record that
        # committed but whose response was lost cannot be applied twice.
        feed.retry = True
        logger.warning("session={} model call failed: {}", session_id, e)
    finally:
        feed.busy = False


async def _notify(
    notifier: Notifier,
    session_id: str,
    watch: Watch,
    event: Event,
    chat_id: Optional[int],
) -> None:
    try:
        await notifier.notify(session_id, watch, event, chat_id)
    except Exception:
        logger.exception("session={} notification failed", session_id)


async def _observe(
    feed: Feed,
    session_id: str,
    call_id: str,
    jpeg: bytes,
    perception: Perception,
    convex: Convex,
    notifier: Notifier,
) -> None:
    view = await convex.query("sessions:live", sessionId=session_id)
    if view is None or view["status"] != "active":
        feed.closed = True
        logger.info("session={} closed: no more model calls", session_id)
        return
    stored = view["watches"]  # a snapshot: edits race, worker:record ignores stale ids
    detection = await perception.detect(jpeg, [w["predicate"] for w in stored])
    results, fired = [], []
    for w, observation in zip(stored, detection.observations):
        tracker = Tracker(w["direction"])
        tracker.state = w["state"]  # with persist=1 this is the whole tracker state
        result: dict = {
            "watchId": w["id"],
            "state": observation.state,
            "evidence": observation.evidence,
        }
        results.append(result)
        if not tracker.update(observation.state):
            continue
        became = "true" if w["direction"] == "rising" else "false"
        text = f"{w['predicate']} - became {became}"
        result["event"] = {"text": text}
        watch = Watch(
            w["rule"], w["predicate"], w["direction"], tracker, observation.evidence
        )
        fired.append((w["id"], watch, text))
    # The next frame may no longer show what the model just saw, so a failed save is
    # retried with this very answer; callId keeps a repeat from being recorded twice.
    # The frame itself is never stored: it goes to Telegram from memory, and the page
    # that sent it keeps its own copy.
    for attempt in range(1, SAVE_ATTEMPTS + 1):
        try:
            recorded = await convex.mutation(
                "worker:record",
                sessionId=session_id,
                callId=call_id,
                usage=detection.usage.wire(),
                results=results,
            )
            break
        except ConvexError as e:
            if attempt == SAVE_ATTEMPTS:
                raise
            logger.warning("session={} save failed, retrying: {}", session_id, e)
            await asyncio.sleep(SAVE_BACKOFF * attempt)
    # A rule dropped or edited while the model was thinking left no event: no alert either.
    fired = [f for f in fired if f[0] in recorded["watchIds"]]
    logger.info(
        "session={} usage +{} fired={} chat={}",
        session_id,
        detection.usage,
        [w.rule for _, w, _ in fired],
        recorded["chatId"] is not None,
    )
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for _, w, text in fired:
        event = Event(0, at, text, jpeg, w.rule)
        task = asyncio.create_task(
            _notify(notifier, session_id, w, event, recorded["chatId"])
        )
        feed.notifications.add(task)
        task.add_done_callback(feed.notifications.discard)
