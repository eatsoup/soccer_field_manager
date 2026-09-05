'use strict';

/*
 * Exercises the localStorage-backed store against the API contract app.js
 * relies on. Runs in Node with a stand-in for localStorage.
 * Run with: node scripts/test-store.js
 */

const assert = require('node:assert');
const path = require('node:path');

// Stand in for the browser store before store.js picks its backend.
const cells = new Map();
globalThis.localStorage = {
  getItem: (k) => (cells.has(k) ? cells.get(k) : null),
  setItem: (k, v) => cells.set(k, String(v)),
  removeItem: (k) => cells.delete(k),
};

const ROOT = path.join(__dirname, '..');
const Store = require(path.join(ROOT, 'public/store.js'));

const api = (method, p, body) => Store.request(method, p, body);

async function fails(code, run) {
  try {
    await run();
  } catch (err) {
    assert.strictEqual(err.code, code, `expected code "${code}", got "${err.code}"`);
    return err;
  }
  assert.fail(`expected failure "${code}" but the call succeeded`);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------- seeding */

test('persists to localStorage and seeds the built-in formations', async () => {
  assert.strictEqual(Store.persistent, true);
  const formations = await api('GET', '/api/formations');
  assert.strictEqual(formations.length, 7);
  assert.strictEqual(formations[0].name, '4-4-2', 'built-ins keep their seeded order');
  assert.ok(formations.every((f) => f.is_default === true));
  assert.ok(cells.has(Store.STORAGE_KEY), 'the document is written to localStorage');
});

test('every built-in slot has an open-play and a kick-off spot in our own half', async () => {
  for (const f of await api('GET', '/api/formations')) {
    assert.strictEqual(f.slots.length, 11, `${f.name} has 11 slots`);
    for (const s of f.slots) {
      assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `${f.name}/${s.code} open-play spot`);
      assert.ok(Number.isFinite(s.kickoff_x), `${f.name}/${s.code} kickoff_x`);
      assert.ok(s.kickoff_y >= 50, `${f.name}/${s.code} kick-off spot is in our own half`);
    }
  }
});

test('a second read reuses the stored document instead of re-seeding', async () => {
  const before = await api('GET', '/api/formations');
  const after = await api('GET', '/api/formations');
  assert.deepStrictEqual(after.map((f) => f.id), before.map((f) => f.id));
});

/* ------------------------------------------------------------- players */

test('players round-trip and sort by availability, then shirt number', async () => {
  const bench = await api('POST', '/api/players', { name: 'Benched', shirt_number: 2, active: false });
  await api('POST', '/api/players', { name: 'Keeper', shirt_number: 1, primary_position: 'GK', foot: 'left' });
  await api('POST', '/api/players', { name: 'Nomad' }); // no shirt number

  assert.strictEqual(bench.active, 0);
  const list = await api('GET', '/api/players');
  assert.deepStrictEqual(list.map((p) => p.name), ['Keeper', 'Nomad', 'Benched']);
  assert.strictEqual(list[0].foot, 'left');
  assert.strictEqual(list[1].shirt_number, null);
  assert.strictEqual(list[1].primary_position, 'CM', 'falls back to the default position');
});

test('a player update only touches the fields it is given', async () => {
  const created = await api('POST', '/api/players', { name: 'Winger', shirt_number: 7, notes: 'quick' });
  const updated = await api('PUT', `/api/players/${created.id}`, { name: 'Winger II' });
  assert.strictEqual(updated.name, 'Winger II');
  assert.strictEqual(updated.shirt_number, 7);
  assert.strictEqual(updated.notes, 'quick');
  await api('DELETE', `/api/players/${created.id}`);
});

test('players reject a blank name and 404 when missing', async () => {
  const err = await fails('required', () => api('POST', '/api/players', { name: '   ' }));
  assert.deepStrictEqual(err.params, { field: 'name' });
  await fails('playerNotFound', () => api('PUT', '/api/players/9999', { name: 'Ghost' }));
  await fails('playerNotFound', () => api('DELETE', '/api/players/9999'));
});

/* --------------------------------------------------------------- staff */

