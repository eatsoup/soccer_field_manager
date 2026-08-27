'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { kickoffShape } = require('./public/kickoff.js');

const DB_PATH = process.env.SOCCER_DB || path.join(__dirname, 'soccer.db');

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  shirt_number       INTEGER,
  primary_position   TEXT    NOT NULL DEFAULT 'CM',
  secondary_position TEXT,
  foot               TEXT    NOT NULL DEFAULT 'right',
  birth_year         INTEGER,
  notes              TEXT,
  active             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS staff (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  role   TEXT NOT NULL DEFAULT 'Coach',
  email  TEXT,
  phone  TEXT,
  notes  TEXT
);

CREATE TABLE IF NOT EXISTS formations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS formation_slots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  formation_id INTEGER NOT NULL REFERENCES formations(id) ON DELETE CASCADE,
  code         TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  role_group   TEXT    NOT NULL DEFAULT 'MID',
  x            REAL    NOT NULL,
  y            REAL    NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS strategies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  formation_id INTEGER REFERENCES formations(id) ON DELETE SET NULL,
  description  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per on-pitch slot for a strategy. x/y override the formation default
-- so a slot can be nudged without editing the formation itself.
CREATE TABLE IF NOT EXISTS strategy_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  slot_id     INTEGER NOT NULL REFERENCES formation_slots(id) ON DELETE CASCADE,
  player_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
  x           REAL,
  y           REAL,
  UNIQUE (strategy_id, slot_id)
);

CREATE TABLE IF NOT EXISTS strategy_drawings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  points      TEXT    NOT NULL DEFAULT '[]',
  color       TEXT    NOT NULL DEFAULT '#ffd166',
  label       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_slots_formation  ON formation_slots(formation_id);

CREATE INDEX IF NOT EXISTS idx_assign_strategy  ON strategy_assignments(strategy_id);
CREATE INDEX IF NOT EXISTS idx_draw_strategy    ON strategy_drawings(strategy_id);
`);

/*
 * Kick-off support was added after the first release, so it arrives as an
 * additive migration: a second coordinate set per slot (and per strategy
 * override) plus a flag for which side is taking the kick-off. The lineup is
 * deliberately shared between the two phases — same eleven, different spots.
 */
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('formation_slots', 'kickoff_x', 'REAL');
addColumn('formation_slots', 'kickoff_y', 'REAL');
addColumn('strategy_assignments', 'kickoff_x', 'REAL');
addColumn('strategy_assignments', 'kickoff_y', 'REAL');
addColumn('strategies', 'takes_kickoff', 'INTEGER NOT NULL DEFAULT 1');

// Drawings belong to one phase: an open-play arrow should not appear on the
// kick-off board. Existing drawings predate the split and were all open play.
addColumn('strategy_drawings', 'phase', "TEXT NOT NULL DEFAULT 'open'");

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

function seedFormations() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM formations').get();
  if (existing.n > 0) return;

  const insertFormation = db.prepare(
    'INSERT INTO formations (name, description, is_default) VALUES (?, ?, 1)'
  );
  const insertSlot = db.prepare(
    `INSERT INTO formation_slots (formation_id, code, label, role_group, x, y, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  for (const formation of DEFAULT_FORMATIONS) {
    const { lastInsertRowid } = insertFormation.run(formation.name, formation.description);
    formation.slots.forEach(([code, label, group, x, y], i) => {
      insertSlot.run(lastInsertRowid, code, label, group, x, y, i);
    });
  }
}

/**
 * Any slot without a kick-off spot gets one derived from its open-play spot.
 * Covers both the built-ins on a fresh database and rows created before the
 * kick-off columns existed.
 */
function backfillKickoffSpots() {
  const pending = db
    .prepare('SELECT DISTINCT formation_id AS id FROM formation_slots WHERE kickoff_x IS NULL OR kickoff_y IS NULL')
    .all();
  if (pending.length === 0) return;

  const slotsFor = db.prepare('SELECT * FROM formation_slots WHERE formation_id = ? ORDER BY sort_order, id');
  const setSpot = db.prepare('UPDATE formation_slots SET kickoff_x = ?, kickoff_y = ? WHERE id = ?');

  for (const { id } of pending) {
    for (const spot of kickoffShape(slotsFor.all(id), { takesKickoff: true })) {
      setSpot.run(spot.x, spot.y, spot.id);
    }
  }
}

seedFormations();
backfillKickoffSpots();

module.exports = { db, DB_PATH };
