# ADR-20260921: Make Convex the State Backend, Keep the Python Worker for Vision

Status: accepted 2026-09-21. The code is complete on branch `convex` (local commits) and
runs locally against the Convex dev deployment. Nothing in section "Open" is undecided;
what is left is the rollout, listed under "Still to come".

## Context

Watcher (camera page → FastAPI on Render → vision model → tracker → SSE and Telegram) was
built on 2026-09-12 for another hackathon. It is being entered into the Convex All Gas
Hackathon, submission due 2026-09-22 12:00 PT. The entry rules that shape the design:

- "Anything goes, as long as Convex is the backend." Judging looks for real use of queries,
  mutations and live updates; "a thin frontend on a hosted page does not count."
- The live app "must be a convex.site or chatgpt.site URL" that opens without an invite.
- Public repo, `hackathon.md` at the root, demo video up to 3 minutes.
- Rules text: each submission must "use hackathon cohost or partner integrations"
  (OpenAI, Firecrawl, AgentMail).

Today every piece of state lives in the memory of one Render process
(`src/server/session.py`: `SessionStore`, `Subscribers`). A restart, a deploy or a free-tier
spin-down erases all sessions, events, photos and Telegram links. The same `Session` object
mixes durable application state (rules, their true/false state, events, usage, subscriber)
with throwaway computer-vision state (motion gate, locks, last frame).

Constraints set by the owner: smallest possible diff and regression risk with about two
days left; do not rewrite the motion gate, the tracker, the Telegram screens or the camera
code; no Firecrawl, no AgentMail.

## Decision

### Architecture

1. **Convex owns all durable state**: sessions, watches (rules with their state and
   evidence), events with photos, token usage, subscribers. The browser and Telegram read
   and change that state through Convex queries, mutations and actions.
2. **The Python/FastAPI worker stays, as a compute worker only.** It receives camera frames
   straight from the browser (they never pass through Convex), runs the motion gate, calls
   the vision model, runs the tracker, and writes results to Convex. Reason: about one frame
   per second per session would burn the Convex free-tier budget (1M function calls, 1 GB
   file egress per month) within hours, and CPU-bound OpenCV work does not fit Convex
   functions. The contest's URL rule concerns the page judges open, which is served from
   convex.site; the worker is an internal service behind Convex actions.
3. **No second source of truth.** The worker keeps no copy of rules. It reads the watches
   from Convex before each model call (the public `sessions:live`, which already carries
   tracker state, status and the free-use deadline) and on each Telegram interaction, and
   writes one model answer back with one mutation, `worker:record`. A failed save is
   retried up to three times with the same answer, because the next frame may no longer
   show a short-lived change; a `callId` kept on the session makes the repeat harmless. What stays in worker memory is only what is safe to lose: gate state,
   per-session lock, busy/retry flags, the last frame (Telegram "snapshot" waits for a
   fresh one), and the Telegram "waiting for rule text" dialog state. That cache is keyed by
   session id, created on the first frame, and swept after 300 s idle.
4. **Live updates replace SSE.** The page subscribes to Convex queries (`sessions:live`,
   `events:list`, `subscribers:get`). SSE also kept a paused session alive; that role moves
   to a 20 s heartbeat mutation plus a cron sweep.
5. **Event photos go to Convex file storage** (rare, about 50–100 KB each). The frame
   stream and the last frame do not.
6. **The tracker is unchanged.** Per model call it is rebuilt from the stored state:
   `Tracker(direction)`, `state = watch.state`, then `update(observation)`. With
   `persist=1`, the only production setting, the confirmed state is the whole tracker state.
7. **Trust between worker and Convex is one shared secret**, `WORKER_SECRET`. Convex
   functions cannot read request headers, so worker-tier functions take it as a validated
   argument and compare it first; the worker's `/internal/normalize` checks it as a normal
   `Authorization: Bearer` header. The Python client is a small `httpx` wrapper over the
   Convex HTTP API (`/api/query|mutation|action`); no new Python dependency.
