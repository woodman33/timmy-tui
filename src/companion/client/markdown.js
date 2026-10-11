/*
 * The model chat's markdown (src/companion/client/chat.js; R4 H92): it replaces Streamdown, which the page loaded with
 * React from esm.sh. marked's lexer (served by the companion from the installed package) reads the text into tokens, and
 * this module builds the page's elements for them with createElement and text nodes only: a model's or a person's words
 * are never parsed as HTML (no innerHTML, no HTML parser of any kind).
 *
 *   - Raw HTML in the text is shown as the text it is.
 *   - Links: only absolute http, https and mailto addresses become links, opened apart from this page with no referrer;
 *     any other address (javascript:, data:, a relative one) stays text, and the page says it is not linked.
 *   - Images are never loaded (the page loads nothing from elsewhere): their words are shown, with their address as a link
 *     when it is an http or https one.
 *   - A code block is its text, with its language and a Copy button; a mermaid block is shown as its source, said to be a
 *     diagram's source that is not drawn here (no diagram code runs on this page).
 *   - No element is given an id, a name, a style or an event handler from the text; classes are this module's own.
 * When marked cannot be had, or its lexer fails on a text, the text is shown as plain text.
 */

/** The only schemes a link may have. */
export const LINK_SCHEMES = Object.freeze(['http:', 'https:', 'mailto:']);

/** `raw` as a link's address when it is an absolute http, https or mailto address (as the URL parser reads it); else null. */
export function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  let url;
  try { url = new URL(raw.trim()); } catch (e) { return null; }
  return LINK_SCHEMES.includes(url.protocol) ? url.href : null;
}

// The entities marked leaves in text for an HTML renderer to have the browser decode: numeric ones, and the common names.
// An unknown name stays as it was written (shown, never guessed).
const NAMED = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', para: '¶', sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢',
  check: '✓', cross: '✗', le: '≤', ge: '≥', ne: '≠', infin: '∞',
}));

/** `s` with its character references decoded (as text: the result is only ever put in a text node). */
export function decodeEntities(s) {
  return String(s).replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
    }
    return NAMED.has(ref) ? NAMED.get(ref) : whole;
  });
}

/** At most `n` characters of `s` (an address shown as text). */
const clip = (s, n = 200) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

function make(doc, tag, cls) {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  return el;
}

const text = (doc, s) => doc.createTextNode(String(s ?? ''));

/** The text as it is, in one element (no markdown): when marked is not there, or could not read the text. */
export function plainText(value, doc = document) {
  const el = make(doc, 'div', 'md-plain');
  el.textContent = String(value ?? '');
  return el;
}

/**
 * The markdown `value` as a fragment of the page's elements. `lex`: marked's lexer (marked.lexer), or null to show the
 * text as it is. Never throws: a text the walk cannot draw is shown as plain text.
 */
export function renderMarkdown(value, lex, doc = document) {
  const frag = doc.createDocumentFragment();
  const source = String(value ?? '');
  if (typeof lex !== 'function') { frag.append(plainText(source, doc)); return frag; }
  try {
    const tokens = lex(source);
    if (!Array.isArray(tokens)) throw new Error('no tokens');
    const drawn = doc.createDocumentFragment();
    for (const t of tokens) block(drawn, t, doc);
    frag.append(drawn);
  } catch (e) {
    frag.append(plainText(source, doc));
  }
  return frag;
}

function block(parent, t, doc) {
  switch (t && t.type) {
    case 'space':
    case 'def':
      return;
    case 'heading': {
      const depth = Math.min(6, Math.max(1, Number(t.depth) || 1));
      const h = make(doc, `h${depth}`);
      inline(h, t.tokens, doc);
      parent.append(h);
      return;
    }
    case 'paragraph': {
      const p = make(doc, 'p');
      inline(p, t.tokens, doc);
      parent.append(p);
      return;
    }
    case 'text':
      if (Array.isArray(t.tokens)) inline(parent, t.tokens, doc);
      else parent.append(text(doc, decodeEntities(t.text)));
      return;
    case 'code':
      parent.append(codeBlock(t, doc));
      return;
    case 'blockquote': {
      const q = make(doc, 'blockquote');
      for (const c of t.tokens || []) block(q, c, doc);
      parent.append(q);
      return;
    }
    case 'hr':
      parent.append(make(doc, 'hr'));
      return;
    case 'list':
      parent.append(list(t, doc));
      return;
    case 'table':
      parent.append(table(t, doc));
      return;
    case 'html': {
      // raw HTML: shown as the text it is
      const raw = make(doc, 'div', 'md-raw');
      raw.textContent = String(t.text ?? t.raw ?? '').replace(/\n+$/, '');
      parent.append(raw);
      return;
    }
    default:
      if (t && typeof t.raw === 'string') parent.append(text(doc, t.raw));
  }
}

function inline(parent, tokens, doc) {
  for (const t of tokens || []) {
    switch (t && t.type) {
      case 'text':
        if (Array.isArray(t.tokens)) inline(parent, t.tokens, doc);
        else parent.append(text(doc, decodeEntities(t.text)));
        break;
      case 'escape':
        parent.append(text(doc, t.text));
        break;
      case 'strong':
      case 'em':
      case 'del': {
        const el = make(doc, t.type);
        inline(el, t.tokens, doc);
        parent.append(el);
        break;
      }
      case 'codespan': {
        const c = make(doc, 'code');
        c.textContent = String(t.text ?? '');
        parent.append(c);
        break;
      }
      case 'br':
        parent.append(make(doc, 'br'));
        break;
      case 'link':
        parent.append(link(t, doc));
        break;
      case 'image':
        parent.append(image(t, doc));
        break;
      case 'checkbox':
        parent.append(checkbox(t, doc));
        break;
      case 'html': {
        // raw HTML inside a line: shown as the text it is
        const raw = make(doc, 'span', 'md-raw');
        raw.textContent = String(t.text ?? t.raw ?? '');
        parent.append(raw);
        break;
      }
      default:
        if (t && typeof t.raw === 'string') parent.append(text(doc, t.raw));
    }
  }
}

