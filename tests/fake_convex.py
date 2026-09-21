"""Dict-backed stand-in for src.server.convex_client.Convex: the two functions the engine
calls, behaving like convex/sessions.ts `live` and convex/worker.ts `record`."""

import copy

from src.server.convex_client import ConvexError

FOREVER = 2**62


class FakeConvex:
    def __init__(self) -> None:
        self.sessions: dict[str, dict] = {}
        self.events: list[dict] = []
        self.photos: list[bytes] = []
        self.usage: list[dict] = []
        self.chat_id = None
        self.down = False

    def add(self, session_id: str, *watches: tuple[str, str, str]) -> dict:
        """watches: (rule, predicate, direction)."""
        self.sessions[session_id] = {
            "status": "active",
            "limitAt": FOREVER,
            "watches": [
                dict(
                    id=f"{session_id}-w{i}",
                    rule=rule,
                    predicate=predicate,
                    direction=direction,
                    state=None,
                    evidence="",
                )
                for i, (rule, predicate, direction) in enumerate(watches)
            ],
        }
        return self.sessions[session_id]

    async def query(self, path: str, **args):
        assert path == "sessions:live", path
        if self.down:
            raise ConvexError("down")
        return copy.deepcopy(self.sessions.get(args["sessionId"]))

    async def upload(self, jpeg: bytes) -> str:
        self.photos.append(jpeg)
        return f"photo{len(self.photos)}"

    async def mutation(self, path: str, **args):
        assert path == "worker:record", path
        if self.down:
            raise ConvexError("down")
        session = self.sessions[args["sessionId"]]
        self.usage.append(args["usage"])
        live = {w["id"]: w for w in session["watches"]}
        for r in args["results"]:
            watch = live.get(r["watchId"])
            if watch is None or session["status"] != "active":
                continue
            watch.update(state=r["state"], evidence=r["evidence"])
            if "event" in r:
                self.events.append({"rule": watch["rule"], **r["event"]})
        return {"chatId": self.chat_id}

    async def aclose(self) -> None:
        pass
