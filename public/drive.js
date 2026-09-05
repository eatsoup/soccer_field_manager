'use strict';

/*
 * Google Drive backup transport.
 *
 * The app is a static site with no backend, so there is nowhere to keep a
 * client secret and nothing to run a server-side OAuth exchange. What is left
 * is the browser-only flow: Google Identity Services hands us a short-lived
 * access token in a popup, and we call the Drive REST API with it directly.
 *
 * Consequences worth knowing:
 *   - It needs an OAuth client ID of your own (see the README). There is no
 *     shared one to fall back on, so the app asks for it and remembers it.
 *   - The scope is `drive.file`, the narrowest one that works: this app can
 *     only ever see the files it created itself, never the rest of your Drive.
 *   - The token is good for about an hour and is kept in sessionStorage, so a
 *     page reload does not sign you out but closing the tab still does. It
 *     never reaches localStorage, where it would outlive the browsing session.
 *
 * Like store.js, failures carry a stable `code` that the browser translates.
 */
(function (root) {
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const FOLDER_NAME = 'Soccer Field Manager';
  const CLIENT_ID_KEY = 'sfm.drive.clientId';
  const SESSION_KEY = 'sfm.drive.session';
  // A minute of slack so a token cannot expire mid-upload. `isConnected` uses
  // it too: a token this tool would refuse to reuse is not a live connection,
  // and saying otherwise invites a popup from code that cannot open one.
  const EXPIRY_SLACK = 60_000;

  class DriveError extends Error {
    constructor(code, message, params) {
      super(message);
      this.code = code;
      this.params = params;
    }
  }

  /* -------------------------------------------------------- client id */

  function storedClientId() {
    try {
      return root.localStorage.getItem(CLIENT_ID_KEY) || '';
    } catch {
      return '';
    }
  }

  /** A deployment can ship its own id in config.js; the field overrides it. */
  const getClientId = () => storedClientId() || (root.SFM_CONFIG?.googleClientId ?? '').trim();

  function setClientId(value) {
    const id = String(value ?? '').trim();
    if (id === getClientId()) return id;
    disconnect();
    try {
      if (id) root.localStorage.setItem(CLIENT_ID_KEY, id);
      else root.localStorage.removeItem(CLIENT_ID_KEY);
    } catch {
      // Nothing to do: without storage the id lasts for this page load only.
    }
    return id;
  }

  /* ------------------------------------------------------------ token */

  let tokenClient = null;
  let clientIdInUse = null;
  let token = null;
  let tokenExpiry = 0;
  let folderId = null;
  let gisPromise = null;

  const isConnected = () => Boolean(token) && Date.now() < tokenExpiry - EXPIRY_SLACK;

  function rememberSession() {
    try {
      root.sessionStorage.setItem(SESSION_KEY,
        JSON.stringify({ clientId: getClientId(), token, tokenExpiry, folderId }));
    } catch {
      // Without sessionStorage the token lasts for this page load only, which
      // is exactly where we were before.
    }
  }

  function forgetSession() {
    try {
      root.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing stored means nothing to clear.
    }
  }

  /*
   * Brings back the token a reload would otherwise drop. A session saved under
   * a different client id belongs to a different app registration, and one too
   * close to expiry would only send the next call looking for a popup it
   * cannot open, so both are discarded rather than trusted.
   */
  (function resumeSession() {
    let saved = null;
    try {
      saved = JSON.parse(root.sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (!saved || typeof saved !== 'object') return;
    if (saved.clientId !== getClientId()
      || !saved.token
      || !(Date.now() < Number(saved.tokenExpiry) - EXPIRY_SLACK)) {
      forgetSession();
      return;
    }
    token = saved.token;
    tokenExpiry = Number(saved.tokenExpiry);
    folderId = saved.folderId || null;
  })();

  function loadGis() {
    if (root.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = GIS_SRC;
      el.async = true;
      el.defer = true;
      el.onload = () => (root.google?.accounts?.oauth2
        ? resolve()
        : reject(new DriveError('driveScriptBlocked', 'Google sign-in did not load')));
      el.onerror = () => {
        gisPromise = null; // let a later attempt retry, e.g. once back online
        reject(new DriveError('driveScriptBlocked', 'Google sign-in did not load'));
      };
      document.head.appendChild(el);
    });
    return gisPromise;
  }

  function authError(response) {
    const kind = response?.type || response?.error;
    if (kind === 'popup_closed' || kind === 'popup_failed_to_open' || kind === 'access_denied') {
      return new DriveError('driveAuthCancelled', 'Google sign-in was cancelled');
    }
    return new DriveError('driveAuthFailed', response?.error_description || 'Google sign-in failed');
  }

  /**
   * Returns a usable access token, opening Google's popup when there is none.
   * Call it only from a click handler — browsers block the popup otherwise.
   */
  async function accessToken() {
    if (token && Date.now() < tokenExpiry - EXPIRY_SLACK) return token;

    const clientId = getClientId();
    if (!clientId) throw new DriveError('driveNoClientId', 'No Google client ID configured');
    await loadGis();

    if (!tokenClient || clientIdInUse !== clientId) {
      tokenClient = root.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: () => {},
      });
      clientIdInUse = clientId;
    }

    return new Promise((resolve, reject) => {
      tokenClient.callback = (response) => {
        if (!response || response.error || !response.access_token) {
          reject(authError(response));
          return;
        }
        token = response.access_token;
        tokenExpiry = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        rememberSession();
        resolve(token);
      };
      tokenClient.error_callback = (err) => reject(authError(err));
      try {
        // Empty prompt: Google skips the consent screen once access is granted.
        tokenClient.requestAccessToken({ prompt: '' });
      } catch (err) {
        reject(new DriveError('driveAuthFailed', err.message));
      }
    });
  }

  /** Signs out for this tab and forgets the token; the grant itself stays. */
  function disconnect() {
    if (token) {
      try {
        root.google?.accounts?.oauth2?.revoke(token, () => {});
      } catch {
        // Revoking is best-effort; dropping the token below is what matters.
      }
    }
    token = null;
    tokenExpiry = 0;
    folderId = null;
    forgetSession();
  }

  /** Proves the client id works and warms the token, without touching files. */
  async function connect() {
    await accessToken();
    return true;
  }

  /* -------------------------------------------------------------- api */

  async function driveFetch(url, options = {}) {
    const bearer = await accessToken();
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${bearer}` },
      });
    } catch {
      throw new DriveError('driveOffline', 'Could not reach Google Drive');
    }
    if (response.status === 401) {
      token = null; // expired or revoked: the next call re-authenticates
      tokenExpiry = 0;
      forgetSession();
      throw new DriveError('driveExpired', 'The Google Drive session expired');
    }
    if (!response.ok) {
      throw new DriveError('driveRequestFailed', `Drive returned ${response.status}`,
        { status: response.status });
    }
    return response;
  }

  /** The folder backups live in, created on first use. */
  async function backupFolder() {
    if (folderId) return folderId;
    const query = `mimeType='${FOLDER_MIME}' and name='${FOLDER_NAME}' and trashed=false`;
    const found = await driveFetch(
      `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`);
    const existing = (await found.json()).files || [];
    if (existing.length) {
      folderId = existing[0].id;
      rememberSession();
      return folderId;
    }
    const created = await driveFetch(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    folderId = (await created.json()).id;
    rememberSession();
    return folderId;
  }

  const FIELDS = 'id,name,modifiedTime';

  /** Writes a new backup file into the folder. */
  async function upload(name, payload) {
    const parent = await backupFolder();
    // Random boundary: a player's notes could otherwise contain a fixed one.
    const boundary = `sfm${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const part = 'Content-Type: application/json; charset=UTF-8';
    const body = [
      `--${boundary}`, part, '',
      JSON.stringify({ name, parents: [parent], mimeType: 'application/json' }),
      `--${boundary}`, part, '', JSON.stringify(payload, null, 2),
      `--${boundary}--`, '',
    ].join('\r\n');

    const response = await driveFetch(
      `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
    return response.json();
  }

  /** The backups in the folder, newest first. */
  async function list() {
    const parent = await backupFolder();
    const query = `'${parent}' in parents and trashed=false`;
    const response = await driveFetch(`${API}/files?q=${encodeURIComponent(query)}`
      + `&orderBy=${encodeURIComponent('modifiedTime desc')}&pageSize=50&fields=files(${FIELDS})`);
    return (await response.json()).files || [];
  }

  async function download(fileId) {
    const response = await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new DriveError('driveBadBackup', 'That Drive file is not valid JSON');
    }
  }

  async function remove(fileId) {
    await driveFetch(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    return true;
  }

  root.Drive = {
    DriveError,
    FOLDER_NAME,
    SCOPE,
    getClientId,
    setClientId,
    isConnected,
    connect,
    disconnect,
    upload,
    list,
    download,
    remove,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
