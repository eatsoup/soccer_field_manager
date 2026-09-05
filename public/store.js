'use strict';

/*
 * The database. Everything the app owns — players, staff, formations and
 * strategies — lives in one JSON document in localStorage, so the app is a
 * static site with no backend (it runs on GitHub Pages).
 *
 * `request(method, path, body)` mirrors the REST API the app used to talk to:
 * same paths, same row shapes, same validation, same `{ error, code, params }`
 * failures. That keeps the callers in app.js unchanged and makes it obvious
 * what would move back to a server if this ever grew one.
 *
 * Rows keep their SQL-ish shape (integer ids, 0/1 flags, `updated_at` as
 * "YYYY-MM-DD HH:MM:SS" in UTC) so nothing downstream has to care that the
 * storage changed.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Store = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const kickoff = (typeof module === 'object' && module.exports)
    ? require('./kickoff.js')
    : root;
  const { kickoffShape } = kickoff;

  const STORAGE_KEY = 'soccer.db.v1';

  // Stamped into every backup so an unrelated .json file is rejected with a
  // clear reason instead of half-importing.
  const BACKUP_FORMAT = 'soccer-field-manager-backup';
  const BACKUP_VERSION = 1;

  /* ---------------------------------------------------------- storage */

  /*
   * Private-mode browsers and file:// pages can refuse localStorage entirely.
   * Rather than break, we fall back to a same-shape in-memory store for the
   * session; `available` lets the UI warn that nothing will be kept.
   */
  function pickBackend() {
    try {
      const probe = '__soccer_probe__';
      root.localStorage.setItem(probe, '1');
      root.localStorage.removeItem(probe);
      return { store: root.localStorage, available: true };
    } catch {
      let memory = null;
      return {
        available: false,
        store: {
          getItem: () => memory,
          setItem: (k, v) => { memory = v; },
          removeItem: () => { memory = null; },
        },
      };
    }
  }

  const backend = pickBackend();

  const EMPTY = () => ({
    version: 1,
    seq: {},
    players: [],
    staff: [],
    formations: [],
    formation_slots: [],
    strategies: [],
    strategy_assignments: [],
    strategy_drawings: [],
  });

  const TABLES = Object.keys(EMPTY()).filter((k) => k !== 'version' && k !== 'seq');

  function load() {
    let raw = null;
    try {
      raw = backend.store.getItem(STORAGE_KEY);
    } catch {
      raw = null;
    }

    let db = null;
    if (raw) {
      try {
        db = JSON.parse(raw);
      } catch {
        db = null; // corrupt document: start over rather than dead-end the app
      }
    }
    if (!db || typeof db !== 'object') db = EMPTY();

    // Tolerate a document written by an older version that lacked a table.
    const base = EMPTY();
    for (const table of TABLES) if (!Array.isArray(db[table])) db[table] = base[table];
    if (!db.seq || typeof db.seq !== 'object') db.seq = {};

    if (seed(db)) save(db);
    return db;
  }

  function save(db) {
    try {
      backend.store.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      // Quota is the realistic failure; anything else is just as unrecoverable.
      throw new StoreError(507, 'storageFull', 'Browser storage is full — delete a strategy to free space');
    }
  }

  /** Next id for a table, mimicking INTEGER PRIMARY KEY AUTOINCREMENT. */
  function nextId(db, table) {
    const highest = db[table].reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);
    const next = Math.max(highest, Number(db.seq[table]) || 0) + 1;
    db.seq[table] = next;
    return next;
  }

  const clone = (value) => JSON.parse(JSON.stringify(value));

  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  /* ------------------------------------------------------------ errors */

  // `code` is a stable identifier the browser translates; `message` stays as an
  // English fallback.
  class StoreError extends Error {
    constructor(status, code, message, params) {
      super(message);
      this.status = status;
      this.code = code;
      this.params = params;
    }
  }

  /* -------------------------------------------------------- validation */

  const str = (v, fallback = null) => {
    if (v === undefined || v === null) return fallback;
    const s = String(v).trim();
    return s === '' ? fallback : s;
  };

  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function required(value, field) {
    if (!value) throw new StoreError(400, 'required', `"${field}" is required`, { field });
    return value;
  }

  const FEET = new Set(['left', 'right', 'both']);
  const DRAWING_KINDS = new Set(['arrow', 'run', 'pass', 'dribble', 'line', 'zone', 'text']);
  const PHASES = new Set(['open', 'kickoff']);

  const byText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''));

  /* ------------------------------------------------------------- seed */

  /*
   * Pitch coordinate space is 0-100 on both axes, portrait orientation:
   * y=100 is our own goal line, y=0 is the opponent goal. We attack upward.
   */
  const DEFAULT_FORMATIONS = [
    {
      name: '4-4-2',
      description: 'Two banks of four. Balanced and easy to drill.',
      slots: [
        ['GK', 'Goalkeeper', 'GK', 50, 92],
        ['LB', 'Left Back', 'DEF', 16, 74],
        ['LCB', 'Left Centre Back', 'DEF', 38, 78],
        ['RCB', 'Right Centre Back', 'DEF', 62, 78],
        ['RB', 'Right Back', 'DEF', 84, 74],
        ['LM', 'Left Midfield', 'MID', 15, 50],
        ['LCM', 'Left Central Mid', 'MID', 38, 53],
        ['RCM', 'Right Central Mid', 'MID', 62, 53],
        ['RM', 'Right Midfield', 'MID', 85, 50],
        ['LST', 'Left Striker', 'FWD', 40, 24],
        ['RST', 'Right Striker', 'FWD', 60, 24],
      ],
    },
    {
      name: '4-3-3',
      description: 'Wide front three, single pivot behind two eights.',
      slots: [
        ['GK', 'Goalkeeper', 'GK', 50, 92],
        ['LB', 'Left Back', 'DEF', 16, 74],
        ['LCB', 'Left Centre Back', 'DEF', 38, 78],
        ['RCB', 'Right Centre Back', 'DEF', 62, 78],
        ['RB', 'Right Back', 'DEF', 84, 74],
        ['CDM', 'Holding Mid', 'MID', 50, 60],
        ['LCM', 'Left Eight', 'MID', 32, 46],
        ['RCM', 'Right Eight', 'MID', 68, 46],
        ['LW', 'Left Wing', 'FWD', 15, 25],
        ['ST', 'Striker', 'FWD', 50, 17],
        ['RW', 'Right Wing', 'FWD', 85, 25],
      ],
    },
    {
      name: '4-2-3-1',
      description: 'Double pivot with a free ten behind a lone striker.',
      slots: [
        ['GK', 'Goalkeeper', 'GK', 50, 92],
        ['LB', 'Left Back', 'DEF', 16, 74],
        ['LCB', 'Left Centre Back', 'DEF', 38, 78],
        ['RCB', 'Right Centre Back', 'DEF', 62, 78],
        ['RB', 'Right Back', 'DEF', 84, 74],
        ['LDM', 'Left Pivot', 'MID', 38, 60],
        ['RDM', 'Right Pivot', 'MID', 62, 60],
        ['LAM', 'Left Attacking Mid', 'MID', 18, 38],
        ['CAM', 'Attacking Mid', 'MID', 50, 36],
        ['RAM', 'Right Attacking Mid', 'MID', 82, 38],
        ['ST', 'Striker', 'FWD', 50, 18],
      ],
    },
    {
      name: '4-1-4-1',
      description: 'Compact mid block, one anchor, one striker.',
      slots: [
        ['GK', 'Goalkeeper', 'GK', 50, 92],
        ['LB', 'Left Back', 'DEF', 16, 74],
        ['LCB', 'Left Centre Back', 'DEF', 38, 78],
        ['RCB', 'Right Centre Back', 'DEF', 62, 78],
        ['RB', 'Right Back', 'DEF', 84, 74],
        ['CDM', 'Anchor', 'MID', 50, 62],
        ['LM', 'Left Midfield', 'MID', 15, 44],
        ['LCM', 'Left Central Mid', 'MID', 38, 46],
        ['RCM', 'Right Central Mid', 'MID', 62, 46],
        ['RM', 'Right Midfield', 'MID', 85, 44],
        ['ST', 'Striker', 'FWD', 50, 20],
      ],
    },
    {
      name: '4-4-2 Diamond',
      description: 'Narrow midfield diamond, full backs supply the width.',
      slots: [
        ['GK', 'Goalkeeper', 'GK', 50, 92],
        ['LB', 'Left Back', 'DEF', 15, 72],
        ['LCB', 'Left Centre Back', 'DEF', 38, 78],
        ['RCB', 'Right Centre Back', 'DEF', 62, 78],
        ['RB', 'Right Back', 'DEF', 85, 72],
        ['CDM', 'Diamond Base', 'MID', 50, 62],
        ['LM', 'Left Diamond', 'MID', 24, 48],
        ['RM', 'Right Diamond', 'MID', 76, 48],
        ['CAM', 'Diamond Tip', 'MID', 50, 36],
        ['LST', 'Left Striker', 'FWD', 40, 20],
        ['RST', 'Right Striker', 'FWD', 60, 20],
      ],
    },
    {
      name: '3-5-2',
      description: 'Back three with wing backs pushed high.',
      slots: [
        ['GK', 'Goalkeeper', 'GK', 50, 92],
        ['LCB', 'Left Centre Back', 'DEF', 28, 78],
        ['CB', 'Centre Back', 'DEF', 50, 81],
        ['RCB', 'Right Centre Back', 'DEF', 72, 78],
        ['LWB', 'Left Wing Back', 'MID', 10, 50],
        ['LCM', 'Left Central Mid', 'MID', 33, 52],
        ['CM', 'Central Mid', 'MID', 50, 58],
        ['RCM', 'Right Central Mid', 'MID', 67, 52],
        ['RWB', 'Right Wing Back', 'MID', 90, 50],
        ['LST', 'Left Striker', 'FWD', 40, 22],
        ['RST', 'Right Striker', 'FWD', 60, 22],
      ],
    },
    {
      name: '5-3-2',
      description: 'Back five that drops in, two strikers to counter.',
      slots: [
        ['GK', 'Goalkeeper', 'GK', 50, 92],
        ['LWB', 'Left Wing Back', 'DEF', 10, 66],
        ['LCB', 'Left Centre Back', 'DEF', 30, 79],
        ['CB', 'Centre Back', 'DEF', 50, 82],
        ['RCB', 'Right Centre Back', 'DEF', 70, 79],
        ['RWB', 'Right Wing Back', 'DEF', 90, 66],
        ['LCM', 'Left Central Mid', 'MID', 30, 50],
        ['CM', 'Central Mid', 'MID', 50, 53],
        ['RCM', 'Right Central Mid', 'MID', 70, 50],
        ['LST', 'Left Striker', 'FWD', 40, 22],
        ['RST', 'Right Striker', 'FWD', 60, 22],
      ],
    },
  ];

  /**
   * Puts the built-in formations in an empty document and derives a kick-off
   * spot for any slot missing one. Returns true when it changed anything.
   */
  /** Lays a built-in's slots down under a formation that has none. */
  function insertDefaultSlots(db, formationId, template) {
    template.slots.forEach(([code, label, role_group, x, y], i) => {
      db.formation_slots.push({
        id: nextId(db, 'formation_slots'),
        formation_id: formationId,
        code,
        label,
        role_group,
        x,
        y,
        kickoff_x: null,
        kickoff_y: null,
        sort_order: i,
      });
    });
  }

  function seed(db) {
    let changed = false;

    if (db.formations.length === 0) {
      for (const template of DEFAULT_FORMATIONS) {
        const id = nextId(db, 'formations');
        db.formations.push({
          id,
          name: template.name,
          description: template.description,
          is_default: 1,
        });
        insertDefaultSlots(db, id, template);
      }
      changed = true;
    }

    /*
     * A formation with no slots cannot hold a lineup: the board has nowhere to
     * put a player, so every one of them sits on the bench and the strategy
     * looks empty. The check above only rebuilds the built-ins when the whole
     * table is gone, which leaves the worse case — formations present, slots
     * missing — broken for good. That is reachable through a restore, since a
     * backup's `formation_slots` is not covered by the counts the app shows
     * before overwriting anything. Put the built-ins' slots back by name;
     * a custom formation's are not ours to invent.
     */
    const templates = new Map(DEFAULT_FORMATIONS.map((f) => [f.name, f]));
    for (const formation of db.formations) {
      if (slotsFor(db, formation.id).length) continue;
      const template = templates.get(formation.name);
      if (!template) continue;
      insertDefaultSlots(db, formation.id, template);
      changed = true;
    }

    // Any slot without a kick-off spot gets one derived from its open-play spot.
    const pending = new Set(
      db.formation_slots
        .filter((s) => s.kickoff_x === null || s.kickoff_x === undefined
          || s.kickoff_y === null || s.kickoff_y === undefined)
        .map((s) => s.formation_id)
    );
    for (const formationId of pending) {
      const slots = slotsFor(db, formationId);
      for (const spot of kickoffShape(slots, { takesKickoff: true })) {
        const slot = db.formation_slots.find((s) => s.id === spot.id);
        slot.kickoff_x = spot.x;
        slot.kickoff_y = spot.y;
      }
      changed = true;
    }

    return changed;
  }

  /* ----------------------------------------------------------- queries */

  const slotsFor = (db, formationId) => db.formation_slots
    .filter((s) => s.formation_id === formationId)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  const findPlayer = (db, id) => db.players.find((p) => p.id === id) || null;
  const findStaff = (db, id) => db.staff.find((s) => s.id === id) || null;
  const findFormation = (db, id) => db.formations.find((f) => f.id === id) || null;
  const findStrategy = (db, id) => db.strategies.find((s) => s.id === id) || null;

  const remove = (rows, predicate) => {
    let removed = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (predicate(rows[i])) { rows.splice(i, 1); removed++; }
    }
    return removed;
  };

  /* ----------------------------------------------------------- shaping */

  function formationWithSlots(db, row) {
    return { ...row, is_default: !!row.is_default, slots: slotsFor(db, row.id) };
  }

  function strategyDetail(db, id) {
    const row = findStrategy(db, id);
    if (!row) throw new StoreError(404, 'strategyNotFound', 'Strategy not found');
    return {
      ...row,
      takes_kickoff: !!row.takes_kickoff,
      assignments: db.strategy_assignments.filter((a) => a.strategy_id === id),
      drawings: db.strategy_drawings
        .filter((d) => d.strategy_id === id)
        .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
    };
  }

  /** Validates and normalises the assignment + drawing payload shared by save routes. */
  function writeStrategyContents(db, strategyId, formationId, body) {
    const validSlots = new Set(
      formationId === null ? [] : slotsFor(db, formationId).map((s) => s.id)
    );

    remove(db.strategy_assignments, (a) => a.strategy_id === strategyId);
    const seenSlots = new Set();
    for (const a of Array.isArray(body.assignments) ? body.assignments : []) {
      const slotId = num(a.slot_id);
      if (slotId === null || !validSlots.has(slotId)) continue; // slot not in this formation
      if (seenSlots.has(slotId)) continue;                      // UNIQUE (strategy, slot)
      const playerId = num(a.player_id);
      if (playerId !== null && !findPlayer(db, playerId)) continue; // stale player
      const spot = (vx, vy, minY) => {
        const x = num(vx);
        const y = num(vy);
        return [x === null ? null : clamp(x, 0, 100), y === null ? null : clamp(y, minY, 100)];
      };
      const [x, y] = spot(a.x, a.y, 0);
      // Kick-off spots are pinned to our own half (y >= 50).
      const [kickoff_x, kickoff_y] = spot(a.kickoff_x, a.kickoff_y, 50);
      seenSlots.add(slotId);
      db.strategy_assignments.push({
        id: nextId(db, 'strategy_assignments'),
        strategy_id: strategyId,
        slot_id: slotId,
        player_id: playerId,
        x, y, kickoff_x, kickoff_y,
      });
    }

    remove(db.strategy_drawings, (d) => d.strategy_id === strategyId);
    const drawings = Array.isArray(body.drawings) ? body.drawings : [];
    drawings.forEach((d, i) => {
      const kind = str(d.kind, 'arrow');
      if (!DRAWING_KINDS.has(kind)) return;
      const points = (Array.isArray(d.points) ? d.points : [])
        .map((p) => ({ x: num(p.x), y: num(p.y) }))
        .filter((p) => p.x !== null && p.y !== null)
        .map((p) => ({ x: clamp(p.x, 0, 100), y: clamp(p.y, 0, 100) }));
      if (points.length === 0) return;
      db.strategy_drawings.push({
        id: nextId(db, 'strategy_drawings'),
        strategy_id: strategyId,
        kind,
        points,
        color: str(d.color, '#ffd166'),
        label: str(d.label),
        phase: PHASES.has(d.phase) ? d.phase : 'open',
        sort_order: i,
      });
    });
  }

  function slotsFromBody(body) {
    const slots = Array.isArray(body.slots) ? body.slots : [];
    if (slots.length === 0) throw new StoreError(400, 'slotsRequired', 'A formation needs at least one slot');
    if (slots.length > 11) throw new StoreError(400, 'slotsTooMany', 'A formation cannot have more than 11 slots');

    const shaped = slots.map((s, i) => ({
      code: str(s.code, `P${i + 1}`),
      label: str(s.label, str(s.code, `Position ${i + 1}`)),
      role_group: ['GK', 'DEF', 'MID', 'FWD'].includes(s.role_group) ? s.role_group : 'MID',
      x: clamp(num(s.x) ?? 50, 0, 100),
      y: clamp(num(s.y) ?? 50, 0, 100),
      kickoff_x: num(s.kickoff_x),
      kickoff_y: num(s.kickoff_y),
    }));

    // Derive any kick-off spot the caller did not supply, then pin it to our half.
    const derived = kickoffShape(shaped, { takesKickoff: true });
    shaped.forEach((s, i) => {
      s.kickoff_x = clamp(s.kickoff_x ?? derived[i].x, 0, 100);
      s.kickoff_y = clamp(s.kickoff_y ?? derived[i].y, 50, 100);
    });
    return shaped;
  }

  function insertSlots(db, formationId, slots) {
    slots.forEach((s, i) => {
      db.formation_slots.push({
        id: nextId(db, 'formation_slots'),
        formation_id: formationId,
        code: s.code,
        label: s.label,
        role_group: s.role_group,
        x: s.x,
        y: s.y,
        kickoff_x: s.kickoff_x,
        kickoff_y: s.kickoff_y,
        sort_order: i,
      });
    });
  }

  /** Drops the slots of a formation, cascading to assignments that point at them. */
  function dropSlots(db, formationId) {
    const gone = new Set(db.formation_slots.filter((s) => s.formation_id === formationId).map((s) => s.id));
    remove(db.formation_slots, (s) => s.formation_id === formationId);
    remove(db.strategy_assignments, (a) => gone.has(a.slot_id));
  }

  function assertNameFree(db, name, exceptId) {
    if (db.formations.some((f) => f.name === name && f.id !== exceptId)) {
      throw new StoreError(409, 'duplicateFormation', `A formation named "${name}" already exists`, { name });
    }
  }

  /* ------------------------------------------------------------ backup */

  /**
   * The whole document, wrapped in a self-describing envelope. `counts` is
   * there so the app can say what a file holds before overwriting anything.
   */
  function exportBackup(db) {
    const data = { version: db.version, seq: db.seq };
    for (const table of TABLES) data[table] = db[table];
    return {
      format: BACKUP_FORMAT,
      backup_version: BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      counts: countsOf(data),
      data,
    };
  }

  const countsOf = (doc) => ({
    players: doc.players.length,
    staff: doc.staff.length,
    formations: doc.formations.length,
    strategies: doc.strategies.length,
  });

  const isRow = (row) => row !== null && typeof row === 'object' && !Array.isArray(row);

  /**
   * Replaces the document with the contents of a backup. This is a restore,
   * not a merge: whatever is in the browser now is gone afterwards.
   *
   * Rows are taken as they come apart from a shape check — anything that is
   * not an object with a numeric id is dropped — because they were written by
   * the validating routes in the first place. Dangling references are already
   * survivable: the app drops assignments pointing at a missing slot or player
   * the next time it saves the strategy.
   */
  function importBackup(db, payload) {
    if (!isRow(payload)) {
      throw new StoreError(400, 'backupUnreadable', 'That file is not a backup');
    }
    if (payload.format !== undefined && payload.format !== BACKUP_FORMAT) {
      throw new StoreError(400, 'backupWrongFormat', 'That file was written by a different app');
    }
    if (Number(payload.backup_version) > BACKUP_VERSION) {
      throw new StoreError(400, 'backupTooNew', 'That backup comes from a newer version of this app');
    }

    // Accept the envelope or, for hand-edited files, a bare document.
    const doc = isRow(payload.data) ? payload.data : payload;
    if (!TABLES.some((table) => Array.isArray(doc[table]))) {
      throw new StoreError(400, 'backupUnreadable', 'That file is not a backup');
    }

    db.version = 1;
    db.seq = {};
    for (const table of TABLES) {
      const rows = Array.isArray(doc[table]) ? doc[table] : [];
      const seen = new Set();
      db[table] = [];
      for (const row of rows) {
        if (!isRow(row)) continue;
        const id = num(row.id);
        if (id === null || seen.has(id)) continue; // no row without a primary key, no duplicates
        seen.add(id);
        db[table].push({ ...row, id });
      }
      db.seq[table] = db[table].reduce((max, row) => Math.max(max, row.id), 0);
    }

    // An empty backup gets the built-in formations back, exactly like a fresh
    // document; a slot that predates kick-off spots gets one derived.
    seed(db);
    return { imported: true, counts: countsOf(db) };
  }

  /* ------------------------------------------------------------ routes */

  const routes = [
    ['GET', /^\/api\/players$/, (db) => db.players.slice().sort((a, b) =>
      (b.active - a.active)
      || ((a.shirt_number === null) - (b.shirt_number === null))
      || ((a.shirt_number ?? 0) - (b.shirt_number ?? 0))
      || byText(a.name, b.name))],

    ['POST', /^\/api\/players$/, (db, m, body) => {
      const player = {
        id: nextId(db, 'players'),
        name: required(str(body.name), 'name'),
        shirt_number: num(body.shirt_number),
        primary_position: str(body.primary_position, 'CM'),
        secondary_position: str(body.secondary_position),
        foot: FEET.has(body.foot) ? body.foot : 'right',
        birth_year: num(body.birth_year),
        notes: str(body.notes),
        active: body.active === false ? 0 : 1,
      };
      db.players.push(player);
      return player;
    }],

    ['PUT', /^\/api\/players\/(\d+)$/, (db, m, body) => {
      const current = findPlayer(db, Number(m[1]));
      if (!current) throw new StoreError(404, 'playerNotFound', 'Player not found');
      Object.assign(current, {
        name: required(str(body.name, current.name), 'name'),
        shirt_number: body.shirt_number === undefined ? current.shirt_number : num(body.shirt_number),
        primary_position: str(body.primary_position, current.primary_position),
        secondary_position: body.secondary_position === undefined
          ? current.secondary_position : str(body.secondary_position),
        foot: FEET.has(body.foot) ? body.foot : current.foot,
        birth_year: body.birth_year === undefined ? current.birth_year : num(body.birth_year),
        notes: body.notes === undefined ? current.notes : str(body.notes),
        active: body.active === undefined ? current.active : (body.active ? 1 : 0),
      });
      return current;
    }],

    ['DELETE', /^\/api\/players\/(\d+)$/, (db, m) => {
      const id = Number(m[1]);
      if (remove(db.players, (p) => p.id === id) === 0) {
        throw new StoreError(404, 'playerNotFound', 'Player not found');
      }
      // ON DELETE SET NULL: the slot stays, it just has nobody in it.
      for (const a of db.strategy_assignments) if (a.player_id === id) a.player_id = null;
      return { deleted: id };
    }],

    ['GET', /^\/api\/staff$/, (db) => db.staff.slice()
      .sort((a, b) => byText(a.role, b.role) || byText(a.name, b.name))],

    ['POST', /^\/api\/staff$/, (db, m, body) => {
      const member = {
        id: nextId(db, 'staff'),
        name: required(str(body.name), 'name'),
        role: str(body.role, 'Coach'),
        email: str(body.email),
        phone: str(body.phone),
        notes: str(body.notes),
      };
      db.staff.push(member);
      return member;
    }],

    ['PUT', /^\/api\/staff\/(\d+)$/, (db, m, body) => {
      const current = findStaff(db, Number(m[1]));
      if (!current) throw new StoreError(404, 'staffNotFound', 'Staff member not found');
      Object.assign(current, {
        name: required(str(body.name, current.name), 'name'),
        role: str(body.role, current.role),
        email: body.email === undefined ? current.email : str(body.email),
        phone: body.phone === undefined ? current.phone : str(body.phone),
        notes: body.notes === undefined ? current.notes : str(body.notes),
      });
      return current;
    }],

    ['DELETE', /^\/api\/staff\/(\d+)$/, (db, m) => {
      const id = Number(m[1]);
      if (remove(db.staff, (s) => s.id === id) === 0) {
        throw new StoreError(404, 'staffNotFound', 'Staff member not found');
      }
      return { deleted: id };
    }],

    // Built-ins keep their seeded order (4-4-2 first) rather than sorting alphabetically.
    ['GET', /^\/api\/formations$/, (db) => db.formations.slice()
      .sort((a, b) => (b.is_default - a.is_default) || (a.id - b.id))
      .map((f) => formationWithSlots(db, f))],

    ['POST', /^\/api\/formations$/, (db, m, body) => {
      const slots = slotsFromBody(body);
      const name = required(str(body.name), 'name');
      assertNameFree(db, name, null);
      const formation = { id: nextId(db, 'formations'), name, description: str(body.description), is_default: 0 };
      db.formations.push(formation);
      insertSlots(db, formation.id, slots);
      return formationWithSlots(db, formation);
    }],

    ['PUT', /^\/api\/formations\/(\d+)$/, (db, m, body) => {
      const current = findFormation(db, Number(m[1]));
      if (!current) throw new StoreError(404, 'formationNotFound', 'Formation not found');
      if (current.is_default) {
        throw new StoreError(403, 'builtinReadonly', 'Built-in formations cannot be edited — duplicate it first');
      }
      const slots = slotsFromBody(body);
      const name = str(body.name, current.name);
      assertNameFree(db, name, current.id);
      current.name = name;
      current.description = str(body.description);
      dropSlots(db, current.id);
      insertSlots(db, current.id, slots);
      return formationWithSlots(db, current);
    }],

    // Moves existing spots in place. Unlike a full PUT this keeps slot ids, so
    // strategies that reference them survive the edit.
    ['PUT', /^\/api\/formations\/(\d+)\/slots$/, (db, m, body) => {
      const current = findFormation(db, Number(m[1]));
      if (!current) throw new StoreError(404, 'formationNotFound', 'Formation not found');
      if (current.is_default) {
        throw new StoreError(403, 'builtinReadonly', 'Built-in formations cannot be edited — duplicate it first');
      }
      // phase 'kickoff' writes the starting spots, anything else the open-play ones.
      const kickoffPhase = str(body.phase) === 'kickoff';
      for (const s of Array.isArray(body.slots) ? body.slots : []) {
        const slotId = num(s.id);
        const x = num(s.x);
        const y = num(s.y);
        if (slotId === null || x === null || y === null) continue;
        const slot = db.formation_slots.find((row) => row.id === slotId && row.formation_id === current.id);
        if (!slot) continue;
        if (kickoffPhase) {
          slot.kickoff_x = clamp(x, 0, 100);
          slot.kickoff_y = clamp(y, 50, 100);
        } else {
          slot.x = clamp(x, 0, 100);
          slot.y = clamp(y, 0, 100);
        }
      }
      return formationWithSlots(db, current);
    }],

    ['DELETE', /^\/api\/formations\/(\d+)$/, (db, m) => {
      const id = Number(m[1]);
      const current = findFormation(db, id);
      if (!current) throw new StoreError(404, 'formationNotFound', 'Formation not found');
      if (current.is_default) throw new StoreError(403, 'builtinUndeletable', 'Built-in formations cannot be deleted');
      dropSlots(db, id);
      remove(db.formations, (f) => f.id === id);
      // ON DELETE SET NULL: strategies survive, just without a formation.
      for (const s of db.strategies) if (s.formation_id === id) s.formation_id = null;
      return { deleted: id };
    }],

    ['GET', /^\/api\/strategies$/, (db) => db.strategies.slice()
      .sort((a, b) => byText(b.updated_at, a.updated_at) || (b.id - a.id))
      .map((s) => ({ ...s, formation_name: findFormation(db, s.formation_id)?.name ?? null }))],

    ['GET', /^\/api\/strategies\/(\d+)$/, (db, m) => strategyDetail(db, Number(m[1]))],

    ['POST', /^\/api\/strategies$/, (db, m, body) => {
      const formationId = num(body.formation_id);
      if (formationId !== null && !findFormation(db, formationId)) {
        throw new StoreError(400, 'unknownFormation', 'Unknown formation');
      }
      const stamp = now();
      const strategy = {
        id: nextId(db, 'strategies'),
        name: required(str(body.name), 'name'),
        formation_id: formationId,
        description: str(body.description),
        created_at: stamp,
        updated_at: stamp,
        takes_kickoff: body.takes_kickoff === false ? 0 : 1,
      };
      db.strategies.push(strategy);
      writeStrategyContents(db, strategy.id, formationId, body);
      return strategyDetail(db, strategy.id);
    }],

    ['PUT', /^\/api\/strategies\/(\d+)$/, (db, m, body) => {
      const current = findStrategy(db, Number(m[1]));
      if (!current) throw new StoreError(404, 'strategyNotFound', 'Strategy not found');
      const formationId = body.formation_id === undefined ? current.formation_id : num(body.formation_id);
      if (formationId !== null && !findFormation(db, formationId)) {
        throw new StoreError(400, 'unknownFormation', 'Unknown formation');
      }
      Object.assign(current, {
        name: required(str(body.name, current.name), 'name'),
        formation_id: formationId,
        description: body.description === undefined ? current.description : str(body.description),
        takes_kickoff: body.takes_kickoff === undefined ? current.takes_kickoff : (body.takes_kickoff ? 1 : 0),
        updated_at: now(),
      });
      writeStrategyContents(db, current.id, formationId, body);
      return strategyDetail(db, current.id);
    }],

    ['DELETE', /^\/api\/strategies\/(\d+)$/, (db, m) => {
      const id = Number(m[1]);
      if (remove(db.strategies, (s) => s.id === id) === 0) {
        throw new StoreError(404, 'strategyNotFound', 'Strategy not found');
      }
      remove(db.strategy_assignments, (a) => a.strategy_id === id);
      remove(db.strategy_drawings, (d) => d.strategy_id === id);
      return { deleted: id };
    }],

    ['GET', /^\/api\/backup$/, (db) => exportBackup(db)],

    ['PUT', /^\/api\/backup$/, (db, m, body) => importBackup(db, body)],
  ];

  /* ----------------------------------------------------------- request */

  /**
   * Runs one "request" against the stored document. Reads see whatever is in
   * localStorage right now (so a second tab's writes show up); a write is
   * persisted only if the whole handler succeeded, which keeps a rejected
   * payload from leaving half-applied rows behind.
   */
  async function request(method, path, body = {}) {
    const db = load();

    let matchedPath = false;
    for (const [routeMethod, pattern, handler] of routes) {
      const m = pattern.exec(path);
      if (!m) continue;
      matchedPath = true;
      if (method !== routeMethod) continue;

      const result = handler(db, m, body ?? {});
      if (method !== 'GET') save(db);
      return clone(result ?? {});
    }

    throw matchedPath
      ? new StoreError(405, 'methodNotAllowed', 'Method not allowed')
      : new StoreError(404, 'notFound', 'Not found');
  }

  /** Wipes the stored document; the built-in formations come back on next read. */
  function reset() {
    backend.store.removeItem(STORAGE_KEY);
  }

  return {
    request,
    reset,
    STORAGE_KEY,
    BACKUP_FORMAT,
    BACKUP_VERSION,
    StoreError,
    persistent: backend.available,
    DEFAULT_FORMATIONS,
  };
});
