// static/app.js — camera → frames → server → status. No framework.
'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), form = $('ruleForm'), rule = $('rule');
const startBtn = $('start'), stopBtn = $('stop'), restartBtn = $('restart'), sample = $('sample'), sampleValue = $('sampleValue');
const mic = $('mic');
const rules = $('rules'), addBtn = $('add'), status = $('status'), gatePill = $('gate'), statePill = $('state'), flip = $('flip');
const evidence = $('evidence'), events = $('events'), toast = $('toast');
const shotDialog = $('shotDialog'), shotImg = $('shotImg'), shotCaption = $('shotCaption'), shotTime = $('shotTime');
const notify = $('notify'), qrLink = $('qrLink'), qrImg = $('qrImg');
const qrFallback = $('qrFallback'), qrBadge = $('qrBadge'), qrHint = $('qrHint');

const SUB_KEY = 'watcher.subscriber'; // the token survives reloads, so one scan is enough
const SESSION_KEY = 'watcher.session'; // so does the session: a reload resumes it
// The page may be served from another origin than the worker (Convex static hosting);
// config.js says where the worker is. Empty means same origin, as under `make dev`.
const WORKER = (window.WORKER_URL || '').replace(/\/+$/, ''); // paths start with '/'; '//session' is a 404
const BOT = window.TELEGRAM_BOT_USERNAME || '';
const HEARTBEAT_MS = 20000;
// All state lives in Convex: the page reads it through live queries and changes it through
// mutations and actions. Only camera frames go to the worker.
const client = window.CONVEX_URL ? new convex.ConvexClient(window.CONVEX_URL) : null;
const usage = $('usage'), cost = $('cost'), elapsed = $('elapsed');
let generation = 0;
let unsubscribe = []; // live queries of the running session
let heartbeat = null;
let lastEventId = null; // null until the first event list arrives: history is not news
// Frames that went to the model, by the call id the worker answered with. Nothing stores
// a photo: an event names its call, and this tab is the only place that frame still is.
const frames = new Map(); // callId -> object URL, oldest first
let shownEvents = [];     // the last events:list, up to 50; their frames are kept
const PENDING_FRAMES = 5; // frames of calls no event names (yet): most calls fire nothing
function keepFrame(callId, jpeg) {
  frames.set(callId, URL.createObjectURL(jpeg));
  pruneFrames();
  // The event can arrive before the worker's answer to the frame that caused it.
  if (shownEvents.some((e) => e.callId === callId)) renderEvents(shownEvents);
}
function pruneFrames() {
  const shown = new Set(shownEvents.map((e) => e.callId));
  const pending = [...frames.keys()].filter((id) => !shown.has(id));
  for (const id of pending.slice(0, Math.max(0, pending.length - PENDING_FRAMES))) {
    URL.revokeObjectURL(frames.get(id)); frames.delete(id);
  }
}
function dropFrames() { for (const url of frames.values()) URL.revokeObjectURL(url); frames.clear(); shownEvents = []; }
let force = false;      // the rules changed: the next frame asks the model even if nothing moves
let startedAt = 0, clock = null;
function showElapsed() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const FRAME_WIDTH = 640, JPEG_QUALITY = 0.8;
const MAX_OUTSTANDING = 2; // at most this many uploads in flight at once
// Nobody is looking at a hidden tab, and every frame costs tokens — so the loop idles while
// the page is out of sight. The heartbeat keeps going, and that is what keeps the session
// alive across a pause.
const paused = () => document.visibilityState === 'hidden';
let session = null;      // {id, watches: [{id, rule, predicate, direction, state, evidence}]}
let pending = [];        // rules typed before Watch; once a session runs, session.watches is the list
let timer = null;        // setTimeout handle for the sampling loop
let outstanding = 0;     // uploads currently in flight
let uploadSeq = 0;       // increasing tag for each upload, to detect out-of-order responses
let lastRenderedSeq = -1;
let facing = 'environment'; // which camera to ask for; survives stop/start

// ---------- camera ----------
function releaseCamera() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}

