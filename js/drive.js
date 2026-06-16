// Thin wrapper over the Google Drive REST API (v3).
//
// With the drive.file scope, list/search only returns files this app created,
// so a simple folder + flat file layout works without seeing the user's other
// data.

import { CONFIG } from './config.js';
import { getToken, invalidateToken } from './auth.js';

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
    // The server rejected the token even if our local expiry said it was fine.
    // Drop it and fetch a genuinely fresh one, then retry once.
    invalidateToken();
    await getToken({ interactive: true });
    return authFetch(url, options, false);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      invalidateToken();
      throw new Error('AUTH: Google session expired — please reconnect.');
    }
    throw new Error(`Drive ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

let cachedFolderId = null;
let cachedAttachmentsFolderId = null;

const ATTACHMENTS_FOLDER = 'attachments';

async function findOrCreateFolder(name, parentId) {
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const q = encodeURIComponent(
    `mimeType='${FOLDER_MIME}' and name='${name}' and trashed=false${parentClause}`
  );
  const res = await authFetch(`${FILES}?q=${q}&fields=files(id,name)&spaces=drive`);
  const data = await res.json();
  if (data.files?.length) return data.files[0].id;

  const metadata = { name, mimeType: FOLDER_MIME };
  if (parentId) metadata.parents = [parentId];
  const createRes = await authFetch(FILES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  return (await createRes.json()).id;
}

// Find or create the app folder; returns its id.
export async function ensureFolder() {
  if (cachedFolderId) return cachedFolderId;
  cachedFolderId = await findOrCreateFolder(CONFIG.appFolderName, null);
  return cachedFolderId;
}

// Find or create the attachments subfolder; returns its id.
export async function ensureAttachmentsFolder() {
  if (cachedAttachmentsFolderId) return cachedAttachmentsFolderId;
  const parent = await ensureFolder();
  cachedAttachmentsFolderId = await findOrCreateFolder(ATTACHMENTS_FOLDER, parent);
  return cachedAttachmentsFolderId;
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,createdTime,appProperties';

// List all note files in the folder (metadata only). The attachments subfolder
// is filtered out in JS so the Drive query itself stays simple and reliable.
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
  return files.filter((f) => f.mimeType !== FOLDER_MIME);
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
  return (data.files || []).filter((f) => f.mimeType !== FOLDER_MIME);
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

// Upload a binary attachment (File/Blob) into the attachments subfolder.
// Returns { id, name, mimeType, size }.
export async function uploadAttachment(file) {
  const folderId = await ensureAttachmentsFolder();
  const boundary = 'xn-' + Math.random().toString(36).slice(2);
  const type = file.type || 'application/octet-stream';
  const metadata = { name: file.name || 'attachment', parents: [folderId] };

  // Build a multipart/related body as a Blob so binary data is sent intact.
  const pre =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    `Content-Type: ${type}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = new Blob([pre, file, post]);

  const res = await authFetch(
    `${UPLOAD}?uploadType=multipart&fields=id,name,mimeType,size`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  return res.json();
}

// Download an attachment's bytes as a Blob (for previews / opening).
export async function getBlob(fileId) {
  const res = await authFetch(`${FILES}/${fileId}?alt=media`);
  return res.blob();
}
