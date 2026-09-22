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
    fetch: () => new Promise(() => {}),
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {},
    FormData: class { append() {} }, Date, Promise,
  });
  element('limit').hidden = true;
  element('video').readyState = 1;
  element('video').videoWidth = 1280; element('video').videoHeight = 720;
  const run = (code) => vm.runInContext(code, context);
  run(fs.readFileSync('static/app.js', 'utf8'));
  const push = (name, value) => subscriptions.filter((s) => s.active && s.name === name).forEach((s) => s.callback(value));
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { element, run, calls, subscriptions, push, settle, storage };
}

const live = (watches, status = 'active') => ({
  status, watches, startedAt: Date.now(), limitAt: Date.now() + 600000, telegram: false,
  usage: { prompt: 700, completion: 30, calls: 1, usdTicks: 20500000 },
});
// Objects made inside the vm context have another realm's prototypes: compare as JSON.
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));
const cat = { id: 'w1', rule: 'cat arrives', predicate: 'a cat is visible', direction: 'rising', state: null, evidence: '' };

test('Watch starts a session in Convex, live queries drive the page, Stop ends it', async () => {
  const p = page({ answers: { 'subscribers:create': 'sub1', 'sessions:start': { sessionId: 's1' } } });
  await p.settle();
  await p.run("start(['cat arrives'])");
  same(p.calls.find((c) => c[1] === 'sessions:start')[2], { rules: ['cat arrives'], subscriber: 'sub1' });
  assert.equal(p.storage['watcher.session'], 's1');

  p.push('sessions:live', live([{ ...cat, state: true, evidence: 'a tabby on the sofa' }]));
  assert.equal(p.element('state').textContent, 'TRUE');
  assert.equal(p.element('evidence').textContent, '“a tabby on the sofa”');
  assert.equal(p.element('usage').textContent, '730');
  assert.equal(p.element('cost').textContent, '$0.0021');

  const event = { id: 'e1', at: Date.now(), text: 'a cat is visible - became true', rule: 'cat arrives', url: 'https://x/p.jpg' };
  p.push('events:list', [event]); // what was there when the page subscribed is history, not news
  assert.equal(p.element('toast').textContent, '');
  p.push('events:list', [event, { ...event, id: 'e2', text: 'again' }]);
  assert.equal(p.element('toast').textContent, 'Event! again');
  assert.equal(p.element('events').children.length, 2);

  await p.run('stop()');
  same(p.calls.at(-1), ['mutation', 'sessions:stop', { sessionId: 's1' }]);
  assert.ok(p.subscriptions.filter((s) => s.name !== 'subscribers:get').every((s) => !s.active));
  assert.equal(p.storage['watcher.session'], undefined);
  assert.equal(p.run('pending[0]'), 'cat arrives'); // the rules stay for the next Watch
});

test('Stop while the session is still being created stops the one that arrives late', async () => {
  let created;
  const p = page({ answers: { 'subscribers:create': 'sub1', 'sessions:start': () => new Promise((r) => { created = r; }) } });
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
  const known = { 'subscribers:get': { linked: false, limitAt: Date.now() + 600000 } };

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

test("a visitor's own expired limit never stops a session opened by a shared link", async () => {
  const stored = { 'watcher.subscriber': 'guest' };
  const expired = { linked: false, limitAt: Date.now() - 1000 };
  const p = page({ stored, search: '?session=s1', answers: { 'subscribers:get': expired, 'sessions:live': live([cat]) } });
  await p.settle();
  assert.equal(p.run('session.id'), 's1'); // resumed from the link
  assert.ok(p.calls.some((c) => c[1] === 'presence:heartbeat')); // at once, not in 20 s
  p.push('subscribers:get', expired);
  assert.equal(p.element('limit').hidden, true); // the visitor's own limit is not this session's
  p.push('subscribers:get', { ...expired, linked: true }); // e.g. the visitor links Telegram
  assert.equal(p.run('session.id'), 's1');
  assert.ok(!p.calls.some((c) => c[1] === 'sessions:stop'));

  p.push('sessions:live', { ...live([cat]), limitAt: Date.now() - 1 }); // the owner's limit does stop it
  assert.equal(p.run('session'), null);
  assert.equal(p.element('limit').hidden, false);
  assert.equal(p.element('start').disabled, true);
});

test('a renewed limit hides the banner and frees the Watch button', async () => {
  const stored = { 'watcher.subscriber': 'sub1' };
  const p = page({ stored, answers: { 'subscribers:get': { linked: false, limitAt: Date.now() - 1000 } } });
  await p.settle();
  p.push('subscribers:get', { linked: false, limitAt: Date.now() - 1000 });
  assert.equal(p.element('limit').hidden, false);
  assert.equal(p.element('start').disabled, true);
  // what subscribers:renew makes subscribers:get push
  p.push('subscribers:get', { linked: false, limitAt: Date.now() + 600000 });
  assert.equal(p.element('limit').hidden, true);
  assert.equal(p.element('start').disabled, false);
});