async function openCamera() {
  const constraints = { video: { facingMode: { ideal: facing }, width: { ideal: 1280 } }, audio: false };
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (firstError) {
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (e) {
      throw firstError; // real cause (e.g. permission denial) beats the fallback's error
    }
  }
  if (video.readyState < 1) { // HAVE_NOTHING — metadata hasn't loaded yet
    await new Promise((r) => (video.onloadedmetadata = r));
  }
  // Selfie view is mirrored for the preview only — the uploaded JPEG keeps the true orientation.
  video.classList.toggle('mirrored', facing === 'user');
  canvas.width = FRAME_WIDTH;
  canvas.height = Math.round((video.videoHeight / video.videoWidth) * FRAME_WIDTH);
  // While a session runs, render() owns the gate pill and the status line — a mid-watch
  // flip reopens the camera and must not overwrite them.
  if (!session) {
    setPill(gatePill, 'ready', 'idle');
    say('Camera on. Describe what should happen, then press Watch.');
  }
}

// The flip button only makes sense with more than one camera. Device kinds are readable
// without permission; we still call this after the first open so nothing is enumerated early.
async function revealFlipIfMultiCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  flip.hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
}

async function flipCamera() {
  if (flip.disabled) return; // a swap is already in flight
  flip.disabled = true;
  const previous = facing;
  facing = facing === 'environment' ? 'user' : 'environment';
  releaseCamera();
  try {
    await openCamera();
  } catch (e) {
    facing = previous; // the requested camera isn't available — go back to the one that worked
    try {
      await openCamera();
    } catch (_) {
      // both gone; the message below is the only thing left to say
    }
    say(`Could not switch camera: ${e.message}`, true);
  } finally {
    flip.disabled = false;
  }
}

function grabJpeg() {
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
}

// ---------- telegram subscription ----------
// The token is the binding code, and it outlives every watch - so the QR can be shown
// before any rule exists, and one scan covers every watch this browser starts.
let subscriber = null;

async function subscribe() {
  let token = localStorage.getItem(SUB_KEY);
  // null: evicted, or from another deployment. The page makes a new one.
  if (token && !(await client.query('subscribers:get', { token }))) token = null;
  if (!token) {
    token = await client.mutation('subscribers:create', {});
    localStorage.setItem(SUB_KEY, token);
  }
  subscriber = token;
  client.onUpdate('subscribers:get', { token }, (s) => { if (s) showSubscription(token, s); });
}

// The QR stays on screen whether or not the chat is linked - only the badge changes.
// It is hidden in exactly one case: no bot is configured, so there is nothing to offer.
function showSubscription(token, s) {
  if (!BOT) {
    notify.hidden = true;
    return;
  }
  s = { token, linked: s.linked };
  qrLink.href = `https://t.me/${BOT}?start=${token}`;
  const src = `${WORKER}/subscriber/${s.token}/qr.svg`;
  // A failed image is retried on the next update; comparing against the token rather than
  // the full src keeps a cache-busted retry from looping.
  if (qrImg.dataset.token !== s.token || qrImg.dataset.failed === '1') {
    qrImg.dataset.token = s.token;
    delete qrImg.dataset.failed;
    qrImg.src = qrImg.dataset.retry ? `${src}?r=${Date.now()}` : src;
  }
  setPill(qrBadge, s.linked ? '✓ linked' : 'not linked', s.linked ? 'true' : 'idle');
  qrHint.textContent = s.linked
    ? 'Events go to your Telegram chat.'
    : 'Scan to get events in Telegram.';
  notify.hidden = false;
}

// An unreachable QR must not leave a broken image on a white plate - fall back to a
// plain link, which is what the phone running this page would tap anyway.
qrImg.addEventListener('error', () => {
  if (!qrImg.getAttribute('src')) return; // src cleared, not a real failure
  qrImg.dataset.failed = '1';
  qrImg.dataset.retry = '1';
  qrImg.hidden = true;
  qrFallback.hidden = false;
});
qrImg.addEventListener('load', () => {
  qrImg.hidden = false;
  qrFallback.hidden = true;
  delete qrImg.dataset.retry;
});

