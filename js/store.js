// Local cache + Drive sync layer.
//
// - Notes are cached in IndexedDB for instant load and offline reading.
// - Writes go through the Worker outbox when connected (durable: a per-minute
//   cron completes anything that doesn't land), else straight to Drive. Failed
//   writes stay 'dirty' locally and are retried by syncPending().

import * as drive from './drive.js';
import { relayReady, apiFetch } from './auth.js';
import {
  noteToMarkdown,
  noteFromMarkdown,
  noteFilename,
  newId,
} from './note.js';

const DB_NAME = 'xava-notes';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'qid', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const result = fn(os);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function idbAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDb();
  return tx(db, store, 'readwrite', (os) => os.put(value));
}

async function idbDelete(store, key) {
  const db = await openDb();
  return tx(db, store, 'readwrite', (os) => os.delete(key));
}

// --- Public API ---------------------------------------------------------

export async function cachedNotes() {
  const rows = await idbAll('notes');
  return rows
    .map((r) => { r.note.unsynced = !!r.dirty || !r.note.fileId; return r.note; })
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

function appPropsFor(note) {
  // The title is NOT stored here: Drive caps each appProperty at 124 bytes
  // (key + value), which long titles exceed. The full title lives in the file
  // content (frontmatter + H1) and the filename carries a truncated copy, so a
  // metadata copy would be redundant — and nothing reads it back anyway.
  // noteId lets the server-side outbox reconcile a file back to this note (and
  // stay idempotent on retries) without reading the file's contents.
  const p = { type: note.type, noteId: note.id };
  if (note.type === 'task') {
    p.done = note.done ? '1' : '0';
    if (note.due) p.due = note.due;
  }
  return p;
}

async function baseModifiedTime(fileId) {
  if (!fileId) return null;
  const rows = await idbAll('notes');
  const row = rows.find((r) => r.note.fileId === fileId);
  return row ? row.modifiedTime : null;
}

// Write a note's current content to Drive (create or update). Sets note.fileId
// on first create. Throws on failure.
async function writeNoteToDrive(note) {
  const content = noteToMarkdown(note);
  const name = noteFilename(note);
  const appProps = appPropsFor(note);

  // When connected to the backend, hand the write to the Worker's outbox: it
  // writes to Drive with its own refresh token and a per-minute cron retries
  // anything that doesn't land, so a save survives the app closing. Direct Drive
  // is the fallback for serverless mode (no backend / not connected yet).
  if (relayReady()) {
    const meta = await relayPut(note, name, content, appProps);
    if (meta.fileId) note.fileId = meta.fileId;
    return { id: note.fileId, modifiedTime: meta.modifiedTime };
  }

  if (note.fileId) {
    return drive.updateFile(note.fileId, name, content, appProps);
  }
  const meta = await drive.createFile(name, content, appProps);
  note.fileId = meta.id;
  return meta;
}

// POST a create/update to the Worker outbox. Only a synchronous 200 (the Worker
// completed the Drive write) counts as success; a 202 means it was queued but
// not yet confirmed, so we throw to keep the note dirty and let syncPending()
// retry — the server stays idempotent via the stamped noteId.
async function relayPut(note, name, content, appProperties) {
  const res = await apiFetch('/outbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'put', noteId: note.id, fileId: note.fileId || null, name, content, appProperties }),
  });
  if (res.status !== 200) {
    throw new Error(`Relay save not confirmed (${res.status})`);
  }
  const data = await res.json(); // { id, status, fileId, modifiedTime }
  return { fileId: data.fileId || note.fileId || null, modifiedTime: data.modifiedTime || null };
}

// Trash a Drive file via the Worker outbox (deletes are idempotent, so a queued
// 202 is fine — the cron will complete it).
async function relayDelete(fileId) {
  const res = await apiFetch('/outbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'delete', fileId }),
  });
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`Relay delete failed (${res.status})`);
  }
}

// Save a note (create or update). Optimistically updates the cache marked
// "dirty"; on success the dirty flag is cleared, and on ANY failure (offline or
// otherwise) the note simply stays dirty and is retried later by syncPending().
//
// `onConflict` is called when the file changed on Drive since we loaded it; it
// should resolve to 'overwrite' | 'keepBoth' | 'cancel'. Returns
// { status: 'saved' | 'pending' | 'cancelled', note }.
export async function saveNote(note, { onConflict } = {}) {
  const base = await baseModifiedTime(note.fileId);

  // Conflict detection (only for existing files, when online).
  if (note.fileId && navigator.onLine) {
    try {
      const meta = await drive.getMeta(note.fileId);
      if (base && meta.modifiedTime && meta.modifiedTime !== base) {
        const choice = onConflict ? await onConflict() : 'overwrite';
        if (choice === 'cancel') return { status: 'cancelled', note };
        if (choice === 'keepBoth') { note.fileId = null; note.id = newId(); }
        // 'overwrite' -> fall through
      }
    } catch { /* metadata check failed; proceed with save */ }
  }

  note.updated = new Date().toISOString();

  // Optimistic local cache update, marked dirty until Drive confirms.
  await idbPut('notes', { id: note.id, note, modifiedTime: base || note.updated, dirty: true });

  try {
    const meta = await writeNoteToDrive(note);
    await idbPut('notes', { id: note.id, note, modifiedTime: meta.modifiedTime || note.updated, dirty: false });
    return { status: 'saved', note };
  } catch (err) {
    // Stays dirty; syncPending() will retry it later. Never lose the note.
    console.warn('Xava Notes: save deferred, will retry —', err?.message || err);
    return { status: 'pending', note };
  }
}

