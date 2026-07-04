// Main UI controller.

import { getClientId, setClientId } from './config.js';
import { signIn, signOut, isSignedIn, onAuthChange, getToken, relayReady, apiFetch } from './auth.js';
import * as store from './store.js';
import * as drive from './drive.js';
import { emptyNote, notePreview } from './note.js';
import { mdToHtml, htmlToMarkdown } from './markdown.js';
import { parseFiles } from './import.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  notes: [],
  filter: 'all',
  query: '',
  tags: [], // active tag filters (from tapping cards or the tag bar) — ANDed
  inbox: true, // default view: uncategorized notes (no notebook)
  notebook: '', // active notebook path ('' with inbox=false means All notes)
  trash: false, // viewing the Trash (soft-deleted items)
  completed: false, // viewing completed tasks (newest-completed first)
  sort: localStorage.getItem('xn.sort') || 'manual', // 'manual' | 'date' | 'recent'
  current: null, // note being edited
  editing: false, // editor is in edit (vs read-only) mode
  selectMode: false, // bulk multi-select
  selected: new Set(), // selected note ids
};

let draggingNoteId = null; // id of the card being dragged onto a notebook

// Which task cards have their subtasks expanded on the list (persisted).
const expandedTasks = new Set(JSON.parse(localStorage.getItem('xn.expanded') || '[]'));
function isExpanded(id) { return expandedTasks.has(id); }
function toggleExpanded(id) {
  if (expandedTasks.has(id)) expandedTasks.delete(id); else expandedTasks.add(id);
  try { localStorage.setItem('xn.expanded', JSON.stringify([...expandedTasks])); } catch {}
}
function subtaskListHTML(note) {
  return '<ul class="card-subtasks">' + (note.subtasks || []).map((s, i) =>
    `<li class="${s.done ? 'done' : ''}"><button class="sub-check ${s.done ? 'checked' : ''}" data-i="${i}" aria-label="Toggle subtask"></button><span>${escapeHtml(s.text)}</span></li>`
  ).join('') + '</ul>';
}


// --- Notebooks ----------------------------------------------------------

const LS_NOTEBOOKS = 'xn.notebooks';

function registeredNotebooks() {
  try { return JSON.parse(localStorage.getItem(LS_NOTEBOOKS) || '[]'); }
  catch { return []; }
}
function registerNotebook(name) {
  const list = registeredNotebooks();
  if (name && !list.some((n) => n.toLowerCase() === name.toLowerCase())) {
    list.push(name);
    localStorage.setItem(LS_NOTEBOOKS, JSON.stringify(list));
  }
}

// Manual notebook order (the only ordering for notebooks): a list of paths.
const LS_NB_ORDER = 'xn.nbOrder';
function nbOrderList() {
  try { return JSON.parse(localStorage.getItem(LS_NB_ORDER) || '[]'); }
  catch { return []; }
}
function saveNbOrder(arr) {
  try { localStorage.setItem(LS_NB_ORDER, JSON.stringify(arr)); } catch {}
}
function nbRank(path, order) {
  const i = order.indexOf(path);
  return i === -1 ? 1e9 : i;
}

// Move a notebook (with its whole subtree) to just before targetPath in the
// manual order (targetPath null = end).
function dropNotebookBefore(dragged, targetPath) {
  if (!dragged || dragged === targetPath) return;
  let order = nbOrderList();
  if (!order.includes(dragged)) order.push(dragged);
  const sub = order.filter((p) => p === dragged || p.startsWith(dragged + '/'));
  order = order.filter((p) => !sub.includes(p));
  const idx = targetPath ? order.indexOf(targetPath) : -1;
  if (idx === -1) order = order.concat(sub);
  else order.splice(idx, 0, ...sub);
  saveNbOrder(order);
  render();
}

// All notebooks (from notes + any registered empty ones), in manual order.
function allNotebooks() {
  const counts = new Map();
  for (const n of state.notes) {
    if (n.deleted) continue;
    const nb = n.notebook;
    if (!nb) continue;
    const e = counts.get(nb.toLowerCase()) || { name: nb, count: 0 };
    e.count++;
    counts.set(nb.toLowerCase(), e);
  }
  for (const nb of registeredNotebooks()) {
    if (!counts.has(nb.toLowerCase())) counts.set(nb.toLowerCase(), { name: nb, count: 0 });
  }
  const list = [...counts.values()];
  // Ensure every notebook has a slot in the manual order (new ones appended in
  // discovery order), then sort by it.
  const order = nbOrderList();
  let changed = false;
  for (const b of list) if (!order.includes(b.name)) { order.push(b.name); changed = true; }
  if (changed) saveNbOrder(order);
  return list.sort((a, b) => nbRank(a.name, order) - nbRank(b.name, order) || a.name.localeCompare(b.name));
}

// --- Boot ---------------------------------------------------------------

// Restore the last-viewed scope (Inbox / All / notebook / Trash) across reloads.
function restoreView() {
  try {
    const v = JSON.parse(localStorage.getItem('xn.view') || 'null');
    if (v) { state.inbox = !!v.inbox; state.notebook = v.notebook || ''; state.trash = !!v.trash; state.completed = !!v.completed; }
  } catch {}
}

async function boot() {
  registerServiceWorker();
  restoreView();

  // Show cached notes ASAP — before anything that could throw — so they always
  // appear even if later initialization hits a problem.
  try {
    state.notes = await store.cachedNotes();
  } catch (e) {
    console.warn('Xava Notes: cache read failed', e);
    state.notes = [];
  }
  render();

  try {
    wireEvents();
    reflectAuth();
  } catch (e) {
    console.warn('Xava Notes: init failed', e);
  }

  // If launched via the Android share sheet, open the pre-filled note straight
  // away — don't make the user wait behind a full Drive sync. It manages its own
  // token (needed only when there are file attachments to upload), so kick it
  // off before the blocking refresh below and just await it at the end.
  const sharePending = handleSharedContent().catch((e) =>
    console.warn('Xava Notes: share handling failed', e));

  // If we already have a client id, try a silent connect + refresh.
  if (getClientId()) {
    try {
      await getToken({ interactive: false });
    } catch {
      /* will prompt via Settings */
    }
  }
  if (isSignedIn()) {
    await refresh();
  } else if (!getClientId()) {
    openSettings();
  }

  await sharePending;
}

// Web Share Target: the service worker stashed the shared title/text/url and any
// files in the 'xn-shared' cache. On a cold start the OS navigates us to
// ?shared=1; but when the app is *already open* the OS often just focuses the
// existing window without navigating, so we also get poked via a postMessage
// from the SW (see registerServiceWorker). Either way we just look for stashed
// content in the cache and consume it — guarded so the two triggers can't
// double-process the same share.
let handlingShare = false;
async function handleSharedContent() {
  // Clear the boot flag from the URL so a refresh can't re-trigger.
  if (new URLSearchParams(location.search).has('shared')) {
    history.replaceState({}, '', location.pathname);
  }
  if (handlingShare) return;

  let meta = null;
  const files = [];
  let cache;
  try {
    cache = await caches.open('xn-shared');
    const metaRes = await cache.match('./shared-meta');
    if (!metaRes) return; // nothing was shared
    meta = await metaRes.json();
  } catch (e) { console.warn('Xava Notes: share read failed', e); return; }

  handlingShare = true;
  try {
    for (const f of meta.files || []) {
      const res = await cache.match(f.key);
      if (res) files.push(new File([await res.blob()], f.name, { type: f.type }));
      await cache.delete(f.key);
    }
    await cache.delete('./shared-meta');
  } catch (e) { console.warn('Xava Notes: share read failed', e); }

  const n = emptyNote('note');
  n.title = meta.title || '';
  let body = meta.text || '';
  if (meta.url && meta.url !== meta.text) body += (body ? '\n\n' : '') + meta.url;
  n.body = body;
  if (state.notebook) n.notebook = state.notebook;

  if (files.length) {
    if (!isSignedIn()) { try { await getToken({ interactive: true }); } catch {} }
    for (const file of files) {
      setStatus(`Attaching ${file.name}…`, true, true);
      try {
        const m = await drive.uploadAttachment(file);
        n.attachments.push({
          id: m.id, name: m.name || file.name,
          mime: m.mimeType || file.type || '', size: Number(m.size) || file.size || 0,
        });
      } catch (e) {
        setStatus(`Couldn't attach ${file.name}: ${e.message}`, true);
      }
    }
    setStatus('');
  }
  openEditor(n, { edit: true });
  handlingShare = false;
}

onAuthChange(async (signed) => {
  reflectAuth();
  if (signed) await refresh();
});

// --- Sync ---------------------------------------------------------------

let syncing = false;
async function refresh() {
  if (!isSignedIn()) return;
  if (syncing) return; // already running — don't stack syncs / restart the spin
  syncing = true;
  const syncBtn = $('#syncBtn');
  if (syncBtn) syncBtn.classList.add('syncing');
  // Sticky while it runs — the spinner, not a timed popup, signals "in progress".
  setStatus('Syncing…', true, true);
  try {
    state.notes = await store.refreshFromDrive();
    render();
    setStatus('Synced');
  } catch (err) {
    if (!navigator.onLine) {
      setStatus('Offline — showing cached notes', true);
    } else if (/^AUTH:|\b401\b|invalid authentication/i.test(err.message)) {
      reflectAuth();
      setStatus('Session expired — reconnect Google Drive', true);
      openSettings();
    } else {
      setStatus(`Sync error: ${err.message}`, true);
    }
  } finally {
    syncing = false;
    if (syncBtn) syncBtn.classList.remove('syncing');
  }
}

// Lightweight retry of just the unsynced notes (no full Drive re-list). Used on
// app focus / coming online so notes that failed to save reach Drive.
async function quickSync() {
  if (!isSignedIn() || !navigator.onLine) return;
  if (!state.notes.some((n) => n.unsynced)) return;
  const res = await store.syncPending();
  state.notes = await store.cachedNotes();
  render();
  if (res.synced) setStatus(`Synced ${res.synced} item${res.synced === 1 ? '' : 's'} to Drive`);
}

// --- Rendering ----------------------------------------------------------

// Mark a task done/undone, stamping the completion time (so the Completed view
// can order by it) and clearing it when re-opened.
function setDone(note, done) {
  note.done = done;
  note.completedAt = done ? new Date().toISOString() : '';
}

function matchesFilter(note) {
  switch (state.filter) {
    case 'task': return note.type === 'task';
    case 'note': return note.type === 'note';
    case 'open': return note.type === 'task' && !note.done;
    case 'overdue': return isOverdue(note);
    case 'today': return note.due && isToday(note.due);
    default: return true;
  }
}

function noteHasTag(note, tag) {
  const k = tag.toLowerCase();
  return (note.tags || []).some((t) => t.toLowerCase() === k);
}

