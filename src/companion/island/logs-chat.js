/*
 * The `timmy logs` chat mirror's island (src/utils/chatpage.html, served at /chat; R4 H95). It was a module script inline
 * in the page that imported React 18.3.1 and an unpinned Streamdown from esm.sh. It is now this module, bundled by
 * scripts/companion-web-build.mjs with the installed React and Streamdown 2.5.0 (the same build as the browser companion's
 * chat; shared chunks) and served by the log companion itself (/web/island/...), so the page runs under script-src 'self'.
 *
 * What it does is unchanged: the left column draws the TUI's conversation turns with Streamdown in its static mode (no
 * plugins, as before), each answer with its seal when it has one; the right column is the receipt rain (the last nine).
 * Both come from /chat/events, read with the page's token in a header (timmyEvents, from the page's own token script,
 * /chat/page.js); without the token it reads nothing and the page says how to open it.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Streamdown } from 'streamdown';

const h = React.createElement;
const left = document.getElementById('left');
const right = document.getElementById('right');

function Left(props) {
  const turns = props.turns;
  if (!turns.length) return h('h1', { id: 'empty' }, 'no conversation yet — type a mission in the TUI');
  return h('div', null, turns.map((t, i) => {
    if (t.role === 'user') return h('div', { className: 'user', key: i }, t.content);
    return h('div', { className: 'assistant', key: i },
      h(Streamdown, { mode: 'static' }, t.content),
      t.seal ? h('div', { className: 'sealed' }, '● sealed ', h('b', null, t.seal)) : null);
  }));
}

const root = createRoot(left);
let turns = [];
const drops = [];
function drawLeft() { root.render(h(Left, { turns })); }
function drawRight() {
  right.replaceChildren();
  drops.slice(-9).forEach((d) => {
    const e = document.createElement('div');
    e.className = 'drop';
    const s = document.createElement('div'); s.className = 's'; s.textContent = d.subject;
    const hh = document.createElement('div'); hh.className = 'h'; hh.textContent = d.hash;
    const m = document.createElement('div'); m.className = 'm'; m.textContent = '· ' + d.kind + ' · ' + d.ts;
    e.append(s, hh, m);
    right.appendChild(e);
  });
}
left.dataset.island = 'ready';
// R4 (H84): read with fetch, the token in a header (an EventSource cannot send one); nothing without the token
const page = window;
const es = page.timmyToken && typeof page.timmyEvents === 'function' ? page.timmyEvents('/chat/events') : {};
es.onmessage = (ev) => {
  const o = JSON.parse(ev.data);
  if (o.t === 'turns') { turns = o.turns; drawLeft(); }
  else if (o.t === 'receipt') { drops.push(o); drawRight(); }
};
