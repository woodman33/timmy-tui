// tui.spike (warroom-t3b1): HOME ported to @opentui/core to measure against
// ink. Shares journey/bus/keymap by import (not copy). Mouse: click a journey
// row → its receipt; click a tab → switch.
import { createCliRenderer, BoxRenderable, TextRenderable } from '@opentui/core';
import { readChain, type Receipt } from '../utils/receipts.js';
import { journeyRows } from '../tui/journey.js';
import { subscribe } from '../bus/index.js';
import { TABS } from '../tui/shell-mode.js';

const renderer = await createCliRenderer({ exitOnCtrlC: true });
const chain = readChain('runs');
const rows = journeyRows(chain);
let tab = 0;
let selected: Receipt | null = null;
let lastEvent = 'none';

const root = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', height: '100%' });
renderer.root.add(root);

const colorOf = (s: string): string =>
  s === 'sealed' || s === 'done' ? '#33FF66' : s === 'next' ? '#FF8C1A' : s === 'REFUSED' ? '#FF3B3B' : '#8899aa';

const added: unknown[] = [];
function paint(): void {
  for (const a of added.splice(0)) (root as { remove: (r: unknown) => void }).remove(a);
  const head = String(chain[chain.length - 1]?.hash ?? '—').slice(7, 15);
  root.add(new TextRenderable(renderer, { content: `TIMMY-OT   chain · ${head}   bus ${lastEvent}` }));
  root.add(new TextRenderable(renderer, {
    content: TABS.map((t, i) => (i === tab ? `[${t}]` : ` ${t} `)).join(''),
  }));
  if (tab === 0) {
    rows.forEach((r, i) => {
      const line = new TextRenderable(renderer, {
        content: `${r.state === 'done' ? '✓' : r.state === 'next' ? '▶' : ' '} ${r.step.verb.padEnd(10)} ${r.fact.slice(0, 60)}`,
        fg: colorOf(r.state),
      });
      line.onMouseDown = () => { selected = r.receipt; paint(); };
      root.add(line); added.push(line);
      void i;
    });
    if (selected) root.add(new TextRenderable(renderer, { content: `selected: ${selected.hash.slice(0, 16)} ${selected.subject.slice(0, 50)}`, fg: '#dfe8f5' }));
  } else {
    root.add(new TextRenderable(renderer, { content: `${tab === 2 ? `RECEIPTS ${chain.length}` : `tab ${TABS[tab]} (spike: HOME only ported)`}` }));
  }
}
paint();
console.error("PAINTED added=" + added.length);

renderer.on('mouse', (e: { type?: string; x?: number; y?: number }) => {
  if (e.type === 'down' || e.type === 'mousedown') {
    const y = e.y ?? 0;
    if (y === 1) { // tab row
      const x = e.x ?? 0;
      let acc = 0;
      TABS.forEach((t, i) => { const w = t.length + 2; if (x >= acc && x < acc + w) tab = i; acc += w; });
      paint();
    }
  }
});

subscribe(ev => {
  const e = ev as { kind?: string; ts?: string };
  lastEvent = `${e.kind ?? '?'}@${String(e.ts ?? '').slice(11, 19)}`;
  paint();
});

process.on('SIGTERM', () => { renderer.destroy(); process.exit(0); });