// Split the search box into #tag tokens and free-text words.
function parseSearch(q) {
  const tags = [];
  const words = [];
  for (const tok of (q || '').split(/\s+/)) {
    if (!tok) continue;
    if (tok.startsWith('#') && tok.length > 1) tags.push(tok.slice(1));
    else words.push(tok);
  }
  return { tags, text: words.join(' ') };
}

// All tags currently required: the tapped tags plus any #tags in the search box.
function activeTagFilters() {
  const { tags } = parseSearch(state.query);
  return [...state.tags, ...tags];
}

function matchesText(note) {
  const { text } = parseSearch(state.query);
  if (!text) return true;
  const hay = [
    note.title,
    note.body,
    (note.tags || []).join(' '),
    (note.subtasks || []).map((s) => s.text).join(' '),
  ].join(' ').toLowerCase();
  return hay.includes(text.toLowerCase());
}

function inNotebook(note, sel) {
  const nb = (note.notebook || '').toLowerCase();
  const s = sel.toLowerCase();
  return nb === s || nb.startsWith(s + '/'); // a notebook includes its sub-notebooks
}

function passesFilters(note) {
  // Trash view shows only soft-deleted items (search still works); the normal
  // views never show deleted items.
  if (state.trash) return !!note.deleted && matchesText(note);
  if (note.deleted) return false;

  // Completed view: every checked-off task (across all notebooks), filtered by
  // the active tags/search. Sorting by completion time is handled in sortItems.
  if (state.completed) {
    if (!(note.type === 'task' && note.done)) return false;
    for (const t of activeTagFilters()) if (!noteHasTag(note, t)) return false;
    return matchesText(note);
  }
  // Everywhere else, completed tasks are hidden.
  if (note.type === 'task' && note.done) return false;

  // Scope: Inbox = uncategorized only; a notebook = that notebook (+ sub); All = no constraint.
  if (state.inbox) { if (note.notebook) return false; }
  else if (state.notebook && !inNotebook(note, state.notebook)) return false;

  if (!matchesFilter(note)) return false;
  for (const t of activeTagFilters()) {
    if (!noteHasTag(note, t)) return false;
  }
  return matchesText(note);
}

// Sort comparators.
function byDueDate(a, b) {
  const da = a.due || '', db = b.due || '';
  if (da && db) return da.localeCompare(db); // soonest (and most overdue) first
  if (da) return -1; // dated items before undated
  if (db) return 1;
  return (b.updated || '').localeCompare(a.updated || ''); // undated: most recent
}
function byRecent(a, b) {
  return (b.updated || '').localeCompare(a.updated || '');
}

// Manual order: explicit `order` if set, otherwise fall back to recency so
// never-reordered notes still have a stable position (newest first).
function effectiveOrder(note) {
  if (note.order) return note.order;
  return -(Date.parse(note.updated || note.created) || 0);
}
function byManual(a, b) {
  return effectiveOrder(a) - effectiveOrder(b) || (b.updated || '').localeCompare(a.updated || '');
}

// Completion time, falling back to last-updated for tasks done before we began
// recording completedAt.
function completedTime(note) {
  return Date.parse(note.completedAt || note.updated || note.created || '') || 0;
}
function byCompleted(a, b) {
  return completedTime(b) - completedTime(a); // most recently completed first
}

function sortItems(items) {
  if (state.completed) return [...items].sort(byCompleted);
  const cmp = state.sort === 'date' ? byDueDate : state.sort === 'manual' ? byManual : byRecent;
  return [...items].sort(cmp);
}

function sectionHeader(label, extraClass = '') {
  const h = document.createElement('div');
  h.className = `section-head ${extraClass}`.trim();
  h.textContent = label;
  return h;
}

function render() {
  // Remember the current view so a refresh stays put.
  try { localStorage.setItem('xn.view', JSON.stringify({ inbox: state.inbox, notebook: state.notebook, trash: state.trash, completed: state.completed })); } catch {}
  try { renderTagBar(); } catch (e) { console.warn('Xava Notes: tag bar render failed', e); }
  try { renderNotebookBar(); } catch (e) { console.warn('Xava Notes: notebook bar failed', e); }
  try { renderNotebooksUI(); } catch (e) { console.warn('Xava Notes: notebooks UI failed', e); }
  try { renderSelectionBar(); } catch (e) { console.warn('Xava Notes: selection bar failed', e); }
  const list = $('#list');
  if (!list) return;

  const sortBtn = $('#sortBtn');
  if (sortBtn) {
    const labels = { date: 'Due date', recent: 'Recent', manual: 'Manual' };
    sortBtn.classList.toggle('active', state.sort === 'manual');
    sortBtn.title = `Sort: ${labels[state.sort]} (tap to change)`;
    const lbl = $('#sortLabel');
    if (lbl) lbl.textContent = labels[state.sort];
  }
  list.classList.toggle('manual', state.sort === 'manual' && !state.trash && !state.completed);
  const quickBar = $('#quickAddBar');
  if (quickBar) quickBar.hidden = state.trash || state.completed;

  const pending = state.notes.filter((n) => n.unsynced).length;
  const syncBtn = $('#syncBtn');
  if (syncBtn) {
    syncBtn.classList.toggle('pending', pending > 0);
    syncBtn.title = pending > 0 ? `${pending} not synced — tap to sync` : 'Sync now';
  }
  reflectConnection();

  const items = sortItems(state.notes.filter(passesFilters));
  const filtering = state.query || state.tags.length || state.filter !== 'all';

  if (items.length === 0) {
    let msg, hint = '';
    if (state.trash) msg = 'Trash is empty.';
    else if (filtering) msg = 'No matches.';
    else if (state.completed) { msg = 'No completed tasks yet.'; hint = 'Tasks you check off appear here, newest first.'; }
    else if (state.inbox) { msg = 'Inbox is empty.'; hint = 'New notes land here until you file them in a notebook.'; }
    else if (state.notebook) msg = 'This notebook is empty.';
    else { msg = 'No notes yet.'; hint = 'Tap + to capture your first note.'; }
    list.innerHTML = `<div class="empty"><p>${msg}</p><p class="muted">${hint}</p></div>`;
    return;
  }

  list.innerHTML = '';

  if (state.trash) {
    const head = document.createElement('div');
    head.className = 'trash-head';
    head.innerHTML =
      '<span class="muted small">Items stay on Drive until you empty the trash.</span>' +
      '<button id="emptyTrashBtn" class="danger-btn">Empty Trash</button>';
    list.appendChild(head);
    head.querySelector('#emptyTrashBtn').addEventListener('click', emptyTrashFlow);
    items.forEach((n) => list.appendChild(renderCard(n)));
    return;
  }

  // In the default (by-date) view, float overdue items into a labelled section
  // at the top so anything past due is impossible to miss.
  const grouped = state.sort === 'date' && state.filter !== 'overdue';
  const overdue = grouped ? items.filter(isOverdue) : [];
  const rest = grouped ? items.filter((n) => !isOverdue(n)) : items;

  if (overdue.length) {
    list.appendChild(sectionHeader(`Overdue · ${overdue.length}`, 'overdue'));
    overdue.forEach((n) => list.appendChild(renderCard(n)));
    if (rest.length) list.appendChild(sectionHeader('Everything else'));
  }
  rest.forEach((n) => list.appendChild(renderCard(n)));
}

function isTagActive(tag) {
  const k = tag.toLowerCase();
  return state.tags.some((t) => t.toLowerCase() === k);
}

