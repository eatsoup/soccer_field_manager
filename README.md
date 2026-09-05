# Soccer Field Manager

A web app for running a squad: players, coaching staff, formations, and a
drag-and-drop tactics board with arrows. It is a static site — no backend, no
build step, no dependencies. Everything you enter is stored in the browser's
`localStorage`, on the machine you enter it on — and the **Backup** tab is how
you get a copy of it out again, as a file or into your own Google Drive.

```bash
npm start               # or: node scripts/serve.js
# → http://localhost:3000
```

`scripts/serve.js` is a plain static file server for local development; set
`PORT` to change the port. Any static server works — `npx serve public` does
the same job. Opening `public/index.html` straight off the disk works as well,
though some browsers refuse `localStorage` on `file://` pages — the app then
warns that nothing will be kept.

## Publishing

The site is `public/`. `.github/workflows/pages.yml` runs `npm test`, then
deploys that directory to GitHub Pages on every push to `main`; pull requests
run the same tests but stop short of publishing, and the workflow can also be
started by hand from the Actions tab. There is no build step — the directory is
uploaded as it is.

Enable it once, in the repository: **Settings → Pages → Build and deployment →
Source: GitHub Actions**. The deployed URL shows up on the workflow run. It
works from a project page (`user.github.io/repo/`) as well as a user page —
every asset is referenced relatively.