// How many cached notes are not yet confirmed on Drive.
export async function countPending() {
  const rows = await idbAll('notes');
  return rows.filter((r) => r.dirty || !r.note.fileId).length;
}

// Retry writing every dirty note to Drive. Returns { synced, pending }.
export async function syncPending() {
  if (!navigator.onLine) return { synced: 0, pending: await countPending() };
  const rows = await idbAll('notes');
  let synced = 0;
  for (const r of rows) {
    // Retry anything not confirmed on Drive: dirty edits AND notes that never
    // got a fileId (e.g. a create whose response was lost). The pending/unsynced
    // count uses this same condition, so the two must stay in lockstep — else a
    // note shows "Unsynced" forever while the retry loop quietly skips it.
    if (!r.dirty && r.note.fileId) continue;
    try {
      const meta = await writeNoteToDrive(r.note);
      await idbPut('notes', { id: r.note.id, note: r.note, modifiedTime: meta.modifiedTime || r.note.updated, dirty: false });
      synced++;
    } catch { /* still failing; keep dirty for the next attempt */ }
  }
  return { synced, pending: await countPending() };
}

// Soft delete: flag the note as deleted but keep the file on Drive.
export async function softDeleteNote(note) {
  note.deleted = true;
  note.deletedAt = new Date().toISOString();
  return saveNote(note);
}

export async function restoreNote(note) {
  note.deleted = false;
  note.deletedAt = '';
  return saveNote(note);
}

// Permanently remove a note (and its attachments) from Drive and the cache.
export async function purgeNote(note) {
  await idbDelete('notes', note.id);
  for (const att of note.attachments || []) {
    if (att.id) drive.trashFile(att.id).catch(() => {});
  }
  if (!note.fileId) return;
  try {
    if (relayReady()) await relayDelete(note.fileId);
    else await drive.trashFile(note.fileId);
  } catch (err) {
    if (isOffline(err)) {
      await idbPut('queue', { kind: 'delete', fileId: note.fileId });
    } else {
      throw err;
    }
  }
}

// Permanently remove every soft-deleted note.
export async function emptyTrash() {
  const rows = await idbAll('notes');
  for (const r of rows) {
    if (r.note.deleted) await purgeNote(r.note);
  }
}

// Pull the latest from Drive, fetching content only for changed files.
export async function refreshFromDrive() {
  await syncPending(); // push any locally-saved-but-not-yet-on-Drive notes
  await flushQueue();

  const files = await drive.listFiles();
  const cached = await idbAll('notes');
  const byFileId = new Map(
    cached.filter((r) => r.note.fileId).map((r) => [r.note.fileId, r])
  );
  const seenFileIds = new Set();

  for (const f of files) {
    seenFileIds.add(f.id);
    const existing = byFileId.get(f.id);
    if (existing && existing.dirty) continue; // local has unsynced edits; don't clobber
    if (existing && existing.modifiedTime === f.modifiedTime) {
      continue; // unchanged
    }
    try {
      const text = await drive.getContent(f.id);
      const note = noteFromMarkdown(text, f.id, f.name);
      await idbPut('notes', { id: note.id, note, modifiedTime: f.modifiedTime });
    } catch (err) {
      // Don't let one unreadable file abort the whole sync.
      console.warn('Xava Notes: could not load file', f.name, err);
    }
  }

  // Remove cache entries whose Drive file disappeared (deleted elsewhere), but
  // keep not-yet-synced local notes (no fileId). Guard: only prune when the
  // listing actually returned something, so a transient empty/partial response
  // can never wipe a populated cache.
  if (files.length > 0) {
    for (const r of cached) {
      if (r.note.fileId && !seenFileIds.has(r.note.fileId)) {
        await idbDelete('notes', r.note.id);
      }
    }
  }

  return cachedNotes();
}

async function flushQueue() {
  // Deferred permanent deletes (purges that failed while offline). Saves are
  // handled separately via the per-note dirty flag (syncPending).
  const queue = await idbAll('queue');
  for (const item of queue) {
    try {
      if (item.kind === 'delete') {
        await drive.trashFile(item.fileId);
      }
      await idbDelete('queue', item.qid);
    } catch (err) {
      if (isOffline(err)) return; // still offline; stop and retry later
      // Drop poison items so the queue can make progress.
      await idbDelete('queue', item.qid);
    }
  }
}

function isOffline(err) {
  return !navigator.onLine || /Failed to fetch|NetworkError/i.test(err?.message || '');
}
