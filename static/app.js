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
// The page may be served from another origin than the worker (Convex static hosting);
// config.js says where the worker is. Empty means same origin, as under `make dev`.
const WORKER = window.WORKER_URL || '';
const SUB_POLL_MS = 5000;
const usage = $('usage'), cost = $('cost'), elapsed = $('elapsed');
let generation = 0;
let updates = null, lastRevision = -1, announcedEvents = 0;
let startedAt = 0, clock = null;
function showElapsed() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const FRAME_WIDTH = 640, JPEG_QUALITY = 0.8;
const MAX_OUTSTANDING = 2; // at most this many uploads in flight at once
// Nobody is looking at a hidden tab, and every frame costs tokens — so the loop idles while
// the page is out of sight. The updates stream stays open, and that is what keeps the
// server-side session alive across a pause of any length.
const paused = () => document.visibilityState === 'hidden';
let session = null;      // {session_id, watches: [{rule, predicate, direction, state, evidence}]}
let pending = [];        // rules typed before Watch; once a session runs, session.watches is the list
let timer = null;        // setTimeout handle for the sampling loop
let outstanding = 0;     // uploads currently in flight
let uploadSeq = 0;       // increasing tag for each upload, to detect out-of-order responses
let lastRenderedSeq = -1;
let knownEvents = 0;
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
  const saved = localStorage.getItem(SUB_KEY);
  if (saved) {
    try {
      return await api(`/subscriber/${saved}`); // still known to this server?
    } catch (e) {
      if (e.status !== 404) throw e; // 404: expired, or a server restart wiped it
    }
  }
  const fresh = await api('/subscriber', { method: 'POST' });
  localStorage.setItem(SUB_KEY, fresh.token);
  return fresh;
}

// The QR stays on screen whether or not the chat is linked - only the badge changes.
// It is hidden in exactly one case: no bot is configured, so there is nothing to offer.
function showSubscription(s) {
  subscriber = s.token;
  if (!s.telegram_link) {
    notify.hidden = true;
    return;
  }
  qrLink.href = s.telegram_link;
  const src = `${WORKER}/subscriber/${s.token}/qr.svg`;
  // A failed image is retried on the next poll; comparing against the token rather than
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

async function watchSubscription() {
  try {
    showSubscription(await subscribe());
  } catch (e) {
    notify.hidden = true; // no channel to offer - the page still works without one
  }
  setTimeout(watchSubscription, SUB_POLL_MS);
}

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
    const s = await api(`/session/${currentSession.session_id}/frame`, { method: 'POST', body: fd });
    // Concurrent uploads can resolve out of order — drop a response older than
    // the newest one already rendered.
    if (session !== currentSession) return;
    if (mySeq > lastRenderedSeq) {
      lastRenderedSeq = mySeq;
      render(s);
    }
  } catch (e) {
    if (session !== currentSession) return;
    if (e.status === 404) { stop('Session expired — start again.'); return; }
    say(`Upload failed: ${e.message}`, true);
  } finally {
    if (session === currentSession) outstanding--;
  }
}

