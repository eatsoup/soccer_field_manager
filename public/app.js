'use strict';

/* =========================================================== constants */

// The pitch model is 0-100 on both axes; SVG is 100 x 154 so the drawing
// stays proportional to a real 68m x 105m field. YS converts model y -> SVG y.
const YS = 1.54;

const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'SS', 'ST'];

const POSITION_GROUP = {
  GK: 'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  LW: 'FWD', RW: 'FWD', SS: 'FWD', ST: 'FWD',
};

// Formation slot codes are side-specific (LCB, RCM…); this maps them back to
// the position vocabulary used on player records.
const SLOT_TO_POSITION = {
  GK: 'GK', LB: 'LB', RB: 'RB', CB: 'CB', LCB: 'CB', RCB: 'CB',
  LWB: 'LWB', RWB: 'RWB', CDM: 'CDM', LDM: 'CDM', RDM: 'CDM',
  CM: 'CM', LCM: 'CM', RCM: 'CM', CAM: 'CAM', LAM: 'LW', RAM: 'RW',
  LM: 'LM', RM: 'RM', LW: 'LW', RW: 'RW', ST: 'ST', LST: 'ST', RST: 'ST',
};

// Stored as stable keys so a role keeps its meaning across languages.
const STAFF_ROLES = [
  'head_coach', 'assistant_coach', 'goalkeeper_coach', 'fitness_trainer',
  'physiotherapist', 'performance_analyst', 'team_manager', 'scout', 'kit_manager',
];

/** Roles saved before the key switch, or typed by hand, show as-is. */
const roleLabel = (role) => (hasKey(`role.${role}`) ? t(`role.${role}`) : role);

/** Slot labels come from the database; prefer a translation when we have one. */
const slotLabel = (slot) => (hasKey(`slot.${slot.code}`) ? t(`slot.${slot.code}`) : slot.label);

/** Built-in formation blurbs are translated by name; custom ones keep their text. */
const formationDesc = (f) =>
  (f.is_default && hasKey(`formation.desc.${f.name}`) ? t(`formation.desc.${f.name}`) : (f.description || ''));

const GROUP_COLOR = { GK: '#f4a261', DEF: '#4cc9f0', MID: '#4ade80', FWD: '#f472b6' };

const PALETTE = ['#ffd166', '#4cc9f0', '#f472b6', '#4ade80', '#ffffff', '#ef4444'];

const DRAWING_KINDS = ['run', 'pass', 'dribble', 'line', 'zone', 'text', 'arrow'];

/* =============================================================== state */

// Each slot carries two spots: the open-play shape and the kick-off shape. The
// lineup is shared between them — same eleven players, different positions.
const PHASES = {
  open:    { slotX: 'x',         slotY: 'y',         minY: 3 },
  kickoff: { slotX: 'kickoff_x', slotY: 'kickoff_y', minY: KICKOFF_HALFWAY },
};

const state = {
  players: [],
  staff: [],
  formations: [],
  strategies: [],
  strategy: null,      // { id, name, description, formation_id, takes_kickoff, assignments: Map, drawings: [] }
  phase: 'open',
  tool: 'select',
  color: PALETTE[0],
  saveTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================================================================= api */

/*
 * There is no server: `Store` (store.js) answers the same paths out of
 * localStorage. It fails the same way too — a stable `code` we translate,
 * with its English message as the fallback.
 */
async function api(method, path, body) {
  try {
    return await Store.request(method, path, body);
  } catch (err) {
    const message = err.code && hasKey(`error.${err.code}`)
      ? t(`error.${err.code}`, err.params)
      : (err.message || `${method} ${path} failed`);
    throw new Error(message);
  }
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/** Wraps an async handler so any thrown error surfaces as a toast. */
const guard = (fn) => (...args) => Promise.resolve(fn(...args)).catch((e) => toast(e.message, true));

/* ================================================================ tabs */

function showView(name) {
  if (!$(`.view[data-view="${name}"]`)) name = 'board';
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  if (name === 'data') refreshBackupCounts();
}

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) showView(tab.dataset.view);
});

window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'board'));

/* ============================================================ language */

const LOCALE_STORAGE_KEY = 'sfm.locale';

function preferredLocale() {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved && LOCALES.some((l) => l.code === saved)) return saved;
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return LOCALES.some((l) => l.code === browser) ? browser : 'en';
}

/** Re-labels everything on screen without losing the user's current state. */
function applyLocaleToUi() {
  document.documentElement.lang = getLocale();
  document.title = t('app.title');
  applyTranslations();
  fillPositionSelects();
  refreshFormTitles();
  renderPlayers();
  renderStaff();
  renderFormations();
  renderStrategyList();
  renderBoard();
  renderDriveState();
  renderDriveFiles();
  refreshBackupCounts();
}

/** Form headings depend on whether we are editing, so data-i18n cannot own them. */
function refreshFormTitles() {
  const player = state.players.find((p) => p.id === Number($('#player-id').value));
  $('#player-form-title').textContent = player ? t('squad.edit', { name: player.name }) : t('squad.add');
  $('#player-submit').textContent = t(player ? 'squad.submitSave' : 'squad.submitAdd');

  const member = state.staff.find((m) => m.id === Number($('#staff-id').value));
  $('#staff-form-title').textContent = member ? t('staff.edit', { name: member.name }) : t('staff.add');
  $('#staff-submit').textContent = t(member ? 'staff.submitSave' : 'staff.submitAdd');
}

$('#lang-select').addEventListener('change', (e) => {
  setLocale(e.target.value);
  localStorage.setItem(LOCALE_STORAGE_KEY, getLocale());
  applyLocaleToUi();
});

/* ============================================================== squad */

function groupOf(position) { return POSITION_GROUP[position] || 'MID'; }

function playerLabel(p) {
  return p.shirt_number ? `${p.shirt_number} · ${p.name}` : p.name;
}

function fillPositionSelects() {
  const keep = { pos: $('#player-position').value, pos2: $('#player-position2').value, role: $('#staff-role').value };
  const opts = POSITIONS.map((p) => `<option value="${p}">${p}</option>`).join('');
  $('#player-position').innerHTML = opts;
  $('#player-position2').innerHTML = `<option value="">${t('squad.none')}</option>${opts}`;
  $('#staff-role').innerHTML = STAFF_ROLES
    .map((r) => `<option value="${r}">${esc(roleLabel(r))}</option>`).join('');
  // Rebuilding the options would otherwise reset a half-filled form.
  if (keep.pos) $('#player-position').value = keep.pos;
  $('#player-position2').value = keep.pos2;
  if (keep.role) $('#staff-role').value = keep.role;
}

function renderPlayers() {
  const term = $('#player-search').value.trim().toLowerCase();
  const rows = state.players.filter((p) =>
    !term ||
    p.name.toLowerCase().includes(term) ||
    (p.primary_position || '').toLowerCase().includes(term) ||
    (p.secondary_position || '').toLowerCase().includes(term));

  $('#squad-count').textContent = state.players.length;
  $('#player-rows').innerHTML = rows.length
    ? rows.map((p) => `
      <tr>
        <td>${p.shirt_number ?? '—'}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.primary_position)}${p.secondary_position ? ` <span class="sub">/ ${esc(p.secondary_position)}</span>` : ''}</td>
        <td>${t(`foot.${p.foot}`)}</td>
        <td>${p.birth_year ?? '—'}</td>
        <td><span class="tag ${p.active ? 'on' : 'off'}">${p.active ? t('squad.available') : t('squad.out')}</span></td>
        <td class="actions">
          <button class="link" data-edit-player="${p.id}">${t('action.edit')}</button>
          <button class="link danger" data-del-player="${p.id}">${t('action.delete')}</button>
        </td>
      </tr>`).join('')
    : `<tr class="empty-row"><td colspan="7">${state.players.length ? t('squad.noMatch') : t('squad.empty')}</td></tr>`;
}

