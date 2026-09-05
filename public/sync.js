'use strict';

/*
 * Keeps this browser's document and one file in Google Drive in step.
 *
 * There is no server to arbitrate, so this is deliberately the modest kind of
 * sync: one live file per Drive folder, whole-document writes, and Drive's own
 * `version` counter as the "has anyone else written?" signal. Every device
 * remembers the version it last agreed with; a version it did not expect means
 * somebody else got there first.
 *
 * That gives three honest outcomes and no silent fourth:
 *   - only we changed        -> upload, and move our baseline forward
 *   - only they changed      -> download and apply
 *   - both changed           -> ask, and keep the losing side as a named copy
 *
 * Nothing here touches the DOM or the store directly. `configure()` is handed
 * the few things it cannot know — how to read and apply a document, whether
 * the user is mid-drag, and how to ask a question — so the policy stays here
 * and the app keeps the rendering.
 */
(function (root) {
  const STATE_KEY = 'sfm.sync.v1';
  const PUSH_DELAY = 1500;      // let a burst of edits settle into one upload
  const POLL_INTERVAL = 12_000;
  const IDLE_RECHECK = 1200;    // how often a held update retests the board

  let cfg = null;
  let running = false;

  let fileId = null;
  let baseVersion = null;       // the Drive version this device is in step with
  let dirty = false;            // local edits Drive has not seen yet
  let editSerial = 0;           // so an edit mid-upload is not marked as saved

  let applying = false;         // guards against our own writes looking local
  let inFlight = null;          // one Drive conversation at a time
  let held = null;              // a pulled document waiting for the user to stop
  let pushTimer = null;
  let pollTimer = null;
  let idleTimer = null;

  let phase = 'off';
  let syncedAt = null;
  let lastError = null;

  /* ------------------------------------------------------- persistence */

  /*
   * The baseline outlives the tab on purpose: without it, a device coming back
   * tomorrow cannot tell "Drive moved on while I was away" from "I have edits
   * Drive never got", and would have to ask about a clash that never happened.
   */
  function remember() {
    try {
      root.localStorage.setItem(STATE_KEY,
        JSON.stringify({ fileId, version: baseVersion, dirty }));
    } catch {
      // Sync still works; it just re-establishes the baseline on the next boot.
    }
  }

  function recall() {
    let saved = null;
    try {
      saved = JSON.parse(root.localStorage.getItem(STATE_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (!saved || typeof saved !== 'object') return;
    fileId = saved.fileId || null;
    baseVersion = saved.version ?? null;
    dirty = Boolean(saved.dirty);
  }

  // Read once, up front: `touch()` can persist before `start()` ever runs, and
  // would otherwise write a null baseline over the real one.
  recall();

  /* ------------------------------------------------------------ status */

  const status = () => ({ phase, syncedAt, error: lastError, held: Boolean(held) });

  function report(next, error = null) {
    phase = next;
    lastError = error;
    if (next === 'synced') syncedAt = Date.now();
    try {
      cfg?.onState?.(status());
    } catch {
      // A failing status line must never break the sync itself.
    }
  }

  /* --------------------------------------------------------- plumbing */

  // Drive hands `version` back as a string; a missing one can never match.
  const sameVersion = (a, b) => a != null && b != null && String(a) === String(b);

  /** Runs Drive work one piece at a time, so a push cannot race a pull. */
  function serialise(work) {
    const next = (inFlight || Promise.resolve()).then(work, work);
    inFlight = next.catch(() => {});
    return next;
  }

  const FATAL = new Set([
    'driveExpired', 'driveAuthCancelled', 'driveAuthFailed',
    'driveNoClientId', 'driveScriptBlocked',
  ]);

  async function guarded(work) {
    try {
      await work();
    } catch (err) {
      const code = err?.code || 'driveRequestFailed';
      // A token that needs a popup cannot be renewed from a timer, so stop
      // rather than pester Drive; the panel asks for the click instead.
      if (FATAL.has(code)) stop();
      report('error', code);
    }
  }

  /** Re-finds the live file if it was deleted or trashed from another device. */
  async function remoteMeta() {
    try {
      return await Drive.meta(fileId);
    } catch (err) {
      if (err?.params?.status !== 404) throw err;
      fileId = null;
      baseVersion = null;
      remember();
      await ensureFile();
      return Drive.meta(fileId);
    }
  }

  /* ------------------------------------------------------ the exchange */

  /**
   * Settles on a live file. A device meeting an existing one for the first
   * time has no baseline to reason with: if nothing has been entered here the
   * Drive copy simply is the truth, and otherwise only the user can say.
   */
  async function ensureFile() {
    if (fileId) return;
    const found = await Drive.findCurrent();
    if (!found) {
      const created = await Drive.createCurrent(await cfg.read());
      fileId = created.id;
      baseVersion = created.version;
      dirty = false;
      remember();
      return;
    }

    fileId = found.id;
    if (await cfg.isEmpty()) {
      await applyRemote(await Drive.download(found.id), found.version,
        { hold: false, announce: false });
      return;
    }
    await settleClash(found.version);
  }

  /**
   * Puts a downloaded document on screen. Held back while the user is dragging
   * a token or has unsaved edits in hand — the board changing under someone's
   * fingers is the one thing worse than a slightly stale board.
   */
  async function applyRemote(doc, version, { hold = true, announce = true } = {}) {
    if (hold && cfg.isBusy()) {
      held = { doc, version };
      report('waiting');
      scheduleIdleCheck();
      return;
    }
    held = null;
    applying = true;
    try {
      await cfg.apply(doc);
    } finally {
      applying = false;
    }
    baseVersion = version;
    dirty = false;
    remember();
    report('synced');
    if (announce) cfg.onPulled?.();
  }

  function scheduleIdleCheck() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!running || !held) return;
      if (cfg.isBusy()) { scheduleIdleCheck(); return; }
      const { doc, version } = held;
      serialise(() => guarded(() => applyRemote(doc, version)));
    }, IDLE_RECHECK);
  }

  /**
   * Both sides moved since this device was last in step. Whichever version the
   * user does not keep is written to Drive as a named copy first, so a wrong
   * button is never the end of anyone's afternoon.
   */
  async function settleClash(remoteVersion) {
    report('conflict');
    const theirs = await Drive.download(fileId);
    const mine = await cfg.read();

    if (await cfg.onConflict() === 'remote') {
      await cfg.snapshot(mine, 'local');
      await applyRemote(theirs, remoteVersion, { hold: false });
      return;
    }
    await cfg.snapshot(theirs, 'remote');
    const saved = await Drive.overwrite(fileId, mine);
    baseVersion = saved.version;
    dirty = false;
    remember();
    report('synced');
  }

  async function push() {
    if (!running || !dirty) return;
    await ensureFile();
    if (!dirty) return;              // adopting a remote document settled it

    report('syncing');
    const remote = await remoteMeta();
    if (!sameVersion(remote.version, baseVersion)) {
      await settleClash(remote.version);
      return;
    }

    // Marked before the upload: an edit landing while it is in flight leaves
    // this document stale the moment it arrives, and must not read as saved.
    const mark = editSerial;
    const saved = await Drive.overwrite(fileId, await cfg.read());
    baseVersion = saved.version;
    if (editSerial === mark) {
      dirty = false;
      report('synced');
    } else {
      schedulePush();
    }
    remember();
  }

  async function pull() {
    if (!running) return;
    await ensureFile();
    if (!fileId) return;

    const remote = await remoteMeta();
    if (sameVersion(remote.version, baseVersion)) {
      if (!dirty && phase !== 'waiting') report('synced');
      return;
    }
    if (dirty) {
      await settleClash(remote.version);
      return;
    }
    report('syncing');
    await applyRemote(await Drive.download(fileId), remote.version);
  }

  /* ------------------------------------------------------------ timers */

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => serialise(() => guarded(push)), PUSH_DELAY);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!running) return;
    pollTimer = setTimeout(() => {
      // Nobody is watching a hidden tab; let it idle instead of spending quota.
      if (root.document?.hidden) { schedulePoll(); return; }
      serialise(() => guarded(pull)).then(schedulePoll, schedulePoll);
    }, POLL_INTERVAL);
  }

  root.document?.addEventListener?.('visibilitychange', () => {
    // Coming back to a tab is exactly when it is most likely to be behind.
    if (running && !root.document.hidden) serialise(() => guarded(pull));
  });

  /* ------------------------------------------------------------ public */

  /**
   * Records that the local document changed. Deliberately not conditional on
   * the loop running: edits made while signed out are still edits, and a
   * device that forgot them would let the next sign-in pull straight over the
   * top of an afternoon's work.
   */
  function touch() {
    if (applying) return;
    editSerial++;
    dirty = true;
    remember();
    if (running) schedulePush();
  }

  function start() {
    if (running) return Promise.resolve();
    running = true;
    report('syncing');
    const first = serialise(() => guarded(async () => {
      await ensureFile();
      if (dirty) await push();
      else await pull();
    }));
    first.then(schedulePoll, schedulePoll);
    return first;
  }

  function stop() {
    running = false;
    clearTimeout(pushTimer);
    clearTimeout(pollTimer);
    clearTimeout(idleTimer);
    held = null;
    report('off');
  }

  /** Forgets this device's place in the file — used when signing out. */
  function forget() {
    stop();
    fileId = null;
    baseVersion = null;
    dirty = false;
    try {
      root.localStorage.removeItem(STATE_KEY);
    } catch {
      // Nothing stored, nothing to clear.
    }
  }

  /** Pushes whatever is pending right now, e.g. just before a reload. */
  function flush() {
    clearTimeout(pushTimer);
    if (!running || !dirty) return Promise.resolve();
    return serialise(() => guarded(push));
  }

  root.Sync = {
    configure: (options) => { cfg = options; },
    start,
    stop,
    forget,
    flush,
    touch,
    status,
    isRunning: () => running,
    currentFileId: () => fileId,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
