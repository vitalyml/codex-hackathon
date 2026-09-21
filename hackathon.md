# Hackathon log

- **Project:** Watcher
- **Event:** Convex All Gas Hackathon
- **What it does:** Point a camera at anything, describe in plain English what should
  happen, and get a photo the moment it does — a vision model watches the feed, a Telegram
  bot delivers the alert.
- **Live app:** not deployed
- **Repo:** https://github.com/aroldohernandezarmas/codex-hackathon
- **Frontend:** Other
- **Convex deployment:** not deployed
- **Components:** none
- **Convex features:** none yet
- **Auth:** none
- **AI models:** grok-4.20-0309-non-reasoning
- **Started:** 2026-09-12T08:29:25Z
- **Last updated:** 2026-09-21T11:35:43Z

## Log

### 2026-09-12 - 4c5b210
Project skeleton, a computer-vision gate that filters static frames before any model
call, and Grok vision perception wired up against sample frames. First cut of a mock
FastAPI camera-event API (`scripts/mock_api.py`, `src/server/cv/gate.py`,
`src/server/cv/perception.py`).

### 2026-09-12 - 94dea4b
Core server: an event tracker that fires once per state transition, an in-memory
session store, and the real FastAPI app tying gate, perception and tracker together
into a non-blocking per-frame engine. Render deploy config added
(`src/server/engine.py`, `src/server/session.py`, `src/server/tracker.py`,
`src/server/app.py`, `render.yaml`).

### 2026-09-12 - 07be853
Telegram notifier with QR-code deep-link binding, merged with the web UI branch; bot
menu, buttons and its own QR endpoint added on top
(`src/server/telegram/notifier.py`, `src/server/telegram/bot.py`).

### 2026-09-12 - fea19b2
Camera-flip support, per-session Grok token usage with a reset endpoint, and a live
cost-in-USD counter on the page (`static/app.js`, `src/server/cv/perception.py`).

### 2026-09-12 - e3689a7
Reliability pass: sticky failover across multiple xAI API keys, a Telegram subscriber
flow with its own QR code, a fix for missed camera events, and clearer error logging
for Telegram and xAI requests (`src/server/cv/perception.py`,
`src/server/telegram/notifier.py`).

### 2026-09-12 - b4a252c
Sampling-interval fix (1-10s), on-page usage instructions, and a richer Telegram UX —
more detailed notifications, more bot commands, session tweaks
(`static/app.js`, `src/server/telegram/notifier.py`).

### 2026-09-12 - a1d9e47
Frame-change filter fix so camera or lighting shifts stop triggering false events,
support for several watches per session, adding rules one at a time (on the page and
mid-session), and voice dictation for the rule box (`src/server/cv/gate.py`,
`src/server/session.py`, `static/app.js`).

### 2026-09-12 - e5619bc
README rewritten for people, with an architecture diagram and gate heatmaps; the
how-it-works primer rewritten as three steps; Enter in the rule box now starts the
watch (`README.md`, `static/app.js`).

### 2026-09-13 - fee56f1
Licensing settled after trying AGPL-3.0 and PolyForm Noncommercial: back to all
rights reserved (`LICENSE`).

### 2026-09-14 - 801fae5
Session cost now comes straight from the API's `cost_in_usd_ticks` instead of a local
estimate, with a per-interval cost table added to the README
(`src/server/cv/perception.py`, `README.md`).

### 2026-09-21 - working tree
Convex project set up: `convex` added as a dependency, a `convex/` directory created,
and `.gitignore` updated for `.env.local` by the Convex CLI. No schema, functions, or
components written yet (`package.json`, `.gitignore`).