test('staff round-trip and sort by role, then name', async () => {
  await api('POST', '/api/staff', { name: 'Zoe', role: 'head_coach' });
  await api('POST', '/api/staff', { name: 'Abe', role: 'head_coach', email: 'abe@example.com' });
  const physio = await api('POST', '/api/staff', { name: 'Iris', role: 'physiotherapist' });

  const list = await api('GET', '/api/staff');
  assert.deepStrictEqual(list.map((s) => s.name), ['Abe', 'Zoe', 'Iris']);
  assert.strictEqual(list[0].email, 'abe@example.com');

  await api('DELETE', `/api/staff/${physio.id}`);
  assert.strictEqual((await api('GET', '/api/staff')).length, 2);
  await fails('staffNotFound', () => api('DELETE', `/api/staff/${physio.id}`));
});

/* ---------------------------------------------------------- formations */

test('a formation can be duplicated, renamed and deleted', async () => {
  const source = (await api('GET', '/api/formations')).find((f) => f.name === '4-3-3');
  const copy = await api('POST', '/api/formations', {
    name: '4-3-3 copy', description: 'mine', slots: source.slots,
  });
  assert.strictEqual(copy.is_default, false);
  assert.strictEqual(copy.slots.length, 11);
  assert.notStrictEqual(copy.slots[0].id, source.slots[0].id, 'the copy gets its own slot ids');
  assert.strictEqual(copy.slots[0].kickoff_y, source.slots[0].kickoff_y, 'kick-off spots carry over');

  await fails('duplicateFormation', () => api('POST', '/api/formations', {
    name: '4-3-3 copy', slots: source.slots,
  }));

  const renamed = await api('PUT', `/api/formations/${copy.id}`, { name: '4-3-3 mine', slots: source.slots });
  assert.strictEqual(renamed.name, '4-3-3 mine');

  await api('DELETE', `/api/formations/${copy.id}`);
  assert.ok(!(await api('GET', '/api/formations')).some((f) => f.id === copy.id));
});

test('built-in formations are read-only', async () => {
  const builtin = (await api('GET', '/api/formations'))[0];
  await fails('builtinReadonly', () => api('PUT', `/api/formations/${builtin.id}`, { slots: builtin.slots }));
  await fails('builtinReadonly', () => api('PUT', `/api/formations/${builtin.id}/slots`, {
    slots: [{ id: builtin.slots[0].id, x: 10, y: 10 }],
  }));
  await fails('builtinUndeletable', () => api('DELETE', `/api/formations/${builtin.id}`));
  await fails('formationNotFound', () => api('DELETE', '/api/formations/9999'));
});

test('a formation needs between one and eleven slots', async () => {
  const source = (await api('GET', '/api/formations'))[0];
  await fails('slotsRequired', () => api('POST', '/api/formations', { name: 'Empty', slots: [] }));
  await fails('slotsTooMany', () => api('POST', '/api/formations', {
    name: 'Twelve', slots: [...source.slots, source.slots[0]],
  }));
});

test('moving spots in place keeps slot ids and clamps to the pitch', async () => {
  const source = (await api('GET', '/api/formations'))[0];
  const custom = await api('POST', '/api/formations', { name: 'Movable', slots: source.slots });
  const slotId = custom.slots[5].id;

  const moved = await api('PUT', `/api/formations/${custom.id}/slots`, {
    slots: [{ id: slotId, x: 140, y: -20 }],
  });
  const openSpot = moved.slots.find((s) => s.id === slotId);
  assert.deepStrictEqual([openSpot.x, openSpot.y], [100, 0], 'open play clamps to 0-100');

  const kicked = await api('PUT', `/api/formations/${custom.id}/slots`, {
    phase: 'kickoff', slots: [{ id: slotId, x: 40, y: 12 }],
  });
  const kickSpot = kicked.slots.find((s) => s.id === slotId);
  assert.deepStrictEqual([kickSpot.kickoff_x, kickSpot.kickoff_y], [40, 50], 'kick-off pins to our own half');
  assert.strictEqual(kickSpot.x, 100, 'the open-play spot is untouched');

  await api('DELETE', `/api/formations/${custom.id}`);
});

/* ---------------------------------------------------------- strategies */

