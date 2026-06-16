// Local cache + Drive sync layer.
//
// - Notes are cached in IndexedDB for instant load and offline reading.
// - Writes go straight to Drive when online; when offline they are queued and
//   flushed on the next refresh.

import * as drive from './drive.js';
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
    .map((r) => r.note)
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

function appPropsFor(note) {
  const p = { type: note.type, title: (note.title || '').slice(0, 120) };
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

// Save a note (create or update). Optimistically updates the cache; writes to
// Drive, queueing if offline.
//
// `onConflict` is called when the file changed on Drive since we loaded it; it
// should resolve to 'overwrite' | 'keepBoth' | 'cancel'. Returns
// { status: 'saved' | 'cancelled', note }.
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
  const content = noteToMarkdown(note);
  const name = noteFilename(note);

  // Optimistic local cache update (keep the known base time until confirmed).
  await idbPut('notes', { id: note.id, note, modifiedTime: base || note.updated });

  try {
    let meta;
    if (note.fileId) {
      meta = await drive.updateFile(note.fileId, name, content, appPropsFor(note));
    } else {
      meta = await drive.createFile(name, content, appPropsFor(note));
      note.fileId = meta.id;
    }
    await idbPut('notes', {
      id: note.id,
      note,
      modifiedTime: meta.modifiedTime || note.updated,
    });
  } catch (err) {
    if (isOffline(err)) {
      await idbPut('queue', { kind: 'save', noteId: note.id });
    } else {
      throw err;
    }
  }
  return { status: 'saved', note };
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
    await drive.trashFile(note.fileId);
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
    if (existing && existing.modifiedTime === f.modifiedTime) {
      continue; // unchanged
    }
    try {
      const text = await drive.getContent(f.id);
      const note = noteFromMarkdown(text, f.id);
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
  const queue = await idbAll('queue');
  for (const item of queue) {
    try {
      if (item.kind === 'save') {
        const row = (await idbAll('notes')).find((r) => r.id === item.noteId);
        if (row) await saveNote(row.note);
      } else if (item.kind === 'delete') {
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