// ---------- api ----------
async function api(path, init) {
  const res = await fetch(WORKER + path, init);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.hint || body.error || res.statusText), { status: res.status, body });
  return body;
}

// ---------- loop ----------
async function tick() {
  // Scheduled first: cadence is wall-clock, independent of how long the upload takes.
  timer = setTimeout(tick, Number(sample.value));
  if (!session) return;
  if (paused()) return; // tab hidden — no one to show a reading to, so don't pay for one
  if (outstanding >= MAX_OUTSTANDING) return; // already at the concurrency cap — skip this sample
  if (video.readyState < 2) return; // HAVE_CURRENT_DATA — mid camera swap, no frame to grab
  const currentSession = session;
  outstanding++;
  const mySeq = ++uploadSeq;
  try {
    const fd = new FormData();
    const jpeg = await grabJpeg();
    if (session !== currentSession) return;
    fd.append('frame', jpeg, 'frame.jpg');
    const forced = force;
    const s = await api(`/session/${currentSession.id}/frame${forced ? '?force=1' : ''}`, { method: 'POST', body: fd });
    if (s.callId) keepFrame(s.callId, jpeg);
    if (forced && s.sent) force = false;
    // Concurrent uploads can resolve out of order — drop a response older than
    // the newest one already rendered.
    if (session !== currentSession) return;
    if (mySeq > lastRenderedSeq) {
      lastRenderedSeq = mySeq;
      render(s);
    }
  } catch (e) {
    if (session !== currentSession) return;
    if (e.status === 404) { stop('Session expired — start again.', false, true); return; }
    say(`Upload failed: ${e.message}`, true);
  } finally {
    if (session === currentSession) outstanding--;
  }
}

// ---------- rules ----------
// One list, two sources: `pending` before Watch, the server's watches once a session runs.
// Adding and removing go through the same buttons either way; while running they change
// Convex, and the live query brings back the list (Telegram edits included).
function renderRules() {
  const list = session ? session.watches : pending.map((r) => ({ rule: r }));
  rules.innerHTML = '';
  for (const [i, w] of list.entries()) {
    const li = document.createElement('li');
    li.className = w.state === true ? 'true' : '';
    const text = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = w.rule;
    text.append(b);
    if (w.predicate) {
      const meta = document.createElement('small');
      const arrow = w.direction === 'rising' ? 'becomes true' : 'becomes false';
      const state = w.state === null || w.state === undefined ? 'unknown' : w.state ? 'TRUE' : 'false';
      meta.textContent = `“${w.predicate}” → ${arrow} · ${state}${w.evidence ? ` · ${w.evidence}` : ''}`;
      text.append(meta);
    }
    li.append(text);
    if (!session || list.length > 1) { // a running session keeps at least one rule
      const x = document.createElement('button');
      x.type = 'button'; x.textContent = '✕'; x.title = 'Remove this rule';
      x.addEventListener('click', () => removeRule(i));
      li.append(x);
    }
    rules.append(li);
  }
  rules.hidden = !list.length;
}

async function addRule() {
  const text = rule.value.trim();
  if (!text || addBtn.disabled) return;
  if (!session) {
    pending.push(text);
    rule.value = '';
    renderRules();
    say(pending.length > 1 ? `${pending.length} rules. Add more, or press Watch.` : 'Add another rule, or press Watch.');
    return;
  }
  addBtn.disabled = true;
  const currentSession = session;
  say('Understanding the rule…');
  try {
    const failed = await client.action('watches:add', { sessionId: currentSession.id, rule: text });
    if (session !== currentSession) return;
    if (failed) { say(failed.hint || failed.error, true); return; }
    rule.value = '';
    force = true;
    say('Watching.');
  } catch (e) {
    if (session === currentSession) say(e.message, true);
  } finally {
    addBtn.disabled = false;
  }
}

async function removeRule(i) {
  if (!session) {
    pending.splice(i, 1);
    renderRules();
    return;
  }
  const currentSession = session;
  try {
    const failed = await client.mutation('watches:remove', { watchId: currentSession.watches[i].id });
    if (session !== currentSession) return;
    if (failed) say(failed.hint || failed.error, true);
    else force = true;
  } catch (e) {
    if (session === currentSession) say(e.message, true);
  }
}