function resetPlayerForm() {
  $('#player-form').reset();
  $('#player-id').value = '';
  $('#player-form-title').textContent = t('squad.add');
  $('#player-submit').textContent = t('squad.submitAdd');
  $('#player-cancel').hidden = true;
}

$('#player-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const id = $('#player-id').value;
  const payload = {
    name: $('#player-name').value,
    shirt_number: $('#player-number').value,
    primary_position: $('#player-position').value,
    secondary_position: $('#player-position2').value,
    foot: $('#player-foot').value,
    birth_year: $('#player-year').value,
    notes: $('#player-notes').value,
    active: $('#player-active').value === '1',
  };
  if (id) await api('PUT', `/api/players/${id}`, payload);
  else await api('POST', '/api/players', payload);
  resetPlayerForm();
  await loadPlayers();
  toast(t(id ? 'toast.playerUpdated' : 'toast.playerAdded'));
}));

$('#player-cancel').addEventListener('click', resetPlayerForm);
$('#player-search').addEventListener('input', renderPlayers);

$('#player-rows').addEventListener('click', guard(async (e) => {
  const edit = e.target.closest('[data-edit-player]');
  const del = e.target.closest('[data-del-player]');
  if (edit) {
    const p = state.players.find((x) => x.id === Number(edit.dataset.editPlayer));
    if (!p) return;
    $('#player-id').value = p.id;
    $('#player-name').value = p.name;
    $('#player-number').value = p.shirt_number ?? '';
    $('#player-position').value = p.primary_position;
    $('#player-position2').value = p.secondary_position ?? '';
    $('#player-foot').value = p.foot;
    $('#player-year').value = p.birth_year ?? '';
    $('#player-notes').value = p.notes ?? '';
    $('#player-active').value = p.active ? '1' : '0';
    $('#player-form-title').textContent = t('squad.edit', { name: p.name });
    $('#player-submit').textContent = t('squad.submitSave');
    $('#player-cancel').hidden = false;
    $('#player-name').focus();
  }
  if (del) {
    const p = state.players.find((x) => x.id === Number(del.dataset.delPlayer));
    if (!p || !confirm(t('confirm.deletePlayer', { name: p.name }))) return;
    await api('DELETE', `/api/players/${p.id}`);
    await loadPlayers();
    if (state.strategy) {
      for (const [slotId, a] of state.strategy.assignments) {
        if (a.player_id === p.id) state.strategy.assignments.set(slotId, { ...a, player_id: null });
      }
      renderBoard();
    }
    toast(t('toast.playerDeleted'));
  }
}));

async function loadPlayers() {
  state.players = await api('GET', '/api/players');
  renderPlayers();
  renderBench();
  renderLineup();
}

/* =============================================================== staff */

function renderStaff() {
  $('#staff-count').textContent = state.staff.length;
  $('#staff-rows').innerHTML = state.staff.length
    ? state.staff.map((s) => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${esc(roleLabel(s.role))}</td>
        <td>${s.email ? `<a class="link" href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : '—'}</td>
        <td>${esc(s.phone || t('squad.none'))}</td>
        <td class="actions">
          <button class="link" data-edit-staff="${s.id}">${t('action.edit')}</button>
          <button class="link danger" data-del-staff="${s.id}">${t('action.delete')}</button>
        </td>
      </tr>`).join('')
    : `<tr class="empty-row"><td colspan="5">${t('staff.empty')}</td></tr>`;
}

function resetStaffForm() {
  $('#staff-form').reset();
  $('#staff-id').value = '';
  $('#staff-form-title').textContent = t('staff.add');
  $('#staff-submit').textContent = t('staff.submitAdd');
  $('#staff-cancel').hidden = true;
}

$('#staff-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const id = $('#staff-id').value;
  const payload = {
    name: $('#staff-name').value,
    role: $('#staff-role').value,
    email: $('#staff-email').value,
    phone: $('#staff-phone').value,
    notes: $('#staff-notes').value,
  };
  if (id) await api('PUT', `/api/staff/${id}`, payload);
  else await api('POST', '/api/staff', payload);
  resetStaffForm();
  await loadStaff();
  toast(t(id ? 'toast.staffUpdated' : 'toast.staffAdded'));
}));

$('#staff-cancel').addEventListener('click', resetStaffForm);

$('#staff-rows').addEventListener('click', guard(async (e) => {
  const edit = e.target.closest('[data-edit-staff]');
  const del = e.target.closest('[data-del-staff]');
  if (edit) {
    const s = state.staff.find((x) => x.id === Number(edit.dataset.editStaff));
    if (!s) return;
    $('#staff-id').value = s.id;
    $('#staff-name').value = s.name;
    $('#staff-role').value = s.role;
    $('#staff-email').value = s.email ?? '';
    $('#staff-phone').value = s.phone ?? '';
    $('#staff-notes').value = s.notes ?? '';
    $('#staff-form-title').textContent = t('staff.edit', { name: s.name });
    $('#staff-submit').textContent = t('staff.submitSave');
    $('#staff-cancel').hidden = false;
    $('#staff-name').focus();
  }
  if (del) {
    const s = state.staff.find((x) => x.id === Number(del.dataset.delStaff));
    if (!s || !confirm(t('confirm.deleteStaff', { name: s.name }))) return;
    await api('DELETE', `/api/staff/${s.id}`);
    await loadStaff();
    toast(t('toast.staffDeleted'));
  }
}));

async function loadStaff() {
  state.staff = await api('GET', '/api/staff');
  renderStaff();
}

/* ========================================================== formations */

function currentFormation() {
  return state.formations.find((f) => f.id === state.strategy?.formation_id) || null;
}

let previewPhase = 'open';

function miniPitch(formation, phase = previewPhase) {
  const { slotX, slotY } = PHASES[phase];
  const dots = formation.slots.map((raw) => {
    const s = { ...raw, x: raw[slotX] ?? raw.x, y: raw[slotY] ?? raw.y };
    return `
    <circle cx="${s.x}" cy="${(s.y * YS).toFixed(2)}" r="4.4" fill="${GROUP_COLOR[s.role_group] || '#4ade80'}" />
    <text x="${s.x}" y="${(s.y * YS + 1.6).toFixed(2)}" font-size="3.6" font-weight="700"
          text-anchor="middle" fill="#08210f">${esc(s.code)}</text>`;
  }).join('');
  const shade = phase === 'kickoff'
    ? '<rect x="0" y="0" width="100" height="77" fill="rgba(8,12,17,.45)" />'
    + '<line x1="0" y1="77" x2="100" y2="77" stroke="#ffd166" stroke-width=".6" stroke-dasharray="2 1.5" />'
    : '';
  return `<svg viewBox="0 0 100 154">
      <rect width="100" height="154" fill="#2f7d4f" />
      <g fill="none" stroke="rgba(255,255,255,.5)" stroke-width="0.45">
        <rect x="2" y="2" width="96" height="150" />
        <line x1="2" y1="77" x2="98" y2="77" />
        <circle cx="50" cy="77" r="13.46" />
        <rect x="20.35" y="127.7" width="59.3" height="24.3" />
        <rect x="20.35" y="2" width="59.3" height="24.3" />
      </g>${shade}${dots}
    </svg>`;
}

