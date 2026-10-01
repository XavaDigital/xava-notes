// Writes cases.json: Markdown note files and what the app's own JavaScript
// (public/js/note.js) reads from them. MarkdownNoteTest checks that the PHP port
// in app/Notes/MarkdownNote.php reads every case the same way.
//
// Regenerate after changing note.js or frontmatter.js:
//   node tests/Fixtures/markdown/generate.mjs

import { writeFileSync } from 'node:fs';
import { noteToMarkdown, noteFromMarkdown } from '../../../public/js/note.js';

const base = {
  id: 'mfx1a2b3-abc123', fileId: null, title: '', type: 'note', body: '', notebook: '',
  done: false, completedAt: '', due: '', tags: [], subtasks: [], attachments: [],
  deleted: false, deletedAt: '', order: 0,
  created: '2026-09-01T09:00:00.000Z', updated: '2026-09-02T10:30:00.000Z',
};

// Notes written by the app itself.
const written = {
  'full task': {
    ...base, type: 'task', title: 'Ring the bank', body: 'About the **loan**.\n\n- one\n- two',
    notebook: 'Home', done: true, completedAt: '2026-09-03T08:00:00.000Z', due: '2026-09-05',
    tags: ['money', 'calls'], subtasks: [{ text: 'Find the number', done: true }, { text: 'Ask about: rates', done: false }],
    order: 1727740800000.5,
  },
  'quotes, colons, unicode': {
    ...base, title: 'She said "hi": café ☕', body: 'Line with "quotes" and a back\\slash.\n',
    notebook: 'Notes: misc', tags: ['ünïcode'],
  },
  'in trash': { ...base, title: 'Old idea', body: 'gone', deleted: true, deletedAt: '2026-09-04T00:00:00.000Z' },
  'with attachments': {
    ...base, title: 'Receipt', attachments: [
      { id: '1AbCdEf', name: 'receipt.pdf', mime: 'application/pdf', size: 12345 },
      { id: '1XyZ', name: 'photo one.jpg', mime: 'image/jpeg', size: 99 },
    ],
  },
  'note with a date': { ...base, title: 'Dentist', due: '2026-10-10' },
  'empty title, body only': { ...base, body: 'Just a body line\nand another' },
};

// Files as they might be found in Drive: hand edits, old formats, odd values.
// Windows line endings are left out on purpose: the JavaScript ignores every
// frontmatter line in such a file, and the PHP reader deliberately reads them
// properly (MarkdownNoteTest covers that separately).
const raw = {
  'no frontmatter, heading title': ['Groceries list.md', '# Groceries\n\nmilk\nbread\n'],
  'no frontmatter, title from filename': ['Phone numbers.md', 'Sam 021 555 1234\n'],
  'numbers and bare values': ['y.md', '---\nid: num-1\ntitle: 2024\ntags: [2024, 1.50, plain, "quoted, still split"]\norder: 7\ndone: false\ncreated: 2026-02-02T00:00:00.000Z\n---\n\n\nbody after blank lines\n'],
  'unknown keys and junk lines': ['z.md', '---\nid: "junk-1"\nmood: "fine"\nthis line has no colon\n  stray indent: 3\ntitle: "Kept"\n---\nbody\n'],
  'malformed subtasks': ['s.md', '---\nid: "sub-1"\ntype: "task"\nsubtasks: [a, b]\nattachments:\n  - name: "no id"\n  - id: "has-id"\n    size: "12"\n---\n'],
  'title in frontmatter and heading': ['t.md', '---\nid: "both-1"\ntitle: "From meta"\n---\n# From heading\n\nbody\n'],
  'escaped quote and backslash': ['q.md', '---\nid: "q-1"\ntitle: "a \\"b\\" c\\\\d"\n---\n'],
};

const cases = [];
for (const [name, note] of Object.entries(written)) {
  const markdown = noteToMarkdown(note);
  cases.push({ name, fileName: 'note.md', markdown, expected: noteFromMarkdown(markdown, 'note.md'), volatile: [] });
}
for (const [name, [fileName, markdown]] of Object.entries(raw)) {
  const expected = noteFromMarkdown(markdown, fileName);
  // Fields the JavaScript fills with a fresh id or "now" can't be compared exactly.
  const volatile = [];
  if (!/^id:/m.test(markdown)) volatile.push('id');
  if (!/^created:/m.test(markdown)) volatile.push('created', 'updated');
  cases.push({ name, fileName, markdown, expected, volatile });
}

for (const c of cases) delete c.expected.version;
writeFileSync(new URL('./cases.json', import.meta.url), JSON.stringify(cases, null, 2) + '\n');
console.log(`wrote ${cases.length} cases`);