// Scrollable bar of all tags (most-used first); active ones highlighted.
function renderTagBar() {
  const bar = $('#tagBar');
  if (!bar) return;
  const tags = allTags();
  if (!tags.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;

  let html = '';
  if (state.tags.length) {
    html += '<button class="tagbar-chip clear" data-clear="1">&times; Clear</button>';
  }
  for (const t of tags) {
    html += `<button class="tagbar-chip ${isTagActive(t) ? 'active' : ''}" data-tag="${escapeAttr(t)}">#${escapeHtml(t)}</button>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.tagbar-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.clear) { state.tags = []; render(); }
      else toggleTagFilter(btn.dataset.tag);
    });
  });
}

// Toggle a tag in/out of the active filter set.
function toggleTagFilter(tag) {
  const k = tag.toLowerCase();
  const i = state.tags.findIndex((t) => t.toLowerCase() === k);
  if (i >= 0) state.tags.splice(i, 1);
  else state.tags.push(tag);
  render();
}

function renderCard(note) {
  const card = document.createElement('article');
  card.className = 'card'
    + (note.type === 'task' && note.done ? ' done' : '')
    + (isOverdue(note) ? ' overdue' : '');
  card.dataset.id = note.id;

  const isTask = note.type === 'task';
  const subDone = (note.subtasks || []).filter((s) => s.done).length;
  const subTotal = (note.subtasks || []).length;

  // Swipe actions differ in Trash (Restore / Delete forever) vs normal views
  // (Delete / Edit). Left = right-swipe reveal, right = left-swipe reveal.
  const actions = state.trash
    ? `<div class="card-actions card-actions-left"><button class="card-purge" aria-label="Delete forever"><span>&#128465;</span>Delete</button></div>
       <div class="card-actions card-actions-right"><button class="card-restore" aria-label="Restore"><span>&#8617;</span>Restore</button></div>`
    : `<div class="card-actions card-actions-left"><button class="card-del" aria-label="Delete note"><span>&#128465;</span>Delete</button></div>
       <div class="card-actions card-actions-right"><button class="card-edit" aria-label="Edit note"><span>&#9998;</span>Edit</button></div>`;

  card.innerHTML = `
    ${actions}
    <div class="card-front">
      <div class="card-main">
        <span class="drag-handle" aria-label="Reorder" title="Drag to reorder">&#8942;&#8942;</span>
        ${isTask ? `<button class="check ${note.done ? 'checked' : ''}" aria-label="Toggle done"></button>` : '<span class="dot"></span>'}
        <div class="card-text">
          <div class="card-title">${escapeHtml(note.title || notePreview(note) || 'Untitled')}</div>
          ${note.title && note.body ? `<div class="card-preview">${escapeHtml(notePreview(note))}</div>` : ''}
          <div class="card-meta">
            ${note.unsynced ? '<span class="badge unsynced" title="Saved on this device — not yet on Drive">● Unsynced</span>' : ''}
            ${note.notebook ? `<button class="nb-chip" data-nb="${escapeAttr(note.notebook)}">&#128214; ${escapeHtml(note.notebook)}</button>` : ''}
            ${note.due ? `<span class="badge ${isOverdue(note) ? 'overdue' : ''}">${formatDue(note.due)}</span>` : ''}
            ${subTotal ? `<button class="badge subtasks-toggle">${isExpanded(note.id) ? '&#9662;' : '&#9656;'} ${subDone}/${subTotal}</button>` : ''}
            ${(note.attachments || []).length ? `<span class="badge">📎 ${note.attachments.length}</span>` : ''}
            ${(note.tags || []).map((t) => `<button class="tag ${isTagActive(t) ? 'active' : ''}" data-tag="${escapeAttr(t)}">#${escapeHtml(t)}</button>`).join('')}
          </div>
        </div>
      </div>
      ${subTotal && isExpanded(note.id) ? subtaskListHTML(note) : ''}
    </div>`;

  // Multi-select mode: the whole card toggles selection; skip normal wiring.
  if (state.selectMode) {
    card.classList.add('selectable');
    const on = state.selected.has(note.id);
    card.classList.toggle('selected', on);
    card.querySelector('.card-main').insertAdjacentHTML(
      'afterbegin', `<span class="sel-box ${on ? 'on' : ''}"></span>`
    );
    card.addEventListener('click', () => toggleSelect(note.id));
    return card;
  }

  if (isTask) {
    card.querySelector('.check').addEventListener('click', async (e) => {
      e.stopPropagation();
      setDone(note, !note.done);
      render(); // a completed task leaves the main view (and vice versa)
      await store.saveNote(note);
    });
  }
  // Expand/collapse the subtask checklist inline.
  const subToggle = card.querySelector('.subtasks-toggle');
  if (subToggle) subToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleExpanded(note.id); render(); });
  card.querySelectorAll('.sub-check').forEach((cb) => {
    cb.addEventListener('click', async (e) => {
      e.stopPropagation();
      const i = Number(cb.dataset.i);
      if (!note.subtasks[i]) return;
      note.subtasks[i].done = !note.subtasks[i].done;
      render();
      await store.saveNote(note);
    });
  });
  card.querySelectorAll('.tag').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't open the editor
      toggleTagFilter(btn.dataset.tag);
    });
  });
  const nbChip = card.querySelector('.nb-chip');
  if (nbChip) nbChip.addEventListener('click', (e) => { e.stopPropagation(); selectNotebook(nbChip.dataset.nb); });

  // In manual sort, the handle (desktop) reorders; otherwise the whole card
  // drags onto a notebook (desktop) to file it there.
  if (state.sort === 'manual' && !state.trash) {
    wireReorderHandle(card, note);
  } else {
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      draggingNoteId = note.id;
      e.dataTransfer.setData('text/plain', note.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => { draggingNoteId = null; card.classList.remove('dragging'); });
  }

  if (state.trash) {
    // Restore action (swipe left) brings the item back to its notebook/Inbox.
    card.querySelector('.card-restore').addEventListener('click', async (e) => {
      e.stopPropagation();
      closeSwipes(null);
      await store.restoreNote(note);
      state.notes = await store.cachedNotes();
      render();
    });
    // Delete-forever action (swipe right) purges from Drive after confirmation.
    card.querySelector('.card-purge').addEventListener('click', async (e) => {
      e.stopPropagation();
      closeSwipes(null);
      const choice = await showDialog({
        title: note.title || notePreview(note) || 'Item',
        message: 'Permanently delete this item from Drive? This cannot be undone.',
        actions: [
          { label: 'Delete forever', value: 'yes', kind: 'danger' },
          { label: 'Cancel', value: 'no' },
        ],
      });
      if (choice !== 'yes') return;
      await store.purgeNote(note);
      state.notes = await store.cachedNotes();
      render();
    });
  } else {
    // Edit action (swipe left) opens straight in edit mode.
    card.querySelector('.card-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      closeSwipes(null);
      openEditor(note, { edit: true });
    });
    // Delete action (swipe right) soft-deletes after confirmation.
    card.querySelector('.card-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      closeSwipes(null);
      const choice = await showDialog({
        title: note.title || notePreview(note) || 'Item',
        message: 'Move this item to Trash?',
        actions: [
          { label: 'Move to Trash', value: 'yes', kind: 'danger' },
          { label: 'Cancel', value: 'no' },
        ],
      });
      if (choice !== 'yes') return;
      await store.softDeleteNote(note);
      state.notes = await store.cachedNotes();
      render();
    });
  }

  // Touch gestures: swipe (both views) + long-press reorder (internally gated to
  // non-trash manual sort, so it stays inert in Trash).
  wireCardGestures(card, note);

  card.querySelector('.card-text').addEventListener('click', () => {
    if (suppressCardClick) { suppressCardClick = false; return; }
    if (card.classList.contains('show-edit') || card.classList.contains('show-del')) {
      card.classList.remove('show-edit', 'show-del'); return;
    }
    if (state.trash) trashItemFlow(note);
    else openEditor(note);
  });
  return card;
}

const SWIPE_W = 88; // px width of a revealed action (Edit left-swipe / Delete right-swipe)
function closeSwipes(except) {
  document.querySelectorAll('.card.show-edit, .card.show-del').forEach((c) => {
    if (c !== except) c.classList.remove('show-edit', 'show-del');
  });
}

// --- Drag-to-reorder (shared by the desktop handle and mobile long-press) ----
// The card follows the finger via transform while staying put in the DOM (moving
// the captured element would drop pointer capture); a drop-indicator line shows
// where it will land, and the reorder is committed on release.
let reorder = null;
let suppressCardClick = false; // a drag/swipe just happened — don't treat as a tap

function dropIndicator() {
  let ind = document.getElementById('dropIndicator');
  if (!ind) { ind = document.createElement('div'); ind.id = 'dropIndicator'; ind.className = 'drop-indicator'; }
  return ind;
}

function beginReorder(card, note, startY) {
  closeSwipes(null);
  reorder = { card, note, list: card.parentElement, startY, target: null, moved: false };
  card.classList.add('reordering');
  if (navigator.vibrate) { try { navigator.vibrate(20); } catch {} }
}

function updateReorder(clientY) {
  if (!reorder) return;
  const { card, list, startY } = reorder;
  reorder.moved = true;
  card.style.transform = `translateY(${clientY - startY}px)`;
  if (clientY < 80) window.scrollBy(0, -12);
  else if (clientY > window.innerHeight - 80) window.scrollBy(0, 12);

  const siblings = [...list.children].filter((el) => el.classList.contains('card') && el !== card);
  let target = null;
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { target = sib; break; }
  }
  reorder.target = target;
  const ind = dropIndicator();
  if (target) list.insertBefore(ind, target);
  else list.appendChild(ind);
}

async function finishReorder() {
  if (!reorder) return;
  const r = reorder;
  reorder = null;
  r.card.classList.remove('reordering');
  r.card.style.transform = '';
  document.getElementById('dropIndicator')?.remove();
  if (!r.moved) return; // picked up but not dragged — leave as-is

  if (r.target) r.list.insertBefore(r.card, r.target);
  else r.list.appendChild(r.card);
  const cards = [...r.list.children].filter((el) => el.classList.contains('card'));
  const idx = cards.indexOf(r.card);
  const prevNote = cards[idx - 1] && state.notes.find((n) => n.id === cards[idx - 1].dataset.id);
  const nextNote = cards[idx + 1] && state.notes.find((n) => n.id === cards[idx + 1].dataset.id);
  const ka = prevNote ? effectiveOrder(prevNote) : null;
  const kb = nextNote ? effectiveOrder(nextNote) : null;
  if (ka == null && kb == null) r.note.order = effectiveOrder(r.note);
  else if (ka == null) r.note.order = kb - 1000;
  else if (kb == null) r.note.order = ka + 1000;
  else r.note.order = (ka + kb) / 2;

  await store.saveNote(r.note);
  state.notes = await store.cachedNotes();
  render();
}

// Desktop / handle: pointer drag.
function wireReorderHandle(card, note) {
  const handle = card.querySelector('.drag-handle');
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    beginReorder(card, note, e.clientY);
    const move = (ev) => updateReorder(ev.clientY);
    const up = () => { handle.removeEventListener('pointermove', move); finishReorder(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
}

// Touch gestures on the card body: long-press to reorder (manual sort), swipe to
// reveal Edit, tap to open (via the click handler). Vertical drag scrolls.
function wireCardGestures(card, note) {
  const front = card.querySelector('.card-front');
  let startX = null, startY = null, dx = 0, mode = null, lastY = 0, lpTimer = null;
  const clearLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };

  card.addEventListener('touchstart', (e) => {
    if (state.selectMode) return;
    if (e.target.closest('.drag-handle, .check, .tag, .nb-chip, .card-edit')) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; lastY = t.clientY; dx = 0; mode = null;
    suppressCardClick = false;
    if (state.sort === 'manual' && !state.trash) {
      clearLP();
      lpTimer = setTimeout(() => {
        if (mode === null) { mode = 'reorder'; beginReorder(card, note, lastY); }
      }, 450); // long-press anywhere on the card picks it up for reordering
    }
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (startX == null) return;
    const t = e.touches[0]; lastY = t.clientY;
    const mx = t.clientX - startX, my = t.clientY - startY;
    if (mode === 'reorder') { e.preventDefault(); updateReorder(t.clientY); return; }
    if (mode === null) {
      if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) { mode = 'swipe'; clearLP(); closeSwipes(card); card.classList.add('swiping'); }
      else if (Math.abs(my) > 8) { mode = 'scroll'; clearLP(); } // let the page scroll
    }
    if (mode === 'swipe') {
      e.preventDefault();
      // Left swipe reveals Edit (front moves left); right swipe reveals Delete.
      const base = card.classList.contains('show-edit') ? -SWIPE_W
        : card.classList.contains('show-del') ? SWIPE_W : 0;
      dx = Math.max(-SWIPE_W, Math.min(SWIPE_W, base + mx));
      front.style.transform = `translateX(${dx}px)`;
    }
  }, { passive: false });

  const end = () => {
    clearLP();
    if (startX == null) return;
    if (mode === 'reorder') { suppressCardClick = true; finishReorder(); }
    else if (mode === 'swipe') {
      suppressCardClick = true;
      card.classList.remove('swiping');
      front.style.transform = '';
      card.classList.remove('show-edit', 'show-del');
      if (dx < -SWIPE_W / 2) card.classList.add('show-edit');
      else if (dx > SWIPE_W / 2) card.classList.add('show-del');
    }
    startX = null; mode = null;
  };
  card.addEventListener('touchend', end);
  card.addEventListener('touchcancel', end);
}

async function trashItemFlow(note) {
  const choice = await showDialog({
    title: note.title || notePreview(note) || 'Item',
    message: 'This item is in the Trash.',
    actions: [
      { label: 'Restore', value: 'restore', kind: 'primary' },
      { label: 'Delete forever', value: 'purge', kind: 'danger' },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
  if (choice === 'restore') await store.restoreNote(note);
  else if (choice === 'purge') await store.purgeNote(note);
  else return;
  state.notes = await store.cachedNotes();
  render();
}

async function emptyTrashFlow() {
  const choice = await showDialog({
    title: 'Empty Trash?',
    message: 'Permanently delete all items in the Trash from Drive. This cannot be undone.',
    actions: [
      { label: 'Empty Trash', value: 'yes', kind: 'danger' },
      { label: 'Cancel', value: 'no' },
    ],
  });
  if (choice !== 'yes') return;
  setStatus('Emptying trash…', true);
  try {
    await store.emptyTrash();
    state.notes = await store.cachedNotes();
    render();
    setStatus('Trash emptied', true);
  } catch (e) {
    setStatus(`Could not empty trash: ${e.message}`, true);
  }
}

// --- Multi-select / bulk actions ---------------------------------------

function toggleSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selected.clear();
  const fab = $('#fab');
  if (fab) fab.hidden = on; // avoid overlap with the selection bar
  render();
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function renderSelectionBar() {
  const bar = $('#selectionBar');
  if (!bar) return;
  bar.hidden = !state.selectMode;
  const selectBtn = $('#selectBtn');
  if (selectBtn) selectBtn.classList.toggle('active', state.selectMode);
  if (state.selectMode) {
    const n = state.selected.size;
    $('#selCount').textContent = `${n} selected`;
    $('#selNotebook').disabled = n === 0;
    $('#selDelete').disabled = n === 0;
  }
}

function selectAllVisible() {
  for (const note of state.notes.filter(passesFilters)) state.selected.add(note.id);
  render();
}

function pickNotebook() {
  const actions = [{ label: 'No notebook', value: '' }];
  for (const b of allNotebooks()) actions.push({ label: b.name, value: b.name });
  actions.push({ label: '+ New notebook…', value: '__new__', kind: 'primary' });
  actions.push({ label: 'Cancel', value: null });
  return showDialog({
    title: 'Move to notebook',
    message: `File the ${state.selected.size} selected item(s) into:`,
    actions,
  });
}

async function bulkAssignNotebook() {
  if (!state.selected.size) return;
  let target = await pickNotebook();
  if (target === null) return;
  if (target === '__new__') {
    target = createNotebook();
    if (!target) return;
  }
  const ids = [...state.selected];
  let done = 0;
  for (const id of ids) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) continue;
    note.notebook = target;
    await store.saveNote(note);
    setStatus(`Filing ${++done} of ${ids.length}…`, true, true);
  }
  state.notes = await store.cachedNotes();
  toggleSelectMode(false);
  setStatus(`Moved ${done} item${done === 1 ? '' : 's'}${target ? ` to ${target}` : ''}`, true);
}

async function bulkDelete() {
  if (!state.selected.size) return;
  const choice = await showDialog({
    title: `Move ${state.selected.size} item(s) to Trash?`,
    message: 'They stay on Drive until you empty the Trash.',
    actions: [
      { label: 'Move to Trash', value: 'yes', kind: 'danger' },
      { label: 'Cancel', value: 'no' },
    ],
  });
  if (choice !== 'yes') return;
  const ids = [...state.selected];
  let done = 0;
  for (const id of ids) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) continue;
    await store.softDeleteNote(note);
    setStatus(`Deleting ${++done} of ${ids.length}…`, true, true);
  }
  state.notes = await store.cachedNotes();
  toggleSelectMode(false);
  setStatus(`Moved ${done} item${done === 1 ? '' : 's'} to Trash`, true);
}

// --- Notebooks view -----------------------------------------------------

function renderNotebookBar() {
  const bar = $('#notebookBar');
  if (!bar) return;
  let icon, label;
  if (state.trash) { icon = '&#128465;'; label = 'Trash'; }
  else if (state.completed) { icon = '&#10003;'; label = 'Completed'; }
  else if (state.notebook) { icon = '&#128214;'; label = state.notebook; }
  else if (state.inbox) { icon = '&#128229;'; label = 'Inbox'; }
  else { icon = '&#128194;'; label = 'All notes'; }

  bar.hidden = false;
  bar.innerHTML =
    `<button id="scopeBtn" class="scope-btn"><span class="nb-ico">${icon}</span>` +
    `<strong>${escapeHtml(label)}</strong><span class="caret">&#9662;</span></button>`;
  $('#scopeBtn').addEventListener('click', openScopeMenu);
}

function openScopeMenu() {
  const menu = $('#scopeMenu');
  const panel = menu && menu.querySelector('.scope-panel');
  const btn = $('#scopeBtn');
  if (!menu || !panel || !btn) return;
  renderNotebooksUI(); // ensure the list is current
  const search = $('#scopeSearch');
  if (search) { search.value = ''; filterScopeList(''); }
  const r = btn.getBoundingClientRect();
  panel.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.hidden = false;
}

function filterScopeList(q) {
  const query = (q || '').trim().toLowerCase();
  $('#scopeList').querySelectorAll('.notebook-item').forEach((it) => {
    it.hidden = !!query && !it.textContent.toLowerCase().includes(query);
  });
}

function hideScopeMenu() {
  const m = $('#scopeMenu');
  if (m) m.hidden = true;
}

// Close whichever navigation surface is open (drawer overlay or scope menu).
function closeNav() {
  hideScopeMenu();
  if (overlay) closeOverlayByUser();
}

function openDrawer() {
  renderNotebooksUI();
  show('#drawer');
  openOverlay(() => hide('#drawer'));
}
function closeDrawer() { closeOverlayByUser(); }

// Build a tree from flat "Parent/Child" notebook paths, synthesizing any
// intermediate parent groups that have no notes of their own.
function notebookTree() {
  const nodes = new Map();
  const ensure = (path) => {
    if (nodes.has(path)) return nodes.get(path);
    const segs = path.split('/');
    const node = { path, name: segs[segs.length - 1], depth: segs.length - 1, children: [] };
    nodes.set(path, node);
    if (segs.length > 1) ensure(segs.slice(0, -1).join('/')).children.push(node);
    return node;
  };
  for (const b of allNotebooks()) {
    const segs = b.name.split('/');
    let acc = '';
    for (let i = 0; i < segs.length; i++) { acc = i === 0 ? segs[0] : `${acc}/${segs[i]}`; ensure(acc); }
  }
  const order = nbOrderList();
  const cmp = (a, b) => nbRank(a.path, order) - nbRank(b.path, order) || a.name.localeCompare(b.name);
  const sortRec = (n) => { n.children.sort(cmp); n.children.forEach(sortRec); };
  const roots = [...nodes.values()].filter((n) => n.depth === 0).sort(cmp);
  roots.forEach(sortRec);
  return roots;
}

// Count of (non-deleted) notes in a notebook path, including its sub-notebooks.
// A task that's been checked off (the Completed view's domain).
function isCompletedTask(n) {
  return n.type === 'task' && n.done;
}

function notebookCount(path) {
  return state.notes.filter((n) => !n.deleted && !isCompletedTask(n) && n.notebook && inNotebook(n, path)).length;
}

function notebookListHTML() {
  const live = state.notes.filter((n) => !n.deleted);
  const open = live.filter((n) => !isCompletedTask(n)); // completed live in their own view
  const total = open.length;
  const inboxCount = open.filter((n) => !n.notebook).length;
  const completedCount = live.filter(isCompletedTask).length;
  const trashCount = state.notes.length - live.length;
  const inboxActive = state.inbox && !state.trash && !state.completed;
  const allActive = !state.inbox && !state.notebook && !state.trash && !state.completed;
  let html =
    `<button class="notebook-item ${inboxActive ? 'active' : ''}" data-scope="inbox">` +
    `<span>&#128229; Inbox</span><span class="nb-count">${inboxCount}</span></button>` +
    `<button class="notebook-item ${allActive ? 'active' : ''}" data-scope="all">` +
    `<span>&#128194; All notes</span><span class="nb-count">${total}</span></button>`;
  const row = (node) => {
    const active = !state.trash && !state.inbox && state.notebook && state.notebook.toLowerCase() === node.path.toLowerCase();
    html +=
      `<button class="notebook-item ${active ? 'active' : ''}" data-nb="${escapeAttr(node.path)}"` +
      ` style="padding-left:${12 + node.depth * 16}px">` +
      `<span>${escapeHtml(node.name)}</span><span class="nb-count">${notebookCount(node.path)}</span></button>`;
    node.children.forEach(row);
  };
  notebookTree().forEach(row);
  html +=
    `<button class="notebook-item completed ${state.completed ? 'active' : ''}" data-scope="completed">` +
    `<span>&#10003; Completed</span><span class="nb-count">${completedCount}</span></button>` +
    `<button class="notebook-item trash ${state.trash ? 'active' : ''}" data-trash="1">` +
    `<span>&#128465; Trash</span><span class="nb-count">${trashCount}</span></button>`;
  return html;
}

// Render the notebook list into both the drawer (mobile) and the sidebar
// (desktop), wiring click-to-filter and drag-and-drop-to-file.
function renderNotebooksUI() {
  ['#notebookList', '#sidebarList', '#scopeList'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.innerHTML = notebookListHTML();
    el.querySelectorAll('.notebook-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (nbReorderJustHappened) { nbReorderJustHappened = false; return; }
        if (btn.dataset.trash) selectTrash();
        else if (btn.dataset.scope === 'inbox') selectInbox();
        else if (btn.dataset.scope === 'all') selectAll();
        else if (btn.dataset.scope === 'completed') selectCompleted();
        else selectNotebook(btn.dataset.nb);
      });

      // Reorder notebooks: long-press on touch, mouse-drag on desktop.
      // (No native draggable — on Android it hijacks long-press as a native drag.)
      if (btn.dataset.nb) {
        wireNbTouchReorder(btn, btn.dataset.nb, el);
        wireNbMouseReorder(btn, btn.dataset.nb, el);
      }

      // Drop target for filing a dragged card.
      btn.addEventListener('dragover', (e) => {
        if (!draggingNoteId) return;
        e.preventDefault();
        btn.classList.add('drop-hover');
      });
      btn.addEventListener('dragleave', () => btn.classList.remove('drop-hover'));
      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        btn.classList.remove('drop-hover');
        const id = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || draggingNoteId;
        dropNoteOnTarget(id, btn);
      });
    });
  });
}