8. **Rule normalization stays in Python.** The Convex actions `sessions:start` and
   `watches:add` call the worker's `/internal/normalize`, then insert through a mutation.
   Capacity limits (`MAX_SESSIONS`, `MAX_WATCHES`) are checked inside that mutation, which
   removes the `pending_sessions` counter workaround.

### Data model

Tables: `sessions` (status `active|stopped`, subscriberId, usage), `watches`
(sessionId, order, rule, predicate, direction, state, evidence), `events` (sessionId,
watchId, text, rule, storageId), `subscribers` (chatId, muted, lastSeen), `presence`
(sessionId, lastSeen; separate so heartbeats do not invalidate `sessions:live`, which is
also why `sessions` has no `lastSeen` of its own).

- The subscriber token the page keeps is the subscriber's document id. Convex mutations
  have no cryptographic random source, and every public function already rests on ids
  being unguessable, so a separate token field would add nothing.

- Events are identified by document id; the number shown in the UI is the list index.
- Editing a rule is delete-and-insert at the same `order`, so the watch gets a new id and a
  model answer that was in flight for the old rule is ignored by `worker:record`.
- Telegram sees only `active` sessions (index `by_subscriber` on `[subscriberId, status]`).
- A heartbeat never revives a stopped session.
- `events:list` returns the latest 50. `subscribers:*` expose `linked: boolean`, never the
  numeric chat id. `MAX_SUBSCRIBERS` is 100.

### Frontend and hosting

9. **The page is hosted with `@convex-dev/static-hosting`** at the site root. No bundler:
   `scripts/build_web.sh` copies `static/` into `dist/` and writes `config.js`
   (`CONVEX_URL`, `WORKER_URL`, `TELEGRAM_BOT_USERNAME`). Under `make dev` FastAPI serves
   the same `config.js` live, so one page works on both hosts.
10. **The Convex browser client is the prebuilt `browser.bundle.js` from `convex@1.46.0`,
    vendored into `static/vendor/`.** Function names are passed as strings
    (`"sessions:live"`). No runtime CDN dependency.
11. The Telegram deep link is built in the browser from the bot username in `config.js`.
    The QR image still comes from the worker (`GET /subscriber/{token}/qr.svg`), which needs
    no stored state.
12. Convex region: US East (the cheaper one; EU West costs 1.3×). Fixed at creation.

### Product behavior

13. **A session survives a page reload.** The session id is kept in `localStorage` and in
    the URL as `?session=<id>`, which also makes a session shareable by link. On load:
    unknown id → start screen; `stopped` → "Session expired — start again" and the id is
    cleared; `active` → resume with the stored rules, events and usage. An explicit Stop
    clears the id.
14. **A session goes `stopped` after 180 s without a heartbeat**, and that is final.
    Background tabs throttle timers to about once a minute, so a shorter limit would kill
    hidden tabs.
15. **Events and photos live only as long as the session.** Photos are the user's camera,
    so a stop (explicit, or by the sweep) schedules the deletion of the session with its
    events, photos, watches and presence at once, in batches of 500 events. An hourly
    cron deletes any stopped session that schedule missed. (Until 2026-09-22 stopped
    sessions were kept until the end of the hackathon, bounded by a 5,000-event quota.)
16. **Free use is limited to 10 minutes**, counted from the creation time of the
    *subscriber* (the token the browser gets on first load), so Stop → Start does not reset
    it. After the limit the worker is told the session is closed and stops calling the
    model; the page shows a banner with a stub "pay to continue" button. There is no real
    payment, and Telegram linking stays optional. Clearing browser storage resets the
    limit; that is accepted, since the hard budget guard is the monthly spend limit in the
    OpenAI dashboard.
17. No rate-limiter component and no authentication.
18. Telegram shows nothing special when the limit is reached.

### Operations

19. **Keep-alive:** a Convex cron requests the worker's `/health` every 10 minutes, because
    the free Render plan spins down after 15 minutes without inbound traffic and takes about
    a minute to wake.
20. **Cold start is reported, not hidden:** the call to `/internal/normalize` times out
    after 20 s and the action returns `{error: "worker_starting"}`; the page says so and the
    user retries.
