'use strict';

/*
 * Exercises the Drive sync loop without a browser or a network.
 *
 * Each "device" is a real store.js + sync.js pair running in its own VM
 * context, so the two cannot see each other's globals — the same isolation
 * two browsers have. They share one stand-in for Drive that counts calls and
 * bumps a version on every write, exactly as Drive does, and one virtual clock
 * so a twelve-second poll costs nothing to wait for.
 *
 * Run with: node scripts/test-sync.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------ the clock */

const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

function makeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { at: now + (Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/* ------------------------------------------------------------ fake Drive */

function makeDrive() {
  let seq = 0;
  const files = new Map();
  const notFound = () => Object.assign(new Error('not found'),
    { code: 'driveRequestFailed', params: { status: 404 } });
  const bump = (f) => {
    f.version = String(++seq);
    f.modifiedTime = new Date(1700000000000 + seq * 1000).toISOString();
    return f;
  };
  const meta = (f) => ({
    id: f.id, name: f.name, version: f.version,
    modifiedTime: f.modifiedTime, appProperties: f.appProperties,
  });

  const drive = {
    calls: { meta: 0, overwrite: 0, download: 0, upload: 0 },
    async upload(name, payload, role) {
      drive.calls.upload++;
      const f = {
        id: `f${files.size + 1}`, name,
        appProperties: role ? { sfmRole: role } : undefined,
        content: JSON.parse(JSON.stringify(payload)),
      };
      files.set(f.id, bump(f));
      return meta(f);
    },
    async overwrite(id, payload) {
      const f = files.get(id);
      if (!f) throw notFound();
      drive.calls.overwrite++;
      f.content = JSON.parse(JSON.stringify(payload));
      return meta(bump(f));
    },
    async meta(id) {
      const f = files.get(id);
      if (!f) throw notFound();
      drive.calls.meta++;
      return meta(f);
    },
    async download(id) {
      const f = files.get(id);
      if (!f) throw notFound();
      drive.calls.download++;
      return JSON.parse(JSON.stringify(f.content));
    },
    async findCurrent() {
      for (const f of files.values()) if (f.appProperties?.sfmRole === 'current') return meta(f);
      return null;
    },
    createCurrent(payload) { return drive.upload('Current.json', payload, 'current'); },
    isCurrent: (f) => f?.appProperties?.sfmRole === 'current',
    async list() { return [...files.values()].map(meta); },
    async remove(id) { files.delete(id); return true; },
    _files: files,
  };
  return drive;
}

/* ---------------------------------------------------------- the devices */

function makeDevice(label, drive, clock, storedCells) {
  // Seeded before the scripts run: a real page load finds localStorage already
  // populated, and sync.js reads its baseline the moment it is evaluated.
  const cells = new Map(storedCells || []);
  const ctx = {
    console, Date, Math, JSON, Promise, Object, Array, Set, Map,
    String, Number, Boolean, Error, RegExp, isNaN, parseInt, parseFloat,
    Drive: drive,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    localStorage: {
      getItem: (k) => (cells.has(k) ? cells.get(k) : null),
      setItem: (k, v) => cells.set(k, String(v)),
      removeItem: (k) => cells.delete(k),
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of ['kickoff.js', 'store.js', 'sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), ctx,
      { filename: file });
  }

  const dev = {
    label, ctx, cells,
    busy: false,
    conflictAnswer: 'local',
    log: [],
    phase: 'off',
    request: (m, p, b) => ctx.Store.request(m, p, b),
  };

  // Mirrors app.js: every non-GET write nudges the sync engine.
  dev.api = async (method, p, body) => {
    const result = await ctx.Store.request(method, p, body);
    if (method !== 'GET') ctx.Sync.touch();
    return result;
  };

  ctx.Sync.configure({
    read: () => dev.request('GET', '/api/backup'),
    isEmpty: async () => {
      const { counts } = await dev.request('GET', '/api/backup');
      return counts.players === 0 && counts.staff === 0 && counts.strategies === 0;
    },
    apply: async (doc) => { await dev.request('PUT', '/api/backup', doc); },
    isBusy: () => dev.busy,
    onState: (st) => { dev.phase = st.phase; },
    onPulled: () => dev.log.push('pulled'),
    onConflict: async () => dev.conflictAnswer,
    snapshot: async (payload, side) => {
      dev.log.push(`snapshot:${side}`);
      await drive.upload(`clash-${side}.json`, payload);
    },
  });

  dev.sync = ctx.Sync;
  return dev;
}

const players = async (dev) => (await dev.request('GET', '/api/players')).map((p) => p.name);

/* ------------------------------------------------------------- the tests */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the first device to sync creates the live file', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await settle();

  const current = await drive.findCurrent();
  assert.ok(current, 'a live file exists');
  assert.strictEqual(current.name, 'Current.json');
  assert.strictEqual(a.phase, 'synced');
  const stored = await drive.download(current.id);
  assert.deepStrictEqual(stored.counts.players, 1, 'it holds this device’s work');
});

test('an empty second device adopts the live file without asking', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);
  const b = makeDevice('B', drive, clock);
  b.conflictAnswer = 'THIS SHOULD NEVER BE ASKED';

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await settle();

  await b.sync.start();
  await settle();

  assert.deepStrictEqual(await players(b), ['Alice'], 'B took A’s squad');
  assert.deepStrictEqual(b.log, [], 'nothing was snapshotted, nothing was asked');
  assert.strictEqual(b.phase, 'synced');
});

