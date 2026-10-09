// The project reference board (round R2): a read-only HTML snapshot of the active project whose cards
// link to the real files (relative links) and show the Timmy command that acts on each.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { renderBoard, readObservationRecord, type BoardInput } from '../src/repl/board.js';
import { COMMANDS } from '../src/repl/commands.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const SHA = 'ab'.repeat(32);
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const section = (html: string, cls: string): string[] => [...html.matchAll(new RegExp(`<section class="${cls}"[^>]*>([\\s\\S]*?)</section>`, 'g'))].map((m) => m[1]);
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RECORD = {
  observation: 1,
  made_at: '2026-10-09T09:00:00.000Z',
  project: 'demo',
  source: { path: 'refs/card.png', sha256: SHA },
  tiers: ['deterministic computation', 'model interpretation'],
  reading: 'Measurements are deterministic computations on the pixels.',
  look: {
    image: { width: 640, height: 480, channels: 3 },
    measurements: [
      { name: 'mean_color', value: { r: 10, g: 20, b: 30, hex: '#0a141e' }, unit: 'sRGB 8-bit, uncalibrated', tier: 'deterministic computation' },
      { name: 'dominant_colors', value: [{ hex: '#112233', rgb: [17, 34, 51], share: 0.75 }, { hex: '#fefefe', rgb: [254, 254, 254], share: 0.25 }], unit: 'sRGB', tier: 'deterministic computation' },
      { name: 'sharpness', value: 123.456, unit: 'variance of the Laplacian (relative)', tier: 'deterministic computation' },
      { name: 'edge_density', value: 0.0425, unit: 'fraction of pixels', tier: 'deterministic computation' },
      { name: 'qr_codes_decoded', value: [{ text: 'CARD-0042', corners: [] }], unit: 'decoded text and corner pixels', tier: 'deterministic computation' },
      { name: 'aruco_markers', value: [{ id: 7, corners: [] }, { id: 12, corners: [] }], unit: 'marker id', tier: 'deterministic computation' },
    ],
  },
  interpretation: { status: 'answered', tier: 'model interpretation', model: 'anthropic/claude-haiku-4.5', question: 'What is on the card?', answer: 'A grey test card.', cost_usd: 0.0021 },
  job: { id: 'j0a1b2c' },
};

function fixture(): BoardInput {
  const obs = readObservationRecord('results/observations/card-20261009-090000.json', RECORD);
  if (!obs) throw new Error('the fixture observation did not read');
  return {
    project: 'demo',
    madeAt: '2026-10-09 09:00 UTC',
    base: '../../',
    references: [
      { rel: 'refs/card.png', bytes: 2048, sha256: SHA, kind: 'image' },
      { rel: 'refs/brief.pdf', bytes: 100, kind: 'document' },
      { rel: 'refs/<script>x.png', bytes: 10, kind: 'image' },
    ],
    workflows: [{ rel: 'BUILD.md', blocks: [{ name: 'setup', deps: [] }, { name: 'build', deps: ['setup'] }] }],
    jobs: [{ id: 'j0a1b2c', state: 'completed', label: 'BUILD.md › build', seconds: '1.2 s', receipt: 'deadbeef' }],
    outputs: [{ rel: 'dist/index.html', bytes: 300 }],
    observations: [obs],
  };
}

