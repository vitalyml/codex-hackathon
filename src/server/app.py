"""HTTP surface of the compute worker. State lives in Convex (docs/decisions/ADR-20260921-*):
the page talks to Convex for everything except the frame stream, which comes here."""

import asyncio
import json
import secrets
from contextlib import asynccontextmanager
from pathlib import Path as FilePath
from typing import Optional

import httpx
from fastapi import (
    FastAPI,
    File,
    Header,
    HTTPException,
    Path,
    Query,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pydantic import BaseModel

from src import config
from src.server.convex_client import Convex, ConvexError
from src.server.cv.perception import OpenAIPerception, Perception, PerceptionError
from src.server.engine import handle_frame
from src.server.notifier import Notifier
from src.server.session import Feeds
from src.server.telegram.bot import Bot
from src.server.telegram.notifier import Telegram, TelegramNotifier, poll

STATIC = FilePath(__file__).resolve().parents[2] / "static"


class Rules(BaseModel):
    rules: list[str]


def create_app(
    perception: Perception,
    convex: Convex,
    notifier: Notifier,
    bot: Optional[Bot] = None,
    feeds: Optional[Feeds] = None,
    stt: Optional[httpx.AsyncClient] = None,  # OpenAI, for dictation; None: no mic
) -> FastAPI:
    feeds = feeds if feeds is not None else Feeds()

    async def forget_idle_feeds():
        while True:
            feeds.sweep()
            await asyncio.sleep(10)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        tasks = [asyncio.create_task(forget_idle_feeds())]
        if bot is not None:
            await bot.get_me()
            tasks.append(
                asyncio.create_task(poll(Telegram(bot, convex, feeds, perception)))
            )
        try:
            yield
        finally:
            for feed in feeds.all():
                tasks.extend(feed.notifications)
                if feed.task is not None:
                    tasks.append(feed.task)
            for background in tasks:
                background.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    app = FastAPI(title="camera events", lifespan=lifespan)
    if config.FRONTEND_ORIGIN:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[config.FRONTEND_ORIGIN],
            allow_methods=["GET", "POST"],
            allow_headers=["content-type"],
        )

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/static/config.js")  # before the /static mount, which has no such file
    async def page_config():
        """What scripts/build_web.sh bakes into dist/ for Convex hosting, served live here."""
        values = {
            "CONVEX_URL": config.CONVEX_URL,
            "WORKER_URL": "",  # same origin
            "TELEGRAM_BOT_USERNAME": (bot.username or "") if bot else "",
        }
        body = "".join(f"window.{k} = {json.dumps(v)};\n" for k, v in values.items())
        return Response(body, media_type="text/javascript")

    @app.get("/health")
    async def health():
        return {"ok": True, "feeds": len(feeds)}

    @app.post("/internal/normalize")
    async def normalize(body: Rules, authorization: str = Header("")):
        """For the Convex actions sessions:start and watches:add; convex/lib.ts is the caller."""
        expected = f"Bearer {config.WORKER_SECRET}"
        if not config.WORKER_SECRET or not secrets.compare_digest(
            authorization.encode(), expected.encode()
        ):
            raise HTTPException(401, "bad worker secret")
        if not 0 < len(body.rules) <= config.MAX_WATCHES:
            raise HTTPException(400, "1..MAX_WATCHES rules")
        try:
            specs = await asyncio.gather(*(perception.normalize(r) for r in body.rules))
        except PerceptionError as e:
            return JSONResponse(
                {"error": "perception", "hint": str(e)}, status_code=502
            )
        return {
            "specs": [
                {
                    "predicate": s.predicate,
                    "direction": s.direction,
                    "usage": s.usage.wire(),
                }
                for s in specs
            ]
        }

    @app.post("/session/{session_id}/frame")
    async def frame(
        session_id: str, force: bool = False, frame: UploadFile = File(...)
    ):
        feed = feeds.get(session_id)
        if feed is None:
            # First frame, or the first after a restart or a long pause. Asking Convex
            # keeps strangers from filling the memory with feeds of sessions that do
            # not exist: active sessions are capped there.
            try:
                view = await convex.query("sessions:live", sessionId=session_id)
            except ConvexError as e:
                raise HTTPException(503, f"state backend unavailable: {e}")
            if view is None or view["status"] != "active":
                raise HTTPException(404, "no such session")
            feed = feeds.add(session_id)
        try:
            return await handle_frame(
                feed,
                session_id,
                await frame.read(),
                perception,
                convex,
                notifier,
                force,
            )
        except ValueError:
            raise HTTPException(400, "not a decodable image")

    @app.get("/subscriber/{token}/qr.svg")
    async def subscriber_qr(
        token: str = Path(pattern=r"^[A-Za-z0-9_-]{1,64}$"),  # a Telegram start payload
    ):
        if bot is None:
            raise HTTPException(404, "no telegram bot configured")
        return Response(bot.qr_svg(token), media_type="image/svg+xml")

    @app.post("/subscriber/{token}/stt-token")
    async def stt_token(
        token: str = Path(pattern=r"^[A-Za-z0-9_-]{1,64}$"),
        lang: Optional[str] = Query(None, pattern=r"^[a-z]{2}$"),
    ):
        """A one-minute OpenAI key for the page: the browser streams the microphone to
        OpenAI itself over WebRTC, so the audio never crosses this worker."""
        if stt is None:
            raise HTTPException(404, "dictation is not configured")
        # ponytail: any known subscriber gets a key - rate-limit per subscriber if
        # someone starts farming them.
        try:
            subscriber = await convex.query("subscribers:get", token=token)
        except ConvexError as e:
            raise HTTPException(503, f"state backend unavailable: {e}")
        if subscriber is None:
            raise HTTPException(404, "no such subscriber")
        transcription = {"model": config.OPENAI_STT_MODEL}
        if lang:
            transcription["language"] = lang
        audio: dict = {"transcription": transcription}
        if config.OPENAI_STT_MODEL == "gpt-realtime-whisper":
            audio["turn_detection"] = None  # it streams on its own and rejects a VAD
        try:
            response = await stt.post(
                "/realtime/client_secrets",
                json={
                    "expires_after": {"anchor": "created_at", "seconds": 60},
                    "session": {"type": "transcription", "audio": {"input": audio}},
                },
            )
            response.raise_for_status()
            return {"value": response.json()["value"]}
        except (httpx.HTTPError, KeyError, ValueError) as e:
            logger.warning(
                "stt token: {}", type(e).__name__
            )  # never the key or the body
            raise HTTPException(502, "speech service unavailable")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


def default_app() -> FastAPI:
    perception = OpenAIPerception(config.OPENAI_API_KEYS, config.OPENAI_MODEL)
    convex = Convex(config.CONVEX_URL, config.WORKER_SECRET)
    # Without a token the app runs with no bot: the page hides the Telegram block.
    bot = Bot(config.TELEGRAM_BOT_TOKEN) if config.TELEGRAM_BOT_TOKEN else None
    notifier = TelegramNotifier(bot) if bot else Notifier()
    # Not OPENAI_BASE_URL: the page connects to api.openai.com itself, so the key must
    # come from there even when vision goes through a compatible endpoint.
    stt = httpx.AsyncClient(
        base_url="https://api.openai.com/v1",
        headers={"Authorization": f"Bearer {config.OPENAI_API_KEYS[0]}"},
        timeout=10,
    )
    return create_app(perception, convex, notifier, bot, stt=stt)
