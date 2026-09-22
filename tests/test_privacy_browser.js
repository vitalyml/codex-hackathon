// Run with Playwright available: node --test tests/test_privacy_browser.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const fs = require('node:fs');

async function pageWithCrypto(context) {
  const page = await context.newPage();
  await page.route('https://watcher.test/**', route => route.fulfill({ body: '<!doctype html><title>Privacy test</title>', contentType: 'text/html' }));
  await page.goto('https://watcher.test/');
  await page.addScriptTag({ path: 'static/privacy.js' });
  return page;
}

test('keys are memory-only, non-exportable, reset on stop and lost on reload or tab closure', async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    const device = await browser.newContext();
    const page = await pageWithCrypto(device);
    const saved = await page.evaluate(async () => {
      const keys = await Promise.all([Privacy.current(), Privacy.current()]);
      if (keys[0] !== keys[1]) throw new Error('Concurrent key creation');
      const key = keys[0];
      const text = 'Личный промпт '.repeat(1000);
      return { key, text, encrypted: await Privacy.encrypt(text, key, 'rule') };
    });
    assert.ok(!saved.encrypted.includes('Личный'));
    assert.equal(await page.evaluate(s => Privacy.decrypt(s.encrypted, s.key, 'rule'), saved), saved.text);
    assert.equal(await page.evaluate(async key => (await Privacy.requireKey(key)).extractable, saved.key), false);
    await assert.rejects(page.evaluate(s => Privacy.decrypt(s.encrypted, s.key, 'predicate'), saved), /Cannot read session/);
    const pythonCiphertext = execFileSync('poetry', ['run', 'python', '-c',
      'import json,sys; from src.server.privacy import encrypt; a=json.load(sys.stdin); sys.stdout.write(encrypt(a["text"],a["key"],"evidence"))'],
    { input: JSON.stringify({ text: saved.text, key: saved.key }), encoding: 'utf8' });
    assert.equal(await page.evaluate(({ ciphertext, key }) => Privacy.decrypt(ciphertext, key, 'evidence'), { ciphertext: pythonCiphertext, key: saved.key }), saved.text);
    assert.equal(await page.evaluate(() => localStorage.getItem('watcher.publicKey')), null);
    assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name)), []);
    await page.evaluate(() => Privacy.reset());
    await assert.rejects(page.evaluate(s => Privacy.decrypt(s.encrypted, s.key, 'rule'), saved), /Session ended/);
    const nextKey = await page.evaluate(() => Privacy.current());
    assert.notEqual(nextKey, saved.key);
    await page.reload();
    await page.addScriptTag({ path: 'static/privacy.js' });
    await assert.rejects(page.evaluate(key => Privacy.requireKey(key), nextKey), /Session ended/);
    const closingKey = await page.evaluate(() => Privacy.current());
    await page.close();
    const other = await pageWithCrypto(device);
    await assert.rejects(other.evaluate(key => Privacy.requireKey(key), closingKey), /Session ended/);
    await assert.rejects(other.evaluate(async () => {
      const creating = Privacy.current();
      Privacy.reset();
      await creating;
    }), /Session ended/);
  } finally { await browser.close(); }
});

test('page UI: automatic session keys, Stop, restart and reload without recovery UI', async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const records = new Map();
  const calls = [];
  async function open(context) {
    const page = await context.newPage();
    await page.exposeFunction('rpc', (name, args) => {
      calls.push({ name, args });
      if (name === 'subscribers:create') return 'browser';
      if (name === 'subscribers:get') return { linked: false };
      if (name === 'sessions:startEncrypted') {
        const id = `session${records.size + 1}`;
        records.set(id, { ...args, status: 'active', startedAt: Date.now(), telegram: false,
          watches: args.watches.map((w, i) => ({ ...w, id: `w${i}`, state: null, evidence: '' })) });
        return { sessionId: id };
      }
      if (name === 'sessions:live') return records.get(args.sessionId) || null;
      if (name === 'sessions:stop') { records.get(args.sessionId).status = 'archived'; return null; }
      if (name === 'sessions:history') return [...records].filter(([, s]) => s.encryptionKey === args.encryptionKey).map(([id, s]) => ({ id, startedAt: s.startedAt }));
      if (name === 'events:list') return [];
      if (name === 'presence:heartbeat') return null;
      throw new Error(`Unexpected call: ${name}`);
    });
    await page.route('https://watcher.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/normalize') return route.fulfill({ json: { specs: [{ predicate: 'a cat is visible', direction: 'rising', usage: { prompt: 1, completion: 0, calls: 1, usdTicks: 0 } }] } });
      if (path.endsWith('/frame')) return route.fulfill({ json: { gate: 'skip', sent: false, busy: false } });
      if (path === '/static/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.CONVEX_URL="https://fake.convex.cloud";' });
      if (path === '/static/vendor/convex-browser.bundle.js') return route.fulfill({ contentType: 'text/javascript', body: `window.convex = { ConvexClient: class {
        query(n,a) { return window.rpc(n,a); } mutation(n,a) { return window.rpc(n,a); } action(n,a) { return window.rpc(n,a); }
        onUpdate(n,a,cb) { let active=true; window.rpc(n,a).then(v=>{if(active)cb(v)}); return ()=>{active=false}; }
      }};` });
      const file = path === '/' ? 'static/index.html' : path.slice(1);
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('https://watcher.test/');
    await page.waitForFunction(() => subscriber === 'browser');
    return page;
  }
  try {
    const page = await open(await browser.newContext());
    assert.equal(await page.locator('#exportKey, #importKey, #historyList').count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /encrypt|recovery|protected/i);
    await page.locator('#rule').fill('my private cat prompt');
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#rules').textContent.includes('my private cat prompt'));
    assert.ok(!JSON.stringify([...records]).includes('my private cat prompt'));
    assert.ok(!JSON.stringify(calls).includes('my private cat prompt'));
    assert.ok(!JSON.stringify(calls).includes('privateKey'));
    const firstKey = records.get('session1').encryptionKey;
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Stopped.');
    assert.equal(records.get('session1').status, 'archived');
    await assert.rejects(page.evaluate(key => Privacy.requireKey(key), firstKey), /Session ended/);
    await page.locator('#start').click();
    await page.waitForFunction(() => session?.id === 'session2');
    assert.notEqual(records.get('session2').encryptionKey, firstKey);
    await page.reload();
    await page.waitForFunction(() => subscriber === 'browser');
    assert.equal(await page.evaluate(() => session), null);
    assert.equal(await page.locator('#start').isVisible(), true);
    assert.ok(!(await page.locator('#rules').textContent()).includes('my private cat prompt'));
    await assert.rejects(page.evaluate(key => Privacy.requireKey(key), firstKey), /Session ended/);
  } finally { await browser.close(); }
});
