/**
 * `/canvas` (round R1, gap 4): where Timmy Canvas is, who serves it, whether a page is open, what it
 * saved, and its latest job; starting it inside this REPL when nothing serves it. `/canvas open`
 * opens the page (as `/web studio` does) once it runs.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { StudioHealth } from '../studio/health.js';
import type { CanvasSeen, HandOff } from './canvas-project.js';

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
  /**
   * R4 (H55): the project the canvas shows (src/repl/canvas-project.ts): /canvas names it, and /canvas open first names this
   * REPL's active project to the canvas. Absent: neither is said.
   */
  project?: { handOff: () => Promise<HandOff>; check: () => Promise<CanvasSeen>; mine: () => { name: string; id: string } };
}

/** R4 (H55): the Project row: the project the canvas shows, and whether it is this REPL's. */
function projectRow(seen: CanvasSeen, mine: { name: string; id: string }): Segment[] {
  if (seen.state === 'running' && !seen.project) return row('Project', 'none named to it yet', `/canvas open shows ${mine.name} there`);
  if (seen.state === 'running' && seen.project) {
    return seen.project.id === mine.id ? row('Project', seen.project.name, 'this REPL\'s project, in its Project panel') : row('Project', seen.project.name, `another project; /canvas open shows ${mine.name} there`);
  }
  if (seen.state === 'older') return row('Project', 'unknown', 'this Timmy Canvas is older and cannot show projects');
  if (seen.state === 'remote') return row('Project', 'not told', 'a canvas at TIMMY_STUDIO_URL is not on this machine');
  return row('Project', 'unknown', 'the canvas did not say');
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
  if (args.trim() === 'open') {
    // R4 (H55): the page opens on this REPL's project: named to the canvas first, then opened.
    const told = d.project ? await d.project.handOff() : null;
    const opened: Segment[][] = [[{ text: `  ${d.open()}` }]];
    if (told) opened.push(told.ok ? row('Project', told.name, 'named to the canvas; its Project panel shows its cards') : row('Project', 'not shown there', told.why));
    return opened;
  }
  const by = start === null ? 'at TIMMY_STUDIO_URL' : start.state === 'started' ? 'served by this REPL' : 'served by another Timmy';
  const lines: Segment[][] = [row('Canvas', page, by)];
  lines.push(health.pageConnected === true
    ? row('Page', 'open')
    : health.pageConnected === false
      ? row('Page', 'not open', '/canvas open, or open the address in a browser')
      : row('Page', 'unknown', 'this Timmy Canvas is older and cannot say'));
  if (d.project) lines.push(projectRow(await d.project.check(), d.project.mine()));
  lines.push(row('Saved', health.revision === null ? 'unknown' : health.revision === 0 ? 'nothing saved yet' : `revision ${health.revision}`));
  const job = health.latestJob;
  lines.push(job ? row('Latest', `job ${job.id}, rev ${job.revision}`, job.receipt ? `receipt ${job.receipt}` : job.ok ? 'no receipt linked' : 'failed') : row('Latest', 'no canvas jobs yet'));
  if (health.built === false) lines.push(row('Build', 'the page is not built: npm run build:canvas'));
  return lines;
}
