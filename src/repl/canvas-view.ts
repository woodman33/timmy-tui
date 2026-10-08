/**
 * `/canvas` (round R1, gap 4): where Timmy Canvas is, who serves it, whether a page is open, what it
 * saved, and its latest job; starting it inside this REPL when nothing serves it. `/canvas open`
 * opens the page (as `/web studio` does) once it runs.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { StudioHealth } from '../studio/health.js';

/** What starting the server did: started here, found another Timmy, failed; null: not this process's to start. */
export type CanvasStart = { state: 'started' | 'already-running' } | { state: 'failed'; error: string } | null;

export interface CanvasViewDeps {
  /** Timmy Canvas's address, without a trailing slash. */
  base: string;
  ensure: () => Promise<CanvasStart>;
  health: (base: string) => Promise<StudioHealth>;
  /** Opens the page; one line saying where, or why not. */
  open: () => string;
  glyphs: GlyphSet;
}

const row = (label: string, value: string, note?: string): Segment[] => [
  { text: `  ${label.padEnd(8)} `, role: 'secondary' },
  { text: value },
  ...(note ? [{ text: ` · ${note}`, role: 'secondary' as const }] : []),
];

export async function canvasView(args: string, d: CanvasViewDeps): Promise<Segment[][]> {
  const page = `${d.base}/`;
  const start = await d.ensure();
  const fail = (why: string): Segment[][] => [[{ text: '  ' }, { text: `${d.glyphs.fail} Timmy Canvas is not running`, role: 'failure' }, { text: `: ${why}` }]];
  if (start?.state === 'failed') return fail(start.error);
  const health = await d.health(d.base);
  if (health.state !== 'running') {
    if (start === null) return [[{ text: '  ' }, { text: `${d.glyphs.fail} Timmy Canvas is not running`, role: 'failure' }, { text: ` at ${page} (TIMMY_STUDIO_URL). Start it there with timmy studio.` }]];
    return fail(health.state === 'other' ? `${page} answers, but ${health.detail}.` : `nothing answers at ${page}.`);
  }
  if (args.trim() === 'open') return [[{ text: `  ${d.open()}` }]];
  const by = start === null ? 'at TIMMY_STUDIO_URL' : start.state === 'started' ? 'served by this REPL' : 'served by another Timmy';
  const lines: Segment[][] = [row('Canvas', page, by)];
  lines.push(health.pageConnected === true
    ? row('Page', 'open')
    : health.pageConnected === false
      ? row('Page', 'not open', '/canvas open, or open the address in a browser')
      : row('Page', 'unknown', 'this Timmy Canvas is older and cannot say'));
  lines.push(row('Saved', health.revision === null ? 'unknown' : health.revision === 0 ? 'nothing saved yet' : `revision ${health.revision}`));
  const job = health.latestJob;
  lines.push(job ? row('Latest', `job ${job.id}, rev ${job.revision}`, job.receipt ? `receipt ${job.receipt}` : job.ok ? 'no receipt linked' : 'failed') : row('Latest', 'no canvas jobs yet'));
  if (health.built === false) lines.push(row('Build', 'the page is not built: npm run build:canvas'));
  return lines;
}