// ---------- rules ----------
// One list, two sources: `pending` before Watch, the server's watches once a session runs.
// Adding and removing go through the same buttons either way; while running they also
// hit the server, and the updates stream brings back the list (Telegram edits included).
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
    const r = await api(`/session/${currentSession.session_id}/watches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: text }),
    });
    if (session !== currentSession) return;
    session.watches = r.watches;
    rule.value = '';
    renderRules();
    renderUsage(r.usage);
    say('Watching.');
  } catch (e) {
    if (session !== currentSession) return;
    if (e.status === 404) { stop('Session expired — start again.'); return; }
    say(e.message, true);
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
    await api(`/session/${currentSession.session_id}/watches/${i}`, { method: 'DELETE' });
    if (session !== currentSession) return;
    session.watches.splice(i, 1); // the stream confirms shortly; don't wait for it
    renderRules();
  } catch (e) {
    if (session !== currentSession) return;
    if (e.status === 404) { stop('Session expired — start again.'); return; }
    say(e.message, true);
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
  try {
    const created = await api('/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules, subscriber: subscriber }),
    });
    if (attempt !== generation) {
      api(`/session/${created.session_id}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    session = created;
  } catch (e) {
    if (attempt !== generation) return;
    startBtn.disabled = false;
    if (e.status === 503) { say('The room is full right now. Try again in a minute.', true); return; }
    say(e.message, true);
    return;
  }
  startBtn.disabled = false;
  startBtn.hidden = true; stopBtn.hidden = false; restartBtn.hidden = false;
  pending = []; rule.value = '';
  lastRevision = -1; announcedEvents = 0;
  renderUsage(session.usage);
  startedAt = Date.now(); showElapsed(); clock = setInterval(showElapsed, 1000);
  renderRules();
  events.innerHTML = ''; knownEvents = 0; evidence.textContent = '—';
  outstanding = 0; uploadSeq = 0; lastRenderedSeq = -1;
  setPill(statePill, 'unknown', 'idle');
  say('Watching.');
  connectUpdates();
  tick();
}

async function restart() {
  if (!session) return;
  const deletion = stop(undefined, true);
  const attempt = generation;
  await deletion;
  if (attempt === generation) await start(rulesToStart());
}

function stop(message, keepCamera = false) {
  generation++;
  if (updates) { updates.close(); updates = null; }
  clearTimeout(timer); timer = null;
  const deletion = session ? api(`/session/${session.session_id}`, { method: 'DELETE' }).catch(() => {}) : Promise.resolve();
  if (session) pending = session.watches.map((w) => w.rule); // the rules stay editable for the next Watch
  session = null;
  if (!keepCamera) releaseCamera();
  startBtn.disabled = false; addBtn.disabled = false;
  startBtn.hidden = false; stopBtn.hidden = true; restartBtn.hidden = true;
  renderRules();
  clearInterval(clock); clock = null;
  setPill(gatePill, keepCamera ? 'ready' : 'camera off', 'idle'); setPill(statePill, 'no rule', 'idle');
  say(message || 'Stopped.');
  return deletion;
}

// ---------- render ----------
const GATE_LABEL = { first: 'first frame', skip: 'quiet', change: 'change', light: 'light changed' };
const GATE_TONE = { first: 'send', skip: 'idle', change: 'warn', light: 'info' };

function render(s) {
  if (!session) return; // response arrived after Stop cleared the session — nothing to render
  const label = s.sent ? 'asking the model' : s.busy ? 'model busy' : GATE_LABEL[s.gate] + (s.streak ? ` ×${s.streak}` : '');
  setPill(gatePill, label, s.sent ? 'send' : GATE_TONE[s.gate]);
  renderDetection(s);
}

function connectUpdates() {
  const currentSession = session;
  updates = new EventSource(`${WORKER}/session/${session.session_id}/updates`);
  updates.onmessage = (event) => {
    if (session === currentSession) renderDetection(JSON.parse(event.data));
  };
  updates.addEventListener('expired', () => {
    if (session === currentSession) stop('Session expired — start again.');
  });
}

function renderDetection(s) {
  if (!session || (s.revision !== undefined && s.revision < lastRevision)) return;
  if (s.revision !== undefined) lastRevision = s.revision;
  if (s.watches) {
    session.watches = s.watches; // Telegram may have edited the rules
    renderRules();
    const known = s.watches.filter((w) => w.state !== null);
    const yes = known.filter((w) => w.state).length;
    if (!known.length) setPill(statePill, 'unknown', 'idle');
    else if (s.watches.length === 1) setPill(statePill, yes ? 'TRUE' : 'false', yes ? 'true' : 'false');
    else setPill(statePill, `${yes}/${s.watches.length} true`, yes ? 'true' : 'false');
    const seen = s.watches.map((w) => w.evidence).filter(Boolean);
    evidence.textContent = seen.length ? seen.map((e) => `“${e}”`).join(' · ') : '—';
  }
  if (s.events > knownEvents) refreshEvents(s.events);
  if (s.events > announcedEvents) {
    announcedEvents = s.events;
    flash(); showToast('Event! ' + (s.last_event || ''));
  }
  if (s.usage) renderUsage(s.usage);
}

