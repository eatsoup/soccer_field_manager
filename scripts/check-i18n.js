'use strict';

/*
 * Guards the translation contract:
 *   1. every locale defines exactly the same keys
 *   2. every key referenced in markup or code actually exists
 *   3. no placeholder like {name} is dropped in a translation
 * Run with: node scripts/check-i18n.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { TRANSLATIONS, LOCALES } = require(path.join(ROOT, 'public/i18n.js'));

const problems = [];
const locales = Object.keys(TRANSLATIONS);
const base = 'en';
const baseKeys = Object.keys(TRANSLATIONS[base]);

// 1. matching key sets
for (const locale of locales) {
  if (locale === base) continue;
  const keys = new Set(Object.keys(TRANSLATIONS[locale]));
  for (const key of baseKeys) {
    if (!keys.has(key)) problems.push(`[${locale}] missing key: ${key}`);
  }
  for (const key of keys) {
    if (!TRANSLATIONS[base][key]) problems.push(`[${locale}] key not in ${base}: ${key}`);
  }
}

// 2. placeholders must survive translation
const placeholders = (text) => (String(text).match(/\{(\w+)\}/g) || []).sort().join(',');
for (const locale of locales) {
  if (locale === base) continue;
  for (const key of baseKeys) {
    const want = placeholders(TRANSLATIONS[base][key]);
    const got = placeholders(TRANSLATIONS[locale][key] ?? '');
    if (want !== got) {
      problems.push(`[${locale}] placeholders differ for ${key}: expected "${want}" got "${got}"`);
    }
  }
}

// 3. referenced keys must exist
const known = new Set(baseKeys);
const sources = ['public/index.html', 'public/app.js'];
// prefixes built at runtime from data (slot codes, roles, formation names, error codes)
const DYNAMIC = ['slot.', 'role.', 'formation.desc.', 'error.', 'foot.', 'drawing.', 'kickoff.issue.'];

for (const rel of sources) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const refs = new Set();
  for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) refs.add(m[1]);
  for (const m of text.matchAll(/data-i18n(?:-placeholder|-title)?="([a-zA-Z0-9_.-]+)"/g)) refs.add(m[1]);
  for (const key of refs) {
    if (known.has(key)) continue;
    if (DYNAMIC.some((p) => key.startsWith(p))) continue;
    problems.push(`[${rel}] references undefined key: ${key}`);
  }
}

// 4. every dynamic family used by the app has entries
const REQUIRED_FAMILIES = {
  'foot.': ['foot.left', 'foot.right', 'foot.both'],
  'drawing.': ['drawing.run', 'drawing.pass', 'drawing.dribble', 'drawing.line', 'drawing.zone', 'drawing.text'],
  'kickoff.issue.': ['kickoff.issue.tooManyOverLine', 'kickoff.issue.notOnBall',
    'kickoff.issue.inOpponentHalf', 'kickoff.issue.insideCircle'],
};
for (const [family, keys] of Object.entries(REQUIRED_FAMILIES)) {
  for (const key of keys) {
    if (!known.has(key)) problems.push(`missing required ${family} key: ${key}`);
  }
}

if (problems.length) {
  console.error(`i18n check FAILED (${problems.length} problem${problems.length > 1 ? 's' : ''}):\n`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log(`i18n check passed: ${locales.length} locales (${LOCALES.map((l) => l.code).join(', ')}), ${baseKeys.length} keys each.`);