// What Watch starts with: the list, plus whatever is still typed in the box.
function rulesToStart() {
  const typed = rule.value.trim();
  return typed ? [...pending, typed] : [...pending];
}

async function start(rules) {
  if (startBtn.disabled) return;
  if (!rules.length) { say('Describe something that happens, then press Watch.', true); rule.focus(); return; }
  const attempt = ++generation;
  startBtn.disabled = true;
  if (!video.srcObject) {
    try {
      await openCamera();
    } catch (e) {
      startBtn.disabled = false;
      say(`Camera unavailable: ${e.message}. Use https:// or localhost.`, true);
      return;
    }
  }
  if (attempt !== generation) return;
  say(rules.length > 1 ? 'Understanding the rules…' : 'Understanding the rule…');
  let created;
  try {
    created = await client.action('sessions:start', { rules, subscriber: subscriber || undefined });
  } catch (e) {
    created = { error: 'convex', hint: e.message };
  }
  if (attempt !== generation) {
    if (created.sessionId) client.mutation('sessions:stop', { sessionId: created.sessionId }).catch(() => {});
    return;
  }
  startBtn.disabled = false;
  if (created.error) {
    if (created.error === 'full') say('The room is full right now. Try again in a minute.', true);
    else say(created.hint || created.error, true);
    return;
  }
  adopt(created.sessionId, Date.now());
}

// A session this page runs: just started, or found again after a reload or by a shared link.
function adopt(id, started) {
  session = { id, watches: [] };
  localStorage.setItem(SESSION_KEY, id);
  history.replaceState(null, '', `?session=${id}`);
  startBtn.hidden = true; stopBtn.hidden = false; restartBtn.hidden = false;
  pending = []; rule.value = '';
  startedAt = started; showElapsed(); clock = setInterval(showElapsed, 1000);
  events.innerHTML = ''; lastEventId = null; evidence.textContent = '—'; dropFrames();
  outstanding = 0; uploadSeq = 0; lastRenderedSeq = -1; force = false;
  setPill(statePill, 'unknown', 'idle');
  say('Watching.');
  const current = session;
  const mine = (render) => (value) => { if (session === current) render(value); };
  unsubscribe = [
    client.onUpdate('sessions:live', { sessionId: id }, mine(renderLive)),
    client.onUpdate('events:list', { sessionId: id }, mine(renderEvents)),
  ];
  const beat = () => client.mutation('presence:heartbeat', { sessionId: id }).catch(() => {});
  beat(); // a resumed session may be seconds from the sweep: do not wait out the interval
  heartbeat = setInterval(beat, HEARTBEAT_MS);
  tick();
}

// On load: `?session=` (a shared link) wins over what this browser remembers.
async function resume() {
  const id = new URLSearchParams(location.search).get('session') || localStorage.getItem(SESSION_KEY);
  if (!id) return;
  const view = await client.query('sessions:live', { sessionId: id });
  if (view && view.status === 'active') {
    if (!session) adopt(id, view.startedAt);
    return;
  }
  forget();
  if (view) say('Session expired — start again.');
}

function forget() {
  localStorage.removeItem(SESSION_KEY);
  history.replaceState(null, '', location.pathname);
}

async function restart() {
  if (!session) return;
  const stopping = stop(undefined, true);
  const attempt = generation;
  await stopping;
  if (attempt === generation) await start(rulesToStart());
}

// `gone`: Convex already says the session is over, so there is nothing to stop there.
function stop(message, keepCamera = false, gone = false) {
  generation++;
  unsubscribe.forEach((off) => off()); unsubscribe = [];
  clearInterval(heartbeat); heartbeat = null;
  clearTimeout(timer); timer = null;
  const stopping = session && !gone ? client.mutation('sessions:stop', { sessionId: session.id }).catch(() => {}) : Promise.resolve();
  if (session) pending = session.watches.map((w) => w.rule); // the rules stay editable for the next Watch
  session = null;
  forget();
  if (!keepCamera) releaseCamera();
  startBtn.disabled = false; addBtn.disabled = false;
  startBtn.hidden = false; stopBtn.hidden = true; restartBtn.hidden = true;
  renderRules();
  clearInterval(clock); clock = null;
  setPill(gatePill, keepCamera ? 'ready' : 'camera off', 'idle'); setPill(statePill, 'no rule', 'idle');
  say(message || 'Stopped.');
  return stopping;
}