function renderUsage(u) {
  usage.textContent = u.total.toLocaleString();
  usage.title = `${u.prompt} in / ${u.completion} out, ${u.calls} calls`;
  cost.textContent = u.usd < 0.01 ? `$${u.usd.toFixed(4)}` : `$${u.usd.toFixed(2)}`;
}

// Fetches the event list and only advances knownEvents once it actually succeeds,
// so a Stop or a failed request mid-refresh never drops an event or throws unhandled.
async function refreshEvents(count) {
  if (!session) return;
  const sid = session.session_id;
  try {
    const view = await api(`/session/${sid}`);
    if (!session || session.session_id !== sid) return; // stopped (or restarted) mid-refresh
    events.innerHTML = '';
    for (const e of [...view.events].reverse()) {
      const li = document.createElement('li');
      const src = `${WORKER}/session/${sid}/events/${e.n}.jpg`;
      const at = new Date(e.at).toLocaleTimeString();
      // The thumbnail is a button: the stored frame is 640px wide, so the dialog shows
      // it several times larger than the list ever can.
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
      const cap = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = e.rule ? `${e.rule} — ${e.text}` : e.text;
      const time = document.createElement('time');
      time.textContent = at;
      cap.append(b, time);
      li.append(shot, cap);
      events.append(li);
    }
    knownEvents = count;
  } catch (e) {
    // Leave knownEvents alone — the next status with more events retries the refresh.
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
window.addEventListener('pagehide', () => { if (updates) updates.close(); if (session) navigator.sendBeacon && fetch(`${WORKER}/session/${session.session_id}`, { method: 'DELETE', keepalive: true }); releaseCamera(); });

// ---------- dictation ----------
// Browser-native speech-to-text for the rule box. No backend, no upload. Where the API is
// missing (Firefox), the button stays hidden and typing is the only path — no regression.
(function setupDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // unsupported — leave the mic button hidden
  const recognition = new SR();
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = true;
  // Keep listening until the user taps off. Chrome's default (continuous=false) cuts out on
  // the first pause, which reads as the mic "turning itself off" mid-sentence — not wanted.
  recognition.continuous = true;
  let listening = false;
  let base = ''; // text already in the box when dictation started — new words append to it

  function setListening(on) {
    listening = on;
    mic.classList.toggle('listening', on);
    mic.setAttribute('aria-pressed', on ? 'true' : 'false');
    mic.title = on ? 'Stop dictation' : 'Dictate rule';
  }

  // continuous=true keeps finalized segments in e.results, so read the whole list, not just
  // the latest chunk — otherwise earlier words vanish once a new segment finalizes.
  recognition.addEventListener('result', (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    rule.value = (base + text).trimStart();
  });
  recognition.addEventListener('error', (e) => {
    setListening(false);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') say('Microphone blocked — allow it or type the rule.', true);
    else if (e.error !== 'aborted' && e.error !== 'no-speech') say(`Dictation error: ${e.error}`, true);
  });
  // Whatever ends the run — user tap, silence timeout, network — the button returns to idle.
  recognition.addEventListener('end', () => setListening(false));

  mic.addEventListener('click', () => {
    if (listening) {
      // abort() stops immediately; stop() lingers waiting for a final result, which is what
      // made "off" feel unresponsive. The interim text is already in the box, so nothing lost.
      setListening(false);
      recognition.abort();
      return;
    }
    base = rule.value ? rule.value.trimEnd() + ' ' : '';
    try { recognition.start(); setListening(true); }
    catch (_) { /* already starting — ignore the double click */ }
  });

  mic.hidden = false;
})();

watchSubscription();
openCamera()
  .then(revealFlipIfMultiCamera)
  .catch((e) => say(`Camera unavailable: ${e.message}. Use https:// or localhost.`, true));
