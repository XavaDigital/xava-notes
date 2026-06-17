// Main UI controller.

import { getClientId, setClientId } from './config.js';
import { signIn, signOut, isSignedIn, onAuthChange, getToken } from './auth.js';
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
  sort: 'date', // 'date' = by due date (overdue first), 'recent' = by last edited
  current: null, // note being edited
  editing: false, // editor is in edit (vs read-only) mode
  selectMode: false, // bulk multi-select
  selected: new Set(), // selected note ids
};

let draggingNoteId = null; // id of the card being dragged onto a notebook

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

// All notebooks (from notes + any registered empty ones), with item counts.
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
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- Boot ---------------------------------------------------------------

async function boot() {
  registerServiceWorker();

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

  // If launched via the Android share sheet, open a pre-filled new note.
  await handleSharedContent();
}

// Web Share Target: the service worker stashed the shared title/text/url and any
// files in the 'xn-shared' cache and redirected here with ?shared=1. Build a new
// note from it, uploading shared files as attachments.
async function handleSharedContent() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState({}, '', location.pathname); // don't re-trigger on refresh

  let meta = { title: '', text: '', url: '', files: [] };
  const files = [];
  try {
    const cache = await caches.open('xn-shared');
    const metaRes = await cache.match('./shared-meta');
    if (metaRes) meta = await metaRes.json();
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
}

onAuthChange(async (signed) => {
  reflectAuth();
  if (signed) await refresh();
});

// --- Sync ---------------------------------------------------------------

async function refresh() {
  if (!isSignedIn()) return;
  setStatus('Syncing…');
  try {
    state.notes = await store.refreshFromDrive();
    render();
    setStatus('');
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

function sortItems(items) {
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
  list.classList.toggle('manual', state.sort === 'manual' && !state.trash);

  const pending = state.notes.filter((n) => n.unsynced).length;
  const syncBtn = $('#syncBtn');
  if (syncBtn) {
    syncBtn.classList.toggle('pending', pending > 0);
    syncBtn.title = pending > 0 ? `${pending} not synced — tap to sync` : 'Sync now';
  }

  const items = sortItems(state.notes.filter(passesFilters));
  const filtering = state.query || state.tags.length || state.filter !== 'all';

  if (items.length === 0) {
    let msg, hint = '';
    if (state.trash) msg = 'Trash is empty.';
    else if (filtering) msg = 'No matches.';
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

  card.innerHTML = `
    <div class="card-actions"><button class="card-edit" aria-label="Edit note">&#9998; Edit</button></div>
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
            ${subTotal ? `<span class="badge">${subDone}/${subTotal} subtasks</span>` : ''}
            ${(note.attachments || []).length ? `<span class="badge">📎 ${note.attachments.length}</span>` : ''}
            ${(note.tags || []).map((t) => `<button class="tag ${isTagActive(t) ? 'active' : ''}" data-tag="${escapeAttr(t)}">#${escapeHtml(t)}</button>`).join('')}
          </div>
        </div>
      </div>
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
      note.done = !note.done;
      card.classList.toggle('done', note.done);
      card.classList.toggle('overdue', isOverdue(note));
      card.querySelector('.check').classList.toggle('checked', note.done);
      await store.saveNote(note);
    });
  }
  card.querySelectorAll('.tag').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't open the editor
      toggleTagFilter(btn.dataset.tag);
    });
  });
  const nbChip = card.querySelector('.nb-chip');
  if (nbChip) nbChip.addEventListener('click', (e) => { e.stopPropagation(); selectNotebook(nbChip.dataset.nb); });

  // In manual sort, the drag handle reorders; otherwise the whole card drags
  // onto a notebook (desktop) to file it there.
  if (state.sort === 'manual' && !state.trash) {
    wireReorder(card, note);
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

  // Swipe-to-reveal the Edit action (touch). Edit opens straight in edit mode.
  card.querySelector('.card-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    card.classList.remove('swiped');
    openEditor(note, { edit: true });
  });
  if (!state.trash) wireSwipe(card);

  card.querySelector('.card-text').addEventListener('click', () => {
    if (card.classList.contains('swiped')) { card.classList.remove('swiped'); return; }
    if (state.trash) trashItemFlow(note);
    else openEditor(note);
  });
  return card;
}

const SWIPE_W = 88; // px width of the revealed action
function closeSwipes(except) {
  document.querySelectorAll('.card.swiped').forEach((c) => { if (c !== except) c.classList.remove('swiped'); });
}

