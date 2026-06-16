// Thin wrapper over the Google Drive REST API (v3).
//
// With the drive.file scope, list/search only returns files this app created,
// so a simple folder + flat file layout works without seeing the user's other
// data.

import { CONFIG } from './config.js';
import { getToken } from './auth.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function authFetch(url, options = {}, retry = true) {
  const token = await getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && retry) {
    // Token expired mid-flight; force an interactive refresh once.
    await getToken({ interactive: true });
    return authFetch(url, options, false);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

let cachedFolderId = null;

// Find or create the app folder; returns its id.
export async function ensureFolder() {
  if (cachedFolderId) return cachedFolderId;

  const q = encodeURIComponent(
    `mimeType='${FOLDER_MIME}' and name='${CONFIG.appFolderName}' and trashed=false`
  );
  const res = await authFetch(`${FILES}?q=${q}&fields=files(id,name)&spaces=drive`);
  const data = await res.json();
  if (data.files?.length) {
    cachedFolderId = data.files[0].id;
    return cachedFolderId;
  }

  const createRes = await authFetch(FILES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: CONFIG.appFolderName, mimeType: FOLDER_MIME }),
  });
  const created = await createRes.json();
  cachedFolderId = created.id;
  return cachedFolderId;
}

const FILE_FIELDS = 'id,name,modifiedTime,createdTime,appProperties';

// List all note files in the folder (metadata only).
export async function listFiles() {
  const folderId = await ensureFolder();
  const files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const url =
      `${FILES}?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})` +
      `&orderBy=modifiedTime desc&pageSize=100` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const res = await authFetch(url);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

// Full-text search within the folder. Returns file metadata.
export async function searchFiles(text) {
  const folderId = await ensureFolder();
  const safe = text.replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and fullText contains '${safe}'`
  );
  const url = `${FILES}?q=${q}&fields=files(${FILE_FIELDS})&pageSize=100`;
  const res = await authFetch(url);
  const data = await res.json();
  return data.files || [];
}

// Download a file's text content.
export async function getContent(fileId) {
  const res = await authFetch(`${FILES}/${fileId}?alt=media`);
  return res.text();
}

function multipartBody(metadata, content, boundary) {
  return (
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: text/markdown; charset=UTF-8\r\n\r\n' +
    content +
    `\r\n--${boundary}--`
  );
}

// Create a new note file. Returns the new file metadata.
export async function createFile(name, content, appProperties = {}) {
  const folderId = await ensureFolder();
  const boundary = 'xn-' + Math.random().toString(36).slice(2);
  const metadata = {
    name,
    parents: [folderId],
    mimeType: 'text/markdown',
    appProperties,
  };
  const res = await authFetch(
    `${UPLOAD}?uploadType=multipart&fields=${FILE_FIELDS}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody(metadata, content, boundary),
    }
  );
  return res.json();
}

// Update an existing note file's content (and optionally name/appProperties).
export async function updateFile(fileId, name, content, appProperties = {}) {
  const boundary = 'xn-' + Math.random().toString(36).slice(2);
  const metadata = { name, appProperties };
  const res = await authFetch(
    `${UPLOAD}/${fileId}?uploadType=multipart&fields=${FILE_FIELDS}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody(metadata, content, boundary),
    }
  );
  return res.json();
}

// Move a file to trash.
export async function trashFile(fileId) {
  await authFetch(`${FILES}/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}