function renderFormations() {
  $('#formation-count').textContent = state.formations.length;
  $('#formation-list').innerHTML = state.formations.map((f) => `
    <li>
      <div class="fmeta">
        <div class="fname">${esc(f.name)} ${f.is_default ? `<span class="tag off">${t('formations.builtin')}</span>` : `<span class="tag on">${t('formations.custom')}</span>`}</div>
        <div class="fdesc">${esc(formationDesc(f))} · ${t('formations.positions', { count: f.slots.length })}</div>
      </div>
      <button class="btn btn-sm" data-use-formation="${f.id}">${t('formations.use')}</button>
      <button class="btn btn-sm" data-copy-formation="${f.id}">${t('formations.duplicate')}</button>
      ${f.is_default ? '' : `<button class="btn btn-sm btn-danger" data-del-formation="${f.id}">${t('formations.delete')}</button>`}
    </li>`).join('');

  const preview = state.formations.find((f) => f.id === state.strategy?.formation_id) || state.formations[0];
  $('#formation-preview').innerHTML = preview ? miniPitch(preview) : '';

  $('#formation-select').innerHTML = state.formations
    .map((f) => `<option value="${f.id}">${esc(f.name)}${f.is_default ? '' : ` (${t('formations.custom')})`}</option>`).join('');
  if (state.strategy?.formation_id) $('#formation-select').value = String(state.strategy.formation_id);
}

$('#preview-phases').addEventListener('click', (e) => {
  const btn = e.target.closest('.phase');
  if (!btn || btn.dataset.phase === previewPhase) return;
  previewPhase = btn.dataset.phase;
  $$('#preview-phases .phase').forEach((p) => p.classList.toggle('is-active', p === btn));
  renderFormations();
});

$('#formation-list').addEventListener('click', guard(async (e) => {
  const use = e.target.closest('[data-use-formation]');
  const copy = e.target.closest('[data-copy-formation]');
  const del = e.target.closest('[data-del-formation]');

  if (use) {
    if (!state.strategy) newStrategy();
    applyFormation(Number(use.dataset.useFormation));
    showView('board');
    toast(t('toast.formationApplied'));
  }
  if (copy) {
    const f = state.formations.find((x) => x.id === Number(copy.dataset.copyFormation));
    const name = prompt(t('formations.copyPrompt'), t('formations.copySuffix', { name: f.name }));
    if (!name) return;
    await api('POST', '/api/formations', { name, description: f.description, slots: f.slots });
    await loadFormations();
    toast(t('toast.formationDuplicated'));
  }
  if (del) {
    const f = state.formations.find((x) => x.id === Number(del.dataset.delFormation));
    if (!f || !confirm(t('confirm.deleteFormation', { name: f.name }))) return;
    await api('DELETE', `/api/formations/${f.id}`);
    await loadFormations();
    toast(t('toast.formationDeleted'));
  }
}));

async function loadFormations() {
  state.formations = await api('GET', '/api/formations');
  renderFormations();
  renderBoard();
}

/* =============================================================== pitch */

const svg = $('#pitch');
const layerSlots = $('#layer-slots');
const layerDrawings = $('#layer-drawings');
const layerPreview = $('#layer-preview');
const SVGNS = 'http://www.w3.org/2000/svg';

// Mow stripes are decorative; drawn once.
(function drawStripes() {
  const g = $('#mow-stripes');
  for (let i = 0; i < 10; i++) {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', -2.5);
    r.setAttribute('y', -4 + i * 16.2);
    r.setAttribute('width', 105);
    r.setAttribute('height', 16.2);
    r.setAttribute('fill', i % 2 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.035)');
    g.appendChild(r);
  }
})();

const markerCache = new Map();
function markerFor(color) {
  const id = `ah-${color.replace(/[^a-z0-9]/gi, '')}`;
  if (!markerCache.has(id)) {
    const m = document.createElementNS(SVGNS, 'marker');
    m.setAttribute('id', id);
    m.setAttribute('viewBox', '0 0 10 10');
    m.setAttribute('refX', '8');
    m.setAttribute('refY', '5');
    m.setAttribute('markerWidth', '4.5');
    m.setAttribute('markerHeight', '4.5');
    m.setAttribute('orient', 'auto-start-reverse');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M 0 1 L 9 5 L 0 9 z');
    p.setAttribute('fill', color);
    m.appendChild(p);
    svg.querySelector('defs').appendChild(m);
    markerCache.set(id, true);
  }
  return `url(#${id})`;
}

function eventToModel(evt) {
  const p = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return { x: clamp(p.x, 0, 100), y: clamp(p.y / YS, 0, 100) };
}

const sx = (x) => x;
const sy = (y) => y * YS;

/** Sine-wave path between two model points, used for the dribble notation. */
function wavyPath(a, b) {
  const dx = b.x - a.x;
  const dy = (b.y - a.y) * YS;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return `M ${sx(a.x)} ${sy(a.y)}`;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const steps = Math.max(8, Math.round(len / 2));
  const tail = Math.min(5, len * 0.25); // straight run-in so the arrowhead reads clean
  let d = `M ${sx(a.x)} ${sy(a.y)}`;
  for (let i = 1; i <= steps; i++) {
    const along = (i / steps) * (len - tail);
    const amp = 1.9 * Math.sin((i / steps) * Math.PI * 5);
    d += ` L ${(a.x + ux * along + px * amp).toFixed(2)} ${(sy(a.y) + uy * along + py * amp).toFixed(2)}`;
  }
  d += ` L ${sx(b.x)} ${sy(b.y)}`;
  return d;
}