describe('renderBoard', () => {
  it('has a header, the sections, and a card per file, workflow block, job and observation', () => {
    const html = renderBoard(fixture());
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('Board · demo');
    expect(html).toContain('read-only snapshot, made 2026-10-09 09:00 UTC; act with the commands shown');
    for (const h of ['References', 'Workflows', 'Jobs', 'Results', 'Outputs', 'Observations']) expect(html).toContain(`>${h}`);
    expect(html).toContain('refs/card.png');
    expect(html).toContain('2.0 KB');
    expect(html).toContain(SHA.slice(0, 12));
    expect(html).toMatch(/document/);
  });

  it('shows an image with a relative src and links every card to its file, relative to the board', () => {
    const html = renderBoard(fixture());
    expect(html).toContain('<img src="../../refs/card.png"');
    expect(html).toContain('href="../../refs/brief.pdf"');
    expect(html).toContain('href="../../dist/index.html"');
    expect(html).toContain('href="../../BUILD.md"');
    // The PDF is not drawn as an image.
    expect(html).not.toContain('src="../../refs/brief.pdf"');
    for (const m of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
      expect(m[1]).not.toMatch(/^(?:\/|[a-z][a-z0-9+.-]*:)/i);
    }
  });

  it('shows the commands that act on each card, as copyable code', () => {
    const html = renderBoard(fixture());
    for (const c of ['/observe refs/card.png', '/open refs/card.png', '/open refs/brief.pdf', '/run BUILD.md setup', '/run BUILD.md build', '/jobs j0a1b2c', '/open dist/index.html', '/open results/observations/card-20261009-090000.json']) {
      expect(html).toContain(`data-cmd="${c}"`);
    }
    expect(html).not.toContain('data-cmd="/observe refs/brief.pdf"');
    expect(html).toContain('needs setup');
    expect(html).toContain('receipt deadbeef');
    // One script only: the one that copies a command.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('navigator.clipboard');
  });

  it('keeps the measured values and the model claim in separate, labelled blocks', () => {
    const html = renderBoard(fixture());
    const measured = section(html, 'measured');
    const claim = section(html, 'claim');
    expect(measured).toHaveLength(1);
    expect(claim).toHaveLength(1);
    expect(measured[0]).toContain('measured (deterministic computation)');
    expect(measured[0]).toContain('640 × 480 px');
    expect(measured[0]).toContain('#112233');
    expect(measured[0]).toContain('75%');
    expect(measured[0]).toContain('CARD-0042');
    expect(measured[0]).toMatch(/ArUco[^<]*<\/[a-z]+>\s*<[a-z]+[^>]*>7, 12/);
    expect(measured[0]).toContain('123.456');
    expect(measured[0]).toContain('4.25%');
    expect(measured[0]).not.toContain('A grey test card.');
    expect(measured[0]).not.toContain('claude-haiku');
    expect(claim[0]).toContain('the model&#39;s claim');
    expect(claim[0]).toContain('anthropic/claude-haiku-4.5');
    expect(claim[0]).toContain('What is on the card?');
    expect(claim[0]).toContain('A grey test card.');
    expect(claim[0]).not.toContain('640 × 480');
    expect(claim[0]).not.toContain('#112233');
    // The source image is drawn beside the observation.
    expect(html.match(/<img src="\.\.\/\.\.\/refs\/card\.png"/g)?.length).toBe(2);
  });

  it('a model that did not answer is said so, and no claim is drawn', () => {
    const input = fixture();
    const obs = readObservationRecord('results/observations/x.json', { ...RECORD, interpretation: { status: 'refused', model: 'deepseek/deepseek-chat', question: 'What?', reason: 'it does not take images' } });
    input.observations = obs ? [obs] : [];
    const html = renderBoard(input);
    expect(section(html, 'claim')).toEqual([]);
    expect(html).toContain('it does not take images');
    expect(section(html, 'measured')).toHaveLength(1);
  });

  it('escapes every string: a file named <script>x.png stays text, and its link is encoded', () => {
    const html = renderBoard(fixture());
    expect(html).toContain('refs/&lt;script&gt;x.png');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('href="../../refs/%3Cscript%3Ex.png"');
    const evil = fixture();
    evil.project = '"><img src=x onerror=alert(1)>';
    evil.jobs = [{ id: 'j1', state: 'failed', label: '<b>bold</b> & "quoted"' }];
    const out = renderBoard(evil);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;');
  });

  it('a swatch takes only a colour in #rrggbb form', () => {
    const input = fixture();
    const obs = readObservationRecord('results/observations/x.json', { ...RECORD, look: { ...RECORD.look, measurements: [{ name: 'dominant_colors', value: [{ hex: 'red;background:url(x)', share: 1 }] }] } });
    input.observations = obs ? [obs] : [];
    const html = renderBoard(input);
    expect(html).not.toContain('url(');
  });

  it('an empty section says what to do', () => {
    const html = renderBoard({ project: 'empty', madeAt: 'now', base: '../../', references: [], workflows: [], jobs: [], outputs: [], observations: [] });
    expect(html).toContain('No references yet: /add &lt;file&gt;');
    expect(html).toContain('No workflows yet');
    expect(html).toContain('No jobs yet');
    expect(html).toContain('No outputs yet');
    expect(html).toContain('No observations yet: /observe &lt;image&gt;');
  });

  it('asks for nothing from elsewhere: no remote address, no fetched font; Monaspace Argon first, then monospace', () => {
    const html = renderBoard(fixture());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('@import');
    expect(html).not.toContain('@font-face');
    expect(html).toMatch(/font-family:\s*"Monaspace Argon",\s*ui-monospace[^;]*Menlo[^;]*monospace/);
  });
});

