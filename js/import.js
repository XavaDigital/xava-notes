// Importers for external exports:
//   - Evernote  .enex  (XML; one or many notes, ENML content -> Markdown)
//   - Todoist   .csv   (tasks with due dates + subtask indentation)
//   - Plain     .md / .txt  (single note)
//
// Each importer returns note objects in the app's shape (see note.js). Saving
// them to Drive is the caller's job.

import { emptyNote } from './note.js';

// --- Public entry -------------------------------------------------------

export async function parseFiles(files) {
  const notes = [];
  const errors = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const name = (file.name || '').toLowerCase();
      if (name.endsWith('.enex')) notes.push(...parseEnex(text));
      else if (name.endsWith('.csv')) notes.push(...parseTodoistCsv(text));
      else if (name.endsWith('.md') || name.endsWith('.txt') || name.endsWith('.markdown')) {
        notes.push(parsePlain(file.name, text));
      } else {
        errors.push(`${file.name}: unsupported file type`);
      }
    } catch (e) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }
  return { notes, errors };
}

// --- Plain text / Markdown ---------------------------------------------

function parsePlain(filename, text) {
  const n = emptyNote('note');
  n.title = (filename || 'Imported note').replace(/\.[^.]+$/, '');
  n.body = text.replace(/^#\s+.*\n+/, ''); // drop a leading H1 (becomes title)
  return n;
}

// --- Evernote .enex -----------------------------------------------------

function parseEnex(xml) {
  if (typeof DOMParser === 'undefined') throw new Error('Import needs a browser');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out = [];
  for (const noteEl of doc.querySelectorAll('note')) {
    const title = textOf(noteEl.querySelector('title'));
    const content = textOf(noteEl.querySelector('content'));
    const created = enexTime(textOf(noteEl.querySelector('created')));
    const updated = enexTime(textOf(noteEl.querySelector('updated'))) || created;
    const tags = [...noteEl.querySelectorAll('tag')]
      .map((t) => (t.textContent || '').trim())
      .filter(Boolean);

    const n = emptyNote('note');
    n.title = title || 'Imported note';
    n.body = enmlToMarkdown(content);
    n.tags = tags;
    if (created) n.created = created;
    if (updated) n.updated = updated;
    out.push(n);
  }
  return out;
}

function enexTime(s) {
  // 20230131T142530Z -> ISO
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec((s || '').trim());
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

function enmlToMarkdown(enml) {
  if (!enml) return '';
  const doc = new DOMParser().parseFromString(enml, 'text/html');
  const root = doc.querySelector('en-note') || doc.body;
  return walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function walk(node) {
  let md = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) { md += child.textContent.replace(/\s+/g, ' '); return; }
    if (child.nodeType !== 1) return;
    const tag = child.tagName.toLowerCase();
    const inner = walk(child);
    switch (tag) {
      case 'br': md += '\n'; break;
      case 'div': case 'p': md += inner.replace(/\n+$/, '') + '\n'; break;
      case 'h1': md += `\n# ${inner.trim()}\n`; break;
      case 'h2': md += `\n## ${inner.trim()}\n`; break;
      case 'h3': case 'h4': md += `\n### ${inner.trim()}\n`; break;
      case 'b': case 'strong': md += inner.trim() ? `**${inner.trim()}**` : ''; break;
      case 'i': case 'em': md += inner.trim() ? `_${inner.trim()}_` : ''; break;
      case 'ul': case 'ol': md += `\n${inner}\n`; break;
      case 'li': md += `- ${inner.trim()}\n`; break;
      case 'blockquote': md += `> ${inner.trim()}\n`; break;
      case 'en-todo': md += child.getAttribute('checked') === 'true' ? '- [x] ' : '- [ ] '; break;
      case 'a': {
        const href = child.getAttribute('href');
        md += href ? `[${inner.trim() || href}](${href})` : inner;
        break;
      }
      case 'en-media': md += '_[attachment not imported]_\n'; break;
      default: md += inner;
    }
  });
  return md;
}

// --- Todoist .csv -------------------------------------------------------

export function parseTodoistCsv(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return [];
  const header = rows.shift().map((h) => h.trim().toUpperCase());
  const col = (name) => header.indexOf(name);
  const iType = col('TYPE'), iContent = col('CONTENT'), iDesc = col('DESCRIPTION');
  const iIndent = col('INDENT'), iDate = col('DATE');
  if (iContent < 0) throw new Error('not a Todoist CSV');

  const out = [];
  let current = null;
  let sectionTag = null;

  for (const r of rows) {
    const type = (r[iType] || '').trim().toLowerCase();
    if (type === 'section') {
      sectionTag = (r[iContent] || '').trim() || null;
      current = null;
      continue;
    }
    if (type && type !== 'task') continue;
    const content = (r[iContent] || '').trim();
    if (!content) continue;

    const indent = parseInt(r[iIndent], 10) || 1;
    if (indent > 1 && current) {
      current.subtasks.push({ text: content, done: false });
      continue;
    }

    const n = emptyNote('task');
    n.title = content;
    if (iDesc >= 0 && r[iDesc]) n.body = r[iDesc].trim();
    const due = todoistDate(r[iDate]);
    if (due) n.due = due;
    if (sectionTag) n.tags = [sectionTag];
    out.push(n);
    current = n;
  }
  return out;
}

function todoistDate(s) {
  s = (s || '').trim();
  if (!s) return '';
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return ''; // recurring text like "every day" -> no fixed date
}

// RFC-4180-ish CSV parser (handles quoted fields, escaped quotes, newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// --- helpers ------------------------------------------------------------

function textOf(el) {
  return el ? (el.textContent || '').trim() : '';
}