// ---------- render ----------
const GATE_LABEL = { first: 'first frame', skip: 'quiet', change: 'change', light: 'light changed' };
const GATE_TONE = { first: 'send', skip: 'idle', change: 'warn', light: 'info' };

// The worker's answer to a frame: only what the gate did with it. Everything else about
// the session comes from Convex.
function render(s) {
  if (!session) return; // response arrived after Stop cleared the session — nothing to render
  const label = s.sent ? 'asking the model' : s.busy ? 'model busy' : GATE_LABEL[s.gate] + (s.streak ? ` ×${s.streak}` : '');
  setPill(gatePill, label, s.sent ? 'send' : GATE_TONE[s.gate]);
}

function renderLive(view) {
  // Stopped by the sweep after a long sleep, from another tab, or deleted.
  if (!view || view.status !== 'active') { stop('Session expired — start again.', false, true); return; }
  session.watches = view.watches; // Telegram may have edited the rules
  renderRules();
  const known = view.watches.filter((w) => w.state !== null);
  const yes = known.filter((w) => w.state).length;
  if (!known.length) setPill(statePill, 'unknown', 'idle');
  else if (view.watches.length === 1) setPill(statePill, yes ? 'TRUE' : 'false', yes ? 'true' : 'false');
  else setPill(statePill, `${yes}/${view.watches.length} true`, yes ? 'true' : 'false');
  const seen = view.watches.map((w) => w.evidence).filter(Boolean);
  evidence.textContent = seen.length ? seen.map((e) => `“${e}”`).join(' · ') : '—';
  renderUsage(view.usage);
}

function renderUsage(u) {
  const usd = u.usdTicks / 1e10; // an estimate: tokens times the configured prices
  usage.textContent = (u.prompt + u.completion).toLocaleString();
  usage.title = `${u.prompt} in / ${u.completion} out, ${u.calls} calls`;
  cost.textContent = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

// The latest 50, oldest first; shown newest first.
function renderEvents(list) {
  shownEvents = list;
  pruneFrames();
  const newest = list.length ? list[list.length - 1] : null;
  if (newest && lastEventId !== null && newest.id !== lastEventId) { flash(); showToast('Event! ' + newest.text); }
  lastEventId = newest ? newest.id : '';
  events.innerHTML = '';
  for (const e of [...list].reverse()) {
    const li = document.createElement('li');
    const at = new Date(e.at).toLocaleTimeString();
    const src = frames.get(e.callId); // missing after a reload or in another tab
    const cap = document.createElement('div');
    if (src) {
      // The thumbnail is a button: the frame is 640px wide, so the dialog shows it
      // several times larger than the list ever can.
      const shot = document.createElement('button');
      shot.type = 'button';
      shot.className = 'shot';
      shot.setAttribute('aria-label', `Open larger view: ${e.text}, ${at}`);
      const img = document.createElement('img');
      img.src = src;
      img.alt = e.text;
      img.loading = 'lazy';
      shot.append(img);
      shot.addEventListener('click', () => openShot(src, e.text, at));
      li.append(shot);
    }
    const b = document.createElement('b');
    b.textContent = e.rule ? `${e.rule} — ${e.text}` : e.text;
    const time = document.createElement('time');
    time.textContent = at;
    cap.append(b, time);
    li.append(cap);
    events.append(li);
  }
}

// Full-size snapshot in a native dialog: focus trap, Esc and focus restore come free.
function openShot(src, text, at) {
  shotImg.src = src;
  shotImg.alt = text;
  shotCaption.textContent = text;
  shotTime.textContent = at;
  shotDialog.showModal();
}
// Clicking the backdrop closes; clicks on the picture or caption do not bubble out to it.
shotDialog.addEventListener('click', (ev) => { if (ev.target === shotDialog) shotDialog.close(); });
shotDialog.addEventListener('close', () => { shotImg.removeAttribute('src'); });

function setPill(el, text, tone) { el.textContent = text; el.className = `pill pill-${tone}`; }
function say(text, isError) { status.textContent = text; status.classList.toggle('error', !!isError); }
function flash() { document.body.classList.add('flash'); setTimeout(() => document.body.classList.remove('flash'), 600); }
let toastTimer;
function showToast(text) { toast.textContent = text; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast.hidden = true), 4000); }

