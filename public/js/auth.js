// Sign-in state.
//
// Signing in happens on the server's own page (/login), which sets a session
// cookie and remembers the device. The app only needs to know whether that
// session is still good: GET /api/session answers 200 (signed in) or 401
// (signed out). Offline, the answer is unknown, and the app carries on with
// its cached notes; edits wait in IndexedDB until the session is confirmed.

import { CONFIG } from './config.js';

let status = 'unknown'; // 'in' | 'out' | 'unknown'
let email = '';
const listeners = new Set();

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(next, who = email) {
  const changed = next !== status || who !== email;
  status = next;
  email = who;
  if (changed) for (const fn of listeners) fn(isSignedIn());
}

// True unless the server has said the session is gone. "Unknown" (offline, or
// not checked yet) counts as signed in, so requests are attempted and a 401
// settles it.
export function isSignedIn() {
  return status !== 'out';
}

// True only once the server has confirmed the session.
export function isConfirmed() {
  return status === 'in';
}

export function currentEmail() {
  return email;
}

// Ask the server. Also sets Laravel's XSRF-TOKEN cookie, which writes echo back.
// Returns true when signed in; a network failure leaves the state unchanged.
export async function checkSession() {
  try {
    const res = await fetch(`${CONFIG.apiBase}/session`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.status === 401) { set('out', ''); return false; }
    if (res.ok) { set('in', (await res.json()).email || ''); return true; }
  } catch { /* offline: leave as is */ }
  return isSignedIn();
}

// Called by api.js when any request answers 401.
export function markSignedOut() {
  set('out', '');
}

// Go to the server's sign-in page. It comes back to the app afterwards.
export function goToSignIn() {
  location.href = CONFIG.signInUrl;
}