async function sampleStrategy(overrides = {}) {
  const formation = (await api('GET', '/api/formations'))[0];
  const keeper = (await api('GET', '/api/players')).find((p) => p.primary_position === 'GK');
  return api('POST', '/api/strategies', {
    name: 'Plan A',
    description: 'press high',
    formation_id: formation.id,
    assignments: [{ slot_id: formation.slots[0].id, player_id: keeper.id, x: 51, y: 90 }],
    drawings: [{ kind: 'run', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], color: '#fff', phase: 'kickoff' }],
    ...overrides,
  });
}

test('a strategy saves its lineup and drawings', async () => {
  const saved = await sampleStrategy();
  assert.strictEqual(saved.takes_kickoff, true);
  assert.strictEqual(saved.assignments.length, 1);
  assert.strictEqual(saved.drawings.length, 1);
  assert.deepStrictEqual(saved.drawings[0].points, [{ x: 10, y: 10 }, { x: 20, y: 20 }]);
  assert.strictEqual(saved.drawings[0].phase, 'kickoff');
  assert.match(saved.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const detail = await api('GET', `/api/strategies/${saved.id}`);
  assert.deepStrictEqual(detail.assignments, saved.assignments);
  await api('DELETE', `/api/strategies/${saved.id}`);
});

test('a save replaces the previous lineup and drawings wholesale', async () => {
  const saved = await sampleStrategy();
  const updated = await api('PUT', `/api/strategies/${saved.id}`, {
    name: 'Plan B', takes_kickoff: false, assignments: [], drawings: [],
  });
  assert.strictEqual(updated.name, 'Plan B');
  assert.strictEqual(updated.takes_kickoff, false);
  assert.strictEqual(updated.assignments.length, 0);
  assert.strictEqual(updated.drawings.length, 0);
  assert.strictEqual(updated.formation_id, saved.formation_id, 'the formation is kept when not sent');
  await api('DELETE', `/api/strategies/${saved.id}`);
});

test('unusable assignments and drawings are dropped, not rejected', async () => {
  const formation = (await api('GET', '/api/formations'))[1];
  const saved = await api('POST', '/api/strategies', {
    name: 'Junk',
    formation_id: formation.id,
    assignments: [
      { slot_id: 999999, player_id: null },                       // slot not in this formation
      { slot_id: formation.slots[0].id, player_id: 999999 },      // player is gone
      { slot_id: formation.slots[1].id, x: 250, y: -8, kickoff_x: 60, kickoff_y: 10 },
    ],
    drawings: [
      { kind: 'teleport', points: [{ x: 1, y: 1 }] },             // unknown kind
      { kind: 'zone', points: [] },                               // no points
      { kind: 'zone', points: [{ x: 150, y: -5 }], phase: 'nonsense' },
    ],
  });

  assert.strictEqual(saved.assignments.length, 1);
  const a = saved.assignments[0];
  assert.deepStrictEqual([a.x, a.y], [100, 0], 'open-play spots clamp to the pitch');
  assert.deepStrictEqual([a.kickoff_x, a.kickoff_y], [60, 50], 'kick-off spots pin to our own half');
  assert.strictEqual(saved.drawings.length, 1);
  assert.deepStrictEqual(saved.drawings[0].points, [{ x: 100, y: 0 }]);
  assert.strictEqual(saved.drawings[0].phase, 'open', 'an unknown phase falls back to open play');
  await api('DELETE', `/api/strategies/${saved.id}`);
});

test('the strategy list is newest first and names the formation', async () => {
  const first = await sampleStrategy({ name: 'Older' });
  const second = await sampleStrategy({ name: 'Newer' });
  const list = await api('GET', '/api/strategies');
  assert.deepStrictEqual(list.slice(0, 2).map((s) => s.name), ['Newer', 'Older']);
  assert.strictEqual(list[0].formation_name, '4-4-2');
  await api('DELETE', `/api/strategies/${first.id}`);
  await api('DELETE', `/api/strategies/${second.id}`);
});

test('strategies reject an unknown formation and 404 when missing', async () => {
  await fails('unknownFormation', () => api('POST', '/api/strategies', { name: 'X', formation_id: 9999 }));
  await fails('strategyNotFound', () => api('GET', '/api/strategies/9999'));
  await fails('strategyNotFound', () => api('DELETE', '/api/strategies/9999'));
});

/* ------------------------------------------------------------ cascades */

test('deleting a player empties the slot instead of dropping it', async () => {
  const formation = (await api('GET', '/api/formations'))[0];
  const spare = await api('POST', '/api/players', { name: 'Loanee', primary_position: 'ST' });
  const saved = await api('POST', '/api/strategies', {
    name: 'Loan plan',
    formation_id: formation.id,
    assignments: [{ slot_id: formation.slots[9].id, player_id: spare.id }],
  });

  await api('DELETE', `/api/players/${spare.id}`);
  const detail = await api('GET', `/api/strategies/${saved.id}`);
  assert.strictEqual(detail.assignments.length, 1, 'the slot survives');
  assert.strictEqual(detail.assignments[0].player_id, null, 'the player reference is cleared');
  await api('DELETE', `/api/strategies/${saved.id}`);
});

test('deleting a formation leaves its strategies without one', async () => {
  const source = (await api('GET', '/api/formations'))[0];
  const custom = await api('POST', '/api/formations', { name: 'Doomed', slots: source.slots });
  const saved = await api('POST', '/api/strategies', {
    name: 'Orphan',
    formation_id: custom.id,
    assignments: [{ slot_id: custom.slots[0].id, player_id: null, x: 50, y: 90 }],
  });

  await api('DELETE', `/api/formations/${custom.id}`);
  const detail = await api('GET', `/api/strategies/${saved.id}`);
  assert.strictEqual(detail.formation_id, null);
  assert.strictEqual(detail.assignments.length, 0, 'assignments to deleted slots go with them');
  assert.strictEqual((await api('GET', '/api/strategies')).find((s) => s.id === saved.id).formation_name, null);
  await api('DELETE', `/api/strategies/${saved.id}`);
});

test('replacing a formation\'s slots drops assignments that pointed at the old ones', async () => {
  const source = (await api('GET', '/api/formations'))[0];
  const custom = await api('POST', '/api/formations', { name: 'Rebuilt', slots: source.slots });
  const saved = await api('POST', '/api/strategies', {
    name: 'Rebuild plan',
    formation_id: custom.id,
    assignments: [{ slot_id: custom.slots[0].id, player_id: null, x: 50, y: 90 }],
  });

  await api('PUT', `/api/formations/${custom.id}`, { name: 'Rebuilt', slots: source.slots });
  assert.strictEqual((await api('GET', `/api/strategies/${saved.id}`)).assignments.length, 0);
  await api('DELETE', `/api/strategies/${saved.id}`);
  await api('DELETE', `/api/formations/${custom.id}`);
});

test('deleting a strategy takes its assignments and drawings with it', async () => {
  const saved = await sampleStrategy();
  await api('DELETE', `/api/strategies/${saved.id}`);
  const raw = JSON.parse(cells.get(Store.STORAGE_KEY));
  assert.ok(!raw.strategy_assignments.some((a) => a.strategy_id === saved.id));
  assert.ok(!raw.strategy_drawings.some((d) => d.strategy_id === saved.id));
});

/* ------------------------------------------------------------ dispatch */

test('unknown paths and methods fail the way the app expects', async () => {
  await fails('notFound', () => api('GET', '/api/nope'));
  await fails('methodNotAllowed', () => api('PATCH', '/api/players'));
});

test('a rejected write leaves nothing behind', async () => {
  const before = cells.get(Store.STORAGE_KEY);
  await fails('required', () => api('POST', '/api/players', { name: '' }));
  assert.strictEqual(cells.get(Store.STORAGE_KEY), before);
});

test('returned rows are copies, so callers cannot corrupt the store', async () => {
  const players = await api('GET', '/api/players');
  players[0].name = 'Tampered';
  assert.notStrictEqual((await api('GET', '/api/players'))[0].name, 'Tampered');
});

test('a corrupt document is replaced by a freshly seeded one', async () => {
  cells.set(Store.STORAGE_KEY, '{not json');
  const formations = await api('GET', '/api/formations');
  assert.strictEqual(formations.length, 7);
  assert.strictEqual((await api('GET', '/api/players')).length, 0);
});

test('reset wipes the document and the built-ins come back', async () => {
  Store.reset();
  assert.strictEqual(cells.has(Store.STORAGE_KEY), false);
  assert.strictEqual((await api('GET', '/api/formations')).length, 7);
});

/* --------------------------------------------------------------- backup */

test('a backup carries the whole document plus a format stamp and counts', async () => {
  await api('POST', '/api/players', { name: 'Backup Bob', shirt_number: 8 });
  await api('POST', '/api/staff', { name: 'Backup Bea', role: 'physio' });

  const backup = await api('GET', '/api/backup');
  assert.strictEqual(backup.format, Store.BACKUP_FORMAT);
  assert.strictEqual(backup.backup_version, Store.BACKUP_VERSION);
  assert.ok(Date.parse(backup.exported_at), 'exported_at is a timestamp');
  assert.deepStrictEqual(backup.counts,
    { players: 1, staff: 1, formations: 7, strategies: 0 });
  for (const table of ['players', 'staff', 'formations', 'formation_slots',
    'strategies', 'strategy_assignments', 'strategy_drawings']) {
    assert.ok(Array.isArray(backup.data[table]), `${table} is in the backup`);
  }
  assert.strictEqual(backup.data.players[0].name, 'Backup Bob');
});

test('a backup round-trips through a wiped document', async () => {
  const formation = (await api('GET', '/api/formations'))[0];
  const strategy = await api('POST', '/api/strategies', {
    name: 'Round trip',
    formation_id: formation.id,
    assignments: [{ slot_id: formation.slots[0].id, player_id: null, x: 50, y: 90 }],
    drawings: [{ kind: 'run', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], phase: 'open' }],
  });
  const backup = await api('GET', '/api/backup');

  Store.reset();
  assert.strictEqual((await api('GET', '/api/players')).length, 0, 'wiped first');

  const result = await api('PUT', '/api/backup', backup);
  assert.strictEqual(result.imported, true);
  assert.deepStrictEqual(result.counts,
    { players: 1, staff: 1, formations: 7, strategies: 1 });

  assert.strictEqual((await api('GET', '/api/players'))[0].name, 'Backup Bob');
  assert.strictEqual((await api('GET', '/api/staff'))[0].name, 'Backup Bea');
  const restored = await api('GET', `/api/strategies/${strategy.id}`);
  assert.strictEqual(restored.name, 'Round trip');
  assert.strictEqual(restored.assignments.length, 1);
  assert.strictEqual(restored.drawings.length, 1);
  assert.strictEqual(restored.drawings[0].kind, 'run');
});

