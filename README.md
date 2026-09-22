# Watcher

**Point a camera at anything. Say what should happen. Get told the moment it does.**

Watcher turns any phone or laptop camera into a watchdog that understands plain English.
No zones to draw, no objects to pick from a list, no training. You type
*"the cat jumps onto the table"* and walk away. When it happens, you get a photo of the
moment on your phone.

**No special hardware.** Take the old phone from the drawer, open the page, prop it up
against a mug, and forget about it. Telegram will tell you when something happens.
Grok's vision API does the looking; Render hosts it; the phone just has to have a camera.

> Built at the Grok Bot Serbia Hackathon, Belgrade, 12 September 2026.

---

**Contents**

- [How it works](#how-it-works)
- [What it feels like](#what-it-feels-like)
- [See it](#see-it)
- [Why it's different](#why-its-different)
- [Use it for](#use-it-for)
- [Preprocessing: why a static room costs nothing](#preprocessing-why-a-static-room-costs-nothing)
- [Convex: the backend](#convex-the-backend)
- [Privacy: protection without extra steps](#privacy-protection-without-extra-steps)
- [Run it yourself](#run-it-yourself)
- [Under the hood](#under-the-hood)
- [What it costs](#what-it-costs)

---

## How it works

![Watcher architecture: the browser sends JPEG frames and rule text to a Python worker on Render; rules are normalised into predicates, the gate drops static scenes, only changed frames go to the vision model, the tracker fires once per event and Telegram delivers the proof photo; Convex stores encrypted events and session state and streams live results back to the page](docs/images/architecture2.png)

Many frames in, few model calls, encrypted history. The browser posts frames and rules to
a stateless Python worker; the gate in the middle is where most frames die, and everything
to its right runs only when the scene actually changed. Convex holds session state and the
encrypted event history and pushes live results back to the page; Telegram gets the alert
with the proof photo.

## What it feels like

1. **Open the page, allow the camera.**
2. **Type a rule.** *"Someone opens the door."* *"The kettle starts boiling."*
   *"The baby stands up in the crib."* Speak it instead if you'd rather not type.
3. **Press Watch.** Add up to five rules, change them mid-session, nothing restarts.
4. **Scan the QR code.** Now the alert lands in Telegram with the proof frame attached.
5. **Walk away.** When the door opens, your phone buzzes with the exact frame that shows it.

That's the whole product. No account, no install, nothing stored. Close the tab and
the session is gone.

## See it

![Watcher web page: live camera, two rules, an event with its proof frame, cost counter and the Telegram QR](docs/images/web-ui.png)

The page after the cat showed up. Two rules run at once, the first one just fired, the
event sits on the right with its snapshot, and the counters show what eight seconds of
watching cost.

<p align="center">
  <img src="docs/images/telegram.png" width="340" alt="Telegram bot: dashboard with both rules and their live state, then the MOMENT DETECTED photo with the proof frame and action buttons">
</p>

The same session on the phone. The dashboard lists every rule with its current state and
the model's last words about it. When the cat arrives, the photo lands with the rule that
fired, what the model saw, and buttons to snapshot, browse, pause or go back. This one is
a rendering of the bot's real messages and buttons, not a screenshot from a phone.

## Why it's different

**Any old phone is the camera.** A security camera costs money, needs an app, a hub,
a subscription. Watcher needs a browser. The phone you replaced two years ago is now a
smart camera. Leave it on the windowsill, walk away, wait for the buzz.

**Several things at once.** Up to five rules watch the same camera in one session, and
one model call answers all of them. *"The cat is on the table"* and *"someone opens the
fridge"* and *"the light goes off"* run together. Add or drop rules mid-session from the
page or from Telegram without restarting.

**It understands events, not just objects.** Classic camera alerts fire on "motion" or
"person detected". Watcher fires on a *change* you described: the cat *jumps onto* the
table, not "cat present". You say when; it figures out what state to look for and which
direction the change goes.

**It thinks like a person, not a pixel counter.** A vision model (Grok) looks at the
frame and answers your rule in words. It works on things no motion detector can see:
a light turning on, a pot boiling over, a parcel appearing on the doorstep, a dog getting
on the sofa.

**It doesn't cry wolf.** Every event fires exactly once, at the moment it happens, with
the frame that proves it. No repeat alerts while the cat sits there. It fires again only
when the cat leaves and comes back.

**Tokens only when the scene changes.** Most frames never reach the model. A local
filter compares each frame with the last one that mattered, ignores camera shake and
lighting drift, and only sends frames where something actually changed. A static room
costs nothing for hours. The page shows live what the session has cost in tokens and
dollars.

**Your phone is the remote.** From Telegram you can take a fresh snapshot right now,
add or edit rules, browse recent moments, or pause alerts, all without touching the
laptop that holds the camera.

**Rules in any words.** *"Tell me when the parking spot is free."* *"When my kid leaves
the room."* *"When the printer finishes."* The rule gets rewritten into something a single
frame can answer, and if it doesn't describe a change at all, Watcher says so before
wasting a call.

## Use it for

- **Is the cat on the table?** Point the old phone at the kitchen. *"The cat jumps onto
  the table."* Get the photo evidence and go argue with the cat.
- **Birdwatching out the window.** *"A bird lands on the feeder."* Every visitor gets
  its own snapshot in Telegram, no sitting by the glass.
- **Home security.** *"Someone enters the room."* *"The front door opens."* *"A person
  is at the window."* An old phone on a shelf becomes an alarm that sends you the face.
- **Pets.** The dog on the bed. The hamster out of the cage. The parrot on the curtain.
- **Home.** Parcel at the door. Garage left open. Kettle boiled. Washing machine done.
- **Kids and family.** Baby stood up in the crib. Someone got out of bed. Door opened
  after midnight.
- **Workshops and kitchens.** Pot boiling over. 3D print failed. Coffee ready.
- **Waiting for things.** The parking spot is free. The queue moved. The delivery van
  pulled up. The neighbour's light came on.

If you can say it in a sentence and see it in one frame, Watcher can watch for it.
The only limit is what you think of asking.

## Preprocessing: why a static room costs nothing

Every frame from the browser passes through a gate before anything is sent to Grok. The
gate answers one question: *is there anything in this frame the model hasn't already
seen?* If not, the frame is dropped and costs zero tokens. Three of the four pairs below
are the same kitchen; the gate lets only the cat through.

![the cat arrives](docs/images/gate-cat.png)

![camera nudged](docs/images/gate-camera-nudge.png)

![lamp dimmed](docs/images/gate-lighting.png)

![cat, nudge and dimming together](docs/images/gate-cat-nudge-light.png)

Left: the **anchor**, the last frame that went to the model. Middle: the new frame.
Right: the residual difference on an 8×8 board after compensation; white outline marks
tiles above the send threshold. Real night-vision frames from `data/`, the nudge and the
dimming are synthetic.

### The pipeline, per frame

Everything below runs in a worker thread in a few milliseconds on a 128×72 thumbnail.

1. **Shrink and blur.** Resize to 128×72 (INTER_AREA), Gaussian blur with σ=2, in
   float32. Sensor noise, JPEG blocks and fine texture vanish; a cat, a person or a parcel
   are still tens of pixels wide.

2. **Align against the anchor.** `cv2.findTransformECC` estimates a pure translation
   between the anchor and the new frame. It is accepted only if correlation ≥ 0.97, the
   shift is ≤ 2 px at thumbnail scale (roughly 1% of the frame), and the shift *improves*
   the match in at least 8 of 16 textured regions spread over at least 3 quadrants.
   A phone that got nudged is cancelled. A large object moving is not mistaken for a
   camera move, because it only helps the match locally.

3. **Fit the lighting to the quiet majority.** Per RGB channel, a gain and offset are
   fitted with three rounds of robust regression: each round keeps the 70% of pixels
   that the current fit explains best. The fit is rejected if gain leaves [0.67, 1.5] or
   offset exceeds 40 levels, or if any quadrant of the frame is less than half "quiet"
   after correction, so a bright object filling a corner cannot redefine the exposure of
   the whole scene. Auto-exposure drift, a cloud, a dimmed lamp: explained away.

4. **Measure what's left in Lab.** Both images go to Lab colour space; the per-pixel
   residual is the max over L, a, b. The residual is averaged over each of 64 tiles
   (16×9 px), counting only pixels that overlap after alignment. The loudest tile is the
   score.

5. **Decide.** Score above 6.6 Lab levels: send the frame now, make it the new anchor.
   Below: drop it. No cooldown, no waiting for a second frame, no hysteresis; the first
   frame that shows a real change goes straight to the model.

The same pair before and after steps 2 and 3:

![lighting, before and after compensation](docs/images/gate-lighting-before-after.png)

![camera nudge, before and after compensation](docs/images/gate-camera-nudge-before-after.png)

Two details that matter in practice:

- **Frames during a model call are gated but not sent.** One in-flight request per
  session. If the scene changed while Grok was thinking, the next frame carries it.
- **Quiet frames never move the anchor.** The anchor advances only when a frame is sent,
  so a slow change (dusk, a cat creeping in) accumulates against the same reference until
  it crosses the threshold, instead of hiding in a chain of small steps.

Regenerate the figures with:

```bash
PYTHONPATH=. poetry run python scripts/gate_figures.py
```

`poetry run python -m scripts.benchmark_gate` runs the gate on synthetic shifts,
lighting changes and objects and compares it with the original pixel-diff filter,
without calling any model. Synthetic cases only; real shadows, clipped highlights, big
camera moves and flat scenes may still trigger calls.

## Convex: the backend

![Convex in Watcher: the browser talks to Convex over one WebSocket with live queries and mutations, static hosting serves the page, the Python worker reads rules and tracker state before each model call and writes the answer back through a shared-secret worker API, crons stop stale sessions, keep the free Render worker awake and clean up old data; camera frames go straight to the worker and never pass through Convex](docs/images/convex.png)

**Convex is the application.** The Python worker is compute only: frames in, model answer
out, nothing durable. Everything that makes Watcher a product rather than a demo script
lives in Convex: sessions, rules with their tracker state, events, token usage, Telegram
subscribers, and the encrypted history.

Before Convex all of that sat in the memory of one Render process. A deploy, a restart or a
free-tier spin-down erased every session, every event and every Telegram link, and the
page learned about changes through a hand-rolled Server-Sent Events stream. Convex replaced
that with less code and solved several things at once:

- **State survives the worker.** The worker reads the rules and tracker state from Convex
  before each model call and writes one answer back with one mutation (`worker:record`).
  It keeps no copy of the rules, so there is no second source of truth, and a worker
  restart mid-session loses nothing but the frame buffer. A `callId` on the session makes
  the retry of a failed save harmless.
- **Live updates for free.** The page subscribes to `sessions:live`, `events:list` and
  `subscribers:get`. Any write, whether from the worker, the Telegram bot or another tab,
  shows up on the page instantly. The SSE stream, its reconnect logic and its keep-alive
  are gone; a 20 s heartbeat mutation plus a cron sweep replace them.
- **Telegram and the browser share one state.** A rule added from Telegram appears on the
  page; a rule removed on the page disappears from the bot's dashboard. Both are just
  mutations on the same `watches` table.
- **Scheduling without another service.** Three crons: stop sessions whose page went away
  (every minute), ping the worker so the free Render plan does not spin down (every
  10 minutes), and delete stopped sessions in bounded batches (hourly, and right after
  each stop).
- **Static hosting.** The page itself is served from Convex (`@convex-dev/static-hosting`),
  so the whole product is one `convex.site` URL plus a stateless worker.
- **Encrypted history has a home.** Rules and observations reach Convex already encrypted;
  the public key on the session and the ciphertext in `watches` and `events` are what the
  database holds. See [Privacy](#privacy-protection-without-extra-steps).

One deliberate boundary: camera frames never pass through Convex. About one frame per
second per session would burn the free-tier function budget within hours, and OpenCV work
does not belong in a Convex function. The browser posts frames straight to the worker;
Convex sees only the answers. Rule normalisation goes the other way: a Convex action calls
the worker's `/internal/normalize` to turn rule text into a predicate, so the browser only
ever talks to Convex for state changes.

The design and its trade-offs are written up in
[docs/decisions/ADR-20260921-convex-as-state-backend.md](docs/decisions/ADR-20260921-convex-as-state-backend.md).

## Privacy: protection without extra steps

**Pointing a camera into your home takes trust. Watcher makes privacy part of the
session, without giving you another thing to manage.**

Press **Watch** and protection starts automatically. No passwords to invent, no keys
to download or exchange, no recovery setup. The interface stays focused on what you
want to watch for.

- **Your words are protected in the database.** Rules, the model's observations and
  event text reach Convex already encrypted. A database copy alone cannot reveal them.
- **Each watch gets a fresh key.** The private key lives only in the camera tab's
  memory. It is never saved or exported, and is discarded on **Stop**, reload or tab
  closure. Previous sessions cannot be reopened through the app.
- **Camera frames stay out of the database.** Watcher processes frames in memory;
  event snapshots are available in the current tab and sent to Telegram when you
  enable alerts. Telegram messages remain in your chat.

![How user prompts are encrypted: AES-256-GCM encrypts each text field, RSA-OAEP wraps its key, and the browser decrypts the stored data](docs/images/encrypt.png)

The engineering behind this is deliberately invisible: Web Crypto creates a new
RSA-OAEP key pair for each session, and each text field gets a fresh AES-256-GCM key.
The browser encrypts rules; the Python worker encrypts the model's observations using
only the public key. Convex stores the ciphertext and public key, while the private
key stays with the browser.

**The boundary is clear.** The worker and AI provider see the frames and rules needed
for processing, and Telegram receives readable alerts when enabled. Encrypted records
and metadata remain in Convex after a session ends; discarding the private key does
not delete those records. The protection applies to database storage; it does not
cover a compromised browser.

[Implementation and session lifecycle →](docs/encrypted-history.md)

## Run it yourself

You need Python 3.10, Poetry, and an xAI API key. A Telegram bot token is optional but
that's where the fun is.

```bash
make install                 # poetry install
cp .env.example .env         # fill in XAI_API_KEYS, optionally TELEGRAM_BOT_TOKEN
make dev                     # http://localhost:8000
```

Browsers only expose the camera on `https://` or `localhost`, so for a phone on the same
Wi-Fi you'll want a tunnel or a deploy. `render.yaml` deploys the whole thing to Render
on push to `master`; secrets live in the Render dashboard.

To create the Telegram bot: talk to [@BotFather](https://t.me/BotFather), `/newbot`,
copy the token into `.env`. Full details in [src/server/telegram/README.md](src/server/telegram/README.md).

```bash
make test                    # pytest
make format                  # black + isort
make lint                    # black --check, isort --check, mypy
```

## Under the hood

One FastAPI worker on Render, one static page on Convex static hosting, Convex as the
database. `render.yaml` deploys the worker on every push to `master`; Render terminates
TLS, which browsers require before they hand over the camera.

- **Browser** grabs a frame every 1 to 10 seconds (your slider), JPEG-encodes it, posts it
  to the worker. Rules are typed or dictated (speech-to-text through the same OpenAI API).
  Results, events and session state come back through Convex live queries.
- **Gate** (`src/server/cv/gate.py`) decides whether the frame is worth a model call.
  See [Preprocessing: why a static room costs nothing](#preprocessing-why-a-static-room-costs-nothing).
- **Perception** (`src/server/cv/perception.py`) is Grok's vision API through the
  OpenAI-compatible Chat Completions endpoint. One frame and all your rules go in a single
  prompt; back comes a true/false plus a few words of evidence per rule. Your rule is
  first normalised by a text-only call into a state a single frame can answer, plus the
  direction of change you're waiting for. Several API keys can be listed; it fails over
  between them.
- **Tracker** (`src/server/tracker.py`) remembers the last confirmed answer per rule and
  fires only on the edge: rising for "appears", falling for "leaves". Same answer twice
  in a row is silence, so one moment is one alert.
- **Notifier** logs the event, and if Telegram is configured, sends the proof frame as a
  photo. The bot binds to a browser, not a session, so one QR scan covers everything
  that browser watches later.

- **Convex** (`convex/`) stores sessions, rules, encrypted events, usage and Telegram
  subscribers; a cron cleans up old data. The worker keeps only the frame buffer, the gate
  anchor and in-flight calls in memory.

Sessions expire after 30 seconds of silence. Settings are environment
variables with defaults; see `.env.example` and `src/config.py`.

## What it costs

The counter on the page is an estimate, not a bill: OpenAI reports tokens, not money, so
the worker multiplies every response's prompt and completion tokens by the configured
per-million prices (`OPENAI_PRICE_IN`, `OPENAI_PRICE_OUT`) and the session adds them up.

One call is one frame plus all your rules. With image `detail: low` the frame is about
85 tokens and the whole prompt lands near 190 tokens with a single rule; the answer is
some 25 tokens. At $2.50 per million in and $10 per million out that is $0.0007 per call
on `gpt-4o`, measured on 21 September with 640 px frames. Prompt caching cannot help here:
it needs a 1,024-token identical prefix, and ours is about 100 tokens of text followed by
a frame that differs every time. What you pay per day is that number times how many
frames reach the model, and two things decide that: the slider and the gate.

![Watcher cost by frame interval on gpt-4o with image detail low: one call is 189 prompt tokens plus 24 completion tokens, $0.0007; at a 1 s interval a day costs $61.6 if the gate passes every frame and $12.3 in a typical session where it passes about 20%; at 10 s it is $6.2 and $1.2; a 10-minute session is $0.43 max and $0.09 typical](docs/images/cost.png)

Max is the ceiling: the scene changes every frame and the gate lets everything through.
Typical is a measured session: a room where something happened now and then, the gate
dropped four frames out of five. Cost is linear in the interval, so doubling the slider
halves the bill. A tab in the background sends nothing. `OPENAI_IMAGE_DETAIL=auto` brings
the full-resolution frame back at roughly twice the price per call, should small objects
get missed.

The figure is produced by `scripts/cost_figure.py`.
