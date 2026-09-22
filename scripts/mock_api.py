"""Mock of the HTTP contract for building the page. Usage: poetry run python scripts/mock_api.py"""

from itertools import cycle
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

STATIC = Path(__file__).resolve().parents[1] / "static"
app = FastAPI(title="mock camera events")
sessions: dict[str, dict] = {}

SCRIPT = [
    {
        "gate": "first",
        "streak": 0,
        "sent": True,
        "state": None,
        "evidence": "",
        "fired": False,
    },
    {
        "gate": "skip",
        "streak": 0,
        "sent": False,
        "state": None,
        "evidence": "",
        "fired": False,
    },
    {
        "gate": "skip",
        "streak": 0,
        "sent": False,
        "state": False,
        "evidence": "empty table",
        "fired": False,
    },
    {
        "gate": "change",
        "streak": 1,
        "sent": False,
        "state": False,
        "evidence": "empty table",
        "fired": False,
    },
    {
        "gate": "change",
        "streak": 2,
        "sent": True,
        "state": False,
        "evidence": "cat on the chair",
        "fired": False,
    },
    {
        "gate": "skip",
        "streak": 0,
        "sent": False,
        "state": False,
        "evidence": "cat on the chair",
        "fired": False,
    },
    {
        "gate": "light",
        "streak": 1,
        "sent": False,
        "state": False,
        "evidence": "cat on the chair",
        "fired": False,
    },
    {
        "gate": "change",
        "streak": 1,
        "sent": False,
        "state": False,
        "evidence": "cat on the chair",
        "fired": False,
    },
    {
        "gate": "change",
        "streak": 2,
        "sent": True,
        "state": True,
        "evidence": "cat on the table",
        "fired": True,
    },
    {
        "gate": "skip",
        "streak": 0,
        "sent": False,
        "state": True,
        "evidence": "cat on the table",
        "fired": False,
    },
]


class NewSession(BaseModel):
    rule: str


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/health")
async def health():
    return {"ok": True, "sessions": len(sessions)}


@app.post("/session", status_code=201)
async def create(body: NewSession):
    rule = body.rule.strip().lower()
    if rule == "full":
        return JSONResponse({"error": "full"}, status_code=503)
    sid = f"mock{len(sessions) + 1}"
    direction = "falling" if "leave" in rule or "go" in rule else "rising"
    sessions[sid] = {
        "rule": body.rule,
        "predicate": "a cat is on the table",
        "direction": direction,
        "script": cycle(SCRIPT),
        "events": [],
        "last": SCRIPT[0],
        "busy": 0,
    }
    return {
        "session_id": sid,
        "predicate": "a cat is on the table",
        "direction": direction,
    }


@app.post("/session/{sid}/frame")
async def frame(sid: str, frame: UploadFile = File(...)):
    s = sessions.get(sid) or _404()
    data = await frame.read()
    status = dict(next(s["script"]))
    status["busy"] = s["busy"] % 7 == 6  # show the 'busy' state now and then
    s["busy"] += 1
    if status["fired"]:
        s["events"].append(
            {
                "n": len(s["events"]),
                "at": "2026-09-12T14:32:10Z",
                "text": "a cat is on the table — became true",
                "image": data,
            }
        )
    status["events"] = len(s["events"])
    s["last"] = status
    return status


@app.get("/session/{sid}")
async def view(sid: str):
    s = sessions.get(sid) or _404()
    return {
        "session_id": sid,
        "rule": s["rule"],
        "predicate": s["predicate"],
        "direction": s["direction"],
        "state": s["last"]["state"],
        "evidence": s["last"]["evidence"],
        "events": [{k: e[k] for k in ("n", "at", "text")} for e in s["events"]],
    }


@app.get("/session/{sid}/events/{n}.jpg")
async def image(sid: str, n: int):
    s = sessions.get(sid) or _404()
    if n < 0 or n >= len(s["events"]):
        _404()
    return Response(s["events"][n]["image"], media_type="image/jpeg")


@app.delete("/session/{sid}", status_code=204)
async def delete(sid: str):
    sessions.pop(sid, None)
    return Response(status_code=204)


def _404():
    raise HTTPException(404, "no such session")


app.mount("/static", StaticFiles(directory=STATIC), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
