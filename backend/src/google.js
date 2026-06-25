// Google OAuth token handling + Drive REST writes (server-side).
// Uses the same OAuth client as the PWA (same drive.file app scope), so the
// server can read/write the same XavaNotes folder the client created.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'XavaNotes';

// Exchange an authorization code (PKCE) for tokens, including a refresh token.
export async function exchangeCode(env, code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('token exchange failed: ' + (await r.text()));
  return r.json(); // { access_token, refresh_token, expires_in, ... }
}

// Mint a fresh access token from a stored refresh token.
export async function refreshAccessToken(env, refreshToken) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('token refresh failed: ' + (await r.text()));
  return r.json(); // { access_token, expires_in }
}

async function dfetch(token, url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

export async function ensureFolder(token) {
  const q = encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='${FOLDER_NAME}' and trashed=false`);
  const r = await dfetch(token, `${DRIVE}?q=${q}&fields=files(id)&spaces=drive`);
  const d = await r.json();
  if (d.files && d.files.length) return d.files[0].id;
  const cr = await dfetch(token, DRIVE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  return (await cr.json()).id;
}

function multipart(metadata, content, boundary) {
  return (
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n` +
    content +
    `\r\n--${boundary}--`
  );
}

export async function createFile(token, name, content, appProperties) {
  const folderId = await ensureFolder(token);
  const boundary = 'xn-' + Math.random().toString(36).slice(2);
  const metadata = { name, parents: [folderId], mimeType: 'text/markdown', appProperties };
  const r = await dfetch(token, `${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart(metadata, content, boundary),
  });
  return r.json();
}

export async function updateFile(token, fileId, name, content, appProperties) {
  const boundary = 'xn-' + Math.random().toString(36).slice(2);
  const metadata = { name, appProperties };
  const r = await dfetch(token, `${UPLOAD}/${fileId}?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'PATCH',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart(metadata, content, boundary),
  });
  return r.json();
}

// Find an existing app file by the noteId we stamp into its appProperties.
// Lets the outbox be idempotent: a retried create updates the file the first
// attempt made instead of producing a duplicate. Returns a fileId or null.
export async function findFileByNoteId(token, noteId) {
  const safe = String(noteId).replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `appProperties has { key='noteId' and value='${safe}' } and trashed=false`
  );
  const r = await dfetch(token, `${DRIVE}?q=${q}&fields=files(id)&spaces=drive`);
  const d = await r.json();
  return (d.files && d.files[0] && d.files[0].id) || null;
}

export async function trashFile(token, fileId) {
  await dfetch(token, `${DRIVE}/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}