let nbReorderJustHappened = false;

// Find the notebook item to drop before, given a Y coordinate, and place the
// indicator. Returns the target element (or null = end).
function nbReorderTarget(item, listEl, y) {
  const items = [...listEl.querySelectorAll('.notebook-item[data-nb]')].filter((el) => el !== item);
  let target = null;
  for (const sib of items) {
    const r = sib.getBoundingClientRect();
    if (y < r.top + r.height / 2) { target = sib; break; }
  }
  const ind = dropIndicator();
  if (target) listEl.insertBefore(ind, target);
  else {
    const trash = listEl.querySelector('.notebook-item.trash');
    if (trash) listEl.insertBefore(ind, trash); else listEl.appendChild(ind);
  }
  return target;
}

// Desktop: mouse-drag a notebook to reorder (gated to mouse so it doesn't
// collide with the touch handler).
function wireNbMouseReorder(item, path, listEl) {
  item.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const startY = e.clientY;
    let dragging = false, target = null;
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 5) return;
        dragging = true;
        item.classList.add('nb-dragging');
      }
      item.style.transform = `translateY(${ev.clientY - startY}px)`;
      item.style.zIndex = '5';
      target = nbReorderTarget(item, listEl, ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      item.style.transform = ''; item.style.zIndex = '';
      document.getElementById('dropIndicator')?.remove();
      item.classList.remove('nb-dragging');
      if (dragging) { nbReorderJustHappened = true; dropNotebookBefore(path, target ? target.dataset.nb : null); }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  });
}

