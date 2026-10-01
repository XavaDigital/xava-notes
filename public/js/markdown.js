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

// --- HTML -> Markdown (for the WYSIWYG editor; browser only) ------------

function inlineStyleWrap(el, inner) {
  const t = inner.trim();
  if (!t) return inner;
  const st = (el.getAttribute('style') || '').toLowerCase();
  let s = t;
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(st)) s = `**${s}**`;
  if (/font-style\s*:\s*italic/.test(st)) s = `_${s}_`;
  if (/text-decoration[^;]*line-through/.test(st)) s = `~~${s}~~`;
  if (/background(-color)?\s*:\s*(?!transparent|rgba\(0,\s*0,\s*0,\s*0\))[^;]+/.test(st)) s = `==${s}==`;
  return s;
}

function isChecklistItem(li) {
  return (li.classList && li.classList.contains('md-task')) ||
    !!li.querySelector(':scope > .md-cb');
}

function listToMd(listEl, ordered) {
  let out = '';
  let i = 1;
  listEl.querySelectorAll(':scope > li').forEach((li) => {
    const inner = nodeToMd(li).trim();
    if (isChecklistItem(li)) {
      const checked = li.querySelector(':scope > .md-cb.on') ? 'x' : ' ';
      out += `- [${checked}] ${inner}\n`;
    } else if (ordered) {
      out += `${i++}. ${inner}\n`;
    } else {
      out += `- ${inner}\n`;
    }
  });
  return out;
}

function nodeToMd(node) {
  let md = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) { md += child.textContent.replace(/\s+/g, ' '); return; }
    if (child.nodeType !== 1) return;
    const tag = child.tagName.toLowerCase();
    if (tag === 'br') { md += '\n'; return; }
    if (tag === 'hr') { md += '\n---\n'; return; }
    if (tag === 'ul') { md += '\n' + listToMd(child, false) + '\n'; return; }
    if (tag === 'ol') { md += '\n' + listToMd(child, true) + '\n'; return; }
    if (tag === 'pre') { md += `\n\`\`\`\n${child.textContent.trim()}\n\`\`\`\n`; return; }
    if (tag === 'span' && child.classList.contains('md-cb')) return; // checkbox marker

    const inner = nodeToMd(child);
    const t = inner.trim();
    switch (tag) {
      case 'h1': md += `\n# ${t}\n`; break;
      case 'h2': md += `\n## ${t}\n`; break;
      case 'h3': case 'h4': case 'h5': case 'h6': md += `\n### ${t}\n`; break;
      case 'strong': case 'b': md += t ? `**${t}**` : ''; break;
      case 'em': case 'i': md += t ? `_${t}_` : ''; break;
      case 'del': case 's': case 'strike': md += t ? `~~${t}~~` : ''; break;
      case 'mark': md += t ? `==${t}==` : ''; break;
      case 'u': md += inner; break;
      case 'code': case 'tt': md += t ? '`' + t + '`' : ''; break;
      case 'blockquote': md += `\n> ${t}\n`; break;
      case 'li': md += `- ${t}\n`; break; // stray <li>
      case 'a': {
        const href = child.getAttribute('href');
        md += href ? `[${t || href}](${href})` : inner;
        break;
      }
      case 'p': case 'div': md += inner.replace(/\n+$/, '') + '\n'; break;
      case 'span': case 'font': md += inlineStyleWrap(child, inner); break;
      default: md += inner;
    }
  });
  return md;
}

export function htmlToMarkdown(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  return nodeToMd(root)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
