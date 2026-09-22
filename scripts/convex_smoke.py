"""Smoke test against the Convex dev deployment: a session from start to stop, driven
the way the page and the Telegram bot drive it. Needs CONVEX_URL and WORKER_SECRET in
.env, and a worker reachable at the deployment's WORKER_URL (sessions:start calls it,
which costs one model call).

    poetry run python scripts/convex_smoke.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import config  # noqa: E402
from src.server.convex_client import Convex  # noqa: E402

CHAT = -424242  # no real Telegram chat has a negative private id
USAGE = {"prompt": 0, "completion": 0, "calls": 0, "usdTicks": 0}


def spec(rule: str) -> dict:
    return {"rule": rule, "predicate": rule, "direction": "rising"}


async def main() -> None:
    convex = Convex(config.CONVEX_URL, config.WORKER_SECRET)
    token = await convex.mutation("subscribers:create")
    started = await convex._call(
        "action", "sessions:start", {"rules": ["a person appears"], "subscriber": token}
    )
    session = started["sessionId"]  # KeyError: the action failed, the dict says why
    try:
        assert await convex.query("worker:telegram", chatId=CHAT) is None
        assert not await convex.mutation("worker:link", chatId=CHAT, token="nope")
        assert await convex.mutation("worker:link", chatId=CHAT, token=token)
        view = await convex.query("worker:telegram", chatId=CHAT)
        assert view["session"]["id"] == session and not view["muted"], view
        [first] = view["session"]["watches"]

        put = {"sessionId": session, "usage": USAGE}
        assert await convex.mutation("worker:putWatch", **put, watch=spec("b")) is None
        edited = await convex.mutation(
            "worker:putWatch", **put, watch=spec("a2"), replaces=first["id"]
        )
        assert edited is None, edited
        stale = await convex.mutation(
            "worker:putWatch", **put, watch=spec("a3"), replaces=first["id"]
        )
        assert stale == {"error": "no_watch"}, stale
        view = await convex.query("worker:telegram", chatId=CHAT)
        watches = view["session"]["watches"]
        assert [w["rule"] for w in watches] == ["a2", "b"], watches  # edited in place

        # One answer for two rules, one of them edited away meanwhile: only the live
        # one is kept and alerted, and a retry of the same call says the same.
        photo = await convex.upload(b"jpg")
        answer = {"state": True, "evidence": "seen"}
        fired = {**answer, "event": {"text": "fired", "storageId": photo}}
        results = [
            {"watchId": first["id"], **fired},
            {"watchId": watches[0]["id"], **fired},
        ]
        call = {"sessionId": session, "callId": "smoke", "usage": USAGE}
        for _ in range(2):
            recorded = await convex.mutation("worker:record", **call, results=results)
            assert recorded == {
                "chatId": CHAT,
                "watchIds": [watches[0]["id"]],
            }, recorded
        [event] = (await convex.query("worker:telegram", chatId=CHAT))["session"][
            "events"
        ]
        args = {"eventId": event["id"]}
        assert (await convex.query("worker:event", chatId=CHAT, **args))["url"]
        assert await convex.query("worker:event", chatId=CHAT + 1, **args) is None
        assert await convex.query("worker:event", chatId=CHAT, eventId="nope") is None

        assert await convex.mutation("watches:remove", watchId=watches[1]["id"]) is None
        last = await convex.mutation("watches:remove", watchId=watches[0]["id"])
        assert last and last["error"] == "last_rule", last

        await convex.mutation("worker:mute", chatId=CHAT, muted=True)
        assert (await convex.query("worker:telegram", chatId=CHAT))["muted"]
        live = await convex.query("sessions:live", sessionId=session)
        assert live["telegram"] and live["status"] == "active", live
    finally:
        await convex.mutation("worker:unlink", chatId=CHAT)
        await convex.mutation("sessions:stop", sessionId=session)
    assert await convex.query("worker:telegram", chatId=CHAT) is None
    # A stop schedules the deletion of the session with its photos.
    for _ in range(20):
        if await convex.query("sessions:live", sessionId=session) is None:
            break
        await asyncio.sleep(0.5)
    assert await convex.query("sessions:live", sessionId=session) is None
    assert await convex.query("worker:event", chatId=CHAT, **args) is None
    await convex.aclose()
    print("convex smoke: ok")  # a script's result, not application logging


asyncio.run(main())