// Touch long-press reorder for a notebook item.
function wireNbTouchReorder(item, path, listEl) {
  let lpTimer = null, dragging = false, startY = 0, moved = false;
  const clearLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };

  item.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY; dragging = false; moved = false;
    nbReorderJustHappened = false;
    clearLP();
    lpTimer = setTimeout(() => {
      dragging = true;
      item.classList.add('nb-dragging');
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
    }, 400);
  }, { passive: true });

  item.addEventListener('touchmove', (e) => {
    const y = e.touches[0].clientY;
    if (!dragging) { if (Math.abs(y - startY) > 10) clearLP(); return; } // let it scroll
    e.preventDefault();
    moved = true;
    item.style.transform = `translateY(${y - startY}px)`;
    item.style.zIndex = '5';
    item._dropTarget = nbReorderTarget(item, listEl, y);
  }, { passive: false });

  const end = () => {
    clearLP();
    item.style.transform = ''; item.style.zIndex = '';
    document.getElementById('dropIndicator')?.remove();
    item.classList.remove('nb-dragging');
    if (dragging && moved) {
      nbReorderJustHappened = true;
      dropNotebookBefore(path, item._dropTarget ? item._dropTarget.dataset.nb : null);
    }
    dragging = false;
  };
  item.addEventListener('touchend', end);
  item.addEventListener('touchcancel', end);
}

async function dropNoteOnTarget(noteId, btn) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;
  if (btn.dataset.trash) {
    await store.softDeleteNote(note);
    setStatus('Moved to Trash');
  } else if (btn.dataset.scope === 'all') {
    return; // "All notes" isn't a destination
  } else if (btn.dataset.scope === 'inbox') {
    note.notebook = '';
    await store.saveNote(note);
    setStatus('Moved to Inbox');
  } else {
    note.notebook = btn.dataset.nb || '';
    await store.saveNote(note);
    setStatus(note.notebook ? `Filed in ${note.notebook}` : 'Moved to Inbox');
  }
  state.notes = await store.cachedNotes();
  render();
}

function selectInbox() {
  state.inbox = true;
  state.notebook = '';
  state.trash = false;
  state.completed = false;
  closeNav();
  render();
}

function selectAll() {
  state.inbox = false;
  state.notebook = '';
  state.trash = false;
  state.completed = false;
  closeNav();
  render();
}

function selectNotebook(name) {
  state.inbox = false;
  state.notebook = name || '';
  state.trash = false;
  state.completed = false;
  closeNav();
  render();
}

function selectTrash() {
  state.trash = true;
  state.inbox = false;
  state.notebook = '';
  state.completed = false;
  closeNav();
  render();
}

function selectCompleted() {
  state.completed = true;
  state.trash = false;
  state.inbox = false;
  state.notebook = '';
  closeNav();
  render();
}

// Reset to the All-notes view (used when importing, so every imported item is
// visible regardless of which notebook it landed in).
function goToAllNotes() {
  state.inbox = false;
  state.notebook = '';
  state.trash = false;
  state.completed = false;
  state.filter = 'all';
  state.tags = [];
  const search = $('#searchInput');
  if (search) { search.value = ''; state.query = ''; }
  $$('.chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
  render();
}

function createNotebook() {
  const name = (prompt('New notebook name (use "/" to nest, e.g. Work/Project X)') || '').trim()
    .replace(/^\/+|\/+$/g, '').replace(/\s*\/\s*/g, '/'); // tidy separators
  if (!name) return '';
  registerNotebook(name);
  return name;
}

// --- Editor -------------------------------------------------------------

// --- Recently-used notebooks (for the editor quick-pick badges) ---------

const LS_RECENT_NB = 'xn.recentNotebooks';

function recentNotebooks() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT_NB) || '[]'); }
  catch { return []; }
}

// Record a notebook as most-recently-used (front of the list, de-duplicated).
function touchRecentNotebook(name) {
  if (!name) return;
  const list = recentNotebooks().filter((n) => n.toLowerCase() !== name.toLowerCase());
  list.unshift(name);
  try { localStorage.setItem(LS_RECENT_NB, JSON.stringify(list.slice(0, 12))); } catch {}
}

// The top few notebooks to offer as one-tap badges, excluding `exclude`. Uses
// the explicit recents list, then falls back to notebooks drawn from existing
// notes (most-recently-updated first) so the badges are useful from day one.
function quickPickNotebooks(exclude, limit = 3) {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    if (!name) return;
    const k = name.toLowerCase();
    if (k === (exclude || '').toLowerCase() || seen.has(k)) return;
    seen.add(k); out.push(name);
  };
  recentNotebooks().forEach(add);
  if (out.length < limit) {
    const byRecency = state.notes
      .filter((n) => n.notebook && !n.deleted)
      .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    for (const n of byRecency) { add(n.notebook); if (out.length >= limit) break; }
  }
  return out.slice(0, limit);
}

// Editor quick-pick badges: with no notebook set, show the top recents as
// ghosted one-tap badges; once one is applied, show just that notebook as a
// full-colour, tap-to-clear badge (only one notebook per note).
function renderNotebookQuickPicks(note) {
  const box = $('#notebookQuick');
  if (!box) return;
  const applied = note.notebook || '';
  let html;
  if (applied) {
    html = `<button type="button" class="nb-quick active" data-nb="${escapeAttr(applied)}">` +
      `&#128214; ${escapeHtml(applied)} <span class="nb-quick-x" aria-hidden="true">&times;</span></button>`;
  } else {
    // Most-recent-first from quickPickNotebooks, but displayed reversed so the
    // most recent sits on the right (nearest the dropdown / thumb).
    html = quickPickNotebooks('').reverse()
      .map((n) => `<button type="button" class="nb-quick" data-nb="${escapeAttr(n)}">&#128214; ${escapeHtml(n)}</button>`)
      .join('');
  }
  box.innerHTML = html;
  box.hidden = !html;
  box.querySelectorAll('.nb-quick').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      // The badge sits inside the field's <label>, so without this the click is
      // forwarded to activate the <select>, which undoes the change.
      e.preventDefault();
      note.notebook = btn.classList.contains('active') ? '' : btn.dataset.nb;
      renderNotebookSelect(note);      // keep the dropdown in sync
      renderNotebookQuickPicks(note);  // ghost badges <-> applied badge
    });
  });
}

function renderNotebookSelect(note) {
  const sel = $('#notebookSelect');
  if (!sel) return;
  const names = allNotebooks().map((b) => b.name);
  // Include the note's own notebook even if not yet in the list.
  if (note.notebook && !names.some((n) => n.toLowerCase() === note.notebook.toLowerCase())) {
    names.push(note.notebook);
  }
  let html = '<option value="">No notebook</option>';
  for (const n of names) {
    const selected = note.notebook && note.notebook.toLowerCase() === n.toLowerCase();
    html += `<option value="${escapeAttr(n)}" ${selected ? 'selected' : ''}>${escapeHtml(n)}</option>`;
  }
  sel.innerHTML = html;
}

function openEditor(note, { edit = false } = {}) {
  state.current = note;
  $('#titleInput').value = note.title || '';
  $('#bodyEditor').innerHTML = mdToHtml(note.body || '');
  $('#bodyInput').value = note.body || '';
  setMdMode(false); // open in styled (WYSIWYG) mode
  renderNotebookSelect(note);
  renderNotebookQuickPicks(note);
  $('#dueInput').value = note.due || '';
  $('#doneInput').checked = !!note.done;
  // "Save & email" only makes sense on first save — hide it once the item
  // exists; a saved item gets a plain "Email" action instead (works any time,
  // including from the read-only view).
  $$('.btn-save-email').forEach((b) => { b.hidden = !!note.fileId; });
  $$('.btn-email').forEach((b) => { b.hidden = !note.fileId; });
  note.tags = note.tags || [];
  renderTags(note);
  setType(note.type);
  renderSubtasks(note);
  renderAttachments(note);
  $('#editorMeta').textContent = note.fileId
    ? `Edited ${formatWhen(note.updated)}`
    : 'New';
  // New notes open editable; existing notes open read-only to avoid accidental
  // edits, with an Edit button to switch.
  setEditing(edit || !note.fileId);
  show('#editor');
  openOverlay(doCloseEditor);
  if (state.editing && !note.title) $('#titleInput').focus();
}

// Toggle the editor between read-only and editable.
function setEditing(on) {
  state.editing = on;
  const sheet = $('#editor');
  if (sheet) sheet.classList.toggle('readonly', !on);
  const ed = $('#bodyEditor');
  if (!on) setMdMode(false); // always show the styled view when read-only
  if (ed) ed.contentEditable = on ? 'true' : 'false';
  const ti = $('#titleInput'); if (ti) ti.readOnly = !on;
  const nb = $('#notebookSelect'); if (nb) nb.disabled = !on;
  const du = $('#dueInput'); if (du) du.disabled = !on;
  const dn = $('#doneInput'); if (dn) dn.disabled = !on;
}

function setType(type) {
  state.current.type = type;
  $('#typeNote').classList.toggle('active', type === 'note');
  $('#typeTask').classList.toggle('active', type === 'task');
  $('#taskFields').hidden = type !== 'task';
}

// --- Body formatting (WYSIWYG + raw Markdown) --------------------------

// Are we showing the raw Markdown textarea (vs the styled editor)?
function inMdMode() { return !$('#bodyInput').hidden; }

// Toggle between styled (contenteditable) and raw Markdown (textarea).
function setMdMode(on) {
  const ed = $('#bodyEditor');
  const ta = $('#bodyInput');
  const btn = $('#mdToggle');
  if (!ed || !ta) return;
  if (on) {
    ta.value = htmlToMarkdown(ed.innerHTML);
    ed.hidden = true;
    ta.hidden = false;
  } else {
    ed.innerHTML = mdToHtml(ta.value);
    ta.hidden = true;
    ed.hidden = false;
  }
  if (btn) btn.classList.toggle('active', on);
}

