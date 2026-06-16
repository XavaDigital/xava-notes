// Minimal, dependency-free Markdown -> HTML for previewing notes, plus a plain
// text stripper for list previews. Input is HTML-escaped first, so the only
// tags in the output are the ones we generate (safe against injection).

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Inline formatting: links, bold, strikethrough, highlight, italic, code.
function inline(s) {
  return s
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function mdToHtml(md) {
  const lines = escapeHtml(md || '').split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol'
  let inCode = false, codeBuf = [];
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const flushCode = () => { out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`); codeBuf = []; };

  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (inCode) {
      if (fence) { inCode = false; flushCode(); } else codeBuf.push(line);
      continue;
    }
    if (fence) { closeList(); inCode = true; codeBuf = []; continue; }

    if (/^\s*$/.test(line)) { closeList(); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      closeList();
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = /^\s*&gt;\s?(.*)$/.exec(line))) {
      closeList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if ((m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      if (listType !== 'ul') { closeList(); out.push('<ul class="md-tasks">'); listType = 'ul'; }
      const checked = m[1].toLowerCase() === 'x';
      out.push(`<li class="md-task"><span class="md-cb${checked ? ' on' : ''}"></span>${inline(m[2])}</li>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inCode) flushCode();
  closeList();
  return out.join('\n');
}

// Remove Markdown markers for clean, plain-text list previews.
export function stripMarkdown(md) {
  return (md || '')
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