function drawingElement(d, index) {
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'drawing');
  g.dataset.index = index;
  const pts = d.points;
  const a = pts[0];
  const b = pts[pts.length - 1];

  const stroke = (el, extra = {}) => {
    el.setAttribute('stroke', d.color);
    el.setAttribute('stroke-width', '1.1');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('fill', 'none');
    for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
    return el;
  };

  if (d.kind === 'zone') {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', Math.min(a.x, b.x));
    r.setAttribute('y', sy(Math.min(a.y, b.y)));
    r.setAttribute('width', Math.abs(b.x - a.x));
    r.setAttribute('height', Math.abs(sy(b.y) - sy(a.y)));
    stroke(r, { 'stroke-dasharray': '2 1.6', fill: d.color, 'fill-opacity': '.16' });
    g.appendChild(r);
  } else if (d.kind === 'text') {
    const textEl = document.createElementNS(SVGNS, 'text');
    textEl.setAttribute('x', sx(a.x));
    textEl.setAttribute('y', sy(a.y));
    textEl.setAttribute('fill', d.color);
    textEl.setAttribute('font-size', '4.2');
    textEl.setAttribute('font-weight', '700');
    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('paint-order', 'stroke');
    textEl.setAttribute('stroke', 'rgba(0,0,0,.65)');
    textEl.setAttribute('stroke-width', '1.1');
    textEl.setAttribute('stroke-linejoin', 'round');
    textEl.textContent = d.label || t('drawing.defaultLabel');
    g.appendChild(textEl);
  } else {
    const path = document.createElementNS(SVGNS, 'path');
    const dAttr = d.kind === 'dribble'
      ? wavyPath(a, b)
      : `M ${sx(a.x)} ${sy(a.y)} L ${sx(b.x)} ${sy(b.y)}`;
    path.setAttribute('d', dAttr);
    stroke(path);
    if (d.kind === 'pass') path.setAttribute('stroke-dasharray', '3 2.2');
    if (d.kind !== 'line') path.setAttribute('marker-end', markerFor(d.color));
    g.appendChild(path);

    if (d.label) {
      const textEl = document.createElementNS(SVGNS, 'text');
      textEl.setAttribute('x', (a.x + b.x) / 2);
      textEl.setAttribute('y', sy((a.y + b.y) / 2) - 1.5);
      textEl.setAttribute('fill', d.color);
      textEl.setAttribute('font-size', '3.4');
      textEl.setAttribute('text-anchor', 'middle');
      textEl.textContent = d.label;
      g.appendChild(textEl);
    }
  }

  // Invisible fat hit area so erase-clicks are forgiving.
  const hit = document.createElementNS(SVGNS, 'path');
  hit.setAttribute('class', 'drawing-hit');
  hit.setAttribute('d', d.kind === 'text'
    ? `M ${sx(a.x) - 6} ${sy(a.y) - 2} L ${sx(a.x) + 6} ${sy(a.y) - 2}`
    : `M ${sx(a.x)} ${sy(a.y)} L ${sx(b.x)} ${sy(b.y)}`);
  g.appendChild(hit);

  return g;
}

/**
 * Drawings for the phase currently on screen, each paired with its index in the
 * full array so edits address the right row.
 */
function phaseDrawings(phase = state.phase) {
  return (state.strategy?.drawings ?? [])
    .map((d, index) => ({ d, index }))
    .filter(({ d }) => (d.phase || 'open') === phase);
}

function renderDrawings() {
  layerDrawings.replaceChildren();
  const list = phaseDrawings();
  for (const { d, index } of list) layerDrawings.appendChild(drawingElement(d, index));

  $('#draw-count').textContent = list.length;
  $('#drawing-scope').textContent = t('board.drawingsFor', { phase: t(`phase.${state.phase}`) });
  $('#drawing-list').innerHTML = list.length
    ? list.map(({ d, index }) => `
      <li data-draw="${index}">
        <span class="pill" style="background:${esc(d.color)}"></span>
        <span class="title">${t(`drawing.${d.kind}`)}${d.label ? `: ${esc(d.label)}` : ''}</span>
        <button class="link danger" data-del-draw="${index}">×</button>
      </li>`).join('')
    : `<li class="hint">${t('board.drawingsHint')}</li>`;
}

/** Where a slot sits in the given phase: strategy override, else formation default. */
function slotPosition(slot, phase = state.phase) {
  const { slotX, slotY } = PHASES[phase];
  const a = state.strategy.assignments.get(slot.id);
  return {
    x: a?.[slotX] ?? slot[slotX] ?? slot.x,
    y: a?.[slotY] ?? slot[slotY] ?? slot.y,
  };
}

/** Records a dragged spot against whichever phase is on screen. */
function setSlotPosition(slotId, point) {
  const { slotX, slotY } = PHASES[state.phase];
  const a = state.strategy.assignments.get(slotId) || {};
  state.strategy.assignments.set(slotId, { ...a, [slotX]: point.x, [slotY]: point.y });
}

function renderSlots() {
  layerSlots.replaceChildren();
  const formation = currentFormation();
  if (!formation) return;

  for (const slot of formation.slots) {
    const a = state.strategy.assignments.get(slot.id);
    const player = a?.player_id ? state.players.find((p) => p.id === a.player_id) : null;
    const { x, y } = slotPosition(slot);

    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', `slot${player ? '' : ' empty'}`);
    g.setAttribute('transform', `translate(${x} ${sy(y)})`);
    g.dataset.slotId = slot.id;

    const circle = document.createElementNS(SVGNS, 'circle');
    circle.setAttribute('class', 'token');
    circle.setAttribute('r', '5');
    circle.setAttribute('fill', GROUP_COLOR[slot.role_group] || '#4ade80');
    g.appendChild(circle);

    const num = document.createElementNS(SVGNS, 'text');
    num.setAttribute('class', 'num');
    num.setAttribute('y', '1.6');
    num.textContent = player ? (player.shirt_number ?? slot.code) : slot.code;
    g.appendChild(num);

    const nm = document.createElementNS(SVGNS, 'text');
    nm.setAttribute('class', 'nm');
    nm.setAttribute('y', '9.4');
    nm.textContent = player ? player.name.split(' ').slice(-1)[0] : '';
    g.appendChild(nm);

    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = `${slotLabel(slot)} (${slot.code})${player ? ` — ${player.name}` : ` — ${t('slot.empty')}`}`;
    g.appendChild(title);

    layerSlots.appendChild(g);
  }
}

function renderLineup() {
  const formation = currentFormation();
  if (!formation || !state.strategy) { $('#lineup').innerHTML = ''; return; }
  $('#lineup').innerHTML = formation.slots.map((slot) => {
    const a = state.strategy.assignments.get(slot.id);
    const player = a?.player_id ? state.players.find((p) => p.id === a.player_id) : null;
    return `<li>
      <span class="code">${esc(slot.code)}</span>
      <span class="who${player ? '' : ' vacant'}">${player ? esc(playerLabel(player)) : t('board.open')}</span>
      ${player ? `<button class="x" data-clear-slot="${slot.id}" title="${t('board.sendToBench')}">×</button>` : ''}
    </li>`;
  }).join('');
}

$('#lineup').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-clear-slot]');
  if (!btn) return;
  const slotId = Number(btn.dataset.clearSlot);
  const a = state.strategy.assignments.get(slotId) || {};
  state.strategy.assignments.set(slotId, { ...a, player_id: null });
  markDirty();
  renderBoard();
});

function assignedPlayerIds() {
  const ids = new Set();
  if (!state.strategy) return ids;
  for (const a of state.strategy.assignments.values()) if (a.player_id) ids.add(a.player_id);
  return ids;
}

function renderBench() {
  const used = assignedPlayerIds();
  const bench = state.players.filter((p) => !used.has(p.id));
  $('#bench-count').textContent = bench.length;
  $('#bench').innerHTML = bench.length
    ? bench.map((p) => `
      <li data-player="${p.id}" class="${p.active ? '' : 'inactive'}">
        <span class="pill ${groupOf(p.primary_position)}">${p.shirt_number ?? '·'}</span>
        <span class="who">${esc(p.name)}</span>
        <span class="pos">${esc(p.primary_position)}${p.active ? '' : ' · out'}</span>
      </li>`).join('')
    : `<li class="hint">${t(state.players.length ? 'board.benchEmptyAllPlaying' : 'board.benchEmptyNoPlayers')}</li>`;
}

/* ============================================================== kick-off */