// Read the current body as Markdown, whichever mode is active.
function currentBodyMarkdown() {
  return inMdMode() ? $('#bodyInput').value : htmlToMarkdown($('#bodyEditor').innerHTML);
}

function applyFormat(fmt) {
  if (!inMdMode()) { richFormat(fmt); return; }
  const ta = $('#bodyInput');
  if (!ta || ta.hidden) return;
  const val = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = val.slice(start, end);

  const wrap = (marker, placeholder) => {
    const inner = sel || placeholder;
    ta.value = val.slice(0, start) + marker + inner + marker + val.slice(end);
    const s = start + marker.length;
    ta.selectionStart = s;
    ta.selectionEnd = s + inner.length;
  };

  const prefixLines = (prefix, replaceHeading = false) => {
    const ls = val.lastIndexOf('\n', start - 1) + 1;
    let le = val.indexOf('\n', end);
    if (le === -1) le = val.length;
    const block = val.slice(ls, le)
      .split('\n')
      .map((line) => {
        let l = line;
        if (replaceHeading) l = l.replace(/^#{1,6}\s+/, '');
        else if (l.startsWith(prefix)) return l; // don't stack
        return prefix + l;
      })
      .join('\n');
    ta.value = val.slice(0, ls) + block + val.slice(le);
    ta.selectionStart = ls;
    ta.selectionEnd = ls + block.length;
  };

  const insert = (text, selectFrom, selectLen) => {
    ta.value = val.slice(0, start) + text + val.slice(end);
    const s = selectFrom != null ? start + selectFrom : start + text.length;
    ta.selectionStart = s;
    ta.selectionEnd = selectLen != null ? s + selectLen : s;
  };

  switch (fmt) {
    case 'bold': wrap('**', 'bold'); break;
    case 'italic': wrap('_', 'italic'); break;
    case 'strike': wrap('~~', 'strikethrough'); break;
    case 'highlight': wrap('==', 'highlight'); break;
    case 'code': wrap('`', 'code'); break;
    case 'h1': prefixLines('# ', true); break;
    case 'h2': prefixLines('## ', true); break;
    case 'h3': prefixLines('### ', true); break;
    case 'ul': prefixLines('- '); break;
    case 'ol': prefixLines('1. '); break;
    case 'check': prefixLines('- [ ] '); break;
    case 'quote': prefixLines('> '); break;
    case 'hr': insert('\n---\n'); break;
    case 'link': {
      const text = sel || 'link';
      insert(`[${text}](url)`, text.length + 3, 3); // select the "url" placeholder
      break;
    }
  }
  ta.focus();
}

// WYSIWYG formatting via the browser's editing commands.
function richFormat(fmt) {
  const ed = $('#bodyEditor');
  if (!ed) return;
  ed.focus();
  const exec = (cmd, val = null) => document.execCommand(cmd, false, val);
  switch (fmt) {
    case 'bold': exec('bold'); break;
    case 'italic': exec('italic'); break;
    case 'strike': exec('strikeThrough'); break;
    case 'highlight': exec('hiliteColor', '#ffd54f'); break;
    case 'h1': exec('formatBlock', '<h1>'); break;
    case 'h2': exec('formatBlock', '<h2>'); break;
    case 'h3': exec('formatBlock', '<h3>'); break;
    case 'quote': exec('formatBlock', '<blockquote>'); break;
    case 'ul': exec('insertUnorderedList'); break;
    case 'ol': exec('insertOrderedList'); break;
    case 'hr': exec('insertHorizontalRule'); break;
    case 'code': wrapSelection('code'); break;
    case 'check':
      exec('insertHTML',
        '<ul class="md-tasks"><li class="md-task"><span class="md-cb" contenteditable="false"></span>&nbsp;</li></ul>');
      break;
    case 'link': {
      const url = prompt('Link URL', 'https://');
      if (url) exec('createLink', url);
      break;
    }
  }
}

function wrapSelection(tag) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;
  const el = document.createElement(tag);
  el.appendChild(range.extractContents());
  range.insertNode(el);
  sel.removeAllRanges();
}

function renderSubtasks(note) {
  const ul = $('#subtaskList');
  ul.innerHTML = '';
  (note.subtasks || []).forEach((st, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <input type="checkbox" ${st.done ? 'checked' : ''} />
      <input type="text" class="subtask-text" value="${escapeAttr(st.text)}" placeholder="Subtask" />
      <button class="text-btn remove" aria-label="Remove">&times;</button>`;
    li.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      st.done = e.target.checked;
    });
    const input = li.querySelector('.subtask-text');
    input.addEventListener('input', (e) => { st.text = e.target.value; });
    // Paste or drop a bullet/numbered list to add many subtasks at once.
    input.addEventListener('paste', (e) => addSubtasksFromLines(note, st, clipboardLines(e), e));
    input.addEventListener('drop', (e) => {
      const lines = (e.dataTransfer?.getData('text') || '').split(LINE_SEP).map((l) => l.trim()).filter(Boolean);
      addSubtasksFromLines(note, st, lines, e);
    });
    li.querySelector('.remove').addEventListener('click', () => {
      note.subtasks.splice(i, 1);
      renderSubtasks(note);
    });
    ul.appendChild(li);
  });
}

// Turn pasted/dropped list lines into subtasks (one per line). Single-line input
// is left to the default behaviour.
function addSubtasksFromLines(note, st, rawLines, e) {
  const lines = (rawLines || []).map(stripListMarker).filter(Boolean);
  if (lines.length <= 1) return; // single line — normal paste/drop
  e.preventDefault();
  st.text = lines[0];
  const idx = note.subtasks.indexOf(st);
  const rest = lines.slice(1).map((t) => ({ text: t, done: false }));
  note.subtasks.splice(idx + 1, 0, ...rest);
  setType('task');
  renderSubtasks(note);
}

// Cache of object URLs for attachment previews (per session).
const blobUrlCache = new Map();
async function attachmentUrl(att) {
  if (blobUrlCache.has(att.id)) return blobUrlCache.get(att.id);
  const blob = await drive.getBlob(att.id);
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(att.id, url);
  return url;
}

function renderAttachments(note) {
  const wrap = $('#attachmentList');
  wrap.innerHTML = '';
  const atts = note.attachments || [];
  if (!atts.length) {
    wrap.innerHTML = '<span class="muted small">No files attached.</span>';
    return;
  }
  atts.forEach((att, i) => {
    const isImg = (att.mime || '').startsWith('image/');
    const item = document.createElement('div');
    item.className = 'attachment';
    item.innerHTML = `
      ${isImg ? '<div class="thumb loading"></div>' : '<div class="file-ico">📄</div>'}
      <div class="att-info">
        <div class="att-name">${escapeHtml(att.name)}</div>
        <div class="att-size muted small">${formatSize(att.size)}</div>
      </div>
      <button class="text-btn remove" aria-label="Remove">&times;</button>`;

    const open = async () => {
      try {
        const url = await attachmentUrl(att);
        window.open(url, '_blank');
      } catch (e) {
        setStatus(`Could not open file: ${e.message}`, true);
      }
    };

    if (isImg) {
      const thumb = item.querySelector('.thumb');
      attachmentUrl(att)
        .then((url) => {
          thumb.style.backgroundImage = `url("${url}")`;
          thumb.classList.remove('loading');
        })
        .catch(() => thumb.classList.remove('loading'));
      thumb.addEventListener('click', open);
    } else {
      item.querySelector('.file-ico').addEventListener('click', open);
      item.querySelector('.att-name').addEventListener('click', open);
    }

    item.querySelector('.remove').addEventListener('click', async () => {
      if (!confirm('Remove this attachment?')) return;
      try { await drive.trashFile(att.id); } catch {}
      blobUrlCache.delete(att.id);
      note.attachments.splice(i, 1);
      renderAttachments(note);
    });

    wrap.appendChild(item);
  });
}

async function handleAttachFiles(files) {
  const note = state.current;
  if (!isSignedIn()) {
    try { await getToken({ interactive: true }); }
    catch (e) { setStatus(`Connect Google Drive first: ${e.message}`, true); return; }
  }
  note.attachments = note.attachments || [];
  for (const file of files) {
    setStatus(`Uploading ${file.name}…`, true);
    try {
      const meta = await drive.uploadAttachment(file);
      note.attachments.push({
        id: meta.id,
        name: meta.name || file.name,
        mime: meta.mimeType || file.type || '',
        size: Number(meta.size) || file.size || 0,
      });
      renderAttachments(note);
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`, true);
      return;
    }
  }
  setStatus('');
}

// Strip a leading bullet/number marker from a line.
function stripListMarker(line) {
  return line.replace(/^\s*([-*•‣◦]|\d+[.)])\s+/, '').trim();
}

const LINE_SEP = /\r\n|\r|\n|\u2028|\u2029/;

// Extract list lines from a paste event. Prefers HTML (so a styled bullet list,
// whose plain text may have no line breaks, still splits): list items, then
// block elements / <br>. Falls back to plain text split on any line separator.
function clipboardLines(e) {
  const dt = e.clipboardData || window.clipboardData;
  if (!dt) return [];
  const html = dt.getData && dt.getData('text/html');
  if (html && typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const lis = [...doc.querySelectorAll('li')]
        .map((li) => li.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (lis.length > 1) return lis;
      const body = doc.body;
      if (body) {
        body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
        body.querySelectorAll('p, div, tr, h1, h2, h3').forEach((el) => el.append('\n'));
        const lines = (body.textContent || '').split(LINE_SEP).map((l) => l.trim()).filter(Boolean);
        if (lines.length > 1) return lines;
      }
    } catch {}
  }
  return (dt.getData('text') || '').split(LINE_SEP).map((l) => l.trim()).filter(Boolean);
}

// Create one task per non-empty line, in the current view's notebook.
async function createTasksFromLines(lines) {
  // Dedupe exact-duplicate lines within this batch (keep first).
  const seen = new Set();
  const clean = [];
  for (const raw of lines.map(stripListMarker)) {
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(raw);
  }
  if (!clean.length) return;
  let saved = 0;
  for (const text of clean) {
    const n = emptyNote('task');
    n.title = text;
    if (state.notebook && !state.inbox && !state.trash) n.notebook = state.notebook;
    if (clean.length > 1) setStatus(`Adding ${saved + 1}/${clean.length}…`, true, true);
    await store.saveNote(n);
    saved++;
  }
  state.notes = await store.cachedNotes();
  render();
  setStatus(clean.length > 1 ? `Added ${saved} tasks` : '', clean.length > 1);
  // Recover any that couldn't reach Drive (e.g. a transient rate-limit).
  setTimeout(quickSync, 1500);
}

