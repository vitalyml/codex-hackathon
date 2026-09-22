// node --test tests/test_web_client.js — static/app.js against a fake Convex client.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function page({ stored = {}, search = '', answers = {} } = {}) {
  const elements = new Map();
  const make = () => ({
    textContent: '', value: '1000', disabled: false, hidden: false, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeAttribute(name) { delete this[name]; }, setAttribute() {},
    append(...kids) { this.children.push(...kids); }, focus() {},
    set innerHTML(_) { this.children = []; },
  });
  const element = (id) => elements.get(id) || elements.set(id, make()).get(id);
  const calls = [], subscriptions = [];
  class ConvexClient {
    async query(name, args) { calls.push(['query', name, args]); return answer(name, args); }
    async mutation(name, args) { calls.push(['mutation', name, args]); return answer(name, args); }
    async action(name, args) { calls.push(['action', name, args]); return answer(name, args); }
    onUpdate(name, args, callback) {
      const sub = { name, args, callback, active: true };
      subscriptions.push(sub);
      return () => { sub.active = false; };
    }
  }
  const answer = (name, args) => (typeof answers[name] === 'function' ? answers[name](args) : answers[name]);
  const storage = { ...stored };
  const context = vm.createContext({
    document: {
      getElementById: element, createElement: make, body: { classList: { add() {}, remove() {} } },
      addEventListener() {}, visibilityState: 'visible',
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    window: { addEventListener() {}, CONVEX_URL: 'https://x.convex.cloud', TELEGRAM_BOT_USERNAME: 'cam_bot' },
    convex: { ConvexClient },
    location: { search, pathname: '/' },
    history: { replaceState(_, __, url) { context.location.search = url.startsWith('?') ? url : ''; } },
    URLSearchParams,
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = v; }, removeItem: (k) => { delete storage[k]; },
    },
    fetch: async () => ({ ok: true, json: async () => ({ specs: [{ predicate: 'cat', direction: 'rising', usage: { prompt: 1, completion: 0, calls: 1, usdTicks: 0 } }] }) }),
    Privacy: { current: async () => 'public', encrypt: async (text) => 'enc:v1:' + text, requireKey: async () => {}, decrypt: async (text) => text },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {},
    FormData: class { append() {} }, Date, Promise,
    URL: { createObjectURL: () => 'blob:frame', revokeObjectURL() {} },
  });
  element('video').readyState = 1;
  element('video').videoWidth = 1280; element('video').videoHeight = 720;
  const run = (code) => vm.runInContext(code, context);
  run(fs.readFileSync('static/app.js', 'utf8'));
  const push = (name, value) => subscriptions.filter((s) => s.active && s.name === name).forEach((s) => s.callback(value));
  const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
  return { element, run, calls, subscriptions, push, settle, storage };
}

const live = (watches, status = 'active') => ({
  status, watches, startedAt: Date.now(), telegram: false,
  usage: { prompt: 700, completion: 30, calls: 1, usdTicks: 20500000 },
});
// Objects made inside the vm context have another realm's prototypes: compare as JSON.
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));
const cat = { id: 'w1', rule: 'cat arrives', predicate: 'a cat is visible', direction: 'rising', state: null, evidence: '' };

test('Watch starts a session in Convex, live queries drive the page, Stop ends it', async () => {
  const p = page({ answers: { 'subscribers:create': 'sub1', 'sessions:startEncrypted': { sessionId: 's1' } } });
  await p.settle();
  await p.run("start(['cat arrives'])");
  const createdCall = p.calls.find((c) => c[1] === 'sessions:startEncrypted');
  assert.equal(createdCall[0], 'mutation');
  const sent = createdCall[2];
  assert.equal(sent.encryptionKey, 'public');
  assert.equal(sent.watches[0].rule, 'enc:v1:cat arrives');
  assert.equal(sent.watches[0].predicate, 'enc:v1:cat');
  assert.equal(sent.subscriber, 'sub1');
  assert.equal(p.storage['watcher.session'], 's1');

  p.push('sessions:live', live([{ ...cat, state: true, evidence: 'a tabby on the sofa' }]));
  await p.settle();
  assert.equal(p.element('state').textContent, 'TRUE');
  assert.equal(p.element('evidence').textContent, '“a tabby on the sofa”');
  assert.equal(p.element('usage').textContent, '730');
  assert.equal(p.element('cost').textContent, '$0.0021');

  const event = { id: 'e1', at: Date.now(), text: 'a cat is visible - became true', rule: 'cat arrives', callId: 'c1' };
  p.push('events:list', [event]);
  await p.settle(); // what was there when the page subscribed is history, not news
  assert.equal(p.element('toast').textContent, '');
  p.run("keepFrame('c2', {})"); // the frame that started call c2 stays in this tab only
  p.push('events:list', [event, { ...event, id: 'e2', text: 'again', callId: 'c2' }]);
  await p.settle();
  assert.equal(p.element('toast').textContent, 'Event! again');
  const [newest, older] = p.element('events').children;
  assert.equal(newest.children.length, 2); // the photo, then the caption
  assert.equal(older.children.length, 1);  // no frame for c1: caption only
  // Frames of calls that fired nothing are few and rotate; a shown event keeps its frame.
  for (let i = 0; i < 20; i++) p.run(`keepFrame('quiet${i}', {})`);
  assert.ok(p.run("frames.has('c2') && !frames.has('quiet0') && frames.has('quiet19')"));
  // The worker's answer naming c1 arrives after the event did: the card gets its photo.
  p.run("keepFrame('c1', {})");
  assert.equal(p.element('events').children[1].children.length, 2);

  await p.run('stop()');
  same(p.calls.at(-1), ['mutation', 'sessions:stop', { sessionId: 's1' }]);
  assert.ok(p.subscriptions.filter((s) => s.name !== 'subscribers:get').every((s) => !s.active));
  assert.equal(p.storage['watcher.session'], undefined);
  assert.equal(p.run('pending[0]'), 'cat arrives'); // the rules stay for the next Watch
});

