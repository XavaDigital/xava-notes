// Minimal, dependency-free YAML-frontmatter reader/writer.
//
// We only support the small, well-defined subset that this app emits, so
// round-trips are reliable. It is also lenient: unknown lines are ignored, so
// hand edits in Drive won't break parsing.
//
// Supported in the header (between the two `---` lines):
//   key: scalar            (string | boolean | number)
//   key: [a, b, c]         (inline array of scalars)
//   subtasks:              (block list of {text, done} objects)
//     - text: "Buy milk"
//       done: false

function parseScalar(raw) {
  let v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Quoted string
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseInlineArray(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((s) => parseScalar(s)).filter((s) => s !== '');
}

export function parseFrontmatter(text) {
  const meta = {};
  let body = text || '';

  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text || '');
  if (!match) return { meta, body };

  body = text.slice(match[0].length);
  const lines = match[1].split('\n');

  let inSubtasks = false;
  let subtasks = [];
  let current = null;

  for (const line of lines) {
    if (line.trim() === '') continue;

    // Subtask block handling (indented).
    if (inSubtasks && /^\s+/.test(line)) {
      const itemStart = /^\s*-\s*(.*)$/.exec(line);
      if (itemStart) {
        if (current) subtasks.push(current);
        current = { text: '', done: false };
        const rest = itemStart[1];
        const kv = /^(\w+):\s*(.*)$/.exec(rest);
        if (kv) current[kv[1]] = parseScalar(kv[2]);
        continue;
      }
      const kv = /^\s*(\w+):\s*(.*)$/.exec(line);
      if (kv && current) {
        current[kv[1]] = parseScalar(kv[2]);
        continue;
      }
      continue;
    } else if (inSubtasks) {
      // De-indented: subtasks block ended.
      if (current) { subtasks.push(current); current = null; }
      inSubtasks = false;
    }

    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];

    if (key === 'subtasks') {
      inSubtasks = true;
      subtasks = [];
      current = null;
      continue;
    }
    if (val.trim().startsWith('[')) {
      meta[key] = parseInlineArray(val);
    } else {
      meta[key] = parseScalar(val);
    }
  }

  if (current) subtasks.push(current);
  if (inSubtasks || subtasks.length) meta.subtasks = subtasks;

  return { meta, body };
}

function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function serializeValue(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map((x) => x).join(', ') + ']';
  return quote(v);
}

export function buildFrontmatter(meta, body) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'subtasks') {
      if (!Array.isArray(value) || value.length === 0) continue;
      lines.push('subtasks:');
      for (const st of value) {
        lines.push(`  - text: ${quote(st.text || '')}`);
        lines.push(`    done: ${st.done ? 'true' : 'false'}`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}: ${serializeValue(value)}`);
      continue;
    }
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push('---', '');
  return lines.join('\n') + (body || '');
}
