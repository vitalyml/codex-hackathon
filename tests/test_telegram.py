import asyncio
import copy
from unittest.mock import AsyncMock

import httpx

from src.server.cv.perception import PerceptionError, Rule
from src.server.session import Event, Feeds, Watch
from src.server.telegram import notifier
from src.server.telegram.bot import Bot
from src.server.telegram.notifier import Telegram, TelegramNotifier, handle, respond
from src.server.tracker import Tracker

TOKEN = "sub1"  # the subscriber id the page keeps and the QR carries
SESSION = "s1"


class FakeConvex:
    """The worker:* Telegram functions and watches:remove of convex/, over dicts."""

    def __init__(self) -> None:
        self.subscribers = {TOKEN: {"chatId": None, "muted": False}}
        self.session: dict | None = None  # the active session of TOKEN
        self.saved: list[dict] = []  # every event of the session
        self.billed = 0
        self.ids = 0

    def start(self, *rules: str) -> dict:
        self.session = {"id": SESSION, "watches": [], "eventCount": 0, "events": []}
        for rule in rules:
            self._insert(rule)
        return self.session

    def _insert(self, rule: str, at: int | None = None) -> None:
        self.ids += 1
        watch = {"id": f"w{self.ids}", "rule": rule, "state": None, "evidence": ""}
        watches = self.session["watches"]
        watches.insert(len(watches) if at is None else at, watch)

    async def query(self, path: str, **args):
        sub = next(
            (s for s in self.subscribers.values() if s["chatId"] == args["chatId"]),
            None,
        )
        if path == "worker:event":  # by id among every saved event, not the listed five
            saved = self.saved if sub and self.session else []
            return next((e for e in saved if e["id"] == args["eventId"]), None)
        assert path == "worker:telegram", path
        # a snapshot, like a real query result
        return sub and {"muted": sub["muted"], "session": copy.deepcopy(self.session)}

    async def mutation(self, path: str, **args):
        bound = [
            s for s in self.subscribers.values() if s["chatId"] == args.get("chatId")
        ]
        if path == "worker:link":
            if args["token"] not in self.subscribers:
                return False
            for s in bound:
                s["chatId"] = None
            self.subscribers[args["token"]]["chatId"] = args["chatId"]
            return True
        if path == "worker:mute":
            for s in bound:
                s["muted"] = args["muted"]
        elif path == "worker:unlink":
            for s in bound:
                s["chatId"] = None
        elif path == "watches:remove":
            watches = self.session["watches"]
            if len(watches) == 1:
                return {"error": "last_rule"}
            watches[:] = [w for w in watches if w["id"] != args["watchId"]]
        elif path == "worker:putWatch":
            self.billed += 1
            watches = self.session["watches"]
            if "replaces" in args:
                i = next(
                    (i for i, w in enumerate(watches) if w["id"] == args["replaces"]),
                    None,
                )
                if i is None:
                    return {"error": "no_watch"}
                del watches[i]
                self._insert(args["watch"]["rule"], i)
            else:
                self._insert(args["watch"]["rule"])
        else:
            raise AssertionError(path)
        return None

    async def download(self, url: str) -> bytes:
        return url.encode()


def make_bot(calls: list) -> Bot:
    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"ok": True, "result": {"username": "cam_bot"}})

    bot = Bot("token")
    bot.client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://api.telegram.org/bottoken",
    )
    return bot


def msg(text: str, chat_id: int = 42) -> dict:
    return {"update_id": 1, "message": {"text": text, "chat": {"id": chat_id}}}


def press(data: str, chat_id: int = 42) -> dict:
    return {
        "update_id": 2,
        "callback_query": {
            "id": "cb1",
            "data": data,
            "message": {"chat": {"id": chat_id}},
        },
    }