$('#phases').addEventListener('click', (e) => {
  const btn = e.target.closest('.phase');
  if (!btn || btn.dataset.phase === state.phase) return;
  state.phase = btn.dataset.phase;
  $$('#phases .phase').forEach((p) => p.classList.toggle('is-active', p === btn));
  renderBoard();
});

$('#takes-kickoff').addEventListener('change', (e) => {
  if (!state.strategy) return;
  state.strategy.takes_kickoff = e.target.checked;
  markDirty();
  renderBoard();
});

$('#kickoff-auto').addEventListener('click', () => {
  const formation = currentFormation();
  if (!formation || !state.strategy) return;
  // Derive from this strategy's open-play shape, not the formation's raw defaults.
  const openShape = formation.slots.map((s) => ({ ...s, ...slotPosition(s, 'open') }));
  for (const spot of kickoffShape(openShape, { takesKickoff: state.strategy.takes_kickoff })) {
    const a = state.strategy.assignments.get(spot.id) || {};
    state.strategy.assignments.set(spot.id, { ...a, kickoff_x: spot.x, kickoff_y: spot.y });
  }
  markDirty();
  renderBoard();
  toast(t('toast.kickoffBuilt'));
});

/** Names every player against their kick-off spot so issues can be reported. */
function kickoffEntries() {
  const formation = currentFormation();
  if (!formation) return [];
  return formation.slots.map((slot) => {
    const a = state.strategy.assignments.get(slot.id);
    const player = a?.player_id ? state.players.find((p) => p.id === a.player_id) : null;
    return { label: player ? player.name : slot.code, ...slotPosition(slot, 'kickoff') };
  });
}

function renderKickoffPanel() {
  const active = state.phase === 'kickoff';
  $('#kickoff-panel').hidden = !active;
  $('#layer-kickoff').style.display = active ? '' : 'none';
  if (!active || !state.strategy) return;

  const takesKickoff = !!state.strategy.takes_kickoff;
  $('#takes-kickoff').checked = takesKickoff;
  $('#kickoff-rule').textContent = t(takesKickoff ? 'kickoff.ruleWeTake' : 'kickoff.ruleTheyTake');
  // The circle only restricts us when the opposition is kicking off.
  $('#kickoff-circle').style.opacity = takesKickoff ? '.35' : '1';

  const issues = kickoffIssues(kickoffEntries(), { takesKickoff });
  $('#kickoff-legal').innerHTML = issues.length
    ? `<ul class="issues">${issues.map((i) =>
        `<li>${esc(t(`kickoff.issue.${i.code}`, i.params))}</li>`).join('')}</ul>`
    : `<p class="legal-ok">${t('kickoff.legal')}</p>`;
}

function renderBoard() {
  if (!state.strategy) {
    layerSlots.replaceChildren();
    layerDrawings.replaceChildren();
    $('#lineup').innerHTML = '';
    $('#drawing-list').innerHTML = '';
    $('#layer-kickoff').style.display = 'none';
    return;
  }
  renderSlots();
  renderDrawings();
  renderLineup();
  renderBench();
  renderKickoffPanel();
  const f = currentFormation();
  $('#save-formation-spots').hidden = !f || f.is_default;
}

$('#save-formation-spots').addEventListener('click', guard(async () => {
  const formation = currentFormation();
  if (!formation || formation.is_default) return;
  const slots = formation.slots.map((s) => ({ id: s.id, ...slotPosition(s) }));
  await api('PUT', `/api/formations/${formation.id}/slots`, { slots, phase: state.phase });
  // The offsets now live in the formation itself, so drop the per-strategy ones.
  const { slotX, slotY } = PHASES[state.phase];
  for (const [id, a] of state.strategy.assignments) {
    state.strategy.assignments.set(id, { ...a, [slotX]: null, [slotY]: null });
  }
  await loadFormations();
  markDirty();
  renderBoard();
  toast(t('toast.spotsSaved', { name: formation.name }));
}));

/* ========================================================= board drags */

/** Finds the slot whose token is nearest to a model point, within `radius`. */
function slotNear(point, radius = 7, excludeId = null) {
  const formation = currentFormation();
  if (!formation) return null;
  let best = null;
  let bestDist = Infinity;
  for (const slot of formation.slots) {
    if (slot.id === excludeId) continue;
    const p = slotPosition(slot);
    const dist = Math.hypot(p.x - point.x, (p.y - point.y) * YS);
    if (dist < radius && dist < bestDist) { best = slot; bestDist = dist; }
  }
  return best;
}

function setPlayerInSlot(slotId, playerId) {
  // A player can only occupy one slot; clear any previous holder.
  for (const [id, a] of state.strategy.assignments) {
    if (a.player_id === playerId && id !== slotId) {
      state.strategy.assignments.set(id, { ...a, player_id: null });
    }
  }
  const a = state.strategy.assignments.get(slotId) || {};
  state.strategy.assignments.set(slotId, { ...a, player_id: playerId });
}

// --- dragging a player off the bench onto the pitch -----------------------

$('#bench').addEventListener('pointerdown', (e) => {
  const li = e.target.closest('[data-player]');
  if (!li || !state.strategy || !currentFormation()) return;
  e.preventDefault();

  const playerId = Number(li.dataset.player);
  const player = state.players.find((p) => p.id === playerId);
  const ghost = $('#drag-ghost');
  ghost.textContent = playerLabel(player);
  ghost.hidden = false;
  li.setPointerCapture(e.pointerId);

  const move = (ev) => {
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    const target = slotNear(eventToModel(ev));
    $$('#layer-slots .slot').forEach((g) =>
      g.classList.toggle('drop-target', !!target && Number(g.dataset.slotId) === target.id));
  };
  move(e);

  const up = (ev) => {
    li.releasePointerCapture(e.pointerId);
    li.removeEventListener('pointermove', move);
    li.removeEventListener('pointerup', up);
    li.removeEventListener('pointercancel', up);
    ghost.hidden = true;

    const rect = svg.getBoundingClientRect();
    const inside = ev.clientX >= rect.left && ev.clientX <= rect.right &&
                   ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    const target = inside ? slotNear(eventToModel(ev)) : null;
    if (target) {
      setPlayerInSlot(target.id, playerId);
      markDirty();
    }
    renderBoard();
  };

  li.addEventListener('pointermove', move);
  li.addEventListener('pointerup', up);
  li.addEventListener('pointercancel', up);
});

// --- dragging a token already on the pitch --------------------------------

layerSlots.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'select') return;
  const g = e.target.closest('.slot');
  if (!g || !state.strategy) return;
  e.preventDefault();

  const slotId = Number(g.dataset.slotId);
  const formation = currentFormation();
  const slot = formation.slots.find((s) => s.id === slotId);
  const origin = slotPosition(slot);
  const grab = eventToModel(e);
  const offset = { x: origin.x - grab.x, y: origin.y - grab.y };
  let moved = false;
  let last = origin;

  g.classList.add('dragging');
  svg.setPointerCapture(e.pointerId);

  const minY = PHASES[state.phase].minY;   // kick-off spots may not leave our half
  const move = (ev) => {
    const m = eventToModel(ev);
    last = { x: clamp(m.x + offset.x, 3, 97), y: clamp(m.y + offset.y, minY, 97) };
    moved = true;
    g.setAttribute('transform', `translate(${last.x} ${sy(last.y)})`);
    const target = slotNear(last, 6, slotId);
    $$('#layer-slots .slot').forEach((el) =>
      el.classList.toggle('drop-target', !!target && Number(el.dataset.slotId) === target.id));
  };

  const up = (ev) => {
    svg.releasePointerCapture(e.pointerId);
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.removeEventListener('pointercancel', up);
    g.classList.remove('dragging');

    if (moved) {
      const target = slotNear(last, 6, slotId);
      if (target) {
        // Dropped on another position: swap the two players.
        const mine = state.strategy.assignments.get(slotId) || {};
        const theirs = state.strategy.assignments.get(target.id) || {};
        state.strategy.assignments.set(slotId, { ...mine, player_id: theirs.player_id ?? null });
        state.strategy.assignments.set(target.id, { ...theirs, player_id: mine.player_id ?? null });
      } else {
        // Dropped on open grass: the position itself moves, for this phase only.
        setSlotPosition(slotId, last);
      }
      markDirty();
    }
    renderBoard();
  };

  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
});

