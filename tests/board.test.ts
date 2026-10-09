// The project reference board (round R2): a read-only HTML snapshot of the active project whose cards
// link to the real files (relative links) and show the Timmy command that acts on each.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject, projectId } from '../src/project/index.js';
import { renderBoard, readObservationRecord, type BoardInput, type BoardObservation } from '../src/repl/board.js';
import { COMMANDS } from '../src/repl/commands.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { resetLookChecks } from '../src/vision/look.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const SHA = 'ab'.repeat(32);
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const section = (html: string, cls: string): string[] => [...html.matchAll(new RegExp(`<section class="${cls}"[^>]*>([\\s\\S]*?)</section>`, 'g'))].map((m) => m[1]);
afterEach(async () => {
  resetLookChecks();
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

/** A record read as the board reads it, with the provenance check /board would have made. */
const VERIFIED = { status: 'verified' as const, reasons: [], receipt: '1a2b3c4d' };
const read = (file: string, record: unknown, check: BoardObservation['check'] = VERIFIED): BoardObservation => {
  const obs = readObservationRecord(file, record);
  if (!obs) throw new Error('the fixture observation did not read');
  return { ...obs, ...(check ? { check } : {}) };
};

function fixture(): BoardInput {
  const obs = read('results/observations/card-20261009-090000.json', RECORD);
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
    expect(claim[0]).toContain('no admitted evidence: a claim, not a measurement');
    expect(claim[0]).not.toContain('640 × 480');
    expect(claim[0]).not.toContain('#112233');
    // The source image is drawn beside the observation.
    expect(html.match(/<img src="\.\.\/\.\.\/refs\/card\.png"/g)?.length).toBe(2);
  });

  // Round R2, from the Mac's board: a model's Markdown showed its marks (**QR Code**). Bold and code are
  // drawn after the text is escaped, so a claim can carry no markup of its own.
  it("a claim's **bold** and `code` are drawn; anything else in it stays text", () => {
    const input = fixture();
    const answer = 'This card shows:\n1. **QR Code** (top left)\n2. `CARD-0042` and **<b>x</b>** and <script>alert(1)</script>';
    const obs = readObservationRecord('results/observations/x.json', { ...RECORD, interpretation: { ...RECORD.interpretation, answer } });
    input.observations = obs ? [obs] : [];
    const claim = section(renderBoard(input), 'claim')[0];
    expect(claim).toContain('<strong>QR Code</strong>');
    expect(claim).toContain('<code>CARD-0042</code>');
    expect(claim).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    expect(claim).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(claim).not.toContain('**');
    expect(claim).toContain('1. ');
  });

  // The independent review of 7f2505d: `**` as an operator vanished, and bold ran inside code.
  it("a claim's ** used as an operator stays, and code keeps its asterisks", () => {
    const input = fixture();
    const answer = 'a ** b ** c, then `2 ** 3 ** 2`';
    const obs = readObservationRecord('results/observations/x.json', { ...RECORD, interpretation: { ...RECORD.interpretation, answer } });
    input.observations = obs ? [obs] : [];
    const claim = section(renderBoard(input), 'claim')[0];
    expect(claim).toContain('a ** b ** c, then <code>2 ** 3 ** 2</code>');
    expect(claim).not.toContain('<strong>');
  });

  it('a model that did not answer is said so, and no claim is drawn', () => {
    const input = fixture();
    input.observations = [read('results/observations/x.json', { ...RECORD, interpretation: { status: 'refused', model: 'deepseek/deepseek-chat', question: 'What?', reason: 'it does not take images' } })];
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
    input.observations = [read('results/observations/x.json', { ...RECORD, look: { ...RECORD.look, measurements: [{ name: 'dominant_colors', value: [{ hex: 'red;background:url(x)', share: 1 }], tier: 'deterministic computation' }] } })];
    const html = renderBoard(input);
    expect(section(html, 'measured')[0]).toContain('(not a #rrggbb colour)');
    expect(html).not.toContain('url(');
  });

  // The review of 40022d9: every parsed value was shown as a deterministic measurement, whatever its tier.
  it('shows as measured only what is marked deterministic computation; anything else is not verified', () => {
    const input = fixture();
    const mixed = {
      ...RECORD,
      look: {
        ...RECORD.look,
        measurements: [
          { name: 'sharpness', value: 123.456, unit: 'variance of the Laplacian (relative)', tier: 'deterministic computation' },
          { name: 'mean_color', value: { hex: '#0a141e' }, unit: 'sRGB', tier: 'model interpretation' },
          { name: 'edge_density', value: 0.5, unit: 'fraction of pixels' },
          { value: 'no name at all', tier: 'deterministic computation' },
          'just a string',
        ],
      },
    };
    input.observations = [read('results/observations/x.json', mixed)];
    const html = renderBoard(input);
    const measured = section(html, 'measured');
    const unverified = section(html, 'unverified');
    expect(measured).toHaveLength(1);
    expect(unverified).toHaveLength(1);
    expect(measured[0]).toContain('123.456');
    for (const v of ['#0a141e', 'edge_density', '0.5', 'no name at all', 'just a string']) expect(measured[0]).not.toContain(v);
    expect(unverified[0]).toMatch(/not verified/);
    // Each value says what tier it was recorded with, and none is drawn or worded as a measurement.
    expect(unverified[0]).toContain('mean_color');
    expect(unverified[0]).toContain('tier: model interpretation');
    expect(unverified[0]).toContain('edge_density');
    expect(unverified[0]).toContain('no tier recorded');
    expect(unverified[0]).toContain('no name at all');
    expect(unverified[0]).toContain('just a string');
    expect(unverified[0]).not.toContain('class="swatch"');
    expect(unverified[0]).not.toContain('Mean colour');
    expect(unverified[0]).not.toContain('% of pixels');
    expect(unverified[0]).not.toContain('123.456');
  });

  it('a card that is not verified shows why, and draws nothing as measured', () => {
    for (const check of [
      { status: 'unverified' as const, reasons: ['no observe receipt names this file'] },
      { status: 'stale' as const, reasons: ['refs/card.png changed since it was observed'] },
    ]) {
      const input = fixture();
      input.observations = [read('results/observations/x.json', RECORD, check)];
      const html = renderBoard(input);
      expect(section(html, 'measured')).toEqual([]);
      const unverified = section(html, 'unverified');
      expect(unverified).toHaveLength(1);
      // The values are still there to read, as recorded: the image size and each value with its tier.
      expect(unverified[0]).toContain('640 × 480');
      expect(unverified[0]).toContain('sharpness');
      expect(unverified[0]).toContain('recorded as deterministic computation');
      expect(html).toContain(`status-${check.status}`);
      expect(html).toContain(check.reasons[0]);
      // A model's claim stays a claim.
      expect(section(html, 'claim')[0]).toContain('A grey test card.');
    }
    // An observation the board was given no check for is not verified either.
    const input = fixture();
    input.observations = [read('results/observations/x.json', RECORD, null)];
    const html = renderBoard(input);
    expect(section(html, 'measured')).toEqual([]);
    expect(html).toContain('status-unverified');
    expect(html).toContain('its provenance was not checked');
  });

  // AGENTS.md §4: a model's answer is qualified only by admitted references (src/vision/evidence.ts).
  it("a claim shows its admitted references when the record carries them, and otherwise says it has none", () => {
    const withEvidence = (evidence: unknown, check: BoardObservation['check'] = VERIFIED): string => {
      const input = fixture();
      input.observations = [read('results/observations/x.json', { ...RECORD, interpretation: { ...RECORD.interpretation, evidence } }, check)];
      return section(renderBoard(input), 'claim')[0];
    };
    const admitted = {
      admission: 'admitted_references', run_id: 'run-1', source_revision: SHA, semantic_correctness_verified: false, raw_output: '{}',
      handles: [{ handle_id: 'ev:1111aaaa-0000-4000-8000-000000000000', measurement: 'qr_codes_decoded' }, { handle_id: 'ev:2222bbbb-0000-4000-8000-000000000000', measurement: 'mean_color' }],
    };
    const yes = withEvidence(admitted);
    expect(yes).toContain('admitted references');
    expect(yes).toContain('qr_codes_decoded');
    expect(yes).toContain('mean_color');
    expect(yes).toContain('ev:1111aaaa');
    expect(yes).toMatch(/not that it is right/);
    expect(yes).not.toContain('no admitted evidence');
    expect(yes).not.toContain('not a deterministic value in this record');
    // In a file that is not verified, the admission is only as recorded.
    expect(withEvidence(admitted, { status: 'unverified', reasons: ['no observe receipt names this file'] })).toMatch(/as recorded in a file that is not verified/);
    // A reference to a value the record does not hold as deterministic is said to be so.
    const odd = withEvidence({ ...admitted, handles: [{ handle_id: 'ev:3333', measurement: 'depth_guess' }] });
    expect(odd).toContain('depth_guess [not a deterministic value in this record]');

    const refused = withEvidence({ admission: 'unknown', reason: 'uncited_handle', run_id: 'run-1', source_revision: SHA, raw_output: '{}' });
    expect(refused).toContain('no admitted evidence: a claim, not a measurement');
    expect(refused).toContain('uncited_handle');
    expect(refused).not.toContain('admitted references');

    for (const none of [undefined, { admission: 'admitted_references', handles: 'ev:1' }, { admission: 'admitted_references', handles: [] }, 'admitted']) {
      const claim = withEvidence(none);
      expect(claim).toContain('no admitted evidence: a claim, not a measurement');
      expect(claim).not.toContain('admitted references');
    }
  });

  it('a verified card says which receipt sealed it', () => {
    const html = renderBoard(fixture());
    expect(html).toContain('status-verified');
    expect(html).toMatch(/verified[^<]*<\/strong>[^<]*receipt 1a2b3c4d/);
    expect(section(html, 'unverified')).toEqual([]);
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
    expect(obs?.measurements.every((m) => m.tier === 'deterministic computation')).toBe(true);
    expect(readObservationRecord('x.json', { hello: 1 })).toBeNull();
    expect(readObservationRecord('x.json', null)).toBeNull();
    expect(readObservationRecord('x.json', [])).toBeNull();
  });

  it("keeps each value's tier as recorded, and keeps a malformed entry instead of dropping it", () => {
    const obs = readObservationRecord('a.json', { ...RECORD, look: { ...RECORD.look, measurements: [
      { name: 'a', value: 1, tier: 'deterministic computation' },
      { name: 'b', value: 2, tier: 'model interpretation' },
      { name: 'c', value: 3 },
      { name: 'd', value: 4, tier: { sneaky: true } },
      42,
    ] } });
    expect(obs?.measurements.map((m) => [m.name, m.tier, m.malformed ?? false])).toEqual([
      ['a', 'deterministic computation', false],
      ['b', 'model interpretation', false],
      ['c', undefined, false],
      ['d', undefined, true],
      ['(an entry with no name)', undefined, true],
    ]);
  });

  it('drops a source path that is absolute or climbs out of the project', () => {
    expect(readObservationRecord('a.json', { ...RECORD, source: { path: '/etc/passwd', sha256: SHA } })?.source).toBeUndefined();
    expect(readObservationRecord('a.json', { ...RECORD, source: { path: '../../x.png', sha256: SHA } })?.source).toBeUndefined();
  });
});

