// Google authentication.
//
// Two modes, chosen by whether CONFIG.apiBaseUrl is set:
//
//  • Relay mode (apiBaseUrl set): the OAuth 2.0 *authorization-code* flow. We
//    obtain a code via Google Identity Services (GIS) and hand it to our Worker,
//    which exchanges it for a long-lived *refresh token* (kept server-side) and
//    returns a deviceToken + a short access token. From then on we mint fresh
//    access tokens silently via the Worker for as long as the refresh token
//    lives (months) — so the user almost never has to re-authorise.
//
//  • Serverless mode (apiBaseUrl empty): the OAuth implicit token flow — purely
//    client-side, no backend. Access tokens last ~1h and are refreshed silently
//    only while Google still considers the browser signed in.

import { CONFIG, getClientId } from './config.js';

const LS_TOKEN = 'xn.token';
const LS_DEVICE = 'xn.deviceToken';

let tokenClient = null;        // GIS implicit token client (serverless mode)
let codeClient = null;         // GIS auth-code client (relay mode)
let accessToken = null;
let tokenExpiry = 0;           // epoch ms
let currentClientId = null;
let refreshTimer = null;
let deviceToken = readDevice();

function apiBase() {
  return (CONFIG.apiBaseUrl || '').replace(/\/+$/, '');
}
// Relay mode is active only when a backend URL is configured *and* the user has
// a deviceToken (or is about to get one via sign-in).
function relayEnabled() {
  return !!apiBase();
}

// --- Token persistence --------------------------------------------------

function readDevice() {
  try { return localStorage.getItem(LS_DEVICE) || null; } catch { return null; }
}
function persistDevice() {
  try {
    if (deviceToken) localStorage.setItem(LS_DEVICE, deviceToken);
    else localStorage.removeItem(LS_DEVICE);
  } catch {}
}

function persistToken() {
  try {
    localStorage.setItem(
      LS_TOKEN,
      JSON.stringify({ accessToken, tokenExpiry, clientId: getClientId() })
    );
  } catch {}
}

function clearPersisted() {
  try { localStorage.removeItem(LS_TOKEN); } catch {}
}

// Restore a still-valid token from a previous session (survives refresh).
function hydrateToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_TOKEN) || 'null');
    if (!saved || !saved.accessToken) return;
    // Ignore a token minted for a different client id.
    if (saved.clientId && saved.clientId !== getClientId()) return;
    if (Date.now() < (saved.tokenExpiry || 0) - 10_000) {
      accessToken = saved.accessToken;
      tokenExpiry = saved.tokenExpiry;
    }
  } catch {}
}
hydrateToken();

// Adopt a freshly minted access token (from either flow) and schedule renewal.
function setAccessToken(token, expiresInSeconds) {
  accessToken = token;
  tokenExpiry = Date.now() + (Number(expiresInSeconds || 3600) * 1000);
  persistToken();
  scheduleRefresh();
  emit();
  return accessToken;
}

const listeners = new Set();

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(isSignedIn());
}

export function isSignedIn() {
  return !!accessToken && Date.now() < tokenExpiry - 10_000;
}

// Wait for the GIS script to finish loading.
function waitForGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    let tries = 0;
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(t);
        resolve();
      } else if (++tries > 100) {
        clearInterval(t);
        reject(new Error('Google sign-in failed to load. Check your connection.'));
      }
    }, 100);
  });
}

// --- Relay mode (authorization-code flow via the Worker) ----------------

// Pop the GIS consent UI and resolve with a one-time authorization code.
function requestAuthCode() {
  return new Promise(async (resolve, reject) => {
    try {
      const clientId = getClientId();
      if (!clientId) throw new Error('No Google Client ID set. Open Settings to add one.');
      await waitForGis();
      if (!codeClient || currentClientId !== clientId) {
        currentClientId = clientId;
        codeClient = google.accounts.oauth2.initCodeClient({
          client_id: clientId,
          scope: CONFIG.driveScope,
          ux_mode: 'popup',
          callback: () => {}, // replaced per-request below
        });
      }
      codeClient.callback = (resp) => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        resolve(resp.code);
      };
      codeClient.requestCode();
    } catch (err) {
      reject(err);
    }
  });
}