/** An anchor to `href` (already checked by safeHref), opened apart from this page, with no referrer. */
function anchor(doc, href) {
  const a = make(doc, 'a');
  a.setAttribute('href', href);
  a.setAttribute('rel', 'noopener noreferrer');
  a.setAttribute('target', '_blank');
  return a;
}

function link(t, doc) {
  const href = safeHref(t.href);
  if (href) {
    const a = anchor(doc, href);
    if (typeof t.title === 'string' && t.title) a.setAttribute('title', decodeEntities(t.title));
    inline(a, t.tokens, doc);
    return a;
  }
  // any other address: its words, and why it is not a link
  const span = make(doc, 'span', 'md-unlinked');
  inline(span, t.tokens, doc);
  const note = make(doc, 'span', 'md-note');
  note.textContent = ` (${clip(t.href)} is not linked: only http, https and mailto addresses are)`;
  span.append(note);
  return span;
}

function image(t, doc) {
  const span = make(doc, 'span', 'md-image');
  span.append(text(doc, `[image not shown here: ${decodeEntities(t.text || 'no description')}`));
  const href = safeHref(t.href);
  if (href && href.startsWith('http')) {
    span.append(text(doc, ' · '));
    const a = anchor(doc, href);
    a.textContent = 'its address';
    span.append(a);
  }
  span.append(text(doc, ']'));
  return span;
}

function checkbox(t, doc) {
  const box = make(doc, 'span', 'md-check');
  box.textContent = t.checked ? '☑ ' : '☐ ';
  return box;
}

function list(t, doc) {
  const l = make(doc, t.ordered ? 'ol' : 'ul');
  if (t.ordered) {
    const start = Number(t.start);
    if (Number.isInteger(start) && start >= 0 && start !== 1 && start < 1e9) l.setAttribute('start', String(start));
  }
  const items = Array.isArray(t.items) ? t.items : [];
  if (items.some((i) => i && i.task)) l.classList.add('md-tasks');
  for (const item of items) {
    const li = make(doc, 'li');
    for (const c of (item && item.tokens) || []) {
      if (c && c.type === 'checkbox') { li.append(checkbox(c, doc)); continue; }
      // a tight list's text sits in the item itself
      if (c && c.type === 'text' && !item.loose) {
        if (Array.isArray(c.tokens)) inline(li, c.tokens, doc);
        else li.append(text(doc, decodeEntities(c.text)));
        continue;
      }
      block(li, c, doc);
    }
    l.append(li);
  }
  return l;
}

const ALIGN = new Set(['left', 'center', 'right']);

function table(t, doc) {
  const wrap = make(doc, 'div', 'md-table');
  const tbl = make(doc, 'table');
  const align = Array.isArray(t.align) ? t.align : [];
  const cell = (tag, c, i) => {
    const el = make(doc, tag, ALIGN.has(align[i]) ? `md-align-${align[i]}` : '');
    inline(el, c && c.tokens, doc);
    return el;
  };
  const head = make(doc, 'thead');
  const headRow = make(doc, 'tr');
  (t.header || []).forEach((c, i) => headRow.append(cell('th', c, i)));
  head.append(headRow);
  const body = make(doc, 'tbody');
  for (const row of t.rows || []) {
    const tr = make(doc, 'tr');
    (row || []).forEach((c, i) => tr.append(cell('td', c, i)));
    body.append(tr);
  }
  tbl.append(head, body);
  wrap.append(tbl);
  return wrap;
}

function codeBlock(t, doc) {
  const lang = String(t.lang ?? '').trim().split(/\s+/)[0] || '';
  const source = String(t.text ?? '');
  const diagram = lang.toLowerCase() === 'mermaid';
  const box = make(doc, 'div', diagram ? 'md-diagram' : 'md-code');
  const head = make(doc, 'div', 'md-code-head');
  const label = make(doc, 'span', diagram ? 'md-diagram-note' : 'md-lang');
  label.textContent = diagram ? 'mermaid diagram: its source, not drawn here' : (lang || 'code');
  head.append(label, copyButton(source, doc));
  const pre = make(doc, 'pre');
  const code = make(doc, 'code');
  code.textContent = source;
  pre.append(code);
  box.append(head, pre);
  return box;
}

function copyButton(source, doc) {
  const b = make(doc, 'button', 'md-copy');
  b.type = 'button';
  b.textContent = 'Copy';
  b.addEventListener('click', () => { void copyCode(source, b); });
  return b;
}

/**
 * Copies a block's text. Where the browser will not (no clipboard for this page: a page opened over plain http from another
 * device is not a secure context), the block's text is selected for the person to copy, and the button says so.
 */
async function copyCode(source, button) {
  const say = (words) => {
    button.textContent = words;
    setTimeout(() => { button.textContent = 'Copy'; }, 2500);
  };
  try {
    if (!globalThis.isSecureContext || !globalThis.navigator || !navigator.clipboard) throw new Error('no clipboard here');
    await navigator.clipboard.writeText(source);
    say('Copied');
  } catch (e) {
    const code = button.closest('.md-code, .md-diagram')?.querySelector('pre code');
    const selection = globalThis.getSelection ? getSelection() : null;
    if (code && selection) {
      const range = button.ownerDocument.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      say('Not copied: selected, press Ctrl+C or ⌘C');
    } else {
      say('Not copied');
    }
  }
}