function make(root: string, extra: Partial<WorkspaceDeps> = {}) {
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
    // Sealed as appendReceipt seals: each receipt's hash is the hash of its own body.
    receipts: () => sealed.map((r, i) => {
      const body = { v: 1, id: `rc_${i}`, stream: 'runs', ts: '2026-10-09T09:00:01.000Z', ...r, prev_hash: 'genesis' };
      return { ...body, hash: hashOf({ ...body, hash: '' }) };
    }) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, opened, sealed };
}

const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
/** Writes an observation file into the project and, unless told not to, seals its observe receipt as /observe does. */
function observation(root: string, sealed: ReceiptInput[], rel: string, record: typeof RECORD, o: { seal?: boolean } = {}): string {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  put(root, rel, body);
  if (o.seal !== false) {
    sealed.push({
      kind: 'observe', subject: `observe · ${record.source.path}`, policy: 'human-gated', status: 'ok', project: 'demo', project_id: projectId(folderProject(root).root),
      files: [{ path: record.source.path, sha256: record.source.sha256 }], outputs: [{ path: rel, sha256: sha256(body), bytes: Buffer.byteLength(body) }],
      observation: { tiers: record.tiers, worker: 'timmy-look 1.0.0', measurements: record.look.measurements.length },
    });
  }
  return body;
}
const LOOKED = { ...RECORD, source: { path: 'refs/card.png', sha256: sha256(PNG) }, look: { ...RECORD.look, ok: true, worker: { name: 'timmy-look', version: '1.0.0' } } };