test('a restore replaces the document instead of merging into it', async () => {
  const backup = await api('GET', '/api/backup');
  await api('POST', '/api/players', { name: 'Added After The Backup' });
  assert.strictEqual((await api('GET', '/api/players')).length, 2);

  await api('PUT', '/api/backup', backup);
  const players = await api('GET', '/api/players');
  assert.strictEqual(players.length, 1);
  assert.strictEqual(players[0].name, 'Backup Bob');
});

test('ids keep counting past the restored rows', async () => {
  const highest = (await api('GET', '/api/players'))
    .reduce((max, p) => Math.max(max, p.id), 0);
  const added = await api('POST', '/api/players', { name: 'Next Up' });
  assert.ok(added.id > highest, `${added.id} follows ${highest}`);
});

test('restoring an empty document brings the built-in formations back', async () => {
  await api('PUT', '/api/backup', { format: Store.BACKUP_FORMAT, data: { players: [] } });
  assert.strictEqual((await api('GET', '/api/players')).length, 0);
  assert.strictEqual((await api('GET', '/api/formations')).length, 7);
});

test('a bare document without the envelope is accepted', async () => {
  await api('PUT', '/api/backup', {
    players: [{ id: 3, name: 'Bare', active: 1 }],
    formations: [],
  });
  const players = await api('GET', '/api/players');
  assert.strictEqual(players.length, 1);
  assert.strictEqual(players[0].name, 'Bare');
});

