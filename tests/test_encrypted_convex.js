// Actual Convex handlers with an in-memory database; no deployment or credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

function load(file) {
  const code = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['convex/server', 'convex/values'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require, process, console, setTimeout, clearTimeout });
  return module.exports;
}
const sessions = load('convex/sessions.ts');
const watches = load('convex/watches.ts');
const crons = load('convex/crons.ts');
const worker = load('convex/worker.ts');

test('protected sessions survive Stop and cleanup; legacy sessions still expire', async () => {
  let scheduled = 0;
  const protectedSession = { _id: 's', encryptionKey: 'public', status: 'active' };
  const ctx = {
    db: { get: async () => protectedSession, patch: async (_, patch) => Object.assign(protectedSession, patch) },
    scheduler: { runAfter: async () => { scheduled++; } },
  };
  await crons.stopSession(ctx, 's');
  assert.equal(protectedSession.status, 'archived');
  assert.equal(scheduled, 0);
  await crons.cleanup._handler(ctx, { resume: 's' }); // no deletion attempted
  delete protectedSession.encryptionKey;
  await crons.stopSession(ctx, 's');
  assert.equal(scheduled, 1);
});

test('encrypted creation rejects plaintext before any mutation', async () => {
  const args = { watches: [{ rule: 'private', predicate: 'private predicate', direction: 'rising' }], encryptionKey: 'MIIBpublic', usage: { prompt: 0, completion: 0, calls: 0, usdTicks: 0 } };
  const result = await sessions.startEncrypted._handler({}, args);
  assert.equal(result.error, 'encryption_required');
});

test('protected watches reject plaintext additions and worker records', async () => {
  const usage = { prompt: 0, completion: 0, calls: 0, usdTicks: 0 };
  const session = { _id: 's', encryptionKey: 'public', status: 'active', usage };
  const ctx = { db: { get: async id => id === 's' ? session : { _id: 'w', sessionId: 's' }, patch: async () => {} } };
  const added = await watches.addEncrypted._handler(ctx, { sessionId: 's', usage, watch: { rule: 'secret', predicate: 'secret', direction: 'rising' } });
  assert.equal(added.error, 'encrypted_session');
  const original = process.env.WORKER_SECRET;
  process.env.WORKER_SECRET = 'test-secret';
  try {
    await assert.rejects(worker.record._handler(ctx, { secret: 'test-secret', sessionId: 's', callId: 'c', usage, results: [{ watchId: 'w', state: true, evidence: 'private' }] }), /encryption_required/);
  } finally {
    if (original === undefined) delete process.env.WORKER_SECRET;
    else process.env.WORKER_SECRET = original;
  }
});


test('cleanup upgrades old retained rows once using only the stopped index', async () => {
  const row = { _id: 'old', status: 'stopped', encryptionKey: 'public' };
  let scanned = false, scheduled = false;
  const ctx = {
    db: {
      query: () => ({ withIndex: (name, bounds) => {
        assert.equal(name, 'by_status');
        bounds({ eq: (field, value) => { assert.equal(field, 'status'); assert.equal(value, 'stopped'); } });
        scanned = true;
        return { first: async () => row.status === 'stopped' ? row : null };
      }}),
      patch: async (_, patch) => Object.assign(row, patch),
    },
    scheduler: { runAfter: async () => { scheduled = true; } },
  };
  await crons.cleanup._handler(ctx, {});
  assert.ok(scanned && scheduled);
  assert.equal(row.status, 'archived');
  scheduled = false;
  await crons.cleanup._handler(ctx, {});
  assert.equal(scheduled, false);
});

test('encrypted start creates records directly in its mutation and enforces capacity', async () => {
  assert.equal(sessions.startEncrypted.isMutation, true);
  const rows = [];
  let active = [];
  const ctx = { db: {
    query: () => ({ withIndex: () => ({ collect: async () => active }) }),
    insert: async (table, row) => { rows.push({ table, row }); return table === 'sessions' ? 's' : 'other'; },
  }};
  const args = { watches: [{ rule: 'enc:v1:r', predicate: 'enc:v1:p', direction: 'rising' }], encryptionKey: 'MIIBpublic', usage: { prompt: 0, completion: 0, calls: 0, usdTicks: 0 } };
  assert.equal((await sessions.startEncrypted._handler(ctx, args)).sessionId, 's');
  assert.deepEqual(rows.map(r => r.table), ['sessions', 'presence', 'watches']);
  active = Array(10).fill({});
  assert.equal((await sessions.startEncrypted._handler(ctx, args)).error, 'full');
  assert.equal(rows.length, 3);
});