function wireSwipe(card) {
  const front = card.querySelector('.card-front');
  let startX = null, startY = null, dx = 0, active = false;

  card.addEventListener('touchstart', (e) => {
    if (state.selectMode) return;
    if (e.target.closest('.drag-handle')) return; // handle is for reordering
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; dx = 0; active = false;
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (startX == null) return;
    const t = e.touches[0];
    const mx = t.clientX - startX;
    const my = t.clientY - startY;
    if (!active) {
      if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) { active = true; closeSwipes(card); }
      else if (Math.abs(my) > 8) { startX = null; return; } // vertical scroll wins
    }
    if (active) {
      e.preventDefault();
      // allow left swipe to open; if already open, allow right swipe to close
      const base = card.classList.contains('swiped') ? -SWIPE_W : 0;
      dx = Math.max(-SWIPE_W, Math.min(0, base + mx));
      front.style.transform = `translateX(${dx}px)`;
    }
  }, { passive: false });

  card.addEventListener('touchend', () => {
    if (startX == null) return;
    front.style.transform = '';
    if (active) card.classList.toggle('swiped', dx < -SWIPE_W / 2);
    startX = null; active = false;
  });
}

// Pointer-based drag-to-reorder via the card's handle (works on touch + mouse).
let reorder = null;
function wireReorder(card, note) {
  const handle = card.querySelector('.drag-handle');
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeSwipes(null);
    card.classList.add('reordering');
    reorder = { card, note, pointerId: e.pointerId };
    try { handle.setPointerCapture(e.pointerId); } catch {}
    handle.addEventListener('pointermove', onReorderMove);
    handle.addEventListener('pointerup', onReorderUp, { once: true });
    handle.addEventListener('pointercancel', onReorderUp, { once: true });
  });
}

function onReorderMove(e) {
  if (!reorder) return;
  const { card } = reorder;
  const list = card.parentElement;
  if (!list) return;
  const y = e.clientY;
  // Auto-scroll near the edges of the viewport.
  if (y < 90) window.scrollBy(0, -12);
  else if (y > window.innerHeight - 90) window.scrollBy(0, 12);

  const siblings = [...list.querySelectorAll('.card:not(.reordering)')];
  let placed = false;
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect();
    if (y < r.top + r.height / 2) { list.insertBefore(card, sib); placed = true; break; }
  }
  if (!placed) list.appendChild(card);
}

async function onReorderUp() {
  if (!reorder) return;
  const { card, note } = reorder;
  reorder = null;
  card.classList.remove('reordering');
  const handle = card.querySelector('.drag-handle');
  if (handle) handle.removeEventListener('pointermove', onReorderMove);

  // Compute a fractional order between the new DOM neighbours.
  const list = card.parentElement;
  const cards = [...list.querySelectorAll('.card')];
  const idx = cards.indexOf(card);
  const prevEl = cards[idx - 1], nextEl = cards[idx + 1];
  const prevNote = prevEl && state.notes.find((n) => n.id === prevEl.dataset.id);
  const nextNote = nextEl && state.notes.find((n) => n.id === nextEl.dataset.id);
  const ka = prevNote ? effectiveOrder(prevNote) : null;
  const kb = nextNote ? effectiveOrder(nextNote) : null;
  if (ka == null && kb == null) note.order = effectiveOrder(note);
  else if (ka == null) note.order = kb - 1000;
  else if (kb == null) note.order = ka + 1000;
  else note.order = (ka + kb) / 2;

  await store.saveNote(note);
  state.notes = await store.cachedNotes();
  render();
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
  let icon, label, removable = false;
  if (state.trash) { icon = '&#128465;'; label = 'Trash'; removable = true; }
  else if (state.notebook) { icon = '&#128214;'; label = state.notebook; removable = true; }
  else if (state.inbox) { icon = '&#128229;'; label = 'Inbox'; }
  else { icon = '&#128194;'; label = 'All notes'; }

  bar.hidden = false;
  bar.innerHTML =
    `<span class="notebook-pill"><span class="nb-ico">${icon}</span><strong>${escapeHtml(label)}</strong>` +
    (removable ? '<button class="chip-x" aria-label="Back to Inbox">&times;</button>' : '') +
    '</span>';
  const x = bar.querySelector('.chip-x');
  if (x) x.addEventListener('click', selectInbox);
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
  const sortRec = (n) => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sortRec); };
  const roots = [...nodes.values()].filter((n) => n.depth === 0).sort((a, b) => a.name.localeCompare(b.name));
  roots.forEach(sortRec);
  return roots;
}