test('rows without a usable id, and duplicate ids, are dropped', async () => {
  await api('PUT', '/api/backup', {
    data: {
      players: [
        { id: 1, name: 'Keeper', active: 1 },
        { name: 'No id', active: 1 },
        { id: 1, name: 'Duplicate id', active: 1 },
        'not a row',
      ],
    },
  });
  const players = await api('GET', '/api/players');
  assert.strictEqual(players.length, 1);
  assert.strictEqual(players[0].name, 'Keeper');
});

test('a formation that kept its row but lost its slots is put back together', async () => {
  // A backup's counts cover players, staff, formations and strategies, so one
  // whose formation_slots went missing still looks healthy on the way in. The
  // formations then have nowhere to put a player: every lineup reads as empty.
  Store.reset();
  const before = await api('GET', '/api/formations');
  const stripped = await api('GET', '/api/backup');
  stripped.data.formation_slots = [];

  await api('PUT', '/api/backup', stripped);

  const after = await api('GET', '/api/formations');
  assert.strictEqual(after.length, 7, 'the formations themselves were never lost');
  for (const f of after) {
    assert.ok(f.slots.length > 0, `${f.name} got its slots back`);
    assert.ok(
      f.slots.every((s) => s.kickoff_x !== null && s.kickoff_y !== null),
      `${f.name}'s rebuilt slots have kick-off spots too`);
  }
  assert.deepStrictEqual(
    after.map((f) => f.slots.length), before.map((f) => f.slots.length),
    'each formation is back to the shape it had');
});

