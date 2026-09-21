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
OPENAI_REQUEST_TIMEOUT = float(os.getenv("OPENAI_REQUEST_TIMEOUT", "10"))
OPENAI_ATTEMPT_TIMEOUT = float(os.getenv("OPENAI_ATTEMPT_TIMEOUT", "5"))
# USD per 1M tokens. The API reports tokens, not money, so the page's cost counter is
# an estimate from these prices - keep them in step with the model above.
OPENAI_PRICE_IN = float(os.getenv("OPENAI_PRICE_IN", "2.50"))
OPENAI_PRICE_CACHED = float(os.getenv("OPENAI_PRICE_CACHED", "1.25"))
OPENAI_PRICE_OUT = float(os.getenv("OPENAI_PRICE_OUT", "10.00"))
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "10"))
SESSION_TTL = float(os.getenv("SESSION_TTL", "30"))
MAX_WATCHES = int(os.getenv("MAX_WATCHES", "5"))  # rules per session
MAX_SUBSCRIBERS = int(os.getenv("MAX_SUBSCRIBERS", "20"))
SUBSCRIBER_TTL = float(os.getenv("SUBSCRIBER_TTL", "86400"))
PORT = int(os.getenv("PORT", "8000"))
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
CONVEX_URL = os.getenv("CONVEX_URL", "")  # https://<deployment>.convex.cloud
# Where the page lives when it is not served by this app (Convex static hosting);
# that origin is allowed to call the API. Empty: same-origin only.
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "")
