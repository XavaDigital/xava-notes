// Note model + (de)serialization to/from a Markdown file with YAML frontmatter.

import { parseFrontmatter, buildFrontmatter } from './frontmatter.js';

export function newId() {
  return (
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  );
}

// Create a blank note object.
export function emptyNote(type = 'note') {
  const now = new Date().toISOString();
  return {
    id: newId(),
    fileId: null, // Drive file id, set once saved
    title: '',
    type, // 'note' | 'task'
    body: '',
    done: false,
    due: '', // YYYY-MM-DD
    tags: [],
    subtasks: [], // [{text, done}]
    attachments: [], // [{id, name, mime, size}] — id is the Drive file id
    created: now,
    updated: now,
  };
}

// Serialize a note to Markdown file contents.
export function noteToMarkdown(note) {
  const meta = {
    id: note.id,
    type: note.type,
    created: note.created,
    updated: note.updated,
  };
  if (note.title) meta.title = note.title;
  // A date/due date applies to both notes and tasks.
  if (note.due) meta.due = note.due;
  if (note.type === 'task') {
    meta.done = !!note.done;
    if (note.subtasks?.length) meta.subtasks = note.subtasks;
  }
  if (note.attachments?.length) meta.attachments = note.attachments;
  if (note.tags?.length) meta.tags = note.tags;

  // Body: include the title as an H1 for readability inside Drive.
  let body = '';
  if (note.title) body += `# ${note.title}\n\n`;
  body += note.body || '';
  return buildFrontmatter(meta, body);
}

// Parse Markdown file contents into a note object.
export function noteFromMarkdown(text, fileId) {
  const { meta, body } = parseFrontmatter(text);

  // Strip a leading "# Title" heading from the body if present (we re-add it
  // on save). Keep the rest as the editable body.
  let cleanBody = body;
  const h1 = /^\s*#\s+(.+)\n+/.exec(body);
  let titleFromBody = '';
  if (h1) {
    titleFromBody = h1[1].trim();
    cleanBody = body.slice(h1[0].length);
  }

  return {
    id: meta.id || newId(),
    fileId: fileId || null,
    title: meta.title || titleFromBody || '',
    type: meta.type === 'task' ? 'task' : 'note',
    body: cleanBody.replace(/^\n+/, ''),
    done: !!meta.done,
    due: meta.due || '',
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    subtasks: Array.isArray(meta.subtasks)
      ? meta.subtasks.map((s) => ({ text: String(s.text || ''), done: !!s.done }))
      : [],
    attachments: Array.isArray(meta.attachments)
      ? meta.attachments.map((a) => ({
          id: String(a.id || ''),
          name: String(a.name || ''),
          mime: String(a.mime || ''),
          size: Number(a.size) || 0,
        })).filter((a) => a.id)
      : [],
    created: meta.created || new Date().toISOString(),
    updated: meta.updated || meta.created || new Date().toISOString(),
  };
}

// A safe, human-readable Drive filename for a note.
export function noteFilename(note) {
  const base = (note.title || firstLine(note.body) || 'note')
    .slice(0, 60)
    .replace(/[\\/:*?"<>|#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'note'}.md`;
}

function firstLine(s) {
  return (s || '').split('\n').find((l) => l.trim()) || '';
}

// Short preview text for the list view.
export function notePreview(note) {
  const text = (note.body || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 140);
}