function wireQuickAdd() {
  const input = $('#quickAdd');
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      if (v) { createTasksFromLines([v]); input.value = ''; }
    }
  });
  input.addEventListener('paste', (e) => {
    const lines = clipboardLines(e);
    if (lines.length <= 1) return; // single line — type then Enter
    e.preventDefault();
    createTasksFromLines(lines);
    input.value = '';
  });
}

// --- Tag picker ---------------------------------------------------------

function normalizeTag(raw) {
  return (raw || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim();
}

// All tags used across notes, most-used first.
function allTags() {
  const counts = new Map();
  for (const n of state.notes) {
    if (n.deleted) continue;
    for (const t of n.tags || []) {
      const k = t.toLowerCase();
      const e = counts.get(k) || { tag: t, count: 0 };
      e.count++;
      counts.set(k, e);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .map((x) => x.tag);
}

function renderTags(note) {
  const chips = $('#tagChips');
  chips.innerHTML = '';
  (note.tags || []).forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `#${escapeHtml(t)}<button class="chip-x" aria-label="Remove tag">&times;</button>`;
    chip.querySelector('.chip-x').addEventListener('click', () => {
      note.tags = note.tags.filter((x) => x !== t);
      renderTags(note);
    });
    chips.appendChild(chip);
  });
  $('#tagInput').value = '';
  renderTagSuggest('');
}

function addTag(raw) {
  const note = state.current;
  if (!note) return;
  const tag = normalizeTag(raw);
  if (!tag) return;
  note.tags = note.tags || [];
  // Reuse existing casing if this tag already exists anywhere.
  const existing = allTags().find((t) => t.toLowerCase() === tag.toLowerCase());
  const final = existing || tag;
  if (!note.tags.some((t) => t.toLowerCase() === final.toLowerCase())) {
    note.tags.push(final);
  }
  renderTags(note);
  // Keep focus so you can add several tags in a row; refresh the (focused)
  // suggestion list to show what's left.
  $('#tagInput').focus();
  renderTagSuggest('');
}

function commitPendingTag() {
  const v = $('#tagInput').value.trim();
  if (v) addTag(v);
}

function renderTagSuggest(query) {
  const box = $('#tagSuggest');
  const note = state.current;
  if (!note) { box.hidden = true; return; }
  const q = normalizeTag(query).toLowerCase();
  const selected = new Set((note.tags || []).map((t) => t.toLowerCase()));

  let matches = allTags().filter((t) => !selected.has(t.toLowerCase()));
  if (q) matches = matches.filter((t) => t.toLowerCase().includes(q));
  matches = matches.slice(0, 8);

  const items = matches.map(
    (t) => `<button class="tag-opt" data-tag="${escapeAttr(t)}">#${escapeHtml(t)}</button>`
  );
  const exact = q && allTags().some((t) => t.toLowerCase() === q);
  if (q && !exact && !selected.has(q)) {
    items.push(
      `<button class="tag-opt create" data-tag="${escapeAttr(q)}">+ Create &ldquo;${escapeHtml(q)}&rdquo;</button>`
    );
  }

  // Only show the dropdown while the tag input is actually focused, otherwise
  // it would sit open over the Save button when the editor first opens.
  const focused = document.activeElement === $('#tagInput');
  if (!items.length || !focused) { box.hidden = true; box.innerHTML = ''; return; }

  box.innerHTML = items.join('');
  box.querySelectorAll('.tag-opt').forEach((btn) => {
    // mousedown (not click) so it fires before the input's blur.
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      addTag(btn.dataset.tag);
    });
  });
  box.hidden = false;
}

function collectEditor() {
  commitPendingTag(); // fold any uncommitted text in the tag box into tags
  const n = state.current;
  n.title = $('#titleInput').value.trim();
  n.body = currentBodyMarkdown();
  n.notebook = $('#notebookSelect').value || '';
  n.due = $('#dueInput').value;
  const nowDone = $('#doneInput').checked;
  if (nowDone !== !!n.done) setDone(n, nowDone); // stamp completedAt only on change
  // n.tags is maintained live by the tag picker.
}

async function saveEditor(email = false) {
  collectEditor();
  const n = state.current;
  // Email only on first save (creation) — never on later edits.
  const wasNew = !n.fileId;
  const emailNow = email && wasNew;
  if (!n.title && !n.body.trim() && !(n.subtasks || []).length && !(n.attachments || []).length) {
    closeEditor();
    return;
  }
  const saveBtns = $$('.btn-save, .btn-save-email');
  saveBtns.forEach((b) => { b.classList.add('loading'); b.disabled = true; });
  setStatus('Saving…');
  try {
    const res = await store.saveNote(n, { onConflict: conflictPrompt });
    if (res.status === 'cancelled') {
      setStatus('Save cancelled — reopen to see the other version', true);
      return; // keep the editor open with the user's text
    }
    if (n.notebook) touchRecentNotebook(n.notebook); // feed the quick-pick badges
    // Refresh in-memory list from cache.
    state.notes = await store.cachedNotes();
    const pending = res.status === 'pending';
    // A newly-added item filed in a notebook: jump to that notebook so the user
    // can see it landed there (otherwise it vanishes from the current view with
    // no confirmation). Set the scope directly rather than via selectNotebook()
    // so we don't double-close the editor overlay.
    if (wasNew && n.notebook) {
      state.inbox = false; state.notebook = n.notebook;
      state.trash = false; state.completed = false;
      setStatus(pending ? `Saved to ${n.notebook} — will sync to Drive` : `Added to ${n.notebook}`, pending);
    } else {
      setStatus(pending ? 'Saved on this device — will sync to Drive' : '', pending);
    }
    render();
    closeEditor();
    if (emailNow) emailNoteCopy(n); // best-effort; updates the status itself
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  } finally {
    saveBtns.forEach((b) => { b.classList.remove('loading'); b.disabled = false; });
  }
}

// Email the currently-open (already-saved) note to the user on demand. If the
// editor is in edit mode, capture any in-progress changes first so the email
// reflects what's on screen (this does not save them to Drive).
async function emailCurrentNote() {
  const n = state.current;
  if (!n) return;
  if (state.editing) collectEditor();
  const btns = $$('.btn-email');
  btns.forEach((b) => { b.classList.add('loading'); b.disabled = true; });
  try {
    await emailNoteCopy(n);
  } finally {
    btns.forEach((b) => { b.classList.remove('loading'); b.disabled = false; });
  }
}

// Email a copy of a saved item to the user, via the Worker (which holds the
// Mailgun key). Best-effort and self-reporting.
async function emailNoteCopy(note) {
  if (!relayReady()) {
    setStatus('Saved — connect to the backend to email a copy', true);
    return;
  }
  try {
    const res = await apiFetch('/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: note.title,
        type: note.type,
        body: note.body,
        due: note.due,
        notebook: note.notebook,
      }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
    setStatus('Saved and emailed a copy to you');
  } catch (err) {
    setStatus(`Saved, but the email failed: ${err.message}`, true);
  }
}

// Asked when the file changed on Drive since we opened it.
function conflictPrompt() {
  return showDialog({
    title: 'This item changed elsewhere',
    message: 'It was edited on another device since you opened it. Keep both versions, or overwrite the other one with yours?',
    actions: [
      { label: 'Keep both', value: 'keepBoth', kind: 'primary' },
      { label: 'Overwrite', value: 'overwrite', kind: 'danger' },
      { label: 'Cancel', value: 'cancel' },
    ],
  });
}

async function deleteEditor() {
  const n = state.current;
  if (!n.fileId) { closeEditor(); return; } // unsaved -> just discard
  if (!confirm('Move this item to Trash?')) return;
  await store.softDeleteNote(n);
  state.notes = await store.cachedNotes();
  render();
  closeEditor();
}

function doCloseEditor() {
  hide('#editor');
  state.current = null;
}
function closeEditor() {
  if (overlay) closeOverlayByUser();
  else doCloseEditor();
}

// --- Import -------------------------------------------------------------

async function handleImportFiles(files) {
  if (!files.length) return;

  // Jump to the inbox immediately so the progress counter is visible over the
  // list (and close Settings/drawer if the import was launched from there).
  if (overlay) closeOverlayByUser();
  goToAllNotes();

  if (!isSignedIn()) {
    try { await getToken({ interactive: true }); }
    catch (e) { setStatus(`Connect Google Drive first: ${e.message}`, true); return; }
  }

  setStatus('Reading files…', true, true);
  const { notes, errors } = await parseFiles(files);

  if (!notes.length) {
    setStatus(errors.length ? `Import failed: ${errors[0]}` : 'Nothing to import', true);
    return;
  }

  // Skip duplicates: anything matching an existing note (or an earlier one in
  // this batch) by title + body is not re-imported.
  const seen = new Set(state.notes.map(importKey));

  let saved = 0;
  let dupes = 0;
  for (const note of notes) {
    const key = importKey(note);
    if (seen.has(key)) { dupes++; continue; }
    seen.add(key);
    setStatus(`Importing ${saved + 1} of ${notes.length}…`, true, true);
    try {
      // Upload any embedded attachments (e.g. from Evernote) to Drive first.
      if (note.pendingAttachments?.length) {
        for (const att of note.pendingAttachments) {
          try {
            const file = new File([att.blob], att.name, { type: att.mime });
            const meta = await drive.uploadAttachment(file);
            note.attachments.push({
              id: meta.id,
              name: meta.name || att.name,
              mime: meta.mimeType || att.mime,
              size: Number(meta.size) || att.blob.size || 0,
            });
          } catch (e) {
            errors.push(`${note.title || 'note'} attachment: ${e.message}`);
          }
        }
        delete note.pendingAttachments;
      }
      await store.saveNote(note);
      saved++;
    } catch (e) {
      errors.push(`${note.title || 'note'}: ${e.message}`);
    }
  }

  state.notes = await store.cachedNotes();
  render();
  const parts = [`Imported ${saved} item${saved === 1 ? '' : 's'}`];
  if (dupes) parts.push(`${dupes} duplicate${dupes === 1 ? '' : 's'} skipped`);
  if (errors.length) parts.push(`${errors.length} error${errors.length === 1 ? '' : 's'}`);
  setStatus(parts.join(' · '), true);
  if (errors.length) console.warn('Xava Notes import issues:', errors);
}

