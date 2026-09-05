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
  let baseToken = null;         // the content revision this device is in step with
  let baseDigest = null;        // and a stand-in for what that revision said
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
        JSON.stringify({ fileId, token: baseToken, digest: baseDigest, dirty }));
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
    // `version` is what older builds stored. A baseline in the old currency
    // simply looks unfamiliar, which costs one content check and nothing else.
    baseToken = saved.token ?? saved.version ?? null;
    baseDigest = saved.digest ?? null;
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

  // Drive hands these back as strings; a missing one can never match.
  const sameToken = (a, b) => a != null && b != null && String(a) === String(b);

  // Content revision first. `version` only stands in for a file that has not
  // got one yet — it also climbs for changes nobody made, so it is a hint here
  // rather than the answer.
  const tokenOf = (meta) => meta?.headRevisionId ?? meta?.version ?? null;

  /*
   * A short, stable stand-in for a document's contents. Kept instead of the
   * fingerprint itself, which is the entire squad and has no business sitting
   * in localStorage. Two 32-bit passes and the length: not cryptography, but
   * far past the point where a collision between two versions of one squad is
   * worth reasoning about.
   */
  function digest(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
    }
    return `${text.length}-${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
  }

  /** Records the revision, and what it said, as this device's new baseline. */
  function agree(token, print) {
    baseToken = token;
    baseDigest = digest(print);
    dirty = false;
    remember();
  }

  /*
   * What a document actually says, ignoring the envelope around it. Two
   * exports of the same squad differ in `exported_at` alone, and `seq` counts
   * ids handed out rather than anything on the pitch, so neither belongs in an
   * answer to "did this really change?".
   */
  function fingerprint(payload) {
    const doc = payload?.data ?? payload ?? {};
    const tables = Object.keys(doc).filter((key) => Array.isArray(doc[key])).sort();
    return JSON.stringify(tables.map((key) => [key, doc[key]]));
  }

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
      baseToken = null;
      baseDigest = null;
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
      const mine = await cfg.read();
      const created = await Drive.createCurrent(mine);
      fileId = created.id;
      agree(tokenOf(created), fingerprint(mine));
      return;
    }

    fileId = found.id;
    if (await cfg.isEmpty()) {
      await applyRemote(await Drive.download(found.id), tokenOf(found),
        { hold: false, announce: false });
      return;
    }
    // Work on both sides and no baseline to judge by. If the contents happen
    // to agree there is nothing to settle; if they differ, this device cannot
    // know which is newer, so it asks rather than guesses.
    await reconcile(found, { unsureLocal: true });
  }

  /**
   * The file carries a revision this device has not seen. That is not yet the
   * same as somebody having changed something: Drive issues revisions for its
   * own reasons, and two devices can perfectly well write identical documents.
   * So the contents get the last word before anyone is asked anything.
   */
  async function reconcile(remote, { unsureLocal = false } = {}) {
    const theirs = await Drive.download(fileId);
    const theirPrint = fingerprint(theirs);
    const token = tokenOf(remote);

    /*
     * Measured against what we last agreed on, not against what is on screen
     * now — those are different questions, and only the first one answers
     * "did somebody else change something?". A device holding an edit of its
     * own would otherwise read its own unsent work as a disagreement.
     */
    if (!unsureLocal && baseDigest && digest(theirPrint) === baseDigest) {
      baseToken = token;               // Drive moved, the squad did not
      remember();
      if (!dirty) report('synced');
      return true;                     // safe for a caller mid-push to carry on
    }

    // Or it changed into precisely what this device already holds.
    if (theirPrint === fingerprint(await cfg.read())) {
      agree(token, theirPrint);
      report('synced');
      return false;
    }

    if (dirty || unsureLocal) {
      await settleClash(theirs, token);
      return false;
    }
    report('syncing');
    await applyRemote(theirs, token);
    return false;
  }

  /**
   * Puts a downloaded document on screen. Held back while the user is dragging
   * a token or has unsaved edits in hand — the board changing under someone's
   * fingers is the one thing worse than a slightly stale board.
   */
  async function applyRemote(doc, token, { hold = true, announce = true } = {}) {
    if (hold && cfg.isBusy()) {
      held = { doc, token };
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
    agree(token, fingerprint(doc));
    report('synced');
    if (announce) cfg.onPulled?.();
  }

  function scheduleIdleCheck() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!running || !held) return;
      if (cfg.isBusy()) { scheduleIdleCheck(); return; }
      const { doc, token } = held;
      serialise(() => guarded(() => applyRemote(doc, token)));
    }, IDLE_RECHECK);
  }

  /**
   * Both sides moved since this device was last in step. Whichever version the
   * user does not keep is written to Drive as a named copy first, so a wrong
   * button is never the end of anyone's afternoon.
   */
  async function settleClash(theirs, remoteToken) {
    report('conflict');
    const mine = await cfg.read();

    if (await cfg.onConflict() === 'remote') {
      await cfg.snapshot(mine, 'local');
      await applyRemote(theirs, remoteToken, { hold: false });
      return;
    }
    await cfg.snapshot(theirs, 'remote');
    const saved = await Drive.overwrite(fileId, mine);
    agree(tokenOf(saved), fingerprint(mine));
    report('synced');
  }

  async function push() {
    if (!running || !dirty) return;
    await ensureFile();
    if (!dirty) return;              // adopting a remote document settled it

    report('syncing');
    const remote = await remoteMeta();
    // A revision we have not seen only stops the push if it really differs.
    if (!sameToken(tokenOf(remote), baseToken) && !await reconcile(remote)) return;

    // Marked before the upload: an edit landing while it is in flight leaves
    // this document stale the moment it arrives, and must not read as saved.
    const mark = editSerial;
    const mine = await cfg.read();
    const saved = await Drive.overwrite(fileId, mine);
    baseToken = tokenOf(saved);
    baseDigest = digest(fingerprint(mine));
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
    if (sameToken(tokenOf(remote), baseToken)) {
      if (!dirty && phase !== 'waiting') report('synced');
      return;
    }
    await reconcile(remote);
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
    baseToken = null;
    baseDigest = null;
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