// Double-click a token to send its player back to the bench.
layerSlots.addEventListener('dblclick', (e) => {
  const g = e.target.closest('.slot');
  if (!g || !state.strategy) return;
  const slotId = Number(g.dataset.slotId);
  const a = state.strategy.assignments.get(slotId) || {};
  if (!a.player_id) return;
  state.strategy.assignments.set(slotId, { ...a, player_id: null });
  markDirty();
  renderBoard();
});

/* ======================================================= drawing tools */

$('#tools').addEventListener('click', (e) => {
  const btn = e.target.closest('.tool');
  if (!btn) return;
  state.tool = btn.dataset.tool;
  $$('.tool').forEach((el) => el.classList.toggle('is-active', el === btn));
  svg.classList.toggle('drawing', !['select', 'erase'].includes(state.tool));
  svg.classList.toggle('erasing', state.tool === 'erase');
});

$('#swatches').innerHTML = PALETTE
  .map((c, i) => `<button class="swatch${i === 0 ? ' is-active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`)
  .join('');

$('#swatches').addEventListener('click', (e) => {
  const btn = e.target.closest('.swatch');
  if (!btn) return;
  state.color = btn.dataset.color;
  $$('.swatch').forEach((s) => s.classList.toggle('is-active', s === btn));
});

layerDrawings.addEventListener('click', (e) => {
  if (state.tool !== 'erase') return;
  const g = e.target.closest('.drawing');
  if (!g) return;
  state.strategy.drawings.splice(Number(g.dataset.index), 1);
  markDirty();
  renderDrawings();
});

$('#drawing-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del-draw]');
  if (!btn) return;
  state.strategy.drawings.splice(Number(btn.dataset.delDraw), 1);
  markDirty();
  renderDrawings();
});

svg.addEventListener('pointerdown', (e) => {
  if (!state.strategy) return;
  const tool = state.tool;
  if (tool === 'select' || tool === 'erase') return;
  e.preventDefault();

  const start = eventToModel(e);

  if (tool === 'text') {
    const label = prompt(t('prompt.labelText'));
    if (label && label.trim()) {
      state.strategy.drawings.push({
        kind: 'text', points: [start], color: state.color, label: label.trim(), phase: state.phase,
      });
      markDirty();
      renderDrawings();
    }
    return;
  }

  svg.setPointerCapture(e.pointerId);
  let end = start;

  const move = (ev) => {
    end = eventToModel(ev);
    layerPreview.replaceChildren(
      drawingElement({ kind: tool, points: [start, end], color: state.color, label: null }, -1)
    );
  };

  const up = () => {
    svg.releasePointerCapture(e.pointerId);
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.removeEventListener('pointercancel', up);
    layerPreview.replaceChildren();

    if (Math.hypot(end.x - start.x, (end.y - start.y) * YS) > 2.5) {
      state.strategy.drawings.push({
        kind: tool, points: [start, end], color: state.color, label: null, phase: state.phase,
      });
      markDirty();
      renderDrawings();
    }
  };

  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
});

$('#undo-draw').addEventListener('click', () => {
  const list = phaseDrawings();
  if (!list.length) return;
  state.strategy.drawings.splice(list[list.length - 1].index, 1);
  markDirty();
  renderDrawings();
});

$('#clear-draw').addEventListener('click', () => {
  if (!phaseDrawings().length) return;
  if (!confirm(t('confirm.clearDrawings', { phase: t(`phase.${state.phase}`) }))) return;
  const phase = state.phase;
  state.strategy.drawings = state.strategy.drawings.filter((d) => (d.phase || 'open') !== phase);
  markDirty();
  renderDrawings();
});

$('#reset-positions').addEventListener('click', () => {
  if (!state.strategy) return;
  const { slotX, slotY } = PHASES[state.phase];
  for (const [id, a] of state.strategy.assignments) {
    state.strategy.assignments.set(id, { ...a, [slotX]: null, [slotY]: null });
  }
  markDirty();
  renderBoard();
});

/* ========================================================== strategies */

function markDirty() {
  $('#board-status').textContent = t('status.unsaved');
  clearTimeout(state.saveTimer);
  if (state.strategy?.id) {
    state.saveTimer = setTimeout(() => saveStrategy(true), 900);
  }
}

function newStrategy() {
  const formation = state.formations[0];
  state.strategy = {
    id: null,
    name: '',
    description: '',
    formation_id: formation?.id ?? null,
    takes_kickoff: true,
    assignments: new Map(),
    drawings: [],
  };
  if (formation) for (const s of formation.slots) state.strategy.assignments.set(s.id, { player_id: null, x: null, y: null, kickoff_x: null, kickoff_y: null });
  $('#strategy-name').value = '';
  $('#strategy-notes').value = '';
  if (formation) $('#formation-select').value = String(formation.id);
  $('#board-status').textContent = t('status.newStrategy');
  renderStrategyList();
  renderBoard();
}

/** Swaps the formation under the current lineup, carrying players over in order. */
function applyFormation(formationId) {
  const formation = state.formations.find((f) => f.id === formationId);
  if (!formation || !state.strategy) return;

  const carried = [];
  const previous = state.formations.find((f) => f.id === state.strategy.formation_id);
  for (const slot of previous?.slots ?? []) {
    const a = state.strategy.assignments.get(slot.id);
    if (a?.player_id) carried.push(a.player_id);
  }

  state.strategy.formation_id = formationId;
  state.strategy.assignments = new Map();
  formation.slots.forEach((slot, i) => {
    state.strategy.assignments.set(slot.id, { player_id: carried[i] ?? null, x: null, y: null });
  });

  $('#formation-select').value = String(formationId);
  markDirty();
  renderBoard();
  renderFormations();
}

$('#formation-select').addEventListener('change', (e) => {
  if (!state.strategy) newStrategy();
  applyFormation(Number(e.target.value));
});

$('#strategy-name').addEventListener('input', () => {
  if (state.strategy) { state.strategy.name = $('#strategy-name').value; markDirty(); }
});
$('#strategy-notes').addEventListener('input', () => {
  if (state.strategy) { state.strategy.description = $('#strategy-notes').value; markDirty(); }
});