test('an edit on one device reaches the other on the next poll', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);
  const b = makeDevice('B', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await b.sync.start();
  await settle();

  await a.api('POST', '/api/players', { name: 'Bob' });
  await clock.advance(2000);                 // the debounced push fires
  assert.strictEqual(a.phase, 'synced', 'A finished uploading');
  assert.deepStrictEqual(await players(b), ['Alice'], 'B has not looked yet');

  await clock.advance(13_000);               // B polls
  assert.deepStrictEqual((await players(b)).sort(), ['Alice', 'Bob']);
  assert.deepStrictEqual(b.log, ['pulled'], 'B announced the update once');
});

test('a burst of edits becomes one upload', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);
  await a.sync.start();
  await settle();

  const before = drive.calls.overwrite;
  for (const name of ['One', 'Two', 'Three', 'Four']) {
    await a.api('POST', '/api/players', { name });
    await clock.advance(200);                // faster than the debounce
  }
  await clock.advance(2000);

  assert.strictEqual(drive.calls.overwrite - before, 1, 'four edits, one write');
  assert.strictEqual((await drive.download((await drive.findCurrent()).id)).counts.players, 4);
});

test('an update is held back while the user is mid-gesture, then applied', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);
  const b = makeDevice('B', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await b.sync.start();
  await settle();

  b.busy = true;                             // a finger is on the board
  await a.api('POST', '/api/players', { name: 'Bob' });
  await clock.advance(2000);
  await clock.advance(13_000);

  assert.deepStrictEqual(await players(b), ['Alice'], 'the board did not move');
  assert.strictEqual(b.phase, 'waiting');

  b.busy = false;                            // they let go
  await clock.advance(2000);
  assert.deepStrictEqual((await players(b)).sort(), ['Alice', 'Bob']);
  assert.strictEqual(b.phase, 'synced');
});

test('a clash asks, and keeps the losing version as a named copy', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);
  const b = makeDevice('B', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await b.sync.start();
  await settle();

  // B goes offline in spirit: it edits without polling, while A edits and pushes.
  b.sync.stop();
  await a.api('POST', '/api/players', { name: 'FromA' });
  await clock.advance(2000);

  await b.api('POST', '/api/players', { name: 'FromB' });
  b.conflictAnswer = 'local';                // keep this device
  await b.sync.start();
  await settle();
  await clock.advance(2000);

  assert.deepStrictEqual(b.log, ['snapshot:remote'], 'A’s version was parked in Drive');
  assert.deepStrictEqual((await players(b)).sort(), ['Alice', 'FromB']);

  const parked = (await drive.list()).find((f) => f.name === 'clash-remote.json');
  assert.ok(parked, 'the copy is really in Drive');
  const parkedDoc = await drive.download(parked.id);
  assert.ok(parkedDoc.data.players.some((p) => p.name === 'FromA'),
    'and it is the version that lost');

  // The live file now carries B's answer, and A picks it up.
  await clock.advance(13_000);
  assert.deepStrictEqual((await players(a)).sort(), ['Alice', 'FromB']);
});

