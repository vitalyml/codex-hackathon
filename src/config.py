"""Настройки из переменных окружения."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_API_KEYS = [
    k.strip() for k in os.getenv("OPENAI_API_KEYS", "").split(",") if k.strip()
]
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
# Dictation. gpt-realtime-whisper streams words while the user speaks; the cheaper
# *-transcribe models answer only after a pause.
OPENAI_STT_MODEL = os.getenv("OPENAI_STT_MODEL", "gpt-realtime-whisper")
# low: the frame costs a flat 85 tokens instead of ~430, and the page sends 640 px
# frames anyway. auto | high bring the detail back if small objects get missed.
OPENAI_IMAGE_DETAIL = os.getenv("OPENAI_IMAGE_DETAIL", "low")
OPENAI_REQUEST_TIMEOUT = float(os.getenv("OPENAI_REQUEST_TIMEOUT", "10"))
OPENAI_ATTEMPT_TIMEOUT = float(os.getenv("OPENAI_ATTEMPT_TIMEOUT", "5"))
# USD per 1M tokens. The API reports tokens, not money, so the page's cost counter is
# an estimate from these prices - keep them in step with the model above.
OPENAI_PRICE_IN = float(os.getenv("OPENAI_PRICE_IN", "2.50"))
OPENAI_PRICE_CACHED = float(os.getenv("OPENAI_PRICE_CACHED", "1.25"))
OPENAI_PRICE_OUT = float(os.getenv("OPENAI_PRICE_OUT", "10.00"))
# Rules per session, for the bot's texts; the limit itself (and the session and
# subscriber caps) is enforced in convex/lib.ts.
MAX_WATCHES = int(os.getenv("MAX_WATCHES", "5"))
PORT = int(os.getenv("PORT", "8000"))
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
CONVEX_URL = os.getenv("CONVEX_URL", "")  # https://<deployment>.convex.cloud
# Shared with the Convex deployment (its WORKER_SECRET env): guards the worker-tier
# functions there and /internal/* here.
WORKER_SECRET = os.getenv("WORKER_SECRET", "")
# Where the page lives when it is not served by this app (Convex static hosting);
# that origin is allowed to call the API. Empty: same-origin only. A browser sends Origin
# without a trailing slash, and CORS compares the strings exactly.
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "").rstrip("/")