function strategyPayload() {
  return {
    name: state.strategy.name.trim() || t('status.untitled'),
    description: state.strategy.description,
    formation_id: state.strategy.formation_id,
    takes_kickoff: !!state.strategy.takes_kickoff,
    assignments: Array.from(state.strategy.assignments, ([slot_id, a]) => ({
      slot_id,
      player_id: a.player_id ?? null,
      x: a.x ?? null, y: a.y ?? null,
      kickoff_x: a.kickoff_x ?? null, kickoff_y: a.kickoff_y ?? null,
    })),
    drawings: state.strategy.drawings.map((d) => ({ ...d, phase: d.phase || 'open' })),
  };
}

const saveStrategy = guard(async (silent = false) => {
  if (!state.strategy) return;
  clearTimeout(state.saveTimer);
  const payload = strategyPayload();
  const saved = state.strategy.id
    ? await api('PUT', `/api/strategies/${state.strategy.id}`, payload)
    : await api('POST', '/api/strategies', payload);

  state.strategy.id = saved.id;
  state.strategy.name = saved.name;
  $('#strategy-name').value = saved.name;
  $('#board-status').textContent =
    t('status.saved', { time: new Date().toLocaleTimeString(getLocale()) });
  await loadStrategies();
  if (!silent) toast(t('toast.strategySaved'));
});

$('#save-strategy').addEventListener('click', () => saveStrategy(false));
$('#new-strategy').addEventListener('click', newStrategy);

$('#delete-strategy').addEventListener('click', guard(async () => {
  if (!state.strategy?.id) { newStrategy(); return; }
  if (!confirm(t('confirm.deleteStrategy', { name: state.strategy.name }))) return;
  await api('DELETE', `/api/strategies/${state.strategy.id}`);
  newStrategy();
  await loadStrategies();
  toast(t('toast.strategyDeleted'));
}));

$('#autofill').addEventListener('click', () => {
  const formation = currentFormation();
  if (!formation) return;

  const pool = state.players.filter((p) => p.active);
  const taken = new Set();

  const score = (player, slot) => {
    const want = SLOT_TO_POSITION[slot.code] || slot.code;
    let s = 0;
    if (player.primary_position === want) s = 100;
    else if (player.secondary_position === want) s = 75;
    else if (groupOf(player.primary_position) === slot.role_group) s = 45;
    else if (player.secondary_position && groupOf(player.secondary_position) === slot.role_group) s = 30;
    else s = 5;
    // Left-sided roles read better with a left foot, and vice versa.
    if (slot.code.startsWith('L') && slot.code !== 'LCB' && player.foot !== 'right') s += 6;
    if (slot.code.startsWith('R') && slot.code !== 'RCB' && player.foot !== 'left') s += 3;
    return s;
  };

  // Goalkeeper first, then back to front, so specialists win their slot.
  const order = ['GK', 'DEF', 'MID', 'FWD'];
  const slots = [...formation.slots].sort((a, b) => order.indexOf(a.role_group) - order.indexOf(b.role_group));

  for (const slot of slots) {
    let best = null;
    let bestScore = -1;
    for (const p of pool) {
      if (taken.has(p.id)) continue;
      const s = score(p, slot);
      if (s > bestScore) { best = p; bestScore = s; }
    }
    const a = state.strategy.assignments.get(slot.id) || {};
    state.strategy.assignments.set(slot.id, { ...a, player_id: best ? best.id : null });
    if (best) taken.add(best.id);
  }

  markDirty();
  renderBoard();
  toast(taken.size < formation.slots.length
    ? t('toast.lineupPartial', { filled: taken.size, total: formation.slots.length })
    : t('toast.lineupFilled'));
});

function renderStrategyList() {
  $('#strategy-list').innerHTML = state.strategies.length
    ? state.strategies.map((s) => `
      <li data-strategy="${s.id}" class="${s.id === state.strategy?.id ? 'is-active' : ''}">
        <span class="title">${esc(s.name)}<br><span class="sub">${esc(s.formation_name || t('board.noFormation'))}</span></span>
        <button class="link danger" data-del-strategy="${s.id}">×</button>
      </li>`).join('')
    : `<li class="hint">${t('board.noStrategies')}</li>`;
}

$('#strategy-list').addEventListener('click', guard(async (e) => {
  const del = e.target.closest('[data-del-strategy]');
  if (del) {
    e.stopPropagation();
    const id = Number(del.dataset.delStrategy);
    const s = state.strategies.find((x) => x.id === id);
    if (!confirm(t('confirm.deleteStrategy', { name: s.name }))) return;
    await api('DELETE', `/api/strategies/${id}`);
    if (state.strategy?.id === id) newStrategy();
    await loadStrategies();
    toast(t('toast.strategyDeleted'));
    return;
  }
  const li = e.target.closest('[data-strategy]');
  if (li) await openStrategy(Number(li.dataset.strategy));
}));

async function openStrategy(id) {
  clearTimeout(state.saveTimer);
  const s = await api('GET', `/api/strategies/${id}`);
  const formation = state.formations.find((f) => f.id === s.formation_id) || state.formations[0];

  const assignments = new Map();
  for (const slot of formation?.slots ?? []) assignments.set(slot.id, { player_id: null, x: null, y: null, kickoff_x: null, kickoff_y: null });
  for (const a of s.assignments) {
    if (!assignments.has(a.slot_id)) continue;
    assignments.set(a.slot_id, {
      player_id: a.player_id, x: a.x, y: a.y, kickoff_x: a.kickoff_x, kickoff_y: a.kickoff_y,
    });
  }

  state.strategy = {
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    formation_id: formation?.id ?? null,
    takes_kickoff: s.takes_kickoff !== false,
    assignments,
    drawings: s.drawings.map((d) => ({ ...d, phase: d.phase || 'open' })),
  };

  $('#strategy-name').value = s.name;
  $('#strategy-notes').value = s.description ?? '';
  if (formation) $('#formation-select').value = String(formation.id);
  $('#board-status').textContent = t('status.loaded', { date: s.updated_at });
  renderStrategyList();
  renderFormations();
  renderBoard();
}

async function loadStrategies() {
  state.strategies = await api('GET', '/api/strategies');
  renderStrategyList();
}

/* ============================================================== backup */

/*
 * The Backup tab. Everything this app knows lives in one browser's
 * localStorage, so it is one cleared site setting away from gone — this is how
 * you get a copy out, and how you get one back in. `GET /api/backup` hands
 * over the whole document; `PUT /api/backup` replaces it.
 *
 * Google Drive is the same backup taking a different route out of the browser;
 * drive.js owns the OAuth and the REST calls, this only drives the UI.
 */

