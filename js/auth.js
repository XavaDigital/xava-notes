// Google authentication via Google Identity Services (GIS) token client.
//
// We use the OAuth 2.0 implicit token flow suitable for static, no-backend
// sites. The access token is cached in localStorage (with its expiry) so a page
// refresh reuses it instead of prompting again; once it expires we attempt a
// silent re-request and only show the popup if Google needs re-consent.

import { CONFIG, getClientId } from './config.js';

const LS_TOKEN = 'xn.token';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0; // epoch ms
let currentClientId = null;
let refreshTimer = null;

// --- Token persistence --------------------------------------------------

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

async function ensureTokenClient() {
  const clientId = getClientId();
  if (!clientId) throw new Error('No Google Client ID set. Open Settings to add one.');

  await waitForGis();

  // Rebuild if the client id changed.
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
        accessToken = resp.access_token;
        // expires_in is seconds; default ~3600.
        tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) * 1000);
        persistToken();
        scheduleRefresh();
        emit();
        resolve(accessToken);
      };
      // prompt '' reuses the existing grant silently when possible; Google
      // still shows consent automatically on the very first authorization.
      client.requestAccessToken({ prompt: '' });
    } catch (err) {
      reject(err);
    }
  });
}

// Silently renew the token shortly before it expires so an open/returning
// session never has to prompt again. Google caps access tokens at ~1h, so we
// just keep refreshing them in the background while the Google session is alive.
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!tokenExpiry) return;
  const lead = 5 * 60 * 1000; // refresh 5 minutes before expiry
  const delay = Math.max(15_000, tokenExpiry - Date.now() - lead);
  refreshTimer = setTimeout(() => {
    requestToken(false).catch(() => { /* retry on demand / next focus */ });
  }, delay);
}

// Also top up the token when the app regains focus if it's close to expiring.
if (typeof window !== 'undefined') {
  const topUp = () => {
    if (accessToken && Date.now() > tokenExpiry - 5 * 60 * 1000) {
      requestToken(false).catch(() => {});
    }
  };
  window.addEventListener('focus', topUp);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') topUp();
  });
}

// User-initiated connect (shows consent UI as needed).
export async function signIn() {
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
  emit();
}

// Drop the current token without signing out the UI. Used when the server
// rejects the token (401) even though our local expiry said it was still valid,
// so the next getToken() fetches a genuinely fresh one instead of reusing it.
export function invalidateToken() {
  accessToken = null;
  tokenExpiry = 0;
  clearTimeout(refreshTimer);
  clearPersisted();
}

// Return a valid token, refreshing silently if possible.
export async function getToken({ interactive = false } = {}) {
  if (isSignedIn()) return accessToken;
  return requestToken(interactive);
}
