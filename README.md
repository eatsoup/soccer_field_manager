# Soccer Field Manager

A web app for running a squad: players, coaching staff, formations, and a
drag-and-drop tactics board with arrows. Everything is stored in a local SQLite
file.

No dependencies. Node 22.5+ (uses the built-in `node:sqlite` and `node:http`).

```bash
node server.js          # or: npm start
# → http://localhost:3000
```

Set `PORT` to change the port and `SOCCER_DB` to point at a different database
file. The database is created and seeded with the built-in formations on first
run.

## What's in it

**Squad** — players with shirt number, primary and secondary position, strong
foot, birth year, notes, and an available/unavailable flag. Unavailable players
are skipped by Auto-fill.

**Staff** — coaches, trainers, physios, analysts and so on, with contact details.

**Formations** — seven built-in setups (4-4-2, 4-3-3, 4-2-3-1, 4-1-4-1,
4-4-2 Diamond, 3-5-2, 5-3-2). Built-ins are read-only; duplicate one to get an
editable copy.

**Tactics board** — the main screen. It has two phases, switched by the toggle
at the top left. Each phase owns its **spots** and its **drawings**; the eleven
players are shared, because it is the same XI that starts the match.

| Per phase | Shared |
| --- | --- |
| Position spots | Which players are picked |
| Drawings (arrows, zones, labels) | Formation |
| | Name and notes |

So you can draw a kick-off routine on the kick-off board and a pressing pattern
on the open-play board without them bleeding into each other, while picking your
starting eleven only once. Undo, *Clear drawings* and Erase all act on the phase
currently on screen.

*Kick-off (starting positions)* — every player is pinned to our own half. You
cannot drag anyone over the halfway line; the opponent half is dimmed and the
centre circle is marked. Tick **We take the kick-off** to say which side starts:

- *We kick off* — everyone but the player on the ball must be in our own half.
- *They kick off* — everyone must also be 9.15 m from the ball, so the whole
  centre circle is off limits.

The panel checks the shape against those rules live and names anyone breaking
them. *Build from open play* compresses the open-play shape back into our own
half, clears the circle, and puts the most advanced player on the ball. Every
built-in formation ships with a kick-off shape derived the same way.

*Open play* — the attacking shape, with the full pitch available.

- Drag a player from the bench onto a position to field them.
- Drag one position onto another to swap those two players.
- Drag a position onto open grass to move the spot itself. That override belongs
  to the strategy *and to the phase you are looking at*, so 4-4-2 stays 4-4-2
  while this particular game plan has the left back pushed higher. *Reset spots*
  undoes it for the current phase only.
- *Save spots → formation* (custom formations only) bakes the current phase's
  spots into the formation itself.
- Double-click a player, or use the × in the Starting XI list, to bench them.
- *Auto-fill XI* picks a lineup by position fit, with a nudge toward the right
  footedness for left- and right-sided roles.
- Switching formation carries the eleven players across.

**Drawing tools** — Run (solid arrow), Pass (dashed arrow), Dribble (wavy
arrow), Line, Zone, and text Labels, in six colours. Erase removes a drawing on
click; Undo drops the last one. Drawings are saved with the strategy and belong
to the phase they were drawn on — the panel names which board you are looking at.

Strategies autosave a moment after each change once they have been saved the
first time.

## Translations

The interface ships in **English** and **Dutch**, switchable from the top right.
The choice is remembered in `localStorage`; on a first visit the browser
language decides.

Everything user-facing is translated, including data-driven text: staff roles
(stored as stable keys like `head_coach`, so a role keeps its meaning across
languages), position names, built-in formation descriptions, kick-off rule
violations, and API error messages — the server returns a stable `code` and the
browser renders it in the active language.

### Adding or changing text

Never inline a literal. Markup uses `data-i18n`, `data-i18n-placeholder` and
`data-i18n-title`; code uses `t('key', { param: value })`. Add the key to
**both** locale tables in `public/i18n.js` in the same change, then:

```bash
node scripts/check-i18n.js
```

It fails on any key missing from a locale, any key referenced but undefined, and
any translation that drops a `{placeholder}` its English source has.

Adding a language means one more entry in `LOCALES` and one more table in
`TRANSLATIONS` — the switcher and the checker pick it up automatically.

## Layout

| File | Role |
| --- | --- |
| `server.js` | HTTP server, JSON REST API, static files |
| `db.js` | Schema, migrations, built-in formation seed data |
| `public/i18n.js` | Translation tables (English + Dutch) and the `t()` helper |
| `scripts/check-i18n.js` | Fails if a key is missing from a locale or referenced but undefined |
| `public/kickoff.js` | Kick-off geometry and rule checks, shared by seeder and browser |
| `public/index.html` | Markup and the SVG pitch |
| `public/app.js` | All client logic |
| `public/styles.css` | Styling |

The pitch uses a 0–100 coordinate space on both axes; the SVG is 100 × 154 so
the drawing stays proportional to a real 68 m × 105 m field. `y = 100` is your
own goal line, `y = 0` the opponent's, so our own half is `y >= 50` and the
centre spot is `(50, 50)`. Kick-off spots are clamped to `y >= 50` on the server
as well as in the browser.

## API

```
GET    /api/players           POST /api/players
PUT    /api/players/:id       DELETE /api/players/:id
GET    /api/staff             POST /api/staff
PUT    /api/staff/:id         DELETE /api/staff/:id
GET    /api/formations        POST /api/formations
PUT    /api/formations/:id            (custom only, replaces slots)
PUT    /api/formations/:id/slots      (custom only, moves spots in place;
                                       body.phase "kickoff" writes starting spots)
DELETE /api/formations/:id            (custom only)
GET    /api/strategies        GET  /api/strategies/:id
POST   /api/strategies        PUT  /api/strategies/:id
DELETE /api/strategies/:id
```

Assignments carry `x`/`y` (open play) and `kickoff_x`/`kickoff_y` (starting
positions) but a single `player_id` shared by both phases; drawings carry
`phase` (`open` or `kickoff`); strategies carry `takes_kickoff`. `PUT /api/strategies/:id` replaces
the strategy's assignments and drawings wholesale. Assignments referencing a slot outside the strategy's formation, or a
player that no longer exists, are dropped rather than rejected.
