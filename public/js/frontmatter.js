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

  // Generic block-list state: a key followed by indented "- field: val" items
  // is parsed as an array of objects (used for subtasks and attachments).
  let listKey = null;
  let list = null;
  let current = null;

  const flushList = () => {
    if (!listKey) return;
    if (current) { list.push(current); current = null; }
    if (list.length) meta[listKey] = list;
    listKey = null;
    list = null;
  };

  for (const line of lines) {
    if (line.trim() === '') continue;

    // Inside a block list (indented lines).
    if (listKey && /^\s+/.test(line)) {
      const itemStart = /^\s*-\s*(.*)$/.exec(line);
      if (itemStart) {
        if (current) list.push(current);
        current = {};
        const kv = /^(\w+):\s*(.*)$/.exec(itemStart[1]);
        if (kv) current[kv[1]] = parseScalar(kv[2]);
        continue;
      }
      const kv = /^\s*(\w+):\s*(.*)$/.exec(line);
      if (kv && current) {
        current[kv[1]] = parseScalar(kv[2]);
        continue;
      }
      continue;
    } else if (listKey) {
      flushList(); // de-indented: the block list ended
    }

    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];

    if (val.trim() === '') {
      // A key with no inline value begins a block list of objects.
      listKey = key;
      list = [];
      current = null;
      continue;
    }
    if (val.trim().startsWith('[')) {
      meta[key] = parseInlineArray(val);
    } else {
      meta[key] = parseScalar(val);
    }
  }

  flushList();

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
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (typeof value[0] === 'object' && value[0] !== null) {
        // Block list of objects (subtasks, attachments, …).
        lines.push(`${key}:`);
        for (const obj of value) {
          Object.entries(obj).forEach(([k, v], i) => {
            const prefix = i === 0 ? '  - ' : '    ';
            lines.push(`${prefix}${k}: ${serializeValue(v)}`);
          });
        }
      } else {
        // Inline array of scalars (tags).
        lines.push(`${key}: ${serializeValue(value)}`);
      }
      continue;
    }
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push('---', '');
  return lines.join('\n') + (body || '');
}
