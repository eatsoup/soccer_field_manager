'use strict';

/*
 * Kick-off geometry, shared by the store (store.js) and the board.
 *
 * Laws of the Game, kick-off:
 *   - All players except the one taking the kick-off must be in their own half.
 *   - The opponents of the team taking the kick-off must be at least 9.15 m
 *     from the ball, i.e. outside the centre circle, until the ball is in play.
 *
 * Model coordinates are 0-100 on both axes with y = 100 our own goal line, so
 * "our own half" is y >= 50 and the centre spot is (50, 50). Distances must be
 * measured in SVG space (y scaled by YS) or the circle comes out as an ellipse.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const YS = 1.54;
  const CENTRE = { x: 50, y: 50 };
  const CIRCLE_R = 13.46;     // 9.15 m expressed in SVG units
  const HALFWAY = 50;         // y >= HALFWAY is our own half

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ballDistance = (p) => Math.hypot(p.x - CENTRE.x, (p.y - CENTRE.y) * YS);
  const insideCentreCircle = (p, margin = 0) => ballDistance(p) < CIRCLE_R + margin;

  /** Nudges a point radially out of the centre circle, staying in our own half. */
  function pushOutsideCircle(p, margin = 0.8) {
    if (!insideCentreCircle(p, margin)) return { x: p.x, y: p.y };

    let dx = p.x - CENTRE.x;
    let dy = (p.y - CENTRE.y) * YS;
    let len = Math.hypot(dx, dy);
    if (len < 0.001) { dx = 0; dy = 1; len = 1; }   // dead on the spot: push backwards

    const k = (CIRCLE_R + margin) / len;
    const out = { x: CENTRE.x + dx * k, y: CENTRE.y + (dy * k) / YS };

    if (out.y < HALFWAY) {
      // Radially out would cross into the opponent half; slide along the halfway line instead.
      const y = HALFWAY + 0.5;
      const spread = Math.sqrt(Math.max(0, (CIRCLE_R + margin) ** 2 - ((y - CENTRE.y) * YS) ** 2));
      out.x = CENTRE.x + (p.x >= CENTRE.x ? spread : -spread);
      out.y = y;
    }
    return { x: clamp(out.x, 3, 97), y: clamp(out.y, HALFWAY, 97) };
  }

  /**
   * Derives a legal kick-off shape from an open-play shape: compress the
   * outfield players into our own half keeping their relative order and width,
   * clear the centre circle, and put the most advanced player on the ball when
   * we are the ones kicking off.
   *
   * `slots` need { x, y, role_group }; the result mirrors the input order.
   */
  function kickoffShape(slots, options) {
    const takesKickoff = !options || options.takesKickoff !== false;
    const outfield = slots.filter((s) => s.role_group !== 'GK');
    const ys = outfield.map((s) => s.y);
    const yMin = ys.length ? Math.min(...ys) : 0;
    const yMax = ys.length ? Math.max(...ys) : 100;
    const span = Math.max(1, yMax - yMin);

    const placed = new Map();
    for (const s of slots) {
      if (s.role_group === 'GK') {
        placed.set(s, { x: s.x, y: clamp(Math.max(s.y, 86), HALFWAY, 97) });
      } else {
        // t = 0 for the most advanced player, 1 for the deepest.
        const t = (s.y - yMin) / span;
        placed.set(s, pushOutsideCircle({ x: clamp(s.x, 3, 97), y: 54 + t * 34 }));
      }
    }

    if (takesKickoff && outfield.length) {
      const kicker = outfield.reduce((a, b) => (a.y <= b.y ? a : b));
      placed.set(kicker, { x: CENTRE.x, y: CENTRE.y });
    }

    return slots.map((s) => {
      const p = placed.get(s);
      return { id: s.id, code: s.code, x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)) };
    });
  }

  /**
   * Checks a kick-off shape against the laws. `entries` need { label, x, y }.
   * Returns { code, params } objects — the caller translates them via
   * t('kickoff.issue.' + code). Empty means the shape is legal.
   */
  function kickoffIssues(entries, options) {
    const takesKickoff = !options || options.takesKickoff !== false;
    const issues = [];
    const overTheLine = entries.filter((e) => e.y < HALFWAY - 0.01);

    if (takesKickoff) {
      if (overTheLine.length > 1) {
        issues.push({ code: 'tooManyOverLine', params: { count: overTheLine.length } });
      }
      for (const e of overTheLine) {
        if (!insideCentreCircle(e)) issues.push({ code: 'notOnBall', params: { name: e.label } });
      }
    } else {
      for (const e of overTheLine) {
        issues.push({ code: 'inOpponentHalf', params: { name: e.label } });
      }
      for (const e of entries) {
        if (insideCentreCircle(e)) {
          issues.push({ code: 'insideCircle', params: { name: e.label } });
        }
      }
    }
    return issues;
  }

  return {
    KICKOFF_YS: YS,
    KICKOFF_CENTRE: CENTRE,
    KICKOFF_CIRCLE_R: CIRCLE_R,
    KICKOFF_HALFWAY: HALFWAY,
    ballDistance,
    insideCentreCircle,
    pushOutsideCircle,
    kickoffShape,
    kickoffIssues,
  };
});