// Identity used to detect duplicate imports: title + normalized body.
function importKey(note) {
  const title = (note.title || '').trim().toLowerCase();
  const body = (note.body || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return title + '' + body;
}

// --- Settings -----------------------------------------------------------

function openSettings() {
  $('#clientIdInput').value = getClientId();
  reflectAuth();
  show('#settings');
  openOverlay(() => hide('#settings'));
}

function reflectAuth() {
  const signed = isSignedIn();
  const status = $('#accountStatus');
  if (status) status.textContent = signed ? 'Connected to Google Drive.' : 'Not connected.';
  const inBtn = $('#signInBtn'); if (inBtn) inBtn.hidden = signed;
  const outBtn = $('#signOutBtn'); if (outBtn) outBtn.hidden = !signed;
  reflectConnection();
}

// Persistent banner under the header so a connection problem is visible in the
// app (previously this only showed up in the console). Offline is informational;
// "not connected" is tappable to reconnect.
function reflectConnection() {
  const banner = $('#connBanner');
  if (!banner) return;
  let msg = '', tappable = false;
  if (!navigator.onLine) {
    msg = 'Offline — changes are saved on this device and will sync when you reconnect.';
  } else if (!isSignedIn()) {
    msg = '⚠ Not connected to Google Drive — tap to reconnect.';
    tappable = true;
  }
  banner.textContent = msg;
  banner.hidden = !msg;
  banner.classList.toggle('tappable', tappable);
}

// --- Events -------------------------------------------------------------

function wireEvents() {
  $('#fab').addEventListener('click', () => {
    const n = emptyNote('note');
    if (state.notebook) n.notebook = state.notebook; // auto-assign current notebook
    openEditor(n);
  });
  $('#menuBtn').addEventListener('click', openDrawer);

  // Notebooks drawer
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerScrim').addEventListener('click', closeDrawer);
  $('#scopeScrim').addEventListener('click', hideScopeMenu);
  $('#scopeSearch').addEventListener('input', (e) => filterScopeList(e.target.value));
  $('#newNotebook').addEventListener('click', () => {
    const name = createNotebook();
    if (name) selectNotebook(name);
  });
  $('#sidebarNewNotebook').addEventListener('click', () => {
    const name = createNotebook();
    if (name) selectNotebook(name);
  });
  $('#sidebarSettings').addEventListener('click', openSettings);
  $('#openSettingsBtn').addEventListener('click', () => { hide('#drawer'); openSettings(); });
  $('#newNotebookInline').addEventListener('click', () => {
    const name = createNotebook();
    if (!name) return;
    const note = state.current;
    if (note) { note.notebook = name; renderNotebookSelect(note); renderNotebookQuickPicks(note); }
  });
  $('#notebookSelect').addEventListener('change', () => {
    const note = state.current;
    if (!note) return;
    note.notebook = $('#notebookSelect').value || '';
    renderNotebookQuickPicks(note); // reflect the choice in the quick-pick badges
  });
  $('#syncBtn').addEventListener('click', refresh);
  $('#sortBtn').addEventListener('click', () => {
    const cycle = { manual: 'date', date: 'recent', recent: 'manual' };
    state.sort = cycle[state.sort] || 'manual';
    localStorage.setItem('xn.sort', state.sort);
    const labels = { date: 'due date', recent: 'most recent', manual: 'manual order (drag to reorder)' };
    setStatus(`Sorted by ${labels[state.sort]}`);
    render();
  });
  $('#selectBtn').addEventListener('click', () => toggleSelectMode(!state.selectMode));
  $('#selClose').addEventListener('click', () => toggleSelectMode(false));
  $('#selAll').addEventListener('click', selectAllVisible);
  $('#selNotebook').addEventListener('click', bulkAssignNotebook);
  $('#selDelete').addEventListener('click', bulkDelete);

  let searchTimer;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value.trim();
      render();
    }, 150);
  });

  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    render();
  });

  // Editor
  $('#editorBack').addEventListener('click', closeEditor);
  $$('.btn-edit').forEach((b) => b.addEventListener('click', () => { setEditing(true); $('#bodyEditor').focus(); }));
  $$('.btn-save').forEach((b) => b.addEventListener('click', () => saveEditor(false)));
  $$('.btn-save-email').forEach((b) => b.addEventListener('click', () => saveEditor(true)));
  $$('.btn-email').forEach((b) => b.addEventListener('click', emailCurrentNote));
  $('#editorDelete').addEventListener('click', deleteEditor);
  $('#typeNote').addEventListener('click', () => setType('note'));
  $('#typeTask').addEventListener('click', () => setType('task'));
  $('#addSubtask').addEventListener('click', () => {
    state.current.subtasks = state.current.subtasks || [];
    state.current.subtasks.push({ text: '', done: false });
    setType('task');
    renderSubtasks(state.current);
    const inputs = $('#subtaskList').querySelectorAll('.subtask-text');
    inputs[inputs.length - 1]?.focus(); // focus the new row (handy for pasting a list)
  });
  // Body formatting toolbar (mousedown keeps the textarea selection).
  $('#formatBar').addEventListener('mousedown', (e) => {
    const btn = e.target.closest('button[data-fmt]');
    if (!btn) return;
    e.preventDefault();
    applyFormat(btn.dataset.fmt);
  });
  $('#mdToggle').addEventListener('click', () => setMdMode(!inMdMode()));
  // Toggle checklist checkboxes in the styled editor.
  $('#bodyEditor').addEventListener('click', (e) => {
    if (!state.editing) return; // read-only: don't toggle checkboxes
    const cb = e.target.closest('.md-cb');
    if (cb) cb.classList.toggle('on');
  });

  $('#clearDue').addEventListener('click', () => { $('#dueInput').value = ''; });
  $('#attachBtn').addEventListener('click', () => $('#attachInput').click());
  $('#attachInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file later
    if (files.length) await handleAttachFiles(files);
  });

  // Tag picker
  const tagInput = $('#tagInput');
  tagInput.addEventListener('input', (e) => renderTagSuggest(e.target.value));
  tagInput.addEventListener('focus', (e) => renderTagSuggest(e.target.value));
  tagInput.addEventListener('blur', () => setTimeout(() => { $('#tagSuggest').hidden = true; }, 120));
  tagInput.addEventListener('keydown', (e) => {
    const v = e.target.value;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const first = $('#tagSuggest').querySelector('.tag-opt');
      if (first && !$('#tagSuggest').hidden) addTag(first.dataset.tag);
      else addTag(v);
    } else if (e.key === 'Backspace' && !v) {
      const note = state.current;
      if (note?.tags?.length) { note.tags.pop(); renderTags(note); }
    } else if (e.key === 'Escape') {
      $('#tagSuggest').hidden = true;
    }
  });

  // Settings
  $('#settingsBack').addEventListener('click', () => closeOverlayByUser());
  $('#saveClientId').addEventListener('click', async () => {
    setClientId($('#clientIdInput').value);
    setStatus('Client ID saved.');
    try { await signIn(); } catch (err) { setStatus(err.message, true); }
  });
  $('#signInBtn').addEventListener('click', async () => {
    try { await signIn(); } catch (err) { setStatus(err.message, true); }
  });
  $('#signOutBtn').addEventListener('click', () => { signOut(); reflectAuth(); });

  // Import
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await handleImportFiles(files);
  });
  wireDragDrop();
  wireQuickAdd();

  window.addEventListener('online', () => { reflectConnection(); refresh(); });
  window.addEventListener('offline', reflectConnection);

  // Tap the connection banner to reconnect (when signed out / token expired).
  $('#connBanner').addEventListener('click', async () => {
    if (isSignedIn() || !navigator.onLine) return;
    try { await signIn(); } catch (err) { setStatus(err.message, true); }
  });

  // Retry unsynced notes when the app regains focus, and periodically.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { reflectConnection(); quickSync(); }
  });
  setInterval(quickSync, 60000);
}

function wireDragDrop() {
  const zone = $('#dropZone');
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    if (zone) zone.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0 && zone) zone.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    if (zone) zone.hidden = true;
    await handleImportFiles(Array.from(e.dataTransfer.files || []));
  });
}

// --- Helpers ------------------------------------------------------------

const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function show(sel) { const el = $(sel); if (el) { el.hidden = false; document.body.style.overflow = 'hidden'; } }
function hide(sel) { const el = $(sel); if (el) { el.hidden = true; document.body.style.overflow = ''; } }

// --- Overlay history (Android back closes the open sheet) ---------------
// Opening a sheet pushes a history entry; the back gesture pops it, which we
// intercept to close the sheet instead of leaving the app.
let overlay = null; // { close: fn }

function openOverlay(closeFn) {
  if (overlay) { overlay.close = closeFn; return; } // transition: reuse entry
  overlay = { close: closeFn };
  try { history.pushState({ xnOverlay: true }, ''); } catch {}
}
function closeOverlayByUser() {
  if (overlay) history.back(); // -> popstate -> overlay.close()
}
window.addEventListener('popstate', () => {
  const o = overlay;
  overlay = null;
  if (o) o.close();
});

// Promise-based confirm/choice dialog. actions: [{label, value, kind}].
function showDialog({ title, message, actions }) {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    $('#dialogTitle').textContent = title || '';
    $('#dialogMsg').textContent = message || '';
    const wrap = $('#dialogActions');
    wrap.innerHTML = '';
    const done = (v) => { dlg.hidden = true; document.body.style.overflow = ''; resolve(v); };
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.className = 'dialog-btn ' + (a.kind || '');
      b.textContent = a.label;
      b.addEventListener('click', () => done(a.value));
      wrap.appendChild(b);
    });
    dlg.querySelector('.dialog-scrim').onclick = () => done(null);
    dlg.hidden = false;
    document.body.style.overflow = 'hidden';
  });
}

let statusTimer;
function setStatus(msg, sticky = false, spin = false) {
  const el = $('#status');
  if (!el) return;
  if (!msg) { el.hidden = true; return; }
  el.innerHTML = '';
  if (spin) {
    const s = document.createElement('span');
    s.className = 'mini-spin';
    el.appendChild(s);
  }
  el.appendChild(document.createTextNode(msg)); // text node = safe (no HTML injection)
  el.hidden = false;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function isToday(ymd) {
  return ymd === new Date().toISOString().slice(0, 10);
}
function isOverdue(note) {
  if (!note.due) return false;
  if (note.type === 'task' && note.done) return false; // completed tasks aren't overdue
  return note.due < new Date().toISOString().slice(0, 10);
}
function formatDue(ymd) {
  const today = new Date().toISOString().slice(0, 10);
  if (ymd === today) return 'Today';
  const d = new Date(ymd + 'T00:00:00');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (ymd === tomorrow) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // When the app is already open, a fresh share won't reload the page — the SW
  // pokes us instead so we can consume the stashed content. If the OS instead
  // navigates this window (launch_handler: navigate-existing), the reload's
  // boot() consumes it; the short delay lets that path win so we don't race the
  // teardown. In the focus-only case (no reload) the timer fires and we consume.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'shared') {
      setTimeout(() => handleSharedContent().catch(() => {}), 250);
    }
  });
}

boot();
