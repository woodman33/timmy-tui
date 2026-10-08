/** Round R1, gap 4: `/canvas` says where Timmy Canvas is, who serves it, and what state it is in. */
import { describe, expect, it } from 'vitest';
import { canvasView, type CanvasViewDeps } from '../src/repl/canvas-view.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { StudioHealth } from '../src/studio/health.js';

const text = (lines: Array<Array<{ text: string }>>): string[] => lines.map((l) => l.map((s) => s.text).join(''));
const running = (over: Partial<Extract<StudioHealth, { state: 'running' }>> = {}): StudioHealth => ({
  state: 'running', pageConnected: false, built: true, revision: 14, jobs: 2, tldrawVersion: '5.5.2',
  latestJob: { id: 'turn-ab12cd34', ok: true, revision: 14, at: '2026-10-08T21:00:00Z', receipt: '1a2b3c4d' }, ...over,
});
const deps = (over: Partial<CanvasViewDeps> = {}): CanvasViewDeps => ({
  base: 'http://127.0.0.1:4337',
  ensure: async () => ({ state: 'started' }),
  health: async () => running(),
  open: () => 'Opened in a zellij pane.',
  glyphs: glyphSet(true),
  ...over,
});

describe('/canvas', () => {
  it('starts it when nothing serves it, then says where, the page, the saved revision and the latest job', async () => {
    expect(text(await canvasView('', deps()))).toEqual([
      '  Canvas   http://127.0.0.1:4337/ · served by this REPL',
      '  Page     not open · /canvas open, or open the address in a browser',
      '  Saved    revision 14',
      '  Latest   job turn-ab12cd34, rev 14 · receipt 1a2b3c4d',
    ]);
  });
  it('another Timmy serving it, a page open, no jobs yet', async () => {
    const lines = text(await canvasView('', deps({ ensure: async () => ({ state: 'already-running' }), health: async () => running({ pageConnected: true, jobs: 0, latestJob: null, revision: 0 }) })));
    expect(lines).toEqual([
      '  Canvas   http://127.0.0.1:4337/ · served by another Timmy',
      '  Page     open',
      '  Saved    nothing saved yet',
      '  Latest   no canvas jobs yet',
    ]);
  });
  it('a port held by another program is an error with its fix, never a canvas', async () => {
    const lines = text(await canvasView('', deps({ ensure: async () => ({ state: 'failed', error: 'Port 4337 is used by another program, not Timmy Canvas. Set TIMMY_STUDIO_PORT to a free port.' }) })));
    expect(lines).toEqual(['  ✖ Timmy Canvas is not running: Port 4337 is used by another program, not Timmy Canvas. Set TIMMY_STUDIO_PORT to a free port.']);
  });
  it('says when the page is not built, and how to build it', async () => {
    const lines = text(await canvasView('', deps({ health: async () => running({ built: false }) })));
    expect(lines).toContain('  Build    the page is not built: npm run build:canvas');
  });
  it('an address set by TIMMY_STUDIO_URL is only checked, never started here', async () => {
    let started = false;
    const lines = text(await canvasView('', deps({ base: 'http://127.0.0.1:9999', ensure: async () => { started = true; return null; }, health: async () => ({ state: 'not-running' }) })));
    expect(started).toBe(true); // asked; null means "not this process's to start"
    expect(lines).toEqual(['  ✖ Timmy Canvas is not running at http://127.0.0.1:9999/ (TIMMY_STUDIO_URL). Start it there with timmy studio.']);
  });
  it('/canvas open opens it after making sure it runs', async () => {
    expect(text(await canvasView('open', deps()))).toEqual(['  Opened in a zellij pane.']);
  });
});
