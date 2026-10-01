// Calls to the Xava Notes server. Same origin, so the session cookie carries the
// sign-in. Writes echo Laravel's XSRF-TOKEN cookie back as an X-XSRF-TOKEN
// header (Laravel's CSRF protection); GET /api/session sets that cookie.

import { CONFIG } from './config.js';
import { checkSession, markSignedOut } from './auth.js';

export class AuthError extends Error {
  constructor() {
    super('AUTH: signed out');
    this.name = 'AuthError';
  }
}

function xsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// fetch() with the session, the CSRF header and JSON errors handled. A 401
// marks the app signed out and throws AuthError. A 419 (CSRF token out of date)
// fetches a fresh token and retries once.
async function request(url, { method = 'GET', json, body, headers = {} } = {}, retried = false) {
  const h = { Accept: 'application/json', ...headers };
  let payload = body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  if (method !== 'GET') {
    if (!xsrfToken()) await checkSession();
    h['X-XSRF-TOKEN'] = xsrfToken();
  }
  const res = await fetch(url, {
    method, body: payload, headers: h, credentials: 'same-origin', cache: 'no-store',
  });
  if (res.status === 401) { markSignedOut(); throw new AuthError(); }
  if (res.status === 419 && !retried) {
    if (await checkSession()) return request(url, { method, json, body, headers }, true);
    throw new AuthError();
  }
  return res;
}

const api = (path) => `${CONFIG.apiBase}${path}`;

async function failure(res, what) {
  let detail = '';
  try {
    const data = await res.json();
    detail = data.message || data.error || '';
  } catch { /* not JSON */ }
  return new Error(`${what} failed (${res.status})${detail ? `: ${detail}` : ''}`);
}

// --- Notes --------------------------------------------------------------

// Everything changed after `after` (a rev). Returns { notes, rev }.
export async function pullNotes(after = 0) {
  const res = await request(api(`/notes?after=${encodeURIComponent(after)}`));
  if (!res.ok) throw await failure(res, 'Sync');
  return res.json();
}

// Create or update. Returns { ok: true, version } when stored, or
// { ok: false, note } when the server holds a newer version (409); `note` is
// that version, or { id, purged: true } if it was emptied from Trash.
export async function putNote(note, baseVersion) {
  const { unsynced, rev, version, fileId, ...body } = note;
  const res = await request(api(`/notes/${encodeURIComponent(note.id)}`), {
    method: 'PUT',
    json: { base_version: baseVersion || 0, note: body },
  });
  if (res.status === 409) return { ok: false, note: (await res.json()).note };
  if (!res.ok) throw await failure(res, 'Save');
  const data = await res.json();
  return { ok: true, version: data.version };
}

// Empty from Trash. Repeating it is harmless.
export async function deleteNote(id) {
  const res = await request(api(`/notes/${encodeURIComponent(id)}`), { method: 'DELETE' });
  if (!res.ok) throw await failure(res, 'Delete');
}

// --- Attachments ----------------------------------------------------------

// Upload a File/Blob. Returns { id, name, mime, size } for the note's list.
export async function uploadAttachment(file) {
  const form = new FormData();
  form.append('file', file, file.name || 'attachment');
  const res = await request(api('/attachments'), { method: 'POST', body: form });
  if (!res.ok) throw await failure(res, 'Upload');
  return res.json();
}

export async function getAttachmentBlob(id) {
  const res = await request(api(`/attachments/${encodeURIComponent(id)}`));
  if (!res.ok) throw await failure(res, 'Download');
  return res.blob();
}

export async function deleteAttachment(id) {
  const res = await request(api(`/attachments/${encodeURIComponent(id)}`), { method: 'DELETE' });
  if (!res.ok) throw await failure(res, 'Remove');
}

// --- Other ----------------------------------------------------------------

// Email a copy of a note or task to the owner.
export async function notify({ title, type, body, due, notebook }) {
  const res = await request(api('/notify'), { method: 'POST', json: { title, type, body, due, notebook } });
  if (!res.ok) throw await failure(res, 'Email');
}

// End the session on the server, then show the sign-in page.
export async function signOut() {
  await request(CONFIG.signOutUrl, { method: 'POST' }).catch(() => {});
}
