"""Camera control panel, event cards and Telegram update delivery."""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html import escape
from typing import Optional

import httpx
from loguru import logger

from src.config import MAX_WATCHES
from src.server.convex_client import Convex, ConvexError
from src.server.cv.perception import Perception, PerceptionError
from src.server.notifier import Notifier
from src.server.session import Event, Feed, Feeds, Watch
from src.server.telegram.bot import Bot, Buttons

COMMANDS = {
    "menu": "Open your camera dashboard",
    "snapshot": "Take a photo right now",
    "rules": "Add, edit or remove what to watch for",
    "events": "Browse recent moments",
    "pause": "Pause alerts, keep watching",
    "resume": "Turn alerts back on",
    "help": "How it works",
}
SNAPSHOT_TIMEOUT = 8
BACK: Buttons = [[("‹ Dashboard", "menu")]]
WELCOME = (
    "👋 <b>Camera Events</b>\n<i>Be there. From anywhere.</i>\n\n"
    "Your camera watches. You get the moments that matter.\n\n"
    "<b>Get connected</b>\n"
    "① Open the camera page in your browser.\n"
    "② Scan its Telegram QR code.\n"
    "③ Start watching for something that happens.\n\n"
    "Then take a fresh snapshot, manage your rules, and explore events — right here."
)
GONE = (
    "⌛ <b>This link has expired</b>\nReload the camera page and scan its new QR code."
)
NOT_LINKED = (
    "🔗 <b>Connect your camera</b>\nOpen the camera page and scan its Telegram QR code."
)
NO_WATCH = "📷 <b>Your camera is connected</b>\n\nStart a watch on the camera page to unlock snapshots and remote controls."
HELP = (
    "✦ <b>Your camera, within reach</b>\n\n"
    "📸 <b>Snapshot</b> · A new frame, captured after you tap.\n"
    f"✏️ <b>Rules</b> · Up to {MAX_WATCHES} things to watch for at once. Add, edit or remove any.\n"
    "🗂 <b>Recent events</b> · Revisit moments with photo evidence.\n"
    "🔕 <b>Pause alerts</b> · Keep watching without messages. Resume anytime.\n\n"
    "<b>Keep the camera page open</b>\nYour browser supplies the video. If it stops sending frames, snapshots are unavailable.\n\n"
    "Times are in UTC."
)


def safe(text: str, limit: int = 500) -> str:
    return escape(text if len(text) <= limit else text[: limit - 1] + "…")


@dataclass
class Telegram:
    """What the bot works with. Chats, rules and events live in Convex (`worker:telegram`
    is one read per interaction); `editing` is the only state kept here, and it is safe
    to lose: a restart just asks the user to tap Add or Edit again."""

    bot: Bot
    convex: Convex
    feeds: Feeds
    perception: Perception
    # chat id -> rule entry in progress: "add" | "edit:<watch id>"
    editing: dict[int, str] = field(default_factory=dict)


def menu(muted: bool) -> Buttons:
    return [
        [("📸  Snapshot now", "snapshot")],
        [("✏️ Rules", "rules"), ("🗂 Recent events", "events")],
        [
            (("🔔 Resume alerts", "resume") if muted else ("🔕 Pause alerts", "pause")),
            ("↻ Refresh", "menu"),
        ],
        [("How it works", "help"), ("Disconnect", "disconnect")],
    ]


@dataclass
class Reply:
    chat_id: int
    text: str
    buttons: Optional[Buttons] = None
    callback_id: Optional[str] = None
    image: Optional[bytes] = None