21. **Vision model: OpenAI `gpt-4o` replaces xAI Grok**, so that a partner integration does
    real work in the product. The request shape is unchanged. Provider, keys, model, base
    URL and prices are `OPENAI_*` settings. OpenAI reports tokens, not cost, so session cost
    is estimated from token counts and per-million prices ($2.50 in, $1.25 cached, $10.00
    out). Frames go with image `detail: low` (`OPENAI_IMAGE_DETAIL`). Measured on
    2026-09-21 with 640 px frames, ten interleaved calls per variant:

    | per call        | Grok 4.20      | gpt-4o `auto` | gpt-4o `low` |
    |-----------------|----------------|---------------|--------------|
    | prompt tokens   | ~520           | 529           | 189          |
    | cost            | $0.0004-0.0006 | $0.0015       | $0.0007      |
    | median latency  | 1.24 s         | 1.61 s        | 1.46 s       |
    | right answers   | 10/10          | 10/10         | 10/10        |

    Prompt caching never triggers and cannot help: it needs a 1,024-token identical
    prefix, and ours is about 100 tokens of text followed by a frame that differs every
    time. Measured: three identical requests report `cached_tokens: 0`; the cache shows
    up only with a 1,209-token request repeated with the same image, or with a long
    static text put in front, and that padding costs more than it saves ($0.0021 a call
    against $0.0005).
    Pointing `OPENAI_BASE_URL` at another OpenAI-compatible endpoint restores the old
    provider without a code change.
22. **Tests:** a dict-backed `FakeConvex` for the Python engine and Telegram tests, plus one
    smoke script against a dev deployment. No vitest suite for Convex functions.
23. **Rollout:** one branch (`convex`), merged only after a full smoke test; no feature
    flag. Telegram is migrated last and the app can ship without the bot
    (`TELEGRAM_BOT_TOKEN` empty) if time runs out.
24. **The worker runs in Render region `virginia`**, next to Convex (US East) and the
    OpenAI API. Measured from Belgrade, Convex adds 0.45 s to a model call (0.20 s to
    read the watches, 0.25 s to record) and 1.9 s to upload an event photo. Measured from
    inside US East (a temporary Convex action calling the same HTTP API): 0.027 s to
    read, 0.034 s to record, 0.24 s to upload, and 0.06 s instead of 0.35 s to reach the
    OpenAI API. That brings a call back to about 1.3 s, what it took before the
    migration, and an event to about 1.6 s instead of 3.8 s. A Render region is fixed when the service is created, which
    settles open question 1 in favour of a new service. Moving Convex to EU West was
    rejected: it speeds up European users only, costs 1.3x and needs a new deployment.
25. **Development:** the Convex dev deployment reaches a local worker through a
    `cloudflared` tunnel. Nothing is pushed, deployed or uploaded without the owner's
    explicit go-ahead.
26. `hackathon.md` is maintained with the official `convex-hackathon-skill` after each work
    session. The Convex agent plugin is enabled for this project only, with telemetry off.

### Alternatives rejected

- Mirroring worker state into Convex while the worker stays primary: fastest, but leaves two
  sources of truth and is the "thin frontend" the judging criteria warn against.
- Sending frames or the last frame through Convex: breaks the free-tier quotas.
- A Vite build for the page: more diff for no gain; the static-hosting CLI publishes any
  `dist/`.
- A rate-limiter component: without accounts it limits everyone at once, so one abuser
  could lock the demo for the judges.
- Mandatory Telegram sign-up before use: a judge without Telegram would see a gate instead
  of the product.
- Per-watch result mutations: considered while the plan assumed porting existing
  per-watch code. Nothing was written yet, so `worker:record` takes the whole model
  answer: one transaction, and fewer function calls against the free-tier budget.

## Files Modified

Done on branch `convex` (local commits, nothing pushed to git):

- `.claude/skills/convex-hackathon-skill/SKILL.md`, `references/log-format.md` (created)
- `hackathon.md` (created)
- `package.json`, `package-lock.json` (created)
- `convex/convex.config.ts`, `convex/_generated/*` (created)
- `.gitignore`, `.env.example`, `render.yaml` (modified)
- `src/config.py`, `src/server/app.py`, `src/server/cv/perception.py` (modified)
- `scripts/grok_check.py` → `scripts/vision_check.py` (renamed, modified)
- `scripts/build_web.sh` (created)
- `static/index.html`, `static/app.js` (modified)
- `static/vendor/convex-browser.bundle.js` (created)
- `tests/test_perception.py`, `tests/test_app.py` (modified)
- `docs/decisions/ADR-20260921-convex-as-state-backend.md` (this file)

