// Main UI controller.

import { getClientId, setClientId } from './config.js';
import { signIn, signOut, isSignedIn, onAuthChange, getToken } from './auth.js';
import * as store from './store.js';
import { emptyNote, notePreview } from './note.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  notes: [],
  filter: 'all',
  query: '',
  current: null, // note being edited
};

// --- Boot ---------------------------------------------------------------

async function boot() {
  registerServiceWorker();
  wireEvents();
  reflectAuth();

  // Show cached notes instantly.
  state.notes = await store.cachedNotes();
  render();

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
    setStatus(navigator.onLine ? `Sync error: ${err.message}` : 'Offline — showing cached notes', true);
  }
}

// --- Rendering ----------------------------------------------------------

function matchesFilter(note) {
  switch (state.filter) {
    case 'task': return note.type === 'task';
    case 'note': return note.type === 'note';
    case 'open': return note.type === 'task' && !note.done;
    case 'today': return note.type === 'task' && note.due && isToday(note.due);
    default: return true;
  }
}

function matchesQuery(note) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  const hay = [
    note.title,
    note.body,
    (note.tags || []).join(' '),
    (note.subtasks || []).map((s) => s.text).join(' '),
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

function render() {
  const list = $('#list');
  const items = state.notes.filter((n) => matchesFilter(n) && matchesQuery(n));

  if (items.length === 0) {
    list.innerHTML = `<div class="empty">
      <p>${state.query ? 'No matches.' : 'No notes yet.'}</p>
      <p class="muted">${state.query ? '' : 'Tap + to capture your first note.'}</p>
    </div>`;
    return;
  }

  list.innerHTML = '';
  for (const note of items) {
    list.appendChild(renderCard(note));
  }
}

function renderCard(note) {
  const card = document.createElement('article');
  card.className = 'card' + (note.type === 'task' && note.done ? ' done' : '');
  card.dataset.id = note.id;

  const isTask = note.type === 'task';
  const subDone = (note.subtasks || []).filter((s) => s.done).length;
  const subTotal = (note.subtasks || []).length;

  card.innerHTML = `
    <div class="card-main">
      ${isTask ? `<button class="check ${note.done ? 'checked' : ''}" aria-label="Toggle done"></button>` : '<span class="dot"></span>'}
      <div class="card-text">
        <div class="card-title">${escapeHtml(note.title || notePreview(note) || 'Untitled')}</div>
        ${note.title && note.body ? `<div class="card-preview">${escapeHtml(notePreview(note))}</div>` : ''}
        <div class="card-meta">
          ${isTask && note.due ? `<span class="badge ${isOverdue(note) ? 'overdue' : ''}">${formatDue(note.due)}</span>` : ''}
          ${subTotal ? `<span class="badge">${subDone}/${subTotal} subtasks</span>` : ''}
          ${(note.tags || []).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
    </div>`;

  if (isTask) {
    card.querySelector('.check').addEventListener('click', async (e) => {
      e.stopPropagation();
      note.done = !note.done;
      card.classList.toggle('done', note.done);
      card.querySelector('.check').classList.toggle('checked', note.done);
      await store.saveNote(note);
    });
  }
  card.querySelector('.card-text').addEventListener('click', () => openEditor(note));
  return card;
}

// --- Editor -------------------------------------------------------------

function openEditor(note) {
  state.current = note;
  $('#titleInput').value = note.title || '';
  $('#bodyInput').value = note.body || '';
  $('#dueInput').value = note.due || '';
  $('#doneInput').checked = !!note.done;
  $('#tagsInput').value = (note.tags || []).join(', ');
  setType(note.type);
  renderSubtasks(note);
  $('#editorMeta').textContent = note.fileId
    ? `Edited ${formatWhen(note.updated)}`
    : 'New';
  show('#editor');
  if (!note.title) $('#titleInput').focus();
}

function setType(type) {
  state.current.type = type;
  $('#typeNote').classList.toggle('active', type === 'note');
  $('#typeTask').classList.toggle('active', type === 'task');
  $('#taskFields').hidden = type !== 'task';
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

function collectEditor() {
  const n = state.current;
  n.title = $('#titleInput').value.trim();
  n.body = $('#bodyInput').value;
  n.due = $('#dueInput').value;
  n.done = $('#doneInput').checked;
  n.tags = $('#tagsInput').value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
}

async function saveEditor() {
  collectEditor();
  const n = state.current;
  if (!n.title && !n.body.trim() && !(n.subtasks || []).length) {
    closeEditor();
    return;
  }
  setStatus('Saving…');
  try {
    await store.saveNote(n);
    // Refresh in-memory list from cache.
    state.notes = await store.cachedNotes();
    render();
    setStatus('');
    closeEditor();
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  }
}

async function deleteEditor() {
  const n = state.current;
  if (n.fileId && !confirm('Delete this note?')) return;
  await store.deleteNote(n);
  state.notes = await store.cachedNotes();
  render();
  closeEditor();
}

function closeEditor() {
  hide('#editor');
  state.current = null;
}

// --- Settings -----------------------------------------------------------

function openSettings() {
  $('#clientIdInput').value = getClientId();
  reflectAuth();
  show('#settings');
}

function reflectAuth() {
  const signed = isSignedIn();
  $('#accountStatus').textContent = signed ? 'Connected to Google Drive.' : 'Not connected.';
  $('#signInBtn').hidden = signed;
  $('#signOutBtn').hidden = !signed;
}

// --- Events -------------------------------------------------------------

function wireEvents() {
  $('#fab').addEventListener('click', () => openEditor(emptyNote('note')));
  $('#menuBtn').addEventListener('click', openSettings);
  $('#syncBtn').addEventListener('click', refresh);

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
  $('#editorSave').addEventListener('click', saveEditor);
  $('#editorDelete').addEventListener('click', deleteEditor);
  $('#typeNote').addEventListener('click', () => setType('note'));
  $('#typeTask').addEventListener('click', () => setType('task'));
  $('#addSubtask').addEventListener('click', () => {
    state.current.subtasks = state.current.subtasks || [];
    state.current.subtasks.push({ text: '', done: false });
    setType('task');
    renderSubtasks(state.current);
  });

  // Settings
  $('#settingsBack').addEventListener('click', () => hide('#settings'));
  $('#saveClientId').addEventListener('click', async () => {
    setClientId($('#clientIdInput').value);
    setStatus('Client ID saved.');
    try { await signIn(); } catch (err) { setStatus(err.message, true); }
  });
  $('#signInBtn').addEventListener('click', async () => {
    try { await signIn(); } catch (err) { setStatus(err.message, true); }
  });
  $('#signOutBtn').addEventListener('click', () => { signOut(); reflectAuth(); });

  window.addEventListener('online', refresh);
  window.addEventListener('offline', () => setStatus('Offline — changes will sync later', true));
}

// --- Helpers ------------------------------------------------------------

const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function show(sel) { $(sel).hidden = false; document.body.style.overflow = 'hidden'; }
function hide(sel) { $(sel).hidden = true; document.body.style.overflow = ''; }

let statusTimer;
function setStatus(msg, sticky = false) {
  const el = $('#status');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
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

function isToday(ymd) {
  return ymd === new Date().toISOString().slice(0, 10);
}
function isOverdue(note) {
  return note.type === 'task' && !note.done && note.due && note.due < new Date().toISOString().slice(0, 10);
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
