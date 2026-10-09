import { Lexer } from './vendor/marked-18.0.11.esm.js';

const MAX_LENGTH = 65536;
const MAX_DEPTH = 64;
const MAX_NODES = 12000;
const MAX_MARKERS = 8192;
const entities = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026', ndash: '\u2013', mdash: '\u2014' });

// Decode text without asking the browser to parse any untrusted HTML.
function decodeText(value) {
  return String(value ?? '').replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== '#') return Object.hasOwn(entities, name) ? entities[name] : entity;
    const hex = name[1].toLowerCase() === 'x';
    const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '\ufffd';
  });
}

function safeLink(value) {
  const href = decodeText(value);
  // Require an explicit web scheme. Reject relative, protocol-relative, control
  // character and backslash URLs before the browser can normalize them.
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020\u007f\\]/.test(href)) return null;
  try {
    const url = new URL(href);
    return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/**
 * Render untrusted Markdown using Marked's lexer and an allowlisted DOM tree.
 * HTML and images never create elements; saved text is not modified. The caller
 * owns the returned fragment and styles its container with .message-markdown.
 */
export function renderMarkdown(text, document = globalThis.document) {
  const source = typeof text === 'string' ? text : '';
  const bounded = source.slice(0, MAX_LENGTH);
  const fragment = document.createDocumentFragment();
  let nodes = 0;
  const element = tag => {
    if (++nodes > MAX_NODES) throw new RangeError('Markdown node limit');
    return document.createElement(tag);
  };
  const plain = (parent, value) => {
    if (++nodes > MAX_NODES) throw new RangeError('Markdown node limit');
    parent.append(document.createTextNode(String(value ?? '')));
  };
  const children = (parent, tokens, depth = 0) => {
    if (depth > MAX_DEPTH) throw new RangeError('Markdown nesting limit');
    for (const token of tokens || []) {
      let item;
      switch (token.type) {
        case 'space': case 'def': break;
        case 'heading':
          item = element(`h${Math.min(6, Math.max(1, token.depth))}`);
          children(item, token.tokens, depth + 1); parent.append(item); break;
        case 'paragraph': case 'blockquote': case 'strong': case 'em': case 'del':
          item = element({ paragraph: 'p', blockquote: 'blockquote', strong: 'strong', em: 'em', del: 'del' }[token.type]);
          children(item, token.tokens, depth + 1); parent.append(item); break;
        case 'text':
          if (token.tokens) children(parent, token.tokens, depth + 1);
          else plain(parent, decodeText(token.text));
          break;
        case 'escape': plain(parent, token.text); break;
        case 'html': plain(parent, token.raw); break;
        case 'image': plain(parent, decodeText(token.text || 'Image')); break;
        case 'codespan':
          item = element('code'); plain(item, token.text); parent.append(item); break;
        case 'code': {
          item = element('pre');
          const code = element('code'); plain(code, token.text); item.append(code); parent.append(item); break;
        }
        case 'br': case 'hr': parent.append(element(token.type)); break;
        case 'link': {
          const href = safeLink(token.href);
          if (!href) { children(parent, token.tokens, depth + 1); break; }
          item = element('a'); item.href = href; item.target = '_blank';
          item.rel = 'noopener noreferrer'; item.referrerPolicy = 'no-referrer';
          if (token.title) item.title = decodeText(token.title);
          children(item, token.tokens, depth + 1); parent.append(item); break;
        }
        case 'list':
          item = element(token.ordered ? 'ol' : 'ul');
          if (token.ordered && Number.isSafeInteger(token.start) && token.start > 0 && token.start !== 1) item.start = token.start;
          for (const entry of token.items) {
            const li = element('li');
            if (entry.task) plain(li, entry.checked ? '\u2611 ' : '\u2610 ');
            children(li, entry.tokens, depth + 1); item.append(li);
          }
          parent.append(item); break;
        case 'table': {
          item = element('div'); item.className = 'markdown-table';
          const table = element('table'), head = element('thead'), body = element('tbody');
          const row = (cells, heading) => {
            const tr = element('tr');
            for (const [index, cell] of cells.entries()) {
              const td = element(heading ? 'th' : 'td');
              if (heading) td.scope = 'col';
              const align = token.align[index];
              if (['left', 'center', 'right'].includes(align)) td.className = `align-${align}`;
              children(td, cell.tokens, depth + 1); tr.append(td);
            }
            return tr;
          };
          head.append(row(token.header, true));
          for (const cells of token.rows) body.append(row(cells, false));
          table.append(head, body); item.append(table); parent.append(item); break;
        }
        default: plain(parent, token.raw ?? token.text ?? '');
      }
    }
  };
  try {
    // Keep delimiter-heavy adversarial input out of the recursive lexer. Large
    // replies still remain readable through the same plain-text fallback.
    let markers = 0;
    for (const char of bounded) {
      if ('[]*_>`|'.includes(char) && ++markers > MAX_MARKERS) throw new RangeError('Markdown complexity limit');
    }
    children(fragment, Lexer.lex(bounded, { gfm: true, breaks: false }));
  } catch {
    // Malformed or excessively nested output remains readable as plain text.
    const fallback = document.createElement('div'); fallback.className = 'markdown-plain';
    fallback.textContent = bounded; fragment.replaceChildren(fallback);
  }
  if (source.length > MAX_LENGTH) {
    const notice = document.createElement('p');
    notice.textContent = 'Showing the first 65,536 characters of this reply.';
    fragment.append(notice);
  }
  return fragment;
}