test('a restore keeps dragged spots, including on slots with nobody in them', async () => {
  Store.reset();
  const formation = (await api('GET', '/api/formations'))[0];
  const player = await api('POST', '/api/players', { name: 'Placed Paula' });
  const [taken, moved, untouched] = formation.slots;

  const strategy = await api('POST', '/api/strategies', {
    name: 'Spots', formation_id: formation.id,
    assignments: [
      { slot_id: taken.id, player_id: player.id, x: 30, y: 80, kickoff_x: 40, kickoff_y: 90 },
      // An empty slot dragged somewhere is a deliberate part of the shape.
      { slot_id: moved.id, player_id: null, x: 12, y: 44 },
      { slot_id: untouched.id, player_id: null },
    ],
  });

  const backup = await api('GET', '/api/backup');
  // The damaged shape above must not cost the spots either.
  const stripped = JSON.parse(JSON.stringify(backup));
  stripped.data.formation_slots = [];

  for (const [label, payload] of [['clean', backup], ['slotless', stripped]]) {
    Store.reset();
    await api('PUT', '/api/backup', payload);
    const detail = await api('GET', `/api/strategies/${strategy.id}`);
    const live = new Set(
      (await api('GET', '/api/formations'))
        .find((f) => f.id === detail.formation_id).slots.map((s) => s.id));
    const bySlot = new Map(
      detail.assignments.filter((a) => live.has(a.slot_id)).map((a) => [a.slot_id, a]));

    const placed = bySlot.get(taken.id);
    assert.ok(placed, `${label}: the occupied slot still resolves to a live slot`);
    assert.strictEqual(placed.player_id, player.id, `${label}: the player kept the slot`);
    assert.deepStrictEqual(
      [placed.x, placed.y, placed.kickoff_x, placed.kickoff_y], [30, 80, 40, 90],
      `${label}: both phases of the dragged spot survived`);

    const empty = bySlot.get(moved.id);
    assert.ok(empty, `${label}: the moved empty slot survived`);
    assert.strictEqual(empty.player_id, null, `${label}: and is still empty`);
    assert.deepStrictEqual([empty.x, empty.y], [12, 44], `${label}: at the spot it was moved to`);
  }
});

test('a file from somewhere else is refused rather than half-imported', async () => {
  const before = await api('GET', '/api/players');
  await fails('backupWrongFormat', () => api('PUT', '/api/backup', { format: 'something-else' }));
  await fails('backupTooNew', () =>
    api('PUT', '/api/backup', { format: Store.BACKUP_FORMAT, backup_version: 99, data: {} }));
  await fails('backupUnreadable', () => api('PUT', '/api/backup', { hello: 'world' }));
  await fails('backupUnreadable', () => api('PUT', '/api/backup', null));
  assert.deepStrictEqual(await api('GET', '/api/players'), before, 'nothing changed');
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
    ? `\nstore check FAILED: ${failed} of ${tests.length} tests`
    : `\nstore check passed: ${tests.length} tests`);
  process.exit(failed ? 1 : 0);
})();