// ---------- wiring ----------
// Watch is the submit button, so Enter in the box and the button do the same thing: start the
// watch (list plus what's typed) until a session runs, then add to it. `+ Add` queues without starting.
form.addEventListener('submit', (e) => { e.preventDefault(); session ? addRule() : start(rulesToStart()); });
addBtn.addEventListener('click', addRule);
stopBtn.addEventListener('click', () => stop());
restartBtn.addEventListener('click', restart);
flip.addEventListener('click', flipCamera);
function showSample() { sampleValue.textContent = String(Number(sample.value) / 1000); }
sample.addEventListener('input', showSample);
showSample();
document.addEventListener('visibilitychange', () => {
  if (!session) return;
  if (paused()) { setPill(gatePill, 'paused', 'idle'); say('Paused — tab hidden.'); return; }
  say('Watching.');
  // Hidden tabs have their timers throttled to about once a minute, so the pending one is
  // no use for resuming promptly — drop it and sample right away.
  clearTimeout(timer);
  tick();
});
// The session is not stopped here: a reload resumes it, and one that never comes back is
// stopped by the sweep once its heartbeats end.
window.addEventListener('pagehide', releaseCamera);
// ---------- dictation ----------
// Live speech-to-text for the rule box through OpenAI Realtime. The worker only mints a
// one-minute key (/subscriber/<token>/stt-token); the microphone goes from this browser to
// OpenAI over WebRTC and the words come back on the data channel while the user speaks.
(function setupDictation() {
  if (!window.RTCPeerConnection || !navigator.mediaDevices) return; // leave the mic button hidden
  const CALLS = 'https://api.openai.com/v1/realtime/calls';
  const MAX_MS = 60000; // a forgotten microphone is billed by the minute
  let pc = null, offTimer = null;
  let base = ''; // text already in the box when dictation started — new words append to it
  let heard = '';

  // idle → connecting → listening. WebRTC buffers nothing: words said before the peer
  // connection and transcription session are ready are gone. Wait for both signals.
  function setState(state) {
    mic.classList.toggle('connecting', state === 'connecting');
    mic.classList.toggle('listening', state === 'listening');
    mic.setAttribute('aria-pressed', state === 'idle' ? 'false' : 'true');
    mic.title = state === 'idle' ? 'Dictate rule' : 'Stop dictation';
    mic.setAttribute('aria-busy', state === 'connecting' ? 'true' : 'false');
    if (state === 'connecting') say('Preparing microphone… Please wait.');
    else if (state === 'listening') say('Ready — speak now.');
    else if (/^(Preparing microphone… Please wait\.|Ready — speak now\.)$/.test(status.textContent)) say('');
  }

  // Whatever ends the run — user tap, timeout, network — the button returns to idle.
  // Text already received stays in the box; pending transcription ends with the connection.
  function hangUp() {
    clearTimeout(offTimer); offTimer = null;
    const old = pc; pc = null;
    if (old) { old.getSenders().forEach((s) => s.track && s.track.stop()); old.close(); }
    setState('idle');
  }

  function onEvent(event) {
    if (event.type === 'conversation.item.input_audio_transcription.delta') heard += event.delta;
    // models that answer phrase by phrase send no space between the phrases
    else if (event.type === 'conversation.item.input_audio_transcription.completed') heard += ' ';
    else if (event.type === 'error') { say(`Dictation error: ${(event.error && event.error.message) || 'unknown'}`, true); hangUp(); return; }
    else return;
    rule.value = (base + heard).replace(/\s+/g, ' ').trimStart();
  }

  async function listen() {
    const mine = pc = new RTCPeerConnection();
    const gone = () => pc !== mine; // tapped off, or failed, while this was still connecting
    let sessionReady = false, listening = false;
    let streamP = null; // the mic may be granted while the key is still failing
    setState('connecting');
    base = rule.value ? rule.value.trimEnd() + ' ' : ''; heard = '';
    offTimer = setTimeout(hangUp, MAX_MS);
    try {
      // The mic prompt and the key (browser → worker → Convex → OpenAI) are the slow part;
      // they do not need each other.
      const lang = (navigator.language || '').slice(0, 2).toLowerCase();
      streamP = navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        stream.getTracks().forEach((track) => { track.enabled = false; if (gone()) track.stop(); });
        if (!gone()) mine.addTrack(stream.getTracks()[0], stream);
        return stream;
      });
      const [stream, key] = await Promise.all([
        streamP,
        api(`/subscriber/${subscriber}/stt-token${/^[a-z]{2}$/.test(lang) ? '?lang=' + lang : ''}`, { method: 'POST' }),
      ]);
      if (gone()) { stream.getTracks().forEach((t) => t.stop()); return; }
      const channel = mine.createDataChannel('oai-events');
      const maybeListen = () => {
        if (gone() || listening || !sessionReady || mine.connectionState !== 'connected' || channel.readyState !== 'open') return;
        listening = true;
        stream.getTracks().forEach((track) => { track.enabled = true; });
        clearTimeout(offTimer);
        offTimer = setTimeout(hangUp, MAX_MS);
        setState('listening');
      };
      channel.addEventListener('open', maybeListen);
      channel.addEventListener('close', () => { if (!gone()) hangUp(); });
      channel.addEventListener('error', () => { if (!gone()) hangUp(); });
      channel.addEventListener('message', (e) => {
        if (gone()) return;
        let event; try { event = JSON.parse(e.data); } catch (_) { return; }
        if (event.type === 'session.created' || event.type === 'transcription_session.created') {
          sessionReady = true;
          maybeListen();
        } else onEvent(event);
      });
      mine.addEventListener('connectionstatechange', () => {
        if (gone()) return;
        if (mine.connectionState === 'connected') maybeListen();
        else if (['failed', 'disconnected', 'closed'].includes(mine.connectionState)) hangUp();
      });
      await mine.setLocalDescription(await mine.createOffer());
      if (gone()) return;
      const res = await fetch(CALLS, {
        method: 'POST', body: mine.localDescription.sdp,
        headers: { Authorization: `Bearer ${key.value}`, 'Content-Type': 'application/sdp' },
      });
      if (!res.ok) throw new Error(`speech service answered ${res.status}`);
      const sdp = await res.text();
      if (gone()) return;
      await mine.setRemoteDescription({ type: 'answer', sdp });
    } catch (e) {
      if (streamP) streamP.then((st) => st.getTracks().forEach((t) => t.stop()), () => {});
      if (gone()) return;
      hangUp();
      if (e.name === 'NotAllowedError') say('Microphone blocked — allow it or type the rule.', true);
      else say(`Dictation unavailable: ${e.message}`, true);
    }
  }

  mic.addEventListener('click', () => {
    if (pc) hangUp();
    else if (!subscriber) say('Dictation is not ready yet — try again in a moment.', true);
    else listen();
  });
  // Add and Watch take what is in the box; words heard after that would land in the next rule.
  form.addEventListener('submit', hangUp);
  addBtn.addEventListener('click', hangUp);

  mic.hidden = false;
})();

if (!client) {
  say('This page is not configured: config.js has no CONVEX_URL.', true);
} else {
  subscribe().catch(() => { notify.hidden = true; }); // no channel to offer - the page still works
  openCamera()
    .then(revealFlipIfMultiCamera)
    .catch((e) => say(`Camera unavailable: ${e.message}. Use https:// or localhost.`, true))
    .then(resume)
    .catch((e) => say(e.message, true));
}
