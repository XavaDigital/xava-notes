// Local cache + server sync.
//
// - Notes are cached in IndexedDB for instant load and offline use.
// - A save goes straight to the server. Until the server confirms it the note
//   stays 'dirty' locally and syncPending() retries it, so a note captured
//   with no signal is sent when the connection comes back. Never lose a note.
// - note.version is the server's version of the copy the note was edited
//   from (0 = never confirmed). The server answers 409 when another device has
//   saved a newer one, and the caller's onConflict decides what happens.
// - Pulls fetch only what changed since the last pull (the server's `rev`).

import * as api from './api.js';
import { newId } from './note.js';

const DB_NAME = 'xava-notes';
const DB_VERSION = 2;

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
      // Small key/value store: the last pulled rev.
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
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

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
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

async function getMeta(k, fallback) {
  const row = await idbGet('meta', k);
  return row ? row.v : fallback;
}

function setMeta(k, v) {
  return idbPut('meta', { k, v });
}

// --- Rows -------------------------------------------------------------------
//
// A cached row is { id, note, dirty, mine }. `dirty` means the server has not
// confirmed this content yet. `mine` is the last version this device itself
// wrote, so a save from a stale copy of a note can tell "the newer version on
// the server is my own earlier save" (no conflict) from "another device saved".

function putRow(note, dirty, mine) {
  const { unsynced, rev, purged, ...clean } = note;
  return idbPut('notes', { id: note.id, note: clean, dirty, mine: mine || 0 });
}

// One write at a time per note, so an autosave, a background retry and a pull
// can never interleave on the same note.
const locks = new Map();
function withLock(id, fn) {
  const run = (locks.get(id) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}

// --- Public API ---------------------------------------------------------

export async function cachedNotes() {
  const rows = await idbAll('notes');
  return rows
    .map((r) => { r.note.unsynced = !!r.dirty || !r.note.version; return r.note; })
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

// Send a note and settle any conflict. Writes the outcome to the cache and
// returns { status: 'saved' | 'cancelled', note }. Throws when the server
// can't be reached (or refuses), leaving the note dirty.
async function push(note, onConflict) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await api.putNote(note, note.version);
    if (res.ok) {
      note.version = res.version;
      await putRow(note, false, res.version);
      return { status: 'saved', note };
    }

    const theirs = res.note;
    const choice = await onConflict();
    if (choice === 'cancel') {
      await keepServerCopy(theirs);
      return { status: 'cancelled', note };
    }
    if (choice === 'keepBoth') {
      // Theirs keeps the id; ours becomes a new note.
      await keepServerCopy(theirs);
      note.id = newId();
      note.version = 0;
      await putRow(note, true, 0);
    } else {
      // 'overwrite': save on top of the version the server has.
      note.version = theirs.version;
      await putRow(note, true, 0);
    }
  }
  throw new Error('The note kept changing on another device');
}

// Cache the server's copy of a note (a 409's body, or a pulled note).
async function keepServerCopy(theirs, mine = 0) {
  if (theirs.purged) return idbDelete('notes', theirs.id);
  return putRow(theirs, false, mine);
}

// Save a note (create or update). The cache is updated first, marked dirty;
// on success the dirty flag is cleared, and on ANY failure (offline or
// otherwise) the note simply stays dirty and is retried later by syncPending().
//
// `onConflict` is called when another device saved the note since this copy
// was loaded; it should resolve to 'overwrite' | 'keepBoth' | 'cancel'. With
// no handler the save overwrites, as quick list actions always have. Returns
// { status: 'saved' | 'pending' | 'cancelled', note }.
export async function saveNote(note, { onConflict } = {}) {
  return withLock(note.id, async () => {
    const row = await idbGet('notes', note.id);
    // A copy loaded before this device's own last save carries an older
    // version; base it on that save rather than conflicting with ourselves.
    if (row && row.mine && row.note.version === row.mine && row.mine > (note.version || 0)) {
      note.version = row.mine;
    }
    note.version = note.version || 0;
    note.updated = new Date().toISOString();
    await putRow(note, true, row?.mine);

    try {
      return await push(note, onConflict || (() => 'overwrite'));
    } catch (err) {
      // Stays dirty; syncPending() will retry it later. Never lose the note.
      console.warn('Xava Notes: save deferred, will retry —', err?.message || err);
      return { status: 'pending', note };
    }
  });
}