// Exchange the code at the Worker for a deviceToken + first access token. The
// Worker stores the refresh token server-side (we never see it).
async function exchangeCode(code) {
  const res = await fetch(`${apiBase()}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // ux_mode 'popup' codes are bound to the special 'postmessage' redirect.
    body: JSON.stringify({ code, redirectUri: 'postmessage' }),
  });
  if (!res.ok) {
    throw new Error(`Auth exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json(); // { deviceToken, accessToken, expiresIn }
  deviceToken = data.deviceToken || null;
  persistDevice();
  return setAccessToken(data.accessToken, data.expiresIn);
}

// Mint a fresh access token from the server-stored refresh token. No user UI.
async function refreshViaRelay() {
  if (!deviceToken) throw new Error('AUTH: not connected');
  const res = await fetch(`${apiBase()}/auth/access-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  if (res.status === 401) {
    // The deviceToken itself is no longer valid: a full reconnect is required.
    clearDevice();
    throw new Error('AUTH: Google session expired — please reconnect.');
  }
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json(); // { accessToken, expiresIn }
  return setAccessToken(data.accessToken, data.expiresIn);
}

function clearDevice() {
  deviceToken = null;
  persistDevice();
}

// --- Serverless mode (implicit token flow) ------------------------------

async function ensureTokenClient() {
  const clientId = getClientId();
  if (!clientId) throw new Error('No Google Client ID set. Open Settings to add one.');
  await waitForGis();
  if (!tokenClient || currentClientId !== clientId) {
    currentClientId = clientId;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: CONFIG.driveScope,
      callback: () => {}, // replaced per-request below
    });
  }
  return tokenClient;
}

// Request a token. `interactive` shows the consent popup; otherwise we try a
// silent refresh (only works after the user has consented once).
function requestToken(interactive) {
  return new Promise(async (resolve, reject) => {
    try {
      const client = await ensureTokenClient();
      client.callback = (resp) => {
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        resolve(setAccessToken(resp.access_token, resp.expires_in));
      };
      // prompt '' reuses the existing grant silently when possible; Google
      // still shows consent automatically on the very first authorization.
      client.requestAccessToken({ prompt: '' });
    } catch (err) {
      reject(err);
    }
  });
}

// --- Background renewal --------------------------------------------------

// Renew the token shortly before it expires so an open/returning session never
// has to prompt. In relay mode this is a silent server round-trip; in
// serverless mode it's a silent GIS refresh while the Google session is alive.
function renewSilently() {
  return relayEnabled() ? refreshViaRelay() : requestToken(false);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!tokenExpiry) return;
  const lead = 5 * 60 * 1000; // refresh 5 minutes before expiry
  const delay = Math.max(15_000, tokenExpiry - Date.now() - lead);
  refreshTimer = setTimeout(() => {
    renewSilently().catch(() => { /* retry on demand / next focus */ });
  }, delay);
}

// Also top up the token when the app regains focus if it's close to expiring.
if (typeof window !== 'undefined') {
  const topUp = () => {
    if (accessToken && Date.now() > tokenExpiry - 5 * 60 * 1000) {
      renewSilently().catch(() => {});
    }
  };
  window.addEventListener('focus', topUp);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') topUp();
  });
}

// --- Public API ---------------------------------------------------------

// User-initiated connect (shows consent UI as needed).
export async function signIn() {
  if (relayEnabled()) return exchangeCode(await requestAuthCode());
  return requestToken(true);
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken); } catch {}
  }
  accessToken = null;
  tokenExpiry = 0;
  clearTimeout(refreshTimer);
  clearPersisted();
  clearDevice();
  emit();
}

// Drop the current access token without signing out. Used when the server
// rejects the token (401) even though our local expiry said it was still valid.
// In relay mode we keep the deviceToken — a Drive 401 means the access token
// went stale, not that the device authorization is gone — so the next
// getToken() mints a fresh one with no popup.
export function invalidateToken() {
  accessToken = null;
  tokenExpiry = 0;
  clearTimeout(refreshTimer);
  clearPersisted();
}

// Return a valid token, refreshing silently if possible.
export async function getToken({ interactive = false } = {}) {
  if (isSignedIn()) return accessToken;
  if (relayEnabled()) {
    if (deviceToken) {
      try { return await refreshViaRelay(); }
      catch (err) {
        // deviceToken rejected (or network): only escalate to the popup when
        // the caller allows interaction; otherwise surface the error.
        if (!interactive) throw err;
      }
    }
    if (interactive) return exchangeCode(await requestAuthCode());
    throw new Error('AUTH: not connected');
  }
  return requestToken(interactive);
}
