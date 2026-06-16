// Main UI controller.

import { getClientId, setClientId } from './config.js';
import { signIn, signOut, isSignedIn, onAuthChange, getToken } from './auth.js';
import * as store from './store.js';
import * as drive from './drive.js';
import { emptyNote, notePreview } from './note.js';
import { mdToHtml } from './markdown.js';
import { parseFiles } from './import.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  notes: [],
  filter: 'all',
  query: '',
  tags: [], // active tag filters (from tapping cards or the tag bar) — ANDed
  notebook: '', // active notebook/list view ('' = all notebooks)
  sort: 'date', // 'date' = by due date (overdue first), 'recent' = by last edited
  current: null, // note being edited
};

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

function passesFilters(note) {
  if (state.notebook && (note.notebook || '').toLowerCase() !== state.notebook.toLowerCase()) return false;
  if (!matchesFilter(note)) return false;
  for (const t of activeTagFilters()) {
    if (!noteHasTag(note, t)) return false;
  }
  const { text } = parseSearch(state.query);
  if (text) {
    const hay = [
      note.title,
      note.body,
      (note.tags || []).join(' '),
      (note.subtasks || []).map((s) => s.text).join(' '),
    ].join(' ').toLowerCase();
    if (!hay.includes(text.toLowerCase())) return false;
  }
  return true;
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

function sortItems(items) {
  return [...items].sort(state.sort === 'date' ? byDueDate : byRecent);
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
  const list = $('#list');
  if (!list) return;

  const sortBtn = $('#sortBtn');
  if (sortBtn) sortBtn.classList.toggle('active', state.sort === 'date');

  const items = sortItems(state.notes.filter(passesFilters));
  const filtering = state.query || state.tags.length || state.notebook || state.filter !== 'all';

  if (items.length === 0) {
    list.innerHTML = `<div class="empty">
      <p>${filtering ? 'No matches.' : 'No notes yet.'}</p>
      <p class="muted">${filtering ? '' : 'Tap + to capture your first note.'}</p>
    </div>`;
    return;
  }

  // In the default (by-date) view, float overdue items into a labelled section
  // at the top so anything past due is impossible to miss.
  const grouped = state.sort === 'date' && state.filter !== 'overdue';
  const overdue = grouped ? items.filter(isOverdue) : [];
  const rest = grouped ? items.filter((n) => !isOverdue(n)) : items;

  list.innerHTML = '';
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
    <div class="card-main">
      ${isTask ? `<button class="check ${note.done ? 'checked' : ''}" aria-label="Toggle done"></button>` : '<span class="dot"></span>'}
      <div class="card-text">
        <div class="card-title">${escapeHtml(note.title || notePreview(note) || 'Untitled')}</div>
        ${note.title && note.body ? `<div class="card-preview">${escapeHtml(notePreview(note))}</div>` : ''}
        <div class="card-meta">
          ${note.due ? `<span class="badge ${isOverdue(note) ? 'overdue' : ''}">${formatDue(note.due)}</span>` : ''}
          ${subTotal ? `<span class="badge">${subDone}/${subTotal} subtasks</span>` : ''}
          ${(note.attachments || []).length ? `<span class="badge">📎 ${note.attachments.length}</span>` : ''}
          ${(note.tags || []).map((t) => `<button class="tag ${isTagActive(t) ? 'active' : ''}" data-tag="${escapeAttr(t)}">#${escapeHtml(t)}</button>`).join('')}
        </div>
      </div>
    </div>`;

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
  card.querySelector('.card-text').addEventListener('click', () => openEditor(note));
  return card;
}

// --- Notebooks view -----------------------------------------------------

function renderNotebookBar() {
  const bar = $('#notebookBar');
  if (!bar) return;
  if (!state.notebook) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML =
    `<span class="notebook-pill"><span class="nb-ico">&#128214;</span>` +
    `<strong>${escapeHtml(state.notebook)}</strong>` +
    `<button class="chip-x" aria-label="Leave notebook">&times;</button></span>`;
  bar.querySelector('.chip-x').addEventListener('click', () => selectNotebook(''));
}

function openDrawer() {
  renderNotebookList();
  show('#drawer');
}
function closeDrawer() { hide('#drawer'); }

function renderNotebookList() {
  const el = $('#notebookList');
  if (!el) return;
  const books = allNotebooks();
  const total = state.notes.length;
  let html =
    `<button class="notebook-item ${!state.notebook ? 'active' : ''}" data-nb="">` +
    `<span>All notes</span><span class="nb-count">${total}</span></button>`;
  for (const b of books) {
    const active = state.notebook && state.notebook.toLowerCase() === b.name.toLowerCase();
    html +=
      `<button class="notebook-item ${active ? 'active' : ''}" data-nb="${escapeAttr(b.name)}">` +
      `<span>${escapeHtml(b.name)}</span><span class="nb-count">${b.count}</span></button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.notebook-item').forEach((btn) => {
    btn.addEventListener('click', () => selectNotebook(btn.dataset.nb));
  });
}

function selectNotebook(name) {
  state.notebook = name || '';
  closeDrawer();
  render();
}

function createNotebook() {
  const name = (prompt('New notebook name') || '').trim();
  if (!name) return name;
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

function openEditor(note) {
  state.current = note;
  $('#titleInput').value = note.title || '';
  $('#bodyInput').value = note.body || '';
  setPreview(false); // always open in edit mode
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
  show('#editor');
  if (!note.title) $('#titleInput').focus();
}

function setType(type) {
  state.current.type = type;
  $('#typeNote').classList.toggle('active', type === 'note');
  $('#typeTask').classList.toggle('active', type === 'task');
  $('#taskFields').hidden = type !== 'task';
}

// --- Body formatting (Markdown) ----------------------------------------

function setPreview(on) {
  const ta = $('#bodyInput');
  const pv = $('#bodyPreview');
  const btn = $('#previewToggle');
  if (!ta || !pv) return;
  if (on) {
    pv.innerHTML = mdToHtml(ta.value);
    ta.hidden = true;
    pv.hidden = false;
  } else {
    ta.hidden = false;
    pv.hidden = true;
  }
  if (btn) btn.classList.toggle('active', on);
  $('#formatBar')?.classList.toggle('previewing', on);
}

function applyFormat(fmt) {
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

  switch (fmt) {
    case 'bold': wrap('**', 'bold'); break;
    case 'italic': wrap('_', 'italic'); break;
    case 'h1': prefixLines('# ', true); break;
    case 'h2': prefixLines('## ', true); break;
    case 'ul': prefixLines('- '); break;
    case 'quote': prefixLines('> '); break;
  }
  ta.focus();
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
  n.body = $('#bodyInput').value;
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
  const btn = $('#editorSave');
  btn.classList.add('loading');
  btn.disabled = true;
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
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
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

// --- Import -------------------------------------------------------------

async function handleImportFiles(files) {
  if (!files.length) return;
  if (!isSignedIn()) {
    try { await getToken({ interactive: true }); }
    catch (e) { setStatus(`Connect Google Drive first: ${e.message}`, true); return; }
  }

  setStatus('Reading files…', true);
  const { notes, errors } = await parseFiles(files);

  if (!notes.length) {
    setStatus(errors.length ? `Import failed: ${errors[0]}` : 'Nothing to import', true);
    return;
  }

  let saved = 0;
  for (const note of notes) {
    setStatus(`Importing ${saved + 1}/${notes.length}…`, true);
    try {
      await store.saveNote(note);
      saved++;
    } catch (e) {
      errors.push(`${note.title || 'note'}: ${e.message}`);
    }
  }

  state.notes = await store.cachedNotes();
  render();
  hide('#settings');
  const extra = errors.length ? ` (${errors.length} skipped)` : '';
  setStatus(`Imported ${saved} item${saved === 1 ? '' : 's'}${extra}`, true);
  if (errors.length) console.warn('Xava Notes import issues:', errors);
}

// --- Settings -----------------------------------------------------------

function openSettings() {
  $('#clientIdInput').value = getClientId();
  reflectAuth();
  show('#settings');
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
  $('#openSettingsBtn').addEventListener('click', () => { closeDrawer(); openSettings(); });
  $('#newNotebookInline').addEventListener('click', () => {
    const name = createNotebook();
    if (!name) return;
    const note = state.current;
    if (note) { note.notebook = name; renderNotebookSelect(note); }
  });
  $('#syncBtn').addEventListener('click', refresh);
  $('#sortBtn').addEventListener('click', () => {
    state.sort = state.sort === 'date' ? 'recent' : 'date';
    setStatus(state.sort === 'date' ? 'Sorted by due date' : 'Sorted by most recent');
    render();
  });

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
  // Body formatting toolbar (mousedown keeps the textarea selection).
  $('#formatBar').addEventListener('mousedown', (e) => {
    const btn = e.target.closest('button[data-fmt]');
    if (!btn) return;
    e.preventDefault();
    applyFormat(btn.dataset.fmt);
  });
  $('#previewToggle').addEventListener('click', () => setPreview($('#bodyInput').hidden ? false : true));

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

let statusTimer;
function setStatus(msg, sticky = false) {
  const el = $('#status');
  if (!el) return;
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