def _at(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds")


def _state(w: dict) -> str:
    if w["state"] is None:
        return "⏳ still looking"
    return "✅ True now" if w["state"] else "○ False now"


def _watch_lines(s: dict) -> str:
    return "\n".join(
        f"<b>{i + 1:02d}</b> · {safe(w['rule'], 250)}\n"
        f"{_state(w)} · <i>{safe(w['evidence'], 200) if w['evidence'] else 'waiting for the first observation…'}</i>"
        for i, w in enumerate(s["watches"])
    )


def status_text(s: dict, muted: bool, feed: Optional[Feed]) -> str:
    age = (
        (
            datetime.now(timezone.utc) - datetime.fromisoformat(feed.frame_at)
        ).total_seconds()
        if feed and feed.frame_at
        else None
    )
    connection = (
        "🟢 Receiving frames"
        if age is not None and age < 15
        else "🟠 Waiting for camera"
    )
    return (
        "📷 <b>CAMERA EVENTS</b>\n<i>Your eyes on what matters.</i>\n\n"
        f"{connection}  ·  {'🔕 Alerts paused' if muted else '🔔 Alerts on'}\n\n"
        f"<b>WATCHING FOR</b>\n{_watch_lines(s)}\n\n"
        f"<b>{s['eventCount']}</b> events\n"
        "<i>Take a look, or adjust your rules below.</i>"
    )


def rules_screen(s: dict) -> tuple[str, Buttons]:
    watches = s["watches"]
    text = (
        f"✏️ <b>YOUR RULES</b>\n<i>{len(watches)} of {MAX_WATCHES} · tap to edit or remove</i>\n\n"
        + _watch_lines(s)
    )
    buttons: Buttons = [
        [(f"✏️ {i + 1:02d}", f"edit:{w['id']}"), (f"🗑 {i + 1:02d}", f"drop:{w['id']}")]
        for i, w in enumerate(watches)
    ]
    if len(watches) < MAX_WATCHES:
        buttons.append([("➕ Add rule", "add")])
    return text, buttons + BACK


def _watch_index(session: Optional[dict], command: str) -> Optional[int]:
    """Parse 'edit:<watch id>' / 'drop:<watch id>'; None unless it names a live watch.
    Ids, not positions: a button from an old screen cannot hit a different rule."""
    if session is None:
        return None
    watch_id = command.partition(":")[2]
    return next(
        (i for i, w in enumerate(session["watches"]) if w["id"] == watch_id), None
    )


def caption(w: Watch, event: Event) -> str:
    return (
        "🔔 <b>MOMENT DETECTED</b>\n\n"
        f"<blockquote>{safe(w.rule, 250)}</blockquote>\n"
        f"{safe(w.evidence or event.text, 450)}\n\n"
        f"<i>{event.at[:10]} · {event.at[11:19]} UTC</i>"
    )


async def _view(tg: Telegram, chat_id: int) -> Optional[dict]:
    """None: the chat is not linked. Otherwise {muted, session: None | {...}}."""
    view: Optional[dict] = await tg.convex.query("worker:telegram", chatId=chat_id)
    return view


def _rules_changed(tg: Telegram, session: dict) -> None:
    feed = tg.feeds.get(session["id"])
    if feed is not None:
        feed.retry = True  # ask the model again even if the scene is quiet


async def handle(tg: Telegram, update: dict) -> Optional[Reply]:
    callback = update.get("callback_query") or {}
    message = callback.get("message") or update.get("message") or {}
    chat = message.get("chat") or {}
    if "id" not in chat:
        return None
    chat_id = chat["id"]
    # Camera controls belong in the private chat used by the QR link.
    if chat.get("type", "private") != "private":
        return Reply(
            chat_id,
            "🔒 Open a private chat with me to connect and control your camera.",
            callback_id=callback.get("id"),
        )
    text = message.get("text") or ""
    if callback:
        command, arg = callback.get("data", ""), ""
    elif text.startswith("/"):
        command, _, arg = text[1:].partition(" ")
        command = command.split("@")[0].lower()
    else:
        return None
    if command == "start" and arg.strip():
        if not await tg.convex.mutation(
            "worker:link", chatId=chat_id, token=arg.strip()
        ):
            return Reply(chat_id, GONE)
        tg.editing.pop(chat_id, None)
    view = await _view(tg, chat_id)
    if command in {"help", "start"} and view is None:
        return Reply(chat_id, WELCOME, [[("How it works", "help_details")]])
    if command != "add" and not command.startswith("edit:"):
        tg.editing.pop(chat_id, None)
    if command in {"help", "help_details"}:
        return Reply(chat_id, HELP, BACK if view else None, callback.get("id"))
    if view is None:
        return Reply(chat_id, NOT_LINKED, callback_id=callback.get("id"))
    muted: bool = view["muted"]
    session: Optional[dict] = view["session"]
    result = Reply(chat_id, "", menu(muted), callback.get("id"))
    if (
        session
        and session.get("encrypted")
        and (
            command in {"rules", "rule", "add"}
            or command.startswith(("edit:", "drop:"))
        )
    ):
        tg.editing.pop(chat_id, None)
        result.text = "🔒 Edit protected rules in the camera browser. The recovery key stays on your device."
        return result
    if command in {"menu", "status", "start", "cancel"}:
        result.text = (
            status_text(session, muted, tg.feeds.get(session["id"]))
            if session
            else NO_WATCH
        )
    elif command in {"pause", "stop", "resume"}:
        muted = command != "resume"
        await tg.convex.mutation("worker:mute", chatId=chat_id, muted=muted)
        result.text = (
            "🔕 <b>Alerts paused</b>\n\nYour camera keeps watching and saving events.\nTap <b>Resume alerts</b> whenever you're ready."
            if muted
            else "🔔 <b>You're back on watch</b>\n\nNew moments will arrive here as they happen."
        )
        result.buttons = menu(muted)
    elif command == "disconnect":
        result.text = "🔗 <b>Disconnect this camera?</b>\n\nYou'll need to scan its QR code again to reconnect. To silence alerts, use Pause instead."
        result.buttons = [
            [("Disconnect camera", "confirm_disconnect")],
            [("Keep connected", "menu")],
        ]
    elif command == "confirm_disconnect":
        await tg.convex.mutation("worker:unlink", chatId=chat_id)
        result.text = "🔗 <b>Camera disconnected</b>\nScan the QR code on your camera page to reconnect."
        result.buttons = None
    elif command in {"rules", "rule"}:
        if session is None:
            result.text = NO_WATCH
        else:
            result.text, result.buttons = rules_screen(session)
    elif command == "add":
        if session is None:
            result.text = NO_WATCH
        elif len(session["watches"]) >= MAX_WATCHES:
            result.text = f"✏️ <b>Rule limit reached</b>\n\nUp to {MAX_WATCHES} rules per camera. Remove one to add another."
            result.buttons = [[("‹ Rules", "rules")]]
        else:
            tg.editing[chat_id] = "add"
            result.text = (
                "➕ <b>What else should I watch for?</b>\n\n"
                "Send the new rule as a message. Describe a change, for example:\n\n"
                "<i>Someone enters the room</i>\n<i>The cat jumps onto the table</i>\n<i>The door opens</i>\n\n"
                "Your current rules keep running meanwhile."
            )
            result.buttons = [[("Cancel", "rules")]]
    elif command.startswith("edit:"):
        i = _watch_index(session, command)
        if session is None or i is None:
            result.text = "⌛ <b>This rule is no longer there</b>\nOpen Rules to see the current list."
            result.buttons = [[("‹ Rules", "rules")]]
        else:
            tg.editing[chat_id] = f"edit:{session['watches'][i]['id']}"
            result.text = (
                f"✏️ <b>Edit rule {i + 1:02d}</b>\n\n"
                f"<b>Now</b>\n<blockquote>{safe(session['watches'][i]['rule'])}</blockquote>\n"
                "Send the new wording as a message. It replaces this rule; its state starts over.\n\n"
                "The current rule keeps running until the new one is ready."
            )
            result.buttons = [[("Cancel", "rules")]]
    elif command.startswith("drop:"):
        i = _watch_index(session, command)
        if session is None or i is None:
            result.text = "⌛ <b>This rule is no longer there</b>\nOpen Rules to see the current list."
            result.buttons = [[("‹ Rules", "rules")]]
        # The page's own mutation: it refuses to go below one rule, atomically.
        elif await tg.convex.mutation(
            "watches:remove", watchId=session["watches"][i]["id"]
        ):
            result.text = "✏️ <b>Keep at least one rule</b>\n\nAdd another before removing this one, or stop the watch on the camera page."
            result.buttons = [[("‹ Rules", "rules")]]
        else:
            dropped = session["watches"].pop(i)
            _rules_changed(tg, session)
            result.text, result.buttons = rules_screen(session)
            result.text = (
                f"🗑 <b>Removed</b> · {safe(dropped['rule'], 200)}\n\n" + result.text
            )
    elif command == "events":
        if session is None or not session["events"]:
            result.text = "🗂 <b>The best moments go here</b>\n\nNo events yet. When your rule triggers, you'll find it here with its time."
            result.buttons = BACK
        else:
            recent = session["events"]  # the latest five, newest first
            # Text only: the photo was sent when the event fired and is nowhere else.
            result.text = (
                "🗂 <b>RECENT MOMENTS</b>\n<i>Latest five events · the photos are in the alerts above</i>\n\n"
                + "\n\n".join(
                    f"<b>{e['n'] + 1:02d}</b> · {_at(e['at'])[11:19]} UTC\n{safe(e['rule'] or e['text'], 180)}"
                    for e in recent
                )
            )
            result.buttons = BACK
    elif command == "snapshot":
        result.text = (
            NO_WATCH if session is None else "📸 <b>Waiting for a fresh frame…</b>"
        )
    else:
        result.text = "✦ <b>Your camera controls are below</b>\nTo change what I watch for, open <b>Rules</b> first."
    return result


async def _enter_rule(tg: Telegram, chat_id: int, text: str, mode: str) -> Reply:
    """A rule typed in the chat: normalize it here, insert it in Convex. `mode` is
    "add" or "edit:<watch id>"."""
    rule = text.partition(" ")[2].strip() if text.startswith("/") else text
    view = await _view(tg, chat_id)
    session = view and view["session"]
    if not view or not session:
        return Reply(chat_id, NO_WATCH, BACK)
    if session.get("encrypted"):
        tg.editing.pop(chat_id, None)
        return Reply(
            chat_id,
            "🔒 Edit protected rules in the camera browser. The recovery key stays on your device.",
            BACK,
        )
    if not rule or len(rule) > 500:
        return Reply(
            chat_id,
            "✏️ Please send a rule between 1 and 500 characters.",
            [[("Cancel", "cancel")]],
        )
    await tg.bot.chat_action(chat_id, "typing")
    try:
        spec = await tg.perception.normalize(rule)
    except PerceptionError:
        return Reply(
            chat_id,
            "⚠️ <b>Couldn't understand that rule</b>\nYour current rules are still running. Please try again.",
            [[("Cancel", "rules")]],
        )
    # One mutation bills the call and changes the rules, and refuses if the session
    # stopped, the limit is reached or the edited rule is gone meanwhile.
    args: dict = {
        "sessionId": session["id"],
        "usage": spec.usage.wire(),
        "watch": {
            "rule": rule,
            "predicate": spec.predicate,
            "direction": spec.direction,
        },
    }
    if mode != "add":
        args["replaces"] = mode.partition(":")[2]
    failed = await tg.convex.mutation("worker:putWatch", **args)
    if failed and failed["error"] == "no_session":
        return Reply(
            chat_id,
            "⌛ Your camera session changed. Open the dashboard and try again.",
            BACK,
        )
    tg.editing.pop(chat_id, None)
    if failed:
        return Reply(
            chat_id,
            "⌛ <b>Your rules changed meanwhile</b>\nOpen Rules and try again.",
            [[("‹ Rules", "rules")]],
        )
    _rules_changed(tg, session)
    view = await _view(tg, chat_id) or view
    session = view["session"] or session
    return Reply(
        chat_id,
        ("➕ <b>Rule added</b>" if mode == "add" else "✅ <b>Rule updated</b>")
        + "\n\n"
        + status_text(session, view["muted"], tg.feeds.get(session["id"])),
        menu(view["muted"]),
    )


async def _snapshot(tg: Telegram, chat_id: int) -> Optional[Reply]:
    """None: not linked or no watch - handle() already said so."""
    view = await _view(tg, chat_id)
    session = view and view["session"]
    if not session:
        return None
    await tg.bot.chat_action(chat_id, "upload_photo")
    feed = tg.feeds.get(session["id"])
    try:
        if feed is None:  # no frame since the worker started or for FEED_TTL
            raise asyncio.TimeoutError
        feed.frame_received.clear()
        await asyncio.wait_for(feed.frame_received.wait(), timeout=SNAPSHOT_TIMEOUT)
    except asyncio.TimeoutError:
        return Reply(
            chat_id,
            "🟠 <b>Camera isn't sending frames</b>\n\nKeep the camera page open with a watch running, then try again.",
            [[("📸 Try again", "snapshot")]] + BACK,
        )
    return Reply(
        chat_id,
        f"📸 <b>RIGHT NOW</b>\n\nFresh from your camera.\n<i>{feed.frame_at[:10]} · {feed.frame_at[11:19]} UTC</i>",
        [[("📸 Take another", "snapshot"), ("Dashboard", "menu")]],
        image=feed.latest_frame,
    )


async def respond(tg: Telegram, update: dict) -> None:
    bot = tg.bot
    callback = update.get("callback_query") or {}
    message = callback.get("message") or update.get("message") or {}
    chat = message.get("chat") or {}
    if callback:
        await bot.answer_callback(callback["id"])
    if "id" not in chat:
        return
    chat_id = chat["id"]
    text = (message.get("text") or "").strip()
    command = (
        callback.get("data", "")
        if callback
        else (
            text.split(" ")[0].split("@")[0][1:].lower() if text.startswith("/") else ""
        )
    )
    editing = tg.editing.get(chat_id)  # before handle(): a command cancels rule entry
    reply = await handle(tg, update)
    private = chat.get("type", "private") == "private"
    if (
        private
        and not callback
        and (
            editing
            and not text.startswith("/")
            or command in {"rule", "rules"}
            and " " in text
        )
    ):
        # "/rules <text>" adds
        reply = await _enter_rule(
            tg, chat_id, text, (editing or "add") if not command else "add"
        )
    elif private and command == "snapshot":
        reply = await _snapshot(tg, chat_id) or reply
    if reply is None:
        return
    if reply.image is not None:
        await bot.send_photo(chat_id, reply.image, reply.text, reply.buttons)
    elif callback and "text" in message and message.get("message_id"):
        await bot.edit_message(
            chat_id, message["message_id"], reply.text, reply.buttons
        )
    else:
        await bot.send_message(chat_id, reply.text, reply.buttons)


class TelegramNotifier(Notifier):
    def __init__(self, bot: Bot) -> None:
        self.bot = bot

    async def notify(
        self, session_id: str, watch: Watch, event: Event, chat_id: Optional[int]
    ) -> None:
        await super().notify(session_id, watch, event, chat_id)
        if chat_id is None:  # not linked, or alerts paused: worker:record decides
            return
        try:
            await self.bot.send_photo(
                chat_id,
                event.image,
                caption(watch, event),
                [
                    [("📸 See now", "snapshot"), ("🗂 Recent events", "events")],
                    [("🔕 Pause alerts", "pause"), ("Dashboard", "menu")],
                ],
            )
        except httpx.HTTPError as e:
            logger.warning("session={} telegram send failed: {}", session_id, e)


async def poll(tg: Telegram) -> None:
    """One polling instance. Updates are ordered so rule edits and cancellation agree."""
    await tg.bot.set_commands(COMMANDS)
    offset = 0
    while True:
        try:
            updates = await tg.bot.get_updates(offset)
        except httpx.HTTPError as e:
            logger.warning("telegram poll failed: {!r}", e)
            await asyncio.sleep(3)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            try:
                await respond(tg, update)
            except (httpx.HTTPError, ConvexError) as e:
                logger.warning("telegram reply failed: {}", e)
