// R12: a model's answer as a reader expects it — paragraphs, headings, lists, quotes, fenced code and inline code, bold and
// italics — drawn as React elements (never HTML from the answer: nothing it says becomes markup, a link stays text with its address
// shown, so an answer cannot make the page ask another host). Anything this reader does not know stays the text it is.
import { Fragment } from 'react';

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text, key) {
  const out = [];
  let at = 0;
  let m;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const s = m[0];
    if (m[1]) out.push(<code key={`${key}-${m.index}`}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={`${key}-${m.index}`}>{s.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={`${key}-${m.index}`}>{s.slice(1, -1)}</em>);
    else if (m[4]) { const t = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(s); out.push(<span key={`${key}-${m.index}`} className="ta-md-link" title={t[2]}>{t[1]} <span className="ta-muted">({t[2]})</span></span>); }
    at = m.index + s.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** The blocks of an answer: fenced code, headings, list runs, quotes and paragraphs. */
export function blocksOf(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // a fence opens with ``` and any info string (```bash [name:hello]): its first word is the language
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // the closing fence (or the end, while it streams)
      blocks.push({ kind: 'code', lang: (/^\s*([\w+-]+)/.exec(fence[1]) || [])[1] || '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ kind: 'h', level: h[1].length, text: h[2] }); i += 1; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')); i += 1; }
      blocks.push({ kind: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])) { para.push(lines[i]); i += 1; }
    // (every pass moves on: a line no rule above took is a paragraph of its own)
    if (!para.length) { para.push(line); i += 1; }
    blocks.push({ kind: 'p', text: para.join('\n') });
  }
  return blocks;
}

export function Markdown({ text }) {
  const blocks = blocksOf(text);
  return (
    <div className="ta-md">
      {blocks.map((b, n) => {
        const k = `b${n}`;
        if (b.kind === 'code') return <pre key={k} className="ta-md-code" data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
        if (b.kind === 'h') return <p key={k} className={`ta-md-h ta-md-h${b.level}`}>{inline(b.text, k)}</p>;
        if (b.kind === 'ul') return <ul key={k}>{b.items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>)}</ul>;
        if (b.kind === 'ol') return <ol key={k}>{b.items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>)}</ol>;
        if (b.kind === 'quote') return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
        return <p key={k}>{b.text.split('\n').map((l, j) => <Fragment key={j}>{j ? <br /> : null}{inline(l, `${k}-${j}`)}</Fragment>)}</p>;
      })}
    </div>
  );
}