test('answering a clash the other way takes the Drive version instead', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);
  const b = makeDevice('B', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await b.sync.start();
  await settle();

  b.sync.stop();
  await a.api('POST', '/api/players', { name: 'FromA' });
  await clock.advance(2000);

  await b.api('POST', '/api/players', { name: 'FromB' });
  b.conflictAnswer = 'remote';               // take Drive's
  await b.sync.start();
  await settle();
  await clock.advance(2000);

  assert.deepStrictEqual(b.log[0], 'snapshot:local', 'B’s own version was parked first');
  assert.deepStrictEqual((await players(b)).sort(), ['Alice', 'FromA']);
  const parked = (await drive.list()).find((f) => f.name === 'clash-local.json');
  const parkedDoc = await drive.download(parked.id);
  assert.ok(parkedDoc.data.players.some((p) => p.name === 'FromB'), 'nothing was lost');
});

test('applying a remote document does not bounce straight back as a local edit', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);
  const b = makeDevice('B', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await b.sync.start();
  await settle();

  await a.api('POST', '/api/players', { name: 'Bob' });
  await clock.advance(2000);
  const writes = drive.calls.overwrite;

  await clock.advance(13_000);               // B pulls
  await clock.advance(30_000);               // and is given every chance to echo
  assert.strictEqual(drive.calls.overwrite, writes,
    'a pulled document is not re-uploaded as if the user had typed it');
  assert.strictEqual(b.phase, 'synced');
});

test('a live file deleted from another device is quietly recreated', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await settle();

  drive._files.delete((await drive.findCurrent()).id);

  await a.api('POST', '/api/players', { name: 'Bob' });
  await clock.advance(2000);

  const current = await drive.findCurrent();
  assert.ok(current, 'a new live file took its place');
  assert.strictEqual((await drive.download(current.id)).counts.players, 2);
  assert.strictEqual(a.phase, 'synced');
});

test('a hidden tab stops polling, and catches up when it comes back', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);
  const b = makeDevice('B', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await b.sync.start();
  await settle();

  b.ctx.document = { hidden: true, addEventListener() {} };
  await a.api('POST', '/api/players', { name: 'Bob' });
  await clock.advance(2000);

  const looks = drive.calls.meta;
  await clock.advance(60_000);
  assert.strictEqual(drive.calls.meta, looks + 5,
    'the hidden tab reschedules without asking Drive anything');
  assert.deepStrictEqual(await players(b), ['Alice']);

  b.ctx.document.hidden = false;
  await clock.advance(13_000);
  assert.deepStrictEqual((await players(b)).sort(), ['Alice', 'Bob']);
});

test('an expired token stops the loop instead of hammering Drive', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await settle();

  drive.meta = async () => {
    throw Object.assign(new Error('expired'), { code: 'driveExpired' });
  };

  await a.api('POST', '/api/players', { name: 'Bob' });
  await clock.advance(2000);
  assert.strictEqual(a.phase, 'error');
  assert.strictEqual(a.sync.isRunning(), false, 'the loop stood down');

  const before = drive.calls.download;
  await clock.advance(120_000);
  assert.strictEqual(drive.calls.download, before, 'and stayed down');
});

test('the baseline survives a reload, so coming back is not a clash', async () => {
  const drive = makeDrive();
  const clock = makeClock();
  const a = makeDevice('A', drive, clock);

  await a.api('POST', '/api/players', { name: 'Alice' });
  await a.sync.start();
  await settle();

  // Same browser, new page: a fresh context over the same localStorage.
  const reloaded = makeDevice('A2', drive, clock, a.cells);
  reloaded.conflictAnswer = 'THIS SHOULD NEVER BE ASKED';

  await reloaded.sync.start();
  await settle();

  assert.deepStrictEqual(reloaded.log, [], 'no clash, no question');
  assert.strictEqual(reloaded.phase, 'synced');
  assert.deepStrictEqual(await players(reloaded), ['Alice']);
});

/* --------------------------------------------------------------- runner */

(async function run() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}\n       ${err.message}`);
    }
  }
  console.log(failed
    ? `\nsync check FAILED: ${failed} of ${tests.length} tests`
    : `\nsync check passed: ${tests.length} tests`);
  process.exit(failed ? 1 : 0);
})();
