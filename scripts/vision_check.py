"""3-frame / 5-case check of a Grok vision model on data/*.png. Usage: poetry run python scripts/grok_check.py [model]"""

import base64
import json
import re
import sys
from io import BytesIO
from pathlib import Path
from time import perf_counter

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.config import XAI_API_KEYS, XAI_MODEL  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "data"
MODEL = sys.argv[1] if len(sys.argv) > 1 else XAI_MODEL
URL = "https://api.x.ai/v1/chat/completions"
PREDICATE = "a cat is on the table (a cat on a chair or on the floor does not count)"
TRUTH = {"1.png": False, "2.png": False, "3.png": True}
CASES = [
    ("1.png", "2.png", False),
    ("2.png", "3.png", True),
    ("1.png", "3.png", True),
    ("3.png", "3.png", False),
    ("3.png", "2.png", False),
]

PROMPT = (
    "You look at a single still frame from a fixed security camera.\n"
    "Answer only this about THIS frame: is the following true right now?\n"
    "  {predicate}\n"
    "If the frame is too dark or unclear to tell, answer false.\n"
    'Reply with JSON only: {{"state_now": true|false, "evidence": "<a few words on what you see>"}}'
)


def jpeg(name: str, width: int = 640) -> bytes:
    image = Image.open(DATA / name).convert("L")
    image = image.resize((width, round(image.height * width / image.width)))
    buffer = BytesIO()
    image.save(buffer, "JPEG", quality=85)
    return buffer.getvalue()


def ask(name: str) -> dict:
    payload = {
        "model": MODEL,
        "temperature": 0,
        "max_tokens": 64,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT.format(predicate=PREDICATE)},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/jpeg;base64,"
                            + base64.b64encode(jpeg(name)).decode()
                        },
                    },
                ],
            }
        ],
    }
    started = perf_counter()
    response = httpx.post(
        URL,
        headers={"Authorization": f"Bearer {XAI_API_KEYS[0]}"},
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    body = response.json()
    raw = body["choices"][0]["message"].get("content") or ""
    try:
        parsed = json.loads(raw)
        state, evidence = bool(parsed["state_now"]), str(parsed.get("evidence", ""))
    except (json.JSONDecodeError, KeyError, TypeError):
        found = re.findall(r"true|false", raw.lower())
        state, evidence = (
            (found[-1] == "true") if found else None
        ), f"<unparsed: {raw[:60]}>"
    return {
        "state": state,
        "evidence": evidence,
        "seconds": round(perf_counter() - started, 2),
        "tokens": body.get("usage", {}).get("prompt_tokens"),
    }


def main() -> int:
    assert XAI_API_KEYS, "XAI_API_KEYS is empty"
    print(f"model {MODEL}\n")
    state = {}
    for name in TRUTH:
        r = ask(name)
        state[name] = r["state"]
        ok = "ok " if r["state"] == TRUTH[name] else "BAD"
        print(
            f"{ok} {name}: state={r['state']} ({r['seconds']}s, {r['tokens']} tok) — {r['evidence']}"
        )
    frames = sum(state[n] == TRUTH[n] for n in TRUTH)
    cases = sum(((not state[a]) and state[b]) == expected for a, b, expected in CASES)
    print(f"\nframes {frames}/3 · cases {cases}/5")
    return 0 if frames == 3 and cases == 5 else 1


if __name__ == "__main__":
    sys.exit(main())