function backupFilename() {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `soccer-field-manager-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

const countLines = (counts) => [
  ['data.countPlayers', counts.players],
  ['data.countStaff', counts.staff],
  ['data.countFormations', counts.formations],
  ['data.countStrategies', counts.strategies],
];

const refreshBackupCounts = guard(async () => {
  const { counts } = await api('GET', '/api/backup');
  $('#backup-counts').innerHTML = countLines(counts)
    .map(([key, n]) => `<li><span>${esc(t(key))}</span><b>${n}</b></li>`).join('');
});

/** Hands the browser a file to save. */
function downloadJson(filename, payload) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking immediately can beat the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Replaces everything with the contents of `payload`, after asking. `source`
 * names where it came from so the confirmation is not a blank cheque.
 */
async function restoreBackup(payload, source) {
  const counts = payload?.counts;
  const summary = counts && typeof counts === 'object'
    ? countLines(counts).map(([key, n]) => `${n} ${t(key).toLowerCase()}`).join(', ')
    : t('data.summaryUnknown');
  if (!confirm(t('confirm.restore', { source, summary }))) return false;

  // A queued autosave would otherwise write the pre-restore strategy back.
  clearTimeout(state.saveTimer);
  const result = await api('PUT', '/api/backup', payload);

  /*
   * A restore swaps the whole document out from under a running page, and
   * re-reading the rows is not enough to catch up with that: the open
   * strategy, the board's phase, the drawing tool and the formation preview
   * all live in module state that points at ids the restore just replaced.
   * Reloading is the only way to be sure the screen shows what was restored
   * rather than a half-updated mix — and now that the Drive session survives a
   * reload, it costs nothing to do.
   */
  rememberRestore(result.counts);
  location.reload();
  return true;
}

/*
 * The reload above kills the toast that would have confirmed the restore, so
 * it is parked here and shown once the page comes back up.
 */
const RESTORED_KEY = 'sfm.restored';

function rememberRestore(counts) {
  try {
    sessionStorage.setItem(RESTORED_KEY, JSON.stringify(counts));
  } catch {
    // The toast is a nicety; the reload is the part that matters.
  }
}

function takeRestored() {
  let counts = null;
  try {
    counts = JSON.parse(sessionStorage.getItem(RESTORED_KEY) || 'null');
    sessionStorage.removeItem(RESTORED_KEY);
  } catch {
    counts = null;
  }
  return counts;
}

/* -------------------------------------------------------------- drive */

/** Turns a drive.js failure into the same translated message store errors get. */
function driveMessage(err) {
  return err?.code && hasKey(`error.${err.code}`)
    ? t(`error.${err.code}`, err.params)
    : (err?.message || t('error.driveRequestFailed'));
}

const onDrive = (fn) => (...args) =>
  Promise.resolve(fn(...args)).catch((err) => toast(driveMessage(err), true));

let driveFiles = [];

function renderDriveState() {
  const connected = Drive.isConnected();
  const configured = Boolean(Drive.getClientId());

  $('#drive-state').textContent = t(connected ? 'data.connected' : 'data.disconnected');
  $('#drive-connect').hidden = connected;
  $('#drive-disconnect').hidden = !connected;
  $('#drive-upload').disabled = !connected;
  $('#drive-refresh').disabled = !connected;
  $('#drive-connect').disabled = !configured;
  $('#drive-hint').textContent = configured
    ? t('data.driveFolder', { folder: Drive.FOLDER_NAME })
    : t('data.driveNeedsClientId');

  if (!connected) driveFiles = [];
  renderDriveFiles();
}

function renderDriveFiles() {
  const list = $('#drive-files');
  if (!Drive.isConnected()) {
    list.innerHTML = '';
    return;
  }
  if (!driveFiles.length) {
    list.innerHTML = `<li class="hint">${esc(t('data.driveEmpty'))}</li>`;
    return;
  }
  list.innerHTML = driveFiles.map((f, i) => `
    <li class="drive-file">
      <span class="title">
        ${esc(f.name)}
        <span class="sub">${esc(new Date(f.modifiedTime).toLocaleString(getLocale()))}</span>
      </span>
      <button class="btn btn-sm" data-drive-restore="${i}">${esc(t('data.driveRestore'))}</button>
      <button class="btn btn-sm btn-danger" data-drive-delete="${i}"
              title="${esc(t('data.driveDelete'))}">×</button>
    </li>`).join('');
}

const refreshDriveFiles = onDrive(async () => {
  driveFiles = await Drive.list();
  renderDriveFiles();
});

function initBackupView() {
  $('#backup-export').addEventListener('click', guard(async () => {
    downloadJson(backupFilename(), await api('GET', '/api/backup'));
    toast(t('toast.exported'));
  }));

  $('#backup-import').addEventListener('click', () => $('#backup-file').click());

  $('#backup-file').addEventListener('change', guard(async (event) => {
    const file = event.target.files[0];
    event.target.value = ''; // so picking the same file twice still fires
    if (!file) return;
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error(t('error.backupUnreadable'));
    }
    await restoreBackup(payload, file.name);
  }));

  const clientIdField = $('#drive-client-id');
  clientIdField.value = Drive.getClientId();
  clientIdField.addEventListener('change', () => {
    clientIdField.value = Drive.setClientId(clientIdField.value);
    renderDriveState();
  });
  // An id already configured means the setup details can stay folded away.
  $('#drive-setup').open = !Drive.getClientId();

  $('#drive-connect').addEventListener('click', onDrive(async () => {
    await Drive.connect();
    renderDriveState();
    toast(t('toast.driveConnected'));
    // Listing is a separate call; its own failure toast should win, not this one.
    await refreshDriveFiles();
  }));

  $('#drive-disconnect').addEventListener('click', () => {
    Drive.disconnect();
    renderDriveState();
  });

  $('#drive-upload').addEventListener('click', onDrive(async () => {
    const payload = await api('GET', '/api/backup');
    await Drive.upload(backupFilename(), payload);
    await refreshDriveFiles();
    toast(t('toast.driveSaved', { folder: Drive.FOLDER_NAME }));
  }));

  $('#drive-refresh').addEventListener('click', () => refreshDriveFiles());

  $('#drive-files').addEventListener('click', onDrive(async (event) => {
    const restore = event.target.closest('[data-drive-restore]');
    if (restore) {
      const file = driveFiles[Number(restore.dataset.driveRestore)];
      await restoreBackup(await Drive.download(file.id), file.name);
      return;
    }
    const del = event.target.closest('[data-drive-delete]');
    if (del) {
      const file = driveFiles[Number(del.dataset.driveDelete)];
      if (!confirm(t('confirm.driveDelete', { name: file.name }))) return;
      await Drive.remove(file.id);
      await refreshDriveFiles();
      toast(t('toast.driveDeleted'));
    }
  }));

  renderDriveState();
  // A reload keeps the Drive session, so the file list should come back with
  // it rather than waiting for a Refresh the user has no reason to expect.
  if (Drive.isConnected()) refreshDriveFiles();
}

/* ================================================================ boot */

/** Reads the whole document into the UI. Also used after a restore. */
async function loadAll() {
  await loadFormations();
  await Promise.all([loadPlayers(), loadStaff(), loadStrategies()]);
  if (state.strategies.length) await openStrategy(state.strategies[0].id);
  else newStrategy();
}

(async function init() {
  setLocale(preferredLocale());
  $('#lang-select').innerHTML = LOCALES
    .map((l) => `<option value="${l.code}">${esc(l.label)}</option>`).join('');
  $('#lang-select').value = getLocale();
  document.documentElement.lang = getLocale();
  document.title = t('app.title');
  applyTranslations();
  fillPositionSelects();
  refreshFormTitles();
  showView(location.hash.slice(1) || 'board');
  // Private-mode browsers can refuse localStorage; the app still runs, but
  // whatever you do is gone when the tab closes, so say so.
  if (!Store.persistent) toast(t('toast.storageUnavailable'), true);
  initBackupView();
  // Claimed before the load so a failure there cannot leave it to surface on
  // some unrelated visit later.
  const restored = takeRestored();
  try {
    await loadAll();
    if (restored) toast(t('toast.restored', restored));
  } catch (err) {
    toast(err.message, true);
  }
})();