- `convex/schema.ts`, `convex/lib.ts`, `convex/sessions.ts`, `convex/presence.ts`,
  `convex/watches.ts`, `convex/events.ts`, `convex/worker.ts`, `convex/subscribers.ts`,
  `convex/crons.ts` (created; checked against the dev deployment with `npx convex run`)

- `src/server/convex_client.py`, `tests/fake_convex.py`, `tests/test_convex_client.py`
  (created); `src/server/engine.py`, `src/server/session.py`, `src/server/notifier.py`,
  `tests/test_engine.py`, `tests/test_session.py`, `tests/test_web_client.js` (rewritten)
- Telegram: `telegram`, `link`, `mute`, `unlink`, `putWatch` in `convex/worker.ts`;
  `src/server/telegram/notifier.py`, its `README.md` and `tests/test_telegram.py`
  rewritten over them. The old in-memory `SessionStore`/`Subscribers` are deleted. The
  alert caption lost its event number: numbers are list positions now (see Data model),
  and the engine does not read the list.
- `scripts/convex_smoke.py` (created): the smoke script of decision 22, a session from
  start to stop through the page's and the bot's functions, against the dev deployment.

Still to come, in order: a full run by hand through the tunnel (camera, event photo,
reload, the 10-minute limit, the bot); `README.md` (architecture, gpt-4o cost figures);
`hackathon.md`; then, each on the owner's go-ahead: the Render service in `virginia`, the
Convex production deployment with its environment, the static-site upload, the merge
into `master`, the demo video and the submission.

## Consequences

**Positive**

- Rules, events, photos, usage and Telegram links survive worker restarts, deploys and
  spin-downs; a reload or a shared link resumes a session.
- The page updates through Convex subscriptions; SSE, the 5 s subscriber poll and the
  manual event refresh are removed.
- Several races that needed `asyncio.Lock` discipline or counters become single
  serializable mutations (capacity check, "never below one rule", stale answers after a
  rule edit).
- The entry meets the contest's hosting rule and uses queries, mutations, actions, crons,
  file storage and live queries for the product's real state.

**Negative**

- Two deploy targets and three sets of environment variables (Convex, worker, page build)
  instead of one service.
- Each model call adds two network round trips to Convex (three when an event photo is
  uploaded). A photo uploaded for a `record` that never happens is orphaned in storage.
- The 10-minute limit and all public functions rest on unguessable ids; without accounts
  any limit can be reset by clearing browser storage.
- The cost counter becomes an estimate, and each model call costs about four times more.
- The free-tier ceiling is hard: above 1M function calls a month new mutations can fail, so
  usage has to be watched during judging.
- Four tests in `tests/test_web_client.js` already fail on `master` (they predate the
  multi-rule page and are not part of `make test`); they are rewritten with the frontend
  step, not before.

## Open

1. ~~Where the worker runs for the submission.~~ Decided 2026-09-21: the owner creates
   a new Render service from this repository in region `virginia` (decision 24). The
   teammate's suspended service is not used: its region cannot be changed, and the
   measured gain is a model call in about 1.3 s instead of 1.9 s and an event in about
   1.6 s instead of 3.8 s. The production configuration is: gpt-4o with image
   `detail: low`, the worker in `virginia`, Convex in US East.
2. ~~Automatic pushes to the Convex dev deployment.~~ Decided 2026-09-21: pushes of
   `convex/` code to the dev deployment are the normal workflow and need no approval
   (no data or users there, and functions cannot be checked any other way). Git pushes,
   the production deployment, the static-site upload and secrets still need the owner's
   explicit go-ahead.
3. ~~The `gpt-4o` check on real frames.~~ Done 2026-09-21, see decision 21. `README.md`
   cost figures are still to be rewritten.