// Count of (non-deleted) notes in a notebook path, including its sub-notebooks.
function notebookCount(path) {
  return state.notes.filter((n) => !n.deleted && n.notebook && inNotebook(n, path)).length;
}

function notebookListHTML() {
  const live = state.notes.filter((n) => !n.deleted);
  const total = live.length;
  const inboxCount = live.filter((n) => !n.notebook).length;
  const trashCount = state.notes.length - total;
  const inboxActive = state.inbox && !state.trash;
  const allActive = !state.inbox && !state.notebook && !state.trash;
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
    `<button class="notebook-item trash ${state.trash ? 'active' : ''}" data-trash="1">` +
    `<span>&#128465; Trash</span><span class="nb-count">${trashCount}</span></button>`;
  return html;
}

// Render the notebook list into both the drawer (mobile) and the sidebar
// (desktop), wiring click-to-filter and drag-and-drop-to-file.
function renderNotebooksUI() {
  ['#notebookList', '#sidebarList'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.innerHTML = notebookListHTML();
    el.querySelectorAll('.notebook-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.trash) selectTrash();
        else if (btn.dataset.scope === 'inbox') selectInbox();
        else if (btn.dataset.scope === 'all') selectAll();
        else selectNotebook(btn.dataset.nb);
      });
      // Drop a dragged card here to file it (or trash it).
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
  closeDrawer();
  render();
}

function selectAll() {
  state.inbox = false;
  state.notebook = '';
  state.trash = false;
  closeDrawer();
  render();
}

function selectNotebook(name) {
  state.inbox = false;
  state.notebook = name || '';
  state.trash = false;
  closeDrawer();
  render();
}

function selectTrash() {
  state.trash = true;
  state.inbox = false;
  state.notebook = '';
  closeDrawer();
  render();
}

// Reset to the All-notes view (used when importing, so every imported item is
// visible regardless of which notebook it landed in).
function goToAllNotes() {
  state.inbox = false;
  state.notebook = '';
  state.trash = false;
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
  $('#dueInput').value = note.due || '';
  $('#doneInput').checked = !!note.done;
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
    li.querySelector('.subtask-text').addEventListener('input', (e) => {
      st.text = e.target.value;
    });
    li.querySelector('.remove').addEventListener('click', () => {
      note.subtasks.splice(i, 1);
      renderSubtasks(note);
    });
    ul.appendChild(li);
  });
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
  n.done = $('#doneInput').checked;
  // n.tags is maintained live by the tag picker.
}

async function saveEditor() {
  collectEditor();
  const n = state.current;
  if (!n.title && !n.body.trim() && !(n.subtasks || []).length && !(n.attachments || []).length) {
    closeEditor();
    return;
  }
  const saveBtns = $$('.btn-save');
  saveBtns.forEach((b) => { b.classList.add('loading'); b.disabled = true; });
  setStatus('Saving…');
  try {
    const res = await store.saveNote(n, { onConflict: conflictPrompt });
    if (res.status === 'cancelled') {
      setStatus('Save cancelled — reopen to see the other version', true);
      return; // keep the editor open with the user's text
    }
    // Refresh in-memory list from cache.
    state.notes = await store.cachedNotes();
    render();
    setStatus(res.status === 'pending' ? 'Saved on this device — will sync to Drive' : '', res.status === 'pending');
    closeEditor();
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  } finally {
    saveBtns.forEach((b) => { b.classList.remove('loading'); b.disabled = false; });
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
    if (note) { note.notebook = name; renderNotebookSelect(note); }
  });
  $('#syncBtn').addEventListener('click', refresh);
  $('#sortBtn').addEventListener('click', () => {
    const cycle = { date: 'recent', recent: 'manual', manual: 'date' };
    state.sort = cycle[state.sort] || 'date';
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
  $$('.btn-save').forEach((b) => b.addEventListener('click', saveEditor));
  $('#editorDelete').addEventListener('click', deleteEditor);
  $('#typeNote').addEventListener('click', () => setType('note'));
  $('#typeTask').addEventListener('click', () => setType('task'));
  $('#addSubtask').addEventListener('click', () => {
    state.current.subtasks = state.current.subtasks || [];
    state.current.subtasks.push({ text: '', done: false });
    setType('task');
    renderSubtasks(state.current);
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

  window.addEventListener('online', refresh);
  window.addEventListener('offline', () => setStatus('Offline — changes will sync later', true));

  // Retry unsynced notes when the app regains focus, and periodically.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') quickSync();
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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