def connected(bot=None, perception=None) -> tuple[Telegram, FakeConvex]:
    convex = FakeConvex()
    convex.subscribers[TOKEN]["chatId"] = 42
    convex.start("cat arrives")
    return (
        Telegram(bot or AsyncMock(), convex, Feeds(), perception or AsyncMock()),
        convex,
    )


def rules(convex: FakeConvex) -> list[str]:
    return [w["rule"] for w in convex.session["watches"]]


async def test_link_status_pause_disconnect():
    convex = FakeConvex()
    tg = Telegram(AsyncMock(), convex, Feeds(), AsyncMock())
    assert await handle(tg, msg("hello")) is None
    assert (await handle(tg, msg("/start"))).text.startswith("👋")
    assert (await handle(tg, msg("/start nope"))).text.startswith("⌛")
    assert (await handle(tg, msg("/status"))).text.startswith("🔗")  # not linked yet

    # Binding happens before any rule exists - that is the point of the subscriber.
    r = await handle(tg, msg(f"/start {TOKEN}"))
    assert convex.subscribers[TOKEN]["chatId"] == 42 and r.buttons
    assert (await handle(tg, press("status"))).text.startswith("📷")

    # The watch this browser starts later is picked up without a second scan.
    convex.start("the cat <jumps> onto the table")["watches"][0][
        "evidence"
    ] = "cat on chair"
    r = await handle(tg, press("status"))
    assert (
        r.callback_id == "cb1"
        and "&lt;jumps&gt;" in r.text  # html-escaped
        and "⏳ still looking" in r.text
        and "cat on chair" in r.text
    )
    # A group chat can neither bind nor control the camera.
    group = msg(f"/start {TOKEN}", -1)
    group["message"]["chat"]["type"] = "group"
    assert (await handle(tg, group)).text.startswith("🔒")
    assert convex.subscribers[TOKEN]["chatId"] == 42

    assert (await handle(tg, press("stop"))).text.startswith("🔕")
    assert convex.subscribers[TOKEN] == {"chatId": 42, "muted": True}
    await handle(tg, press("disconnect"))
    assert convex.subscribers[TOKEN]["chatId"] == 42  # asks first
    await handle(tg, press("confirm_disconnect"))
    assert convex.subscribers[TOKEN]["chatId"] is None
    assert (await handle(tg, press("status"))).text.startswith("🔗")


async def test_notify_sends_photo_only_to_the_chat_record_named():
    calls: list = []
    bot = make_bot(calls)
    assert await bot.get_me() == "cam_bot"
    assert bot.deep_link(TOKEN) == f"https://t.me/cam_bot?start={TOKEN}"
    assert bot.qr_svg(TOKEN).startswith(b"<?xml")
    calls.clear()
    watch = Watch("x happens", "x", "rising", Tracker("rising"))
    event = Event(0, "2026-09-12T14:32:10+00:00", "x - became true", b"jpg")
    await TelegramNotifier(bot).notify(SESSION, watch, event, None)
    assert calls == []  # not linked or alerts paused: log only
    await TelegramNotifier(bot).notify(SESSION, watch, event, 42)
    assert calls[0].url.path.endswith("/sendPhoto")
    body = calls[0].content
    assert (
        b'name="chat_id"\r\n\r\n42' in body
        and b"14:32:10 UTC" in body
        and b"jpg" in body
        and b"inline_keyboard" in body
    )
    await bot.aclose()


