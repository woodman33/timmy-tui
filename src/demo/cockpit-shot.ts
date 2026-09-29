/** Privacy-gated captures of the HANDS board. This read-only Ink view uses
 * the shell's cursor reducer without starting the full shell's live services.
 * Captures are presentation artifacts, never model evidence or native qualification.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { loadPatterns, scanText } from '../../lanes/privacy/scan.mjs';
import { cockpitDir, parseRounds, sealCockpit, type Board } from '../harness/cockpit.js';
import { initialShell, shellOnKey } from '../tui/shell-mode.js';
import { visibleWidth } from '../tui/utils/text.js';

const NOW = 1767225600000;
const MAX_TEXT = 1024 * 1024;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const FIXTURE_SHA = '40d13fca6ff8ec39e513ac13e34e1777ea8629ebb0fe4a49c50db492bc21da41';
export interface ShotFrame { name: string; width: 80 | 120; hold: number; text: string }
export interface CockpitShotOptions { cwd?: string; rounds?: string; out?: string; marker?: string; film?: boolean; seal?: boolean }
interface CaptureContext { board: Board; label: string; root: string; store: string }
interface RendererResult { status: number | null; error?: unknown }
export class CockpitShotSealError extends Error {
  constructor(readonly refusal: ReturnType<typeof sealCockpit>) {
    super('Capture published but receipt sealing failed; capture is unsealed.');
    this.name = 'CockpitShotSealError';
  }
}
export interface CockpitShotDependencies {
  capture?: (context: CaptureContext) => Promise<ShotFrame[]>;
  render?: (command: 'agg' | 'ffmpeg', argv: string[], cwd: string) => RendererResult;
  seal?: typeof sealCockpit;
}

function readBounded(path: string, limit = MAX_TEXT): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error('Cockpit artifact is not a bounded regular file.');
    const body = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < body.length) {
      const read = readSync(fd, body, offset, body.length - offset, offset);
      if (read === 0) throw new Error('Cockpit artifact changed during capture.');
      offset += read;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Cockpit artifact changed during capture.');
    return body;
  } finally { closeSync(fd); }
}
function gate(text: string, name: string, patterns: ReturnType<typeof loadPatterns>): void {
  const hit = scanText(text, name, patterns, 'cockpit-shot').find(h => h.severity !== 'review');
  if (hit) throw new Error(`Privacy refused ${name}: ${hit.pattern}; no capture published.`);
}

async function captureBoard({ board, label }: CaptureContext): Promise<ShotFrame[]> {
  const React = await import('react');
  const { Box, Text, render } = await import('ink');
  let state: ReturnType<typeof initialShell> = { ...initialShell(), tab: 'COMMAND', handsOn: true };
  const frames: ShotFrame[] = [];
  const take = async (name: string, width: 80 | 120, hold: number) => {
    const hand = board.hands[state.handsRow];
    const rows = [label, 'HANDS · R0–R4 · declared board values',
      ...board.hands.flatMap((h, index) => [
        `${index === state.handsRow ? '▶' : ' '} ${h.name} · ${h.tool} · ${h.state}`,
        `  ${h.worktree} · ${h.order} · declared seal ${h.lastSeal}`,
      ]), `cursor ${hand?.name ?? '—'} R${state.handsCol}`];
    if (state.handsPrompt && hand) rows.push(`prompt ${hand.name} R${state.handsCol}`, board.prompts?.[hand.name]?.[`R${state.handsCol}`] ?? 'no prompt recorded');
    let text = '';
    const stdout = new Writable({ write(chunk, _encoding, done) { text = String(chunk); done(); } });
    Object.defineProperty(stdout, 'columns', { value: width });
    const stdin = new PassThrough();
    const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const view = render(React.createElement(Box, { flexDirection: 'column', width },
      ...rows.map((row, index) => React.createElement(Text, { key: index }, row))), {
      stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: stderr as NodeJS.WriteStream,
      debug: true, exitOnCtrlC: false, patchConsole: false,
    });
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (!text.includes('HANDS') || !text.includes(label)) throw new Error('Cockpit view did not render.');
      frames.push({ name, width, hold, text });
    } finally { view.unmount(); view.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
  };
  await take('hands-120', 120, 2.4);
  for (let i = 0; i < 4; i++) state = shellOnKey(state, 'right').state;
  await take('cursor-120', 120, 0.8);
  state = shellOnKey(state, 'Enter').state;
  await take('prompt-120', 120, 2.4);
  state = shellOnKey(state, 'Esc').state;
  await take('closed-120', 120, 0.8);
  await take('hands-80', 80, 2);
  return frames;
}

/** Dependencies are for offline tests; injected captures are explicitly labeled. */
export async function runCockpitShot(options: CockpitShotOptions = {}, dependencies: CockpitShotDependencies = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const out = resolve(cwd, options.out ?? '.timmy/captures');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000 });
  const sourceCommit = head.status === 0 && /^[a-f0-9]{40,64}$/.test(head.stdout.trim()) ? head.stdout.trim() : 'unknown';
  const marker = options.marker ?? `ck6-${sourceCommit.slice(0, 7)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(marker)) throw new Error('Marker must be 1–64 plain letters, digits, underscores or hyphens.');
  const destination = join(out, marker);
  if (existsSync(destination)) throw new Error('Capture marker already exists; choose a new marker.');
  const patterns = loadPatterns();
  const workspace = mkdtempSync(join(tmpdir(), 'timmy-cockpit-shot-'));
  let stage: string | undefined;
  let reserved = false;
  let published = false;
  try {
    let board: Board;
    let source: Buffer;
    let kind: 'synthetic-fixture' | 'provided-chart' | 'private';
    if (options.rounds) {
      source = readBounded(resolve(cwd, options.rounds));
      const parsed = parseRounds(source.toString('utf8'));
      board = { ...parsed, source: 'input.rounds.md', importedAt: new Date(NOW).toISOString() };
      kind = sha(source) === FIXTURE_SHA ? 'synthetic-fixture' : 'provided-chart';
    } else {
      source = readBounded(join(cockpitDir(cwd), 'board.json'));
      board = JSON.parse(source.toString('utf8')) as Board;
      kind = 'private';
    }
    if (!Array.isArray(board.hands) || !board.hands.length || board.hands.length > 64
      || board.hands.some(hand => !hand || ['name', 'tool', 'worktree', 'order', 'round', 'state', 'lastSeal'].some(key => typeof hand[key as keyof typeof hand] !== 'string'))
      || !board.prompts || typeof board.prompts !== 'object' || Array.isArray(board.prompts)) throw new Error('Invalid or unbounded cockpit board.');
    // Refuse terminal commands in source text rather than silently rewriting a
    // chart's declarations. The raw input and its hash remain unchanged.
    if (board.hands.some(hand => Object.values(hand).some(value => typeof value === 'string' && UNSAFE_CONTROLS.test(value)))
      || Object.values(board.prompts).some(rounds => !rounds || typeof rounds !== 'object' || Array.isArray(rounds)
        || Object.values(rounds).some(value => typeof value !== 'string' || UNSAFE_CONTROLS.test(value)))) throw new Error('Cockpit board contains invalid or unsafe terminal text.');
    const label = kind === 'synthetic-fixture' ? 'SYNTHETIC FIXTURE · no real session evidence' : kind === 'private' ? 'PRIVATE BOARD CAPTURE' : 'PROVIDED CHART · declared values';
    const boardDir = join(workspace, '.timmy/private/cockpit');
    const store = join(workspace, '.timmy/receipts');
    mkdirSync(boardDir, { recursive: true, mode: 0o700 }); mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(join(boardDir, 'board.json'), JSON.stringify(board), { mode: 0o600, flag: 'wx' });
    // Capture receives an isolated board/store directly. No environment, clock,
    // random generator, private receipt store or full-shell service is changed.
    const frames = await (dependencies.capture ?? captureBoard)({ board, label, root: workspace, store });
    if (!frames.length || frames.length > 16 || !frames.some(frame => frame.width === 80) || !frames.some(frame => frame.width === 120)) throw new Error('Capture requires bounded 80/120-column frames.');
    const frameNames = new Set<string>();
    for (const frame of frames) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(frame.name) || frameNames.has(frame.name) || ![80, 120].includes(frame.width)
        || !Number.isFinite(frame.hold) || frame.hold <= 0 || frame.hold > 30 || typeof frame.text !== 'string'
        || !frame.text.includes(label) || Buffer.byteLength(frame.text) > MAX_TEXT || UNSAFE_CONTROLS.test(frame.text)
        || frame.text.split('\n').length > 32 || frame.text.split('\n').some(line => visibleWidth(line) > frame.width)) throw new Error('Invalid, oversized or unsafe capture frame.');
      frameNames.add(frame.name); gate(frame.text, 'frame', patterns);
    }
    const renderer = dependencies.capture ? 'injected-test' : 'cockpit-read-only-ink-view';
    const publicBoard = { kind, source_sha256: sha(source), hands: board.hands.length };
    const wide = frames.filter(frame => frame.width === 120);
    const height = Math.max(24, ...wide.map(frame => frame.text.split('\n').length));
    let elapsed = 0;
    const cast = [JSON.stringify({ version: 2, width: 120, height, timestamp: NOW / 1000 })];
    for (const frame of wide) {
      cast.push(JSON.stringify([Number(elapsed.toFixed(3)), 'o', `\x1b[2J\x1b[H${frame.text.replace(/\r?\n/g, '\r\n')}`])); elapsed += frame.hold;
    }
    const castBody = cast.join('\n') + '\n';
    const shots = frames.map(frame => ({ file: `${frame.name}.txt`, sha256: sha(frame.text), width: frame.width }));
    // Preflight public metadata before creating the publication staging area.
    gate(JSON.stringify({ marker, sourceCommit, publicBoard, shots, renderer }), 'metadata', patterns);
    gate(castBody, 'cast', patterns);
    mkdirSync(out, { recursive: true });
    stage = mkdtempSync(join(out, '.cockpit-stage-')); chmodSync(stage, 0o700);
    for (const frame of frames) writeFileSync(join(stage, `${frame.name}.txt`), frame.text, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(stage, 'cockpit.cast'), castBody, { mode: 0o600, flag: 'wx' });
    const film: { cast: { file: string; sha256: string; frames: number; seconds: number }; gif: null | { file: string; sha256: string }; mp4: null | { file: string; sha256: string } } = {
      cast: { file: 'cockpit.cast', sha256: sha(castBody), frames: wide.length, seconds: Number(elapsed.toFixed(3)) }, gif: null, mp4: null,
    };
    if (options.film !== false) {
      const render = dependencies.render ?? ((command, argv, dir) => spawnSync(command, argv, { cwd: dir, shell: false, encoding: 'utf8', timeout: 180000, maxBuffer: MAX_TEXT }));
      for (const [command, argv, file] of [
        ['agg', ['cockpit.cast', 'cockpit.gif'], 'cockpit.gif'],
        ['ffmpeg', ['-n', '-i', 'cockpit.gif', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', 'faststart', '-pix_fmt', 'yuv420p', 'cockpit.mp4'], 'cockpit.mp4'],
      ] as const) {
        const result = render(command, [...argv], stage);
        if (result.error || result.status !== 0 || !existsSync(join(stage, file))) throw new Error(`${command} did not produce a successful capture; nothing published.`);
        const bytes = readBounded(join(stage, file), 64 * MAX_TEXT);
        if (!bytes.length) throw new Error(`${command} produced an empty capture; nothing published.`);
        film[command === 'agg' ? 'gif' : 'mp4'] = { file, sha256: sha(bytes) };
      }
    }
    const manifest = { schema: 'timmy.cockpit-shot/2', marker, source_commit: sourceCommit, board: publicBoard, renderer, shots, film,
      gate: { frames: frames.length, findings: 0, patterns_sha256: patterns.sha256 },
      limits: { fullShellCapture: false, nativeQualification: false, modelEvidenceAdmission: false, fixtureClaimsRealSession: false } };
    const manifestBody = JSON.stringify(manifest, null, 2) + '\n';
    gate(manifestBody, 'manifest', patterns);
    const sealMeta = { marker, source_commit: sourceCommit, board_kind: kind, source_sha256: publicBoard.source_sha256, manifest_sha256: sha(manifestBody), renderer };
    gate(JSON.stringify(sealMeta), 'seal', patterns);
    writeFileSync(join(stage, 'manifest.json'), manifestBody, { mode: 0o600, flag: 'wx' });
    mkdirSync(destination, { mode: 0o700 }); reserved = true;
    renameSync(stage, destination); stage = undefined; published = true;
    let sealed: string | null = null;
    if (options.seal !== false) {
      const receipt = (dependencies.seal ?? sealCockpit)('cockpit.shot', sealMeta);
      if (!receipt.ok || !receipt.hash) throw new CockpitShotSealError(receipt);
      sealed = receipt.hash;
    }
    return { ok: true as const, marker, directory: destination, manifest: 'manifest.json', board: publicBoard, renderer, film, sealed };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (reserved && !published) rmSync(destination, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function cockpitShotMain(args: string[], cwd = process.cwd()): Promise<number> {
  try {
    const options: CockpitShotOptions = { cwd };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--json') continue;
      if (arg === '--no-film') { options.film = false; continue; }
      if (arg === '--no-seal') { options.seal = false; continue; }
      if (!['--rounds', '--out', '--marker'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid cockpit shot arguments.');
      const key = arg.slice(2) as 'rounds' | 'out' | 'marker'; options[key] = args[++i];
    }
    console.log(JSON.stringify(await runCockpitShot(options)));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Capture failed.';
    // Unexpected filesystem/renderer errors can carry private absolute paths.
    const safe = scanText(message, 'error', loadPatterns(), 'cockpit-shot').some(hit => hit.severity !== 'review') ? 'Capture failed; private error detail withheld.' : message;
    console.error(JSON.stringify({ ok: false, error: safe }));
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await cockpitShotMain(process.argv.slice(2));