describe('/board in the workspace', () => {
  it('writes .timmy/board/index.html from the project, opens it, and names no absolute path', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'refs/<script>x.png', PNG);
    put(root, 'BUILD.md', '# Build\n\n```bash [name:setup]\necho setup\n```\n\n```bash [name:build, deps:setup]\necho build\n```\n');
    put(root, 'dist/index.html', '<p>hi</p>');
    const { ws, opened, sealed } = make(root);
    observation(root, sealed, 'results/observations/card-20261009-090000.json', LOOKED);
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
    expect(html).toContain('status-verified');
    expect(section(html, 'claim')[0]).toContain('A grey test card.');
    // The observation files are shown as observations, not again as outputs.
    expect(html.match(/data-cmd="\/open results\/observations\/card-20261009-090000\.json"/g)).toHaveLength(1);
    for (const p of new Set([root, realpathSync(root), tmpdir(), homedir()])) expect(html).not.toContain(p);
    expect(html).not.toMatch(/https?:\/\//);
  });

  // The review of 40022d9: an observation file is editable; only a sealed one about an unchanged image is verified.
  it("checks each observation against the project's receipts and its image, and says so on the card", () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'refs/other.png', Buffer.concat([PNG, Buffer.from('other')]));
    const { ws, sealed } = make(root);
    const sealedRel = 'results/observations/card-20261009-090000.json';
    const editedRel = 'results/observations/card-20261009-090001.json';
    const unsealedRel = 'results/observations/card-20261009-090002.json';
    const staleRel = 'results/observations/other-20261009-090003.json';
    observation(root, sealed, sealedRel, { ...LOOKED, made_at: '2026-10-09T09:00:00.000Z' });
    // Edited after it was sealed: one value changed by hand.
    const body = observation(root, sealed, editedRel, { ...LOOKED, made_at: '2026-10-09T09:00:01.000Z' });
    put(root, editedRel, body.replace('123.456', '999.999'));
    // Written by hand: no receipt names it.
    observation(root, sealed, unsealedRel, { ...LOOKED, made_at: '2026-10-09T09:00:02.000Z' }, { seal: false });
    // Sealed, but its image changed afterwards.
    observation(root, sealed, staleRel, { ...LOOKED, made_at: '2026-10-09T09:00:03.000Z', source: { path: 'refs/other.png', sha256: sha256(Buffer.concat([PNG, Buffer.from('other')])) } });
    put(root, 'refs/other.png', Buffer.concat([PNG, Buffer.from('changed')]));

    ws.board('');
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    const cards = [...html.matchAll(/<article class="card obs">([\s\S]*?)<\/article>/g)].map((m) => m[1]);
    expect(cards).toHaveLength(4);
    const card = (rel: string): string => cards.find((c) => c.includes(`data-cmd="/open ${rel}"`)) ?? '';
    // Newest first, as before.
    expect(cards[0]).toContain(staleRel);

    expect(card(sealedRel)).toContain('status-verified');
    expect(card(sealedRel)).toMatch(/<section class="measured">/);

    expect(card(editedRel)).toContain('status-unverified');
    expect(card(editedRel)).toContain('changed after it was sealed');
    expect(card(editedRel)).not.toMatch(/<section class="measured">/);
    expect(card(editedRel)).toContain('999.999');

    expect(card(unsealedRel)).toContain('status-unverified');
    expect(card(unsealedRel)).toContain('no observe receipt names this file');
    expect(card(unsealedRel)).not.toMatch(/<section class="measured">/);

    expect(card(staleRel)).toContain('status-stale');
    expect(card(staleRel)).toContain('refs/other.png changed since it was observed');
    expect(card(staleRel)).not.toMatch(/<section class="measured">/);
    for (const p of new Set([root, realpathSync(root), tmpdir(), homedir()])) expect(html).not.toContain(p);
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

const python = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' }).status === 0 ? 'python3' : null;

describe.skipIf(!python)('/board after a real /observe (OpenCV is importable here)', () => {
  it('shows what the real Look worker measured, in plain words, under its label', async () => {
    const root = temp('proj-');
    const out = temp('outside-');
    const gen = [
      'import cv2, numpy as np, sys',
      'img = np.full((400, 600, 3), 255, np.uint8)',
      "qr = cv2.QRCodeEncoder.create().encode('timmy-board-test')",
      'qr = cv2.resize(qr, (qr.shape[1] * 6, qr.shape[0] * 6), interpolation=cv2.INTER_NEAREST)',
      'qr = cv2.cvtColor(qr, cv2.COLOR_GRAY2BGR) if qr.ndim == 2 else qr',
      'h, w = qr.shape[:2]',
      'img[20:20 + h, 20:20 + w] = qr',
      "if hasattr(cv2, 'aruco'):",
      '    m = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), 7, 160)',
      '    img[60:220, 400:560] = cv2.cvtColor(m, cv2.COLOR_GRAY2BGR)',
      'cv2.imwrite(sys.argv[1], img)',
    ].join('\n');
    expect(spawnSync(python!, ['-c', gen, join(out, 'card.png')], { encoding: 'utf8' }).status).toBe(0);
    const which = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim() || null;
    const { ws, opened } = make(root, { onPath: (c) => (c === 'python3' ? which : null) });
    expect(text(ws.add(join(out, 'card.png')))).toMatch(/refs\/card\.png\s+image/);
    const started = await ws.observeFile('refs/card.png');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);

    expect(text(ws.board(''))).toMatch(/Observations 1/);
    expect(opened).toHaveLength(1);
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    const measured = section(html, 'measured');
    expect(measured).toHaveLength(1);
    // The observe receipt /observe sealed names exactly this file, and the image is unchanged.
    expect(html).toContain('status-verified');
    expect(section(html, 'unverified')).toEqual([]);
    expect(measured[0]).toContain('600 × 400 px, 3 channels');
    expect(measured[0]).toContain('timmy-board-test');
    expect(measured[0]).toMatch(/<span class="swatch" style="background:#ffffff"><\/span>#ffffff \d+(\.\d+)?%/);
    expect(measured[0]).toMatch(/Sharpness<\/dt><dd>\d/);
    expect(measured[0]).toMatch(/Edge density<\/dt><dd>\d+(\.\d+)?% of pixels/);
    if (!measured[0].includes('ArUco marker ids</dt><dd>not measured')) expect(measured[0]).toContain('ArUco marker ids</dt><dd>7</dd>');
    // No question was asked: no model claim, and none is invented.
    expect(section(html, 'claim')).toEqual([]);
    expect(html).toContain(`data-cmd="/open ${outcome.file}"`);
    for (const p of new Set([root, realpathSync(root), out, tmpdir(), homedir()])) expect(html).not.toContain(p);
  });
});