describe('readObservationRecord', () => {
  it('reads what /observe writes, and nothing that is not an observation', () => {
    const obs = readObservationRecord('results/observations/a.json', RECORD);
    expect(obs).toMatchObject({ file: 'results/observations/a.json', source: { path: 'refs/card.png' }, image: { width: 640, height: 480 } });
    expect(obs?.measurements).toHaveLength(6);
    expect(readObservationRecord('x.json', { hello: 1 })).toBeNull();
    expect(readObservationRecord('x.json', null)).toBeNull();
    expect(readObservationRecord('x.json', [])).toBeNull();
  });

  it('drops a source path that is absolute or climbs out of the project', () => {
    expect(readObservationRecord('a.json', { ...RECORD, source: { path: '/etc/passwd', sha256: SHA } })?.source).toBeUndefined();
    expect(readObservationRecord('a.json', { ...RECORD, source: { path: '../../x.png', sha256: SHA } })?.source).toBeUndefined();
  });
});

function make(root: string) {
  const notes: string[] = [];
  const opened: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: {},
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => { opened.push(url); return `Opened ${url}`; },
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, opened, sealed };
}

describe('/board in the workspace', () => {
  it('writes .timmy/board/index.html from the project, opens it, and names no absolute path', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'refs/<script>x.png', PNG);
    put(root, 'BUILD.md', '# Build\n\n```bash [name:setup]\necho setup\n```\n\n```bash [name:build, deps:setup]\necho build\n```\n');
    put(root, 'dist/index.html', '<p>hi</p>');
    put(root, 'results/observations/card-20261009-090000.json', `${JSON.stringify({ ...RECORD, source: { path: 'refs/card.png', sha256: SHA } }, null, 2)}\n`);
    const { ws, opened } = make(root);
    // A job of this project whose label carries the project's folder: the board writes it as ".".
    const job = ws.jobs.start({ kind: 'task', label: `echo ${root}/x`, project: 'demo', root, command: process.execPath, args: ['-e', ''] });
    await ws.jobs.done(job.id);

    const lines = text(ws.board(''));
    expect(lines).toContain('.timmy/board/index.html');
    expect(lines).toMatch(/References 2/);
    expect(lines).toMatch(/Workflows 1/);
    expect(lines).toMatch(/Jobs 1/);
    expect(lines).toMatch(/Outputs 1/);
    expect(lines).toMatch(/Observations 1/);

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^file:\/\/.*\/\.timmy\/board\/index\.html$/);
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).toContain('<img src="../../refs/card.png"');
    expect(html).toContain('data-cmd="/observe refs/card.png"');
    expect(html).toContain('data-cmd="/run BUILD.md build"');
    expect(html).toContain('needs setup');
    expect(html).toContain(`data-cmd="/jobs ${job.id}"`);
    expect(html).toContain('echo ./x');
    expect(html).toContain('data-cmd="/open dist/index.html"');
    expect(html).toContain('refs/&lt;script&gt;x.png');
    expect(section(html, 'measured')[0]).toContain('640 × 480 px');
    expect(section(html, 'claim')[0]).toContain('A grey test card.');
    // The observation files are shown as observations, not again as outputs.
    expect(html.match(/data-cmd="\/open results\/observations\/card-20261009-090000\.json"/g)).toHaveLength(1);
    for (const p of new Set([root, realpathSync(root), tmpdir(), homedir()])) expect(html).not.toContain(p);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('an empty project gets a board that says what to do', () => {
    const root = temp('proj-');
    const { ws, opened } = make(root);
    const lines = text(ws.board(''));
    expect(lines).toMatch(/References 0/);
    expect(opened).toHaveLength(1);
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).toContain('No references yet: /add &lt;file&gt;');
    // The board does not list itself.
    expect(html).not.toContain('board/index.html');
  });

  it('is in the LOOK group, with its /help line within 60 columns', () => {
    const board = COMMANDS.find((c) => c.name === 'board');
    expect(board?.group).toBe('look');
    expect(`  /${'board'.padEnd(11)} ${board?.description}`.length).toBeLessThanOrEqual(60);
  });
});