Each visitor gets their own empty squad, seeded with the built-in formations,
because the data never leaves their browser. Nothing syncs between people or
between devices on its own, and clearing site data clears the squad — the
[Backup tab](#google-drive) is how you move a squad from one browser to
another, or get it back afterwards.

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

**Backup** — the squad lives in one browser and nowhere else, so this tab is
the way out. *Download backup* writes the whole document — players, staff,
formations, strategies, drawings — to a single `.json` file; *Restore from
file* reads one back. A restore is a replacement, not a merge: it asks first,
and names what the file holds before it overwrites anything.

Connect **Google Drive** and you stop having to think about any of it: your
work saves itself into a live file that follows you to every device signed in
to the same account. Whoever deploys the site sets that up once — see
[Google Drive](#google-drive) — after which it is just a sign-in for everyone
else.

## Google Drive

Connect once and the app keeps a **Current.json** in a *Soccer Field Manager*
folder in your own Drive. Every change you make is written there a moment
later, and every device signed in to the same account picks it up — so a phone
on the touchline and a laptop at home stay on the same squad without anyone
pressing save. For anyone using the site it is one click: *Connect*, sign in,
done. Nobody but you has to set anything up.

Alongside it you can keep **named copies**: *Save a named copy…* asks for a
name and writes that state aside, to restore later. Those are the ones you take
on purpose — a shape for a particular opponent, a squad before transfers — and
nothing overwrites them. Reusing a name asks before replacing that copy.

Sync is deliberately the modest kind. There is no server to arbitrate, so each
device tracks the Drive revision it last agreed with and Drive's own version
counter says whether anyone else got there first. Only one side changed, and it
just flows; both changed, and the app asks which to keep — and writes the other
one to Drive as a named copy first, so answering it wrongly costs a click
rather than an afternoon. An update from elsewhere waits while you are dragging
a token or have an unsaved edit in hand, and lands the moment you pause. A tab
you are not looking at stops polling.

Getting there costs you one registration, once, at deploy time. This is the
same arrangement draw.io has: diagrams.net ships JGraph's own client ID on
`app.diagrams.net` so visitors just sign in, while [self-hosting draw.io][dio]
asks you to register a client ID and hand it over as `DRAWIO_GOOGLE_CLIENT_ID`.
A static site has nowhere to keep a client secret and nothing to run a token
exchange, so the browser does the whole OAuth flow — which means the client ID
has to be baked into the deployment rather than shipped by someone else.

[dio]: https://github.com/jgraph/docker-drawio/blob/dev/self-contained/README.md

### Registering the client ID

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project — or pick one you already have.
2. **APIs & Services → Library** → enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → configure it as **External**,
   then **Publish** it. Left in *Testing* it only works for the handful of
   accounts you list as test users, which is the usual reason a coach gets
   turned away at sign-in.
4. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Under **Authorized JavaScript origins** add every origin the
   site is served from — `http://localhost:3000` for local development,
   `https://<user>.github.io` for GitHub Pages. No redirect URI is needed; the
   token never leaves the browser.
5. Put the client ID in `public/config.js` and deploy:

   ```js
   window.SFM_CONFIG = {
     googleClientId: '1234-abcd.apps.googleusercontent.com',
   };
   ```

**No Google verification review is involved.** This app asks for exactly one
scope, `drive.file`, which Google classes as [non-sensitive][scopes] — apps
using only non-sensitive scopes are [not required to go through app
verification][verify]. That is the whole reason to prefer it over `drive` or
`drive.readonly`, which are restricted and drag in a paid security assessment.

[scopes]: https://support.google.com/cloud/answer/13807380?hl=en
[verify]: https://support.google.com/cloud/answer/13463073?hl=en

The Backup tab also has a client ID field, under *Connection settings*. That is
an escape hatch, not the main road: it is for trying Drive out before you have
edited `config.js`, and for forks served from an origin the deployed ID does
not cover. It is remembered in `localStorage`, in that one browser, and takes
precedence over `config.js`.

### What the app can and cannot see

- `drive.file` is per-file access: **this app can only ever open files it
  created itself.** The rest of your Drive is invisible to it, and it is not
  asking for permission to look.
- The access token lives in memory for about an hour and is never written to
  storage. Closing the tab signs you out; *Disconnect* does it immediately.
- Sign-in needs a real origin, so `file://` pages cannot use Drive. Serve the
  site (`npm start`) instead.

Backups are ordinary JSON files in your Drive: the folder is yours, and
deleting one there is the same as deleting it from the list in the app.

## Translations

The interface ships in **English** and **Dutch**, switchable from the top right.
The choice is remembered in `localStorage`; on a first visit the browser
language decides.

Everything user-facing is translated, including data-driven text: staff roles
(stored as stable keys like `head_coach`, so a role keeps its meaning across
languages), position names, built-in formation descriptions, kick-off rule
violations, and store error messages — the store raises a stable `code` and the
browser renders it in the active language.

### Adding or changing text

Never inline a literal. Markup uses `data-i18n`, `data-i18n-placeholder` and
`data-i18n-title`; code uses `t('key', { param: value })`. Add the key to
**both** locale tables in `public/i18n.js` in the same change, then:

```bash
node scripts/check-i18n.js
```

It fails on any key missing from a locale, any key referenced but undefined,
any translation that drops a `{placeholder}` its English source has, and any
failure code `store.js` or `drive.js` can raise that has no `error.<code>`
entry to render it with.

Adding a language means one more entry in `LOCALES` and one more table in
`TRANSLATIONS` — the switcher and the checker pick it up automatically.

## Layout

Everything under `public/` is the deployed site; everything outside it is
tooling that never ships.

| File | Role |
| --- | --- |
| `public/index.html` | Markup and the SVG pitch |
| `public/app.js` | All client logic |
| `public/store.js` | The database: localStorage document, validation, built-in formation seed data |
| `public/i18n.js` | Translation tables (English + Dutch) and the `t()` helper |
| `public/drive.js` | Google Drive sign-in and REST calls, behind a `Drive` object |
| `public/sync.js` | Keeps the local document and the Drive live file in step |
| `public/config.js` | Optional deployment settings — currently just the Google client ID |
| `public/kickoff.js` | Kick-off geometry and rule checks, shared by the store and the board |
| `public/styles.css` | Styling |
| `scripts/serve.js` | Static file server for local development |
| `scripts/test-store.js` | Tests the store against the contract `app.js` relies on |
| `scripts/test-sync.js` | Runs two devices against a stand-in Drive on a virtual clock |
| `scripts/check-i18n.js` | Fails if a key is missing from a locale or referenced but undefined |

The pitch uses a 0–100 coordinate space on both axes; the SVG is 100 × 154 so
the drawing stays proportional to a real 68 m × 105 m field. `y = 100` is your
own goal line, `y = 0` the opponent's, so our own half is `y >= 50` and the
centre spot is `(50, 50)`. Kick-off spots are clamped to `y >= 50` by the store
as well as by the board.

## Where the data lives

One JSON document under the `localStorage` key `soccer.db.v1`, holding
SQL-shaped tables: `players`, `staff`, `formations`, `formation_slots`,
`strategies`, `strategy_assignments`, `strategy_drawings`. Built-in formations
are seeded into an empty document on first load.

`store.js` reaches the rest of the app through one function that deliberately
looks like the REST API this used to be, so `app.js` neither knows nor cares
that the server is gone:

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
GET    /api/backup            PUT  /api/backup
```

Assignments carry `x`/`y` (open play) and `kickoff_x`/`kickoff_y` (starting
positions) but a single `player_id` shared by both phases; drawings carry
`phase` (`open` or `kickoff`); strategies carry `takes_kickoff`.
`PUT /api/strategies/:id` replaces the strategy's assignments and drawings
wholesale. Assignments referencing a slot outside the strategy's formation, or
a player that no longer exists, are dropped rather than rejected. Deletes
cascade the way the foreign keys used to: deleting a player empties their slot,
deleting a formation leaves its strategies without one.

`GET /api/backup` returns the whole document inside an envelope — `format`,
`backup_version`, `exported_at`, `counts` and `data` — which is exactly what
the Backup tab downloads or uploads to Drive. `PUT /api/backup` takes one back
and **replaces** the document; it refuses a file stamped by another app or by a
newer backup version, and drops rows that have no numeric id. A bare document
without the envelope is accepted too, for files edited by hand. Rows are not
re-validated field by field — they were written by the routes above — and
dangling references stay survivable the same way they always were: an
assignment pointing at a missing slot or player is dropped the next time the
strategy is saved.

Writes are persisted only after the whole call succeeds, so a rejected payload
leaves nothing half-applied, and reads go back to `localStorage` each time so a
second tab sees the first one's work on its next action.

```bash
node scripts/test-store.js    # or: npm test — also runs the sync and i18n checks
```

Failures carry a stable `code` (`playerNotFound`, `builtinReadonly`,
`storageFull`, …) that the browser renders in the active language.

**Resetting** — take a backup first if you want it back. `Store.reset()` from
the browser console wipes the document;
the built-in formations come back on the next load. Clearing the site's data in
browser settings does the same. If a browser refuses `localStorage` altogether
(private mode, some file:// setups) the app still runs on an in-memory store
for the session and says so with a warning toast.
