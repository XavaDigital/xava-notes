// Google authentication via Google Identity Services (GIS) token client.
//
// We use the OAuth 2.0 implicit token flow suitable for static, no-backend
// sites. The access token lives in memory only; we silently re-request it when
// it expires or when a Drive call returns 401.

import { CONFIG, getClientId } from './config.js';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0; // epoch ms
let currentClientId = null;

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
        emit();
        resolve(accessToken);
      };
      client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (err) {
      reject(err);
    }
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
  emit();
}

// Return a valid token, refreshing silently if possible.
export async function getToken({ interactive = false } = {}) {
  if (isSignedIn()) return accessToken;
  return requestToken(interactive);
}
