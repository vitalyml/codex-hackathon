"""Dict-backed stand-in for src.server.convex_client.Convex: the two functions the engine
calls, behaving like convex/sessions.ts `live` and convex/worker.ts `record`."""

import copy

from src.server.convex_client import ConvexError


class FakeConvex:
    def __init__(self) -> None:
        self.sessions: dict[str, dict] = {}
        self.subscribers: dict[str, dict] = {}  # token -> subscribers:get view
        self.events: list[dict] = []
        self.usage: list[dict] = []
        self.chat_id = None
        self.down = False
        self.lose_responses = 0  # record commits, then the response is "lost"
        self.kept: dict[str, list[str]] = {}  # callId -> watches whose events were kept

    def add(self, session_id: str, *watches: tuple[str, str, str]) -> dict:
        """watches: (rule, predicate, direction)."""
        self.sessions[session_id] = {
            "status": "active",
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
        if self.down:
            raise ConvexError("down")
        if path == "subscribers:get":
            return copy.deepcopy(self.subscribers.get(args["token"]))
        assert path == "sessions:live", path
        return copy.deepcopy(self.sessions.get(args["sessionId"]))

    async def mutation(self, path: str, **args):
        assert path == "worker:record", path
        if self.down:
            raise ConvexError("down")
        session = self.sessions[args["sessionId"]]
        if args["callId"] in self.kept:
            return {"chatId": self.chat_id, "watchIds": self.kept[args["callId"]]}
        kept = self.kept.setdefault(args["callId"], [])
        self.usage.append(args["usage"])
        live = {w["id"]: w for w in session["watches"]}
        for r in args["results"]:
            watch = live.get(r["watchId"])
            if watch is None or session["status"] != "active":
                continue
            watch.update(state=r["state"], evidence=r["evidence"])
            if "event" in r:
                self.events.append(
                    {"rule": watch["rule"], "callId": args["callId"], **r["event"]}
                )
                kept.append(watch["id"])
        if self.lose_responses:
            self.lose_responses -= 1
            raise ConvexError("response lost")
        return {"chatId": self.chat_id, "watchIds": kept}

    async def aclose(self) -> None:
        pass
