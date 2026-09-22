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

test('real browser: key survives tab closure, recovery works elsewhere, Python output decrypts, corruption fails', async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    const device = await browser.newContext();
    let page = await pageWithCrypto(device);
    const saved = await page.evaluate(async () => {
      const key = await Privacy.current();
      const text = 'Личный промпт 🔑 '.repeat(1000); // bigger than direct RSA can encrypt
      const encrypted = await Privacy.encrypt(text, key, 'rule');
      const second = await Privacy.encrypt(text, key, 'rule');
      return { key, text, encrypted, second, backup: await Privacy.exportBackup(key, ['session1']) };
    });
    assert.notEqual(saved.encrypted, saved.second);
    assert.ok(!saved.encrypted.includes('Личный'));
    await page.close();
    page = await pageWithCrypto(device);
    assert.equal(await page.evaluate(() => Privacy.current()), saved.key);
    const counts = await page.evaluate(async s => {
      let rsa = 0, aes = 0, reads = 0;
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      const transaction = IDBDatabase.prototype.transaction;
      crypto.subtle.decrypt = (...args) => {
        if (args[0].name === 'RSA-OAEP') rsa++; else aes++;
        return decrypt(...args);
      };
      IDBDatabase.prototype.transaction = function(...args) {
        if (args[1] === 'readonly') reads++;
        return transaction.apply(this, args);
      };
      try {
        await Promise.all(Array.from({ length: 10 }, () => Privacy.decrypt(s.encrypted, s.key, 'rule')));
        await Privacy.decrypt(s.encrypted, s.key, 'rule');
        await Privacy.decrypt(s.second, s.key, 'rule');
        return { rsa, aes, reads };
      } finally {
        crypto.subtle.decrypt = decrypt;
        IDBDatabase.prototype.transaction = transaction;
      }
    }, saved);
    assert.deepEqual(counts, { rsa: 2, aes: 2, reads: 1 });
    assert.equal(await page.evaluate(s => Privacy.decrypt(s.encrypted, s.key, 'rule'), saved), saved.text);

    const newDevice = await browser.newContext();
    const other = await pageWithCrypto(newDevice);
    await assert.rejects(other.evaluate(s => Privacy.decrypt(s.encrypted, s.key, 'rule'), saved), /History locked/);
    await other.evaluate(backup => Privacy.importBackup(backup), saved.backup);
    assert.equal(await other.evaluate(s => Privacy.decrypt(s.encrypted, s.key, 'rule'), saved), saved.text);
    await assert.rejects(other.evaluate(s => Privacy.decrypt(s.encrypted, s.key, 'predicate'), saved), /Cannot decrypt/);
    const corrupt = await other.evaluate(s => {
      const box = JSON.parse(s.encrypted.slice(7));
      box.data = (box.data[0] === 'A' ? 'B' : 'A') + box.data.slice(1);
      return 'enc:v1:' + JSON.stringify(box);
    }, saved);
    await assert.rejects(other.evaluate(({ key, corrupt }) => Privacy.decrypt(corrupt, key, 'rule'), { key: saved.key, corrupt }), /Cannot decrypt/);

    const pythonCiphertext = execFileSync('poetry', ['run', 'python', '-c',
      'import json,sys; from src.server.privacy import encrypt; a=json.load(sys.stdin); sys.stdout.write(encrypt(a["text"],a["key"],"evidence"))'],
    { input: JSON.stringify({ text: saved.text, key: saved.key }), encoding: 'utf8' });
    assert.equal(await other.evaluate(({ ciphertext, key }) => Privacy.decrypt(ciphertext, key, 'evidence'), { ciphertext: pythonCiphertext, key: saved.key }), saved.text);

    const badBackup = JSON.parse(saved.backup);
    badBackup.publicKey = await page.evaluate(async () => {
      localStorage.removeItem('watcher.publicKey');
      return Privacy.current();
    });
    await assert.rejects(other.evaluate(backup => Privacy.importBackup(backup), JSON.stringify(badBackup)));
    assert.equal(await other.evaluate(s => Privacy.decrypt(s.encrypted, s.key, 'rule'), saved), saved.text);
  } finally { await browser.close(); }
});

test('page UI: encrypted save, reload, Stop, import an older backup on another device', async () => {
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
    // Backup before any sessions exist must still recover sessions created later.
    await page.getByText('Encrypted history & recovery key', { exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportKey').click();
    const stream = await (await downloadPromise).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const backup = Buffer.concat(chunks);
    await page.locator('#rule').fill('my private cat prompt');
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#rules').textContent.includes('my private cat prompt'));
    assert.ok(!JSON.stringify([...records]).includes('my private cat prompt'));
    assert.ok(!JSON.stringify(calls).includes('my private cat prompt'));
    assert.ok(!JSON.stringify(calls).includes('privateKey'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#rules').textContent.includes('my private cat prompt'));
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Stopped.');
    assert.equal(records.get('session1').status, 'archived');

    const other = await open(await browser.newContext());
    await other.locator('#keyFile').setInputFiles({ name: 'watcher-recovery.json', mimeType: 'application/json', buffer: backup });
    await other.waitForFunction(() => document.querySelector('#historyList').options.length === 2);
    await other.getByText('Encrypted history & recovery key', { exact: true }).click();
    await other.locator('#historyList').selectOption('session1');
    await other.waitForFunction(() => document.querySelector('#status').textContent.includes('Saved history unlocked'));
    assert.ok((await other.locator('#rules').textContent()).includes('my private cat prompt'));
  } finally { await browser.close(); }
});