// How many cached notes are not yet confirmed by the server.
export async function countPending() {
  const rows = await idbAll('notes');
  return rows.filter((r) => r.dirty || !r.note.version).length;
}

// Retry every note the server hasn't confirmed. Returns { synced, pending }.
// Nobody is there to answer a conflict prompt, so a conflict keeps both: the
// other device's version keeps the note, this one becomes a new note.
export async function syncPending() {
  if (!navigator.onLine) return { synced: 0, pending: await countPending() };
  const rows = await idbAll('notes');
  let synced = 0;
  for (const r of rows) {
    // The same condition as countPending/unsynced, so the two stay in lockstep
    // — else a note shows "Unsynced" forever while this loop quietly skips it.
    if (!r.dirty && r.note.version) continue;
    try {
      const res = await withLock(r.id, async () => {
        const cur = await idbGet('notes', r.id); // re-read: it may have moved on
        if (!cur || (!cur.dirty && cur.note.version)) return null;
        return push(cur.note, () => 'keepBoth');
      });
      if (res) synced++;
    } catch (err) {
      // Signed out or offline: the rest would fail the same way.
      if (err instanceof api.AuthError || isOffline(err)) break;
    }
  }
  return { synced, pending: await countPending() };
}

// Soft delete: flag the note as deleted (Trash) but keep it on the server.
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

// Permanently remove a note and its attachments, from the server and the cache.
export async function purgeNote(note) {
  return withLock(note.id, async () => {
    const row = await idbGet('notes', note.id);
    await idbDelete('notes', note.id);
    if (!note.version && !row?.note.version) {
      // Never reached the server, but its attachments may have.
      for (const att of note.attachments || []) {
        if (att.id) api.deleteAttachment(att.id).catch(() => {});
      }
      return;
    }
    try {
      await api.deleteNote(note.id); // the server removes the attachments too
    } catch (err) {
      if (isOffline(err) || err instanceof api.AuthError) {
        await idbPut('queue', { kind: 'delete', id: note.id });
      } else {
        throw err;
      }
    }
  });
}

// Permanently remove every soft-deleted note.
export async function emptyTrash() {
  const rows = await idbAll('notes');
  for (const r of rows) {
    if (r.note.deleted) await purgeNote(r.note);
  }
}

// Send what's waiting, then pull everything changed since the last pull.
export async function refreshFromServer() {
  await syncPending();
  await flushQueue();

  let after = await getMeta('rev', 0);
  let res = await api.pullNotes(after);
  if (res.rev < after) {
    // The server's counter went backwards (restored from a backup): start over.
    after = 0;
    res = await api.pullNotes(0);
  }

  for (const n of res.notes) {
    await withLock(n.id, async () => {
      const local = await idbGet('notes', n.id);
      // Local edits not yet on the server are never overwritten here. Their
      // next push meets a 409 carrying this version, and the conflict is
      // settled there.
      if (local && local.dirty) return;
      if (local && !n.purged && local.note.version === n.version) return;
      await keepServerCopy(n, local?.mine);
    });
  }

  if (after === 0) {
    // A full pull is the complete list: drop confirmed notes it doesn't have
    // (emptied from Trash while this device's markers were lost). Unconfirmed
    // local notes always stay.
    const seen = new Set(res.notes.map((n) => n.id));
    for (const r of await idbAll('notes')) {
      if (seen.has(r.id)) continue;
      await withLock(r.id, async () => {
        const cur = await idbGet('notes', r.id);
        if (cur && !cur.dirty && cur.note.version) await idbDelete('notes', r.id);
      });
    }
  }

  await setMeta('rev', res.rev);
  return cachedNotes();
}

async function flushQueue() {
  // Deferred permanent deletes (purges that failed while offline). Saves are
  // handled separately via the per-note dirty flag (syncPending).
  const queue = await idbAll('queue');
  for (const item of queue) {
    try {
      if (item.kind === 'delete' && item.id) {
        await api.deleteNote(item.id);
      }
      await idbDelete('queue', item.qid);
    } catch (err) {
      if (isOffline(err) || err instanceof api.AuthError) return; // retry later
      // Drop poison items so the queue can make progress.
      await idbDelete('queue', item.qid);
    }
  }
}

function isOffline(err) {
  return !navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(err?.message || '');
}