async def test_rules_add_edit_drop_and_rejected_rules():
    perception = AsyncMock()
    perception.normalize.return_value = Rule("door open", "rising")
    tg, convex = connected(perception=perception)
    feed = tg.feeds.add(SESSION)
    r = await handle(tg, press("rules"))
    assert r.buttons[:2] == [
        [("✏️ 01", "edit:w1"), ("🗑 01", "drop:w1")],
        [("➕ Add rule", "add")],
    ]
    # Add: typed as a plain message after the button; the model is asked again.
    await handle(tg, press("add"))
    await respond(tg, msg("The door opens"))
    assert rules(convex) == ["cat arrives", "The door opens"]
    assert feed.retry and 42 not in tg.editing and convex.billed == 1
    # Edit replaces in place under a new id; the other watch is untouched.
    await handle(tg, press("edit:w1"))
    await respond(tg, msg("Cat leaves"))
    assert rules(convex) == ["Cat leaves", "The door opens"]
    assert (await handle(tg, press("edit:w1"))).text.startswith("⌛")  # the old id
    # Drop: never below one rule.
    await handle(tg, press("drop:w2"))
    assert rules(convex) == ["Cat leaves"]
    assert "Keep at least one" in (await handle(tg, press("drop:w3"))).text
    # The model is down: nothing billed, rules kept, entry stays open.
    await handle(tg, press("add"))
    perception.normalize.side_effect = PerceptionError("unavailable")
    await respond(tg, msg("door opens"))
    assert rules(convex) == ["Cat leaves"] and tg.editing[42] == "add"
    assert convex.billed == 2
    # Navigating away cancels rule entry: the next message is just chatter.
    await handle(tg, press("events"))
    await respond(tg, msg("door opens"))
    assert 42 not in tg.editing and perception.normalize.await_count == 3


async def test_snapshot_waits_for_a_fresh_frame_and_never_sends_a_stale_one(
    monkeypatch,
):
    bot = AsyncMock()
    tg, _ = connected(bot)
    monkeypatch.setattr(notifier, "SNAPSHOT_TIMEOUT", 0.001)
    await respond(tg, press("snapshot"))  # no feed: the page is not sending frames
    bot.send_photo.assert_not_awaited()
    assert "isn't sending frames" in bot.send_message.call_args.args[1]

    monkeypatch.setattr(notifier, "SNAPSHOT_TIMEOUT", 8)
    feed = tg.feeds.add(SESSION)
    feed.latest_frame = b"old event photo"
    feed.frame_received.set()
    task = asyncio.create_task(respond(tg, press("snapshot")))
    for _ in range(5):
        await asyncio.sleep(0)
    bot.send_photo.assert_not_awaited()
    assert not feed.frame_received.is_set()
    feed.latest_frame = b"fresh camera frame"
    feed.frame_at = "2026-09-12T15:00:01+00:00"
    feed.frame_received.set()
    await task
    assert bot.send_photo.call_args.args[1] == b"fresh camera frame"
    assert "15:00:01 UTC" in bot.send_photo.call_args.args[2]


async def test_menu_edits_the_message_and_event_photos_are_scoped_to_the_chat():
    bot = AsyncMock()
    tg, convex = connected(bot)
    # e1 is saved but no longer among the listed five: its button must still work
    convex.saved = [dict(id="e1", at=1789223530000, text="<cat>", rule="", url="jpg")]
    update = press("menu")
    update["callback_query"]["message"].update(message_id=10, text="Dashboard")
    await respond(tg, update)
    bot.edit_message.assert_awaited_once()
    bot.send_message.assert_not_awaited()
    r = await handle(tg, press("event:e1"))
    assert r.image == b"jpg" and "&lt;cat&gt;" in r.text
    assert (await handle(tg, press("event:other"))).image is None
    assert (await handle(tg, press("event:e1", 99))).image is None  # another chat


async def test_edit_message_handles_unchanged_screen_but_preserves_api_errors():
    import json

    import pytest

    requests = []
    description = "Bad Request: message is not modified"

    async def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(400, json={"ok": False, "description": description})

    bot = Bot("token")
    await bot.client.aclose()
    bot.client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://api.telegram.org/bottoken",
    )
    await bot.edit_message(42, 10, "Dashboard", [[("Refresh", "menu")]])
    assert requests[0]["message_id"] == 10
    assert (
        requests[0]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == "menu"
    )
    description = "Bad Request: message can't be edited"
    with pytest.raises(httpx.HTTPStatusError):
        await bot.edit_message(42, 10, "Dashboard")
    await bot.aclose()