test('Stop while the session is still being created stops the one that arrives late', async () => {
  let created;
  const p = page({ answers: { 'subscribers:create': 'sub1', 'sessions:startEncrypted': () => new Promise((r) => { created = r; }) } });
  await p.settle();
  const starting = p.run("start(['cat arrives'])");
  await p.settle();
  p.run('stop()');
  created({ sessionId: 'late' });
  await starting;
  assert.equal(p.run('session'), null);
  same(p.calls.at(-1), ['mutation', 'sessions:stop', { sessionId: 'late' }]);
});

test('a reload resumes an active session, forgets a stopped one, and obeys a remote stop', async () => {
  const stored = { 'watcher.subscriber': 'sub1', 'watcher.session': 's1' };
  const known = { 'subscribers:get': { linked: false } };

  const gone = page({ stored, answers: { ...known, 'sessions:live': live([cat], 'stopped') } });
  await gone.settle();
  assert.equal(gone.run('session'), null);
  assert.equal(gone.storage['watcher.session'], undefined);
  assert.equal(gone.element('status').textContent, 'Session expired — start again.');

  const p = page({ stored, answers: { ...known, 'sessions:live': live([cat]) } });
  await p.settle();
  assert.equal(p.run('session.id'), 's1');
  p.push('sessions:live', live([cat]));
  assert.equal(p.run('session.watches[0].rule'), 'cat arrives');
  // the sweep, or Stop in another tab: nothing to stop in Convex any more
  p.push('sessions:live', live([cat], 'stopped'));
  assert.equal(p.run('session'), null);
  assert.ok(!p.calls.some((c) => c[1] === 'sessions:stop'));
});


test('a failed live decryption releases the session, timers and subscriptions', async () => {
  const p = page({ answers: { 'subscribers:create': 'sub1', 'sessions:startEncrypted': { sessionId: 's1' } } });
  await p.settle();
  await p.run("start(['cat arrives'])");
  p.run("Privacy.decrypt = async () => { throw new Error('damaged history'); }");
  p.push('sessions:live', { ...live([cat]), encryptionKey: 'public' });
  await p.settle();
  assert.equal(p.run('session'), null);
  assert.equal(p.run('heartbeat'), null);
  assert.equal(p.run('timer'), null);
  assert.ok(p.subscriptions.filter(s => s.name !== 'subscribers:get').every(s => !s.active));
  assert.equal(p.element('stop').hidden, true);
  assert.equal(p.element('start').hidden, false);
  assert.equal(p.element('status').textContent, 'damaged history');
  assert.ok(p.calls.some(c => c[1] === 'sessions:stop'));
});

test('remote legacy stop never promises saved encrypted history', async () => {
  const p = page();
  await p.settle();
  p.run("adopt('legacy', Date.now())");
  p.push('sessions:live', live([cat], 'stopped'));
  assert.equal(p.element('status').textContent, 'Session expired — start again.');
});

test('imported history is sorted by timestamp instead of insertion order', async () => {
  const p = page({ stored: { 'watcher.history': JSON.stringify({ newest: { startedAt: 30 }, oldest: { startedAt: 10 }, middle: { startedAt: 20 } }) } });
  await p.settle();
  p.run('showHistory()');
  assert.deepEqual(p.element('historyList').children.map(o => o.value), ['', 'newest', 'middle', 'oldest']);
});
