'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { db, DB_PATH } = require('./db');
const { kickoffShape } = require('./public/kickoff.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new HttpError(413, 'tooLarge', 'Payload too large'));
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'badJson', 'Body is not valid JSON'));
      }
    });
  });
}

// `code` is a stable identifier the browser translates; `message` stays as an
// English fallback for API clients that do not translate.
class HttpError extends Error {
  constructor(status, code, message, params) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

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
  if (!value) throw new HttpError(400, 'required', `"${field}" is required`, { field });
  return value;
}

const FEET = new Set(['left', 'right', 'both']);
const DRAWING_KINDS = new Set(['arrow', 'run', 'pass', 'dribble', 'line', 'zone', 'text']);
const PHASES = new Set(['open', 'kickoff']);

// ---------------------------------------------------------------- queries

const q = {
  allPlayers: db.prepare('SELECT * FROM players ORDER BY active DESC, shirt_number IS NULL, shirt_number, name'),
  getPlayer: db.prepare('SELECT * FROM players WHERE id = ?'),
  insertPlayer: db.prepare(`INSERT INTO players
    (name, shirt_number, primary_position, secondary_position, foot, birth_year, notes, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  updatePlayer: db.prepare(`UPDATE players SET
    name = ?, shirt_number = ?, primary_position = ?, secondary_position = ?,
    foot = ?, birth_year = ?, notes = ?, active = ? WHERE id = ?`),
  deletePlayer: db.prepare('DELETE FROM players WHERE id = ?'),

  allStaff: db.prepare('SELECT * FROM staff ORDER BY role, name'),
  getStaff: db.prepare('SELECT * FROM staff WHERE id = ?'),
  insertStaff: db.prepare('INSERT INTO staff (name, role, email, phone, notes) VALUES (?, ?, ?, ?, ?)'),
  updateStaff: db.prepare('UPDATE staff SET name = ?, role = ?, email = ?, phone = ?, notes = ? WHERE id = ?'),
  deleteStaff: db.prepare('DELETE FROM staff WHERE id = ?'),

  // Built-ins keep their seeded order (4-4-2 first) rather than sorting alphabetically.
  allFormations: db.prepare('SELECT * FROM formations ORDER BY is_default DESC, id'),
  getFormation: db.prepare('SELECT * FROM formations WHERE id = ?'),
  slotsFor: db.prepare('SELECT * FROM formation_slots WHERE formation_id = ? ORDER BY sort_order, id'),
  insertFormation: db.prepare('INSERT INTO formations (name, description, is_default) VALUES (?, ?, 0)'),
  updateFormation: db.prepare('UPDATE formations SET name = ?, description = ? WHERE id = ?'),
  deleteFormation: db.prepare('DELETE FROM formations WHERE id = ?'),
  insertSlot: db.prepare(`INSERT INTO formation_slots
    (formation_id, code, label, role_group, x, y, kickoff_x, kickoff_y, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  clearSlots: db.prepare('DELETE FROM formation_slots WHERE formation_id = ?'),
  moveSlot: db.prepare('UPDATE formation_slots SET x = ?, y = ? WHERE id = ? AND formation_id = ?'),
  moveKickoffSlot: db.prepare(
    'UPDATE formation_slots SET kickoff_x = ?, kickoff_y = ? WHERE id = ? AND formation_id = ?'
  ),

  allStrategies: db.prepare(`SELECT s.*, f.name AS formation_name
    FROM strategies s LEFT JOIN formations f ON f.id = s.formation_id
    ORDER BY s.updated_at DESC, s.id DESC`),
  getStrategy: db.prepare('SELECT * FROM strategies WHERE id = ?'),
  insertStrategy: db.prepare(
    'INSERT INTO strategies (name, formation_id, description, takes_kickoff) VALUES (?, ?, ?, ?)'
  ),
  updateStrategy: db.prepare(`UPDATE strategies SET name = ?, formation_id = ?, description = ?,
    takes_kickoff = ?, updated_at = datetime('now') WHERE id = ?`),
  deleteStrategy: db.prepare('DELETE FROM strategies WHERE id = ?'),

  assignmentsFor: db.prepare('SELECT * FROM strategy_assignments WHERE strategy_id = ?'),
  clearAssignments: db.prepare('DELETE FROM strategy_assignments WHERE strategy_id = ?'),
  insertAssignment: db.prepare(`INSERT INTO strategy_assignments
    (strategy_id, slot_id, player_id, x, y, kickoff_x, kickoff_y) VALUES (?, ?, ?, ?, ?, ?, ?)`),

  drawingsFor: db.prepare('SELECT * FROM strategy_drawings WHERE strategy_id = ? ORDER BY sort_order, id'),
  clearDrawings: db.prepare('DELETE FROM strategy_drawings WHERE strategy_id = ?'),
  insertDrawing: db.prepare(`INSERT INTO strategy_drawings
    (strategy_id, kind, points, color, label, phase, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`),
};

// ---------------------------------------------------------------- shaping

function formationWithSlots(row) {
  return { ...row, is_default: !!row.is_default, slots: q.slotsFor.all(row.id) };
}

function strategyDetail(id) {
  const row = q.getStrategy.get(id);
  if (!row) throw new HttpError(404, 'strategyNotFound', 'Strategy not found');
  return {
    ...row,
    takes_kickoff: !!row.takes_kickoff,
    assignments: q.assignmentsFor.all(id),
    drawings: q.drawingsFor.all(id).map((d) => ({ ...d, points: JSON.parse(d.points) })),
  };
}

/** Validates and normalises the assignment + drawing payload shared by save routes. */
function writeStrategyContents(strategyId, formationId, body) {
  const validSlots = new Set(
    formationId ? q.slotsFor.all(formationId).map((s) => s.id) : []
  );

  q.clearAssignments.run(strategyId);
  for (const a of Array.isArray(body.assignments) ? body.assignments : []) {
    const slotId = num(a.slot_id);
    if (slotId === null || !validSlots.has(slotId)) continue; // slot not in this formation
    const playerId = num(a.player_id);
    if (playerId !== null && !q.getPlayer.get(playerId)) continue; // stale player
    const spot = (vx, vy, minY) => {
      const x = num(vx);
      const y = num(vy);
      return [x === null ? null : clamp(x, 0, 100), y === null ? null : clamp(y, minY, 100)];
    };
    const [x, y] = spot(a.x, a.y, 0);
    // Kick-off spots are pinned to our own half (y >= 50).
    const [kx, ky] = spot(a.kickoff_x, a.kickoff_y, 50);
    q.insertAssignment.run(strategyId, slotId, playerId, x, y, kx, ky);
  }

  q.clearDrawings.run(strategyId);
  const drawings = Array.isArray(body.drawings) ? body.drawings : [];
  drawings.forEach((d, i) => {
    const kind = str(d.kind, 'arrow');
    if (!DRAWING_KINDS.has(kind)) return;
    const points = (Array.isArray(d.points) ? d.points : [])
      .map((p) => ({ x: num(p.x), y: num(p.y) }))
      .filter((p) => p.x !== null && p.y !== null)
      .map((p) => ({ x: clamp(p.x, 0, 100), y: clamp(p.y, 0, 100) }));
    if (points.length === 0) return;
    q.insertDrawing.run(
      strategyId,
      kind,
      JSON.stringify(points),
      str(d.color, '#ffd166'),
      str(d.label),
      PHASES.has(d.phase) ? d.phase : 'open',
      i
    );
  });
}

function slotsFromBody(body) {
  const slots = Array.isArray(body.slots) ? body.slots : [];
  if (slots.length === 0) throw new HttpError(400, 'slotsRequired', 'A formation needs at least one slot');
  if (slots.length > 11) throw new HttpError(400, 'slotsTooMany', 'A formation cannot have more than 11 slots');

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

// ---------------------------------------------------------------- routes

const routes = [
  ['GET', /^\/api\/players$/, () => q.allPlayers.all()],

  ['POST', /^\/api\/players$/, (m, body) => {
    const { lastInsertRowid } = q.insertPlayer.run(
      required(str(body.name), 'name'),
      num(body.shirt_number),
      str(body.primary_position, 'CM'),
      str(body.secondary_position),
      FEET.has(body.foot) ? body.foot : 'right',
      num(body.birth_year),
      str(body.notes),
      body.active === false ? 0 : 1
    );
    return q.getPlayer.get(lastInsertRowid);
  }],

  ['PUT', /^\/api\/players\/(\d+)$/, (m, body) => {
    const id = Number(m[1]);
    const current = q.getPlayer.get(id);
    if (!current) throw new HttpError(404, 'playerNotFound', 'Player not found');
    q.updatePlayer.run(
      required(str(body.name, current.name), 'name'),
      body.shirt_number === undefined ? current.shirt_number : num(body.shirt_number),
      str(body.primary_position, current.primary_position),
      body.secondary_position === undefined ? current.secondary_position : str(body.secondary_position),
      FEET.has(body.foot) ? body.foot : current.foot,
      body.birth_year === undefined ? current.birth_year : num(body.birth_year),
      body.notes === undefined ? current.notes : str(body.notes),
      body.active === undefined ? current.active : (body.active ? 1 : 0),
      id
    );
    return q.getPlayer.get(id);
  }],

  ['DELETE', /^\/api\/players\/(\d+)$/, (m) => {
    if (q.deletePlayer.run(Number(m[1])).changes === 0) throw new HttpError(404, 'playerNotFound', 'Player not found');
    return { deleted: Number(m[1]) };
  }],

  ['GET', /^\/api\/staff$/, () => q.allStaff.all()],

  ['POST', /^\/api\/staff$/, (m, body) => {
    const { lastInsertRowid } = q.insertStaff.run(
      required(str(body.name), 'name'),
      str(body.role, 'Coach'),
      str(body.email),
      str(body.phone),
      str(body.notes)
    );
    return q.getStaff.get(lastInsertRowid);
  }],

  ['PUT', /^\/api\/staff\/(\d+)$/, (m, body) => {
    const id = Number(m[1]);
    const current = q.getStaff.get(id);
    if (!current) throw new HttpError(404, 'staffNotFound', 'Staff member not found');
    q.updateStaff.run(
      required(str(body.name, current.name), 'name'),
      str(body.role, current.role),
      body.email === undefined ? current.email : str(body.email),
      body.phone === undefined ? current.phone : str(body.phone),
      body.notes === undefined ? current.notes : str(body.notes),
      id
    );
    return q.getStaff.get(id);
  }],

  ['DELETE', /^\/api\/staff\/(\d+)$/, (m) => {
    if (q.deleteStaff.run(Number(m[1])).changes === 0) throw new HttpError(404, 'staffNotFound', 'Staff member not found');
    return { deleted: Number(m[1]) };
  }],

  ['GET', /^\/api\/formations$/, () => q.allFormations.all().map(formationWithSlots)],

  ['POST', /^\/api\/formations$/, (m, body) => {
    const slots = slotsFromBody(body);
    const name = required(str(body.name), 'name');
    let id;
    try {
      id = Number(q.insertFormation.run(name, str(body.description)).lastInsertRowid);
    } catch {
      throw new HttpError(409, 'duplicateFormation', `A formation named "${name}" already exists`, { name });
    }
    slots.forEach((s, i) =>
      q.insertSlot.run(id, s.code, s.label, s.role_group, s.x, s.y, s.kickoff_x, s.kickoff_y, i));
    return formationWithSlots(q.getFormation.get(id));
  }],

  ['PUT', /^\/api\/formations\/(\d+)$/, (m, body) => {
    const id = Number(m[1]);
    const current = q.getFormation.get(id);
    if (!current) throw new HttpError(404, 'formationNotFound', 'Formation not found');
    if (current.is_default) throw new HttpError(403, 'builtinReadonly', 'Built-in formations cannot be edited — duplicate it first');
    const slots = slotsFromBody(body);
    q.updateFormation.run(str(body.name, current.name), str(body.description), id);
    q.clearSlots.run(id);
    slots.forEach((s, i) =>
      q.insertSlot.run(id, s.code, s.label, s.role_group, s.x, s.y, s.kickoff_x, s.kickoff_y, i));
    return formationWithSlots(q.getFormation.get(id));
  }],

  // Moves existing spots in place. Unlike a full PUT this keeps slot ids, so
  // strategies that reference them survive the edit.
  ['PUT', /^\/api\/formations\/(\d+)\/slots$/, (m, body) => {
    const id = Number(m[1]);
    const current = q.getFormation.get(id);
    if (!current) throw new HttpError(404, 'formationNotFound', 'Formation not found');
    if (current.is_default) throw new HttpError(403, 'builtinReadonly', 'Built-in formations cannot be edited — duplicate it first');
    // phase 'kickoff' writes the starting spots, anything else the open-play ones.
    const kickoff = str(body.phase) === 'kickoff';
    for (const s of Array.isArray(body.slots) ? body.slots : []) {
      const slotId = num(s.id);
      const x = num(s.x);
      const y = num(s.y);
      if (slotId === null || x === null || y === null) continue;
      if (kickoff) q.moveKickoffSlot.run(clamp(x, 0, 100), clamp(y, 50, 100), slotId, id);
      else q.moveSlot.run(clamp(x, 0, 100), clamp(y, 0, 100), slotId, id);
    }
    return formationWithSlots(current);
  }],

  ['DELETE', /^\/api\/formations\/(\d+)$/, (m) => {
    const id = Number(m[1]);
    const current = q.getFormation.get(id);
    if (!current) throw new HttpError(404, 'formationNotFound', 'Formation not found');
    if (current.is_default) throw new HttpError(403, 'builtinUndeletable', 'Built-in formations cannot be deleted');
    q.deleteFormation.run(id);
    return { deleted: id };
  }],

  ['GET', /^\/api\/strategies$/, () => q.allStrategies.all()],

  ['GET', /^\/api\/strategies\/(\d+)$/, (m) => strategyDetail(Number(m[1]))],

  ['POST', /^\/api\/strategies$/, (m, body) => {
    const formationId = num(body.formation_id);
    if (formationId !== null && !q.getFormation.get(formationId)) {
      throw new HttpError(400, 'unknownFormation', 'Unknown formation');
    }
    const id = Number(q.insertStrategy.run(
      required(str(body.name), 'name'),
      formationId,
      str(body.description),
      body.takes_kickoff === false ? 0 : 1
    ).lastInsertRowid);
    writeStrategyContents(id, formationId, body);
    return strategyDetail(id);
  }],

  ['PUT', /^\/api\/strategies\/(\d+)$/, (m, body) => {
    const id = Number(m[1]);
    const current = q.getStrategy.get(id);
    if (!current) throw new HttpError(404, 'strategyNotFound', 'Strategy not found');
    const formationId = body.formation_id === undefined ? current.formation_id : num(body.formation_id);
    if (formationId !== null && !q.getFormation.get(formationId)) {
      throw new HttpError(400, 'unknownFormation', 'Unknown formation');
    }
    q.updateStrategy.run(
      required(str(body.name, current.name), 'name'),
      formationId,
      body.description === undefined ? current.description : str(body.description),
      body.takes_kickoff === undefined ? current.takes_kickoff : (body.takes_kickoff ? 1 : 0),
      id
    );
    writeStrategyContents(id, formationId, body);
    return strategyDetail(id);
  }],

  ['DELETE', /^\/api\/strategies\/(\d+)$/, (m) => {
    if (q.deleteStrategy.run(Number(m[1])).changes === 0) throw new HttpError(404, 'strategyNotFound', 'Strategy not found');
    return { deleted: Number(m[1]) };
  }],
];

// ---------------------------------------------------------------- static

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(PUBLIC_DIR, rel);
  // Block traversal outside public/.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, { error: 'Forbidden', code: 'forbidden' });
  }
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found', code: 'notFound' });
  }
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'Method not allowed', code: 'methodNotAllowed' });
    }
    return serveStatic(req, res, pathname);
  }

  let matchedPath = false;
  for (const [method, pattern, handler] of routes) {
    const m = pattern.exec(pathname);
    if (!m) continue;
    matchedPath = true;
    if (req.method !== method) continue;
    try {
      const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
      const result = handler(m, body);
      return send(res, method === 'POST' ? 201 : 200, result ?? {});
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.message, code: err.code, params: err.params });
      }
      console.error(`${req.method} ${pathname} failed:`, err);
      return send(res, 500, { error: 'Internal server error', code: 'server' });
    }
  }

  send(res, matchedPath ? 405 : 404, matchedPath
    ? { error: 'Method not allowed', code: 'methodNotAllowed' }
    : { error: 'Not found', code: 'notFound' });
});

server.listen(PORT, () => {
  console.log(`Soccer field management running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
