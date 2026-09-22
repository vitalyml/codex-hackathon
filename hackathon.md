# Hackathon log

- **Project:** Watcher
- **Event:** Convex All Gas Hackathon
- **What it does:** Point a camera at anything, describe in plain English what should
  happen, and get a photo the moment it does — a vision model watches the feed, a Telegram
  bot delivers the alert.
- **Live app:** https://academic-peacock-398.convex.site
- **Repo:** https://github.com/vitalyml/codex-hackathon
- **Frontend:** Convex static hosting
- **Convex deployment:** https://academic-peacock-398.convex.cloud
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, tables, indexes, queries, mutations, actions, crons, file
  storage, realtime queries
- **Auth:** none
- **AI models:** gpt-4o (OpenAI, since 2026-09-21; grok-4.20-0309-non-reasoning before)
- **Started:** 2026-09-12T08:29:25Z
- **Last updated:** 2026-09-21T20:56:43Z

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

### 2026-09-21 - 802b706
Convex project set up and the page moved to Convex static hosting: `scripts/build_web.sh`
assembles `dist/` from `static/` with a generated `config.js`, no bundler; the Python
service stays as a separate compute worker. Vision moved from xAI Grok to OpenAI `gpt-4o`
behind the same request shape, with session cost estimated from token counts. Components:
@convex-dev/static-hosting (`convex/convex.config.ts`, `src/server/cv/perception.py`).

### 2026-09-21 - 9bb2225
All durable state designed and built in Convex; decisions recorded in an ADR. Tables for
sessions, watches, events, subscribers and presence, with indexes by status, subscriber,
session and chat. Starting a session and adding a rule are actions that ask the worker to
normalize the rule, then insert through a mutation that checks the session and rule
limits in the same transaction. A 20 s heartbeat plus a cron sweep stop sessions whose
tab is gone; other crons keep the worker awake and clean up old sessions. Event photos go
to file storage. Convex features: schema, indexes, queries, mutations, actions, crons,
file storage (`convex/schema.ts`, `convex/sessions.ts`, `convex/watches.ts`,
`convex/worker.ts`, `convex/crons.ts`,
`docs/decisions/ADR-20260921-convex-as-state-backend.md`).

### 2026-09-21 - 7af0f06
The worker keeps nothing durable any more. Before each model call it reads the watches
from `sessions:live`, rebuilds the tracker from the stored state, and writes the whole
answer back with one mutation, `worker:record`; a failed save is retried with the same
answer and a call id makes the repeat harmless. Rules that fire on one frame share one
photo. The client is a small `httpx` wrapper over the Convex HTTP API
(`src/server/convex_client.py`, `src/server/engine.py`, `convex/worker.ts`).

### 2026-09-21 - e3b1118
The page runs on Convex live queries instead of SSE and polling: session state, events
and the Telegram link flag arrive through subscriptions from the vendored Convex browser
bundle. A session survives a reload and can be shared by link (`?session=<id>`); free use
is limited to 10 minutes per browser. Convex features: realtime queries
(`static/app.js`, `static/vendor/convex-browser.bundle.js`, `convex/events.ts`,
`convex/subscribers.ts`).

### 2026-09-21 - 8f35683
Cost and latency measured and fixed for production: frames go with image `detail: low`
(189 prompt tokens instead of 529, same answers on ten test calls), and the worker moves
to Render region `virginia` next to Convex US East, which brings a model call to about
1.3 s and an event with its photo to about 1.6 s (`src/server/cv/perception.py`,
`render.yaml`, the ADR).

### 2026-09-21 - 5cf0bd7
The Telegram bot moved to Convex state, the last part of the migration. Every bot screen
is one secret-gated query, `worker:telegram`; linking a chat, pausing alerts,
disconnecting and adding or editing a rule are mutations, and an edit gives the watch a
new id so a model answer in flight for the old wording is ignored. The old in-memory
session and subscriber stores are deleted. A smoke script drives a session from start to
stop through the page's and the bot's functions against the dev deployment
(`convex/worker.ts`, `src/server/telegram/notifier.py`, `scripts/convex_smoke.py`).

### 2026-09-21 - 6a83487
Deploys are one push now. A GitHub Actions workflow runs on changes to `convex/`,
`static/` or the build script, fails early if the page config (`WORKER_URL`,
`TELEGRAM_BOT_USERNAME`, the deploy key) is missing, then ships functions and the page
together with `@convex-dev/static-hosting deploy`, so the two never drift apart
(`.github/workflows/deploy.yml`).

### 2026-09-21 - 96a1b15
Two fixes from the first full run. A visitor's own 10-minute limit no longer stops a
session shared by link, and the heartbeat fires at once when a tab resumes. Alerts go out
only for events that were actually kept: `worker:record` returns the watches whose events
it stored, so a rule removed while the model was thinking stays silent. A Telegram button
older than the last five events still opens its photo through `worker:event`, and
`subscribers:create` never evicts the subscriber of an active session
(`static/app.js`, `convex/worker.ts`, `convex/subscribers.ts`, `src/server/engine.py`).

### 2026-09-21 - 58974c3
Production is live on Convex static hosting. The first deploy put the page up with dead
buttons: it was calling a worker that still ran the pre-Convex build, with no CORS for the
page's origin and no `/internal/normalize`, and a trailing slash in `WORKER_URL` turned
every call into `//session/...`, a 404. Fixed at each boundary: the page, the Convex
calls to the worker (`workerUrl()`) and `FRONTEND_ORIGIN` all drop the slash. The Convex
branch was merged into `master`, and the worker moved to a new Render service in
`virginia` built from `render.yaml`. Checked from outside: `/health` answers from the new
build, the preflight allows the page's origin, `/internal/normalize` rejects a call
without the secret, and a rule saved from the live page starts a watch
(`static/app.js`, `convex/lib.ts`, `convex/crons.ts`, `src/config.py`).
