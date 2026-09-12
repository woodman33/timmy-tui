// ui-cockpit-k7m3 C6 — DEMO. "The cockpit with eight hands on screen is a
// film shot." This takes that shot the way src/demo/cast.ts takes the
// war-room demo: frozen clock, TIMMY_DEMO=1 (nothing launches), the HANDS
// board rendered through ink-testing-library at 120 columns (proof detail)
// and 80 (legibility check). --rounds <chart> stages a COPY of the chart in a
// throwaway root with an empty fixture store — the operator's private overlay
// is never read or written on that path; no --rounds means the private board
// under cwd is the subject. Then, only after EVERY frame passes the privacy
// gate (§12): the text captures land in .timmy/captures/, the 120-column
// beats become an asciinema v2 cast (+ gif/mp4 through agg/ffmpeg), a
// manifest binds every hash, and one `cockpit.shot` seal cites them. A frame
// carrying a personal string refuses the whole shot before any file exists.
//
//   timmy cockpit shot --rounds lanes/demos/hands-8.rounds.md
//   timmy cockpit shot                       # the private board
//   --out <dir> (default .timmy/captures) --marker <tag> (default ck6-<commit7>)
//   --no-film (skip agg/ffmpeg) --no-seal --json
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// frozen clock — same instant as demo.cast so the render is byte-deterministic
const NOW = 1767225600000; // 2026-01-01T00:00:00.000Z
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [number]));
  }
  static now(): number { return NOW; }
}
(globalThis as unknown as { Date: typeof Date }).Date = FrozenDate as unknown as typeof Date;

const WIDE = 120;
const NARROW = 80;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const json = args.includes('--json');
const fail = (msg: string, code = 1): never => {
  if (json) console.log(JSON.stringify({ ok: false, note: msg }));
  else console.error(`cockpit shot: ${msg}`);
  process.exit(code);
};

interface Beat { name: string | null; width: number; hold: number; text: string }

async function main(): Promise<void> {
  const cwd = process.cwd();
  const outDir = resolve(cwd, flag('--out') ?? join('.timmy', 'captures'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const sourceCommit = head.status === 0 ? head.stdout.trim() : 'unknown';
  const marker = flag('--marker') ?? `ck6-${sourceCommit.slice(0, 7)}`;
  const rounds = flag('--rounds');

  // 1. the board. A fixture chart is copied into a throwaway root so that
  //    board.source stays repo-relative (never an absolute path into a home
  //    directory) and the shell reads an empty, deterministic store.
  const ck = await import('../harness/cockpit.js');
  const saved = { root: process.env.TIMMY_REPO_ROOT, store: process.env.TIMMY_STORE, demo: process.env.TIMMY_DEMO };
  let boardKind: 'fixture' | 'private' = 'private';
  if (rounds) {
    const src = resolve(cwd, rounds);
    if (!existsSync(src)) fail(`no such ROUNDS chart: ${rounds}`, 2);
    const root = mkdtempSync(join(tmpdir(), 'cockpit-shot-'));
    const rel = relative(cwd, src);
    const staged = join(root, rel.startsWith('..') ? basename(src) : rel);
    mkdirSync(join(staged, '..'), { recursive: true });
    copyFileSync(src, staged);
    process.env.TIMMY_REPO_ROOT = root;
    process.env.TIMMY_STORE = join(root, '.timmy', 'receipts');
    // the fixture store's receipt ids draw on Math.random — seed it (as
    // demo.cast does) so the header's chain head, and therefore every frame,
    // is byte-identical from one take to the next on the same machine
    let prngState = 0x2f6e2b1 >>> 0;
    (Math as unknown as { random: () => number }).random = () => {
      prngState = (prngState + 0x6d2b79f5) >>> 0;
      let t = prngState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const r = ck.importRounds(staged);
    if (!r.ok) fail(`import failed: ${r.note}`);
    boardKind = 'fixture';
  }
  process.env.TIMMY_DEMO = '1';
  const board = ck.loadBoard();
  if (!board) return fail('no board — pass --rounds <ROUNDS.md> or import one first (timmy cockpit board import)', 2);
  const names = board.hands.map(h => h.name.slice(0, 10));

  // 2. the beats — scripted keys, frames grabbed between them
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  const { ShellV2 } = await import('../tui/components/ShellV2.js');
  const beats: Beat[] = [];
  const handsUp = (f: string) => f.includes('HANDS') && names.every(n => f.includes(n));
  const take = async (width: number, script: (api: {
    press: (key: string, ms?: number) => Promise<void>;
    settle: (pred: (f: string) => boolean, ms?: number) => Promise<void>;
    grab: (name: string | null, hold: number) => void;
  }) => Promise<void>) => {
    const view = render(React.createElement(ShellV2, { width }));
    // ink lays the root out at stdout.columns (the testing stub says 100 through a
    // prototype getter) — shadow it so the rail is not clipped at column 100
    Object.defineProperty(view.stdout, 'columns', { value: width, configurable: true });
    Object.defineProperty(view.stdout, 'rows', { value: 60, configurable: true });
    const press = async (key: string, ms = 140) => { view.stdin.write(key); await sleep(ms); };
    const settle = async (pred: (f: string) => boolean, ms = 10000) => {
      // performance.now is NOT the frozen Date.now — timeouts stay real
      const t0 = performance.now();
      for (;;) {
        if (pred(view.lastFrame() ?? '') || performance.now() - t0 > ms) return;
        await sleep(60);
      }
    };
    const grab = (name: string | null, hold: number) => beats.push({ name, width, hold, text: view.lastFrame() ?? '' });
    await script({ press, settle, grab });
    view.unmount();
  };
  await take(WIDE, async ({ press, settle, grab }) => {
    await press('6'); await settle(f => f.includes('[h] hands'));          // COMMAND
    await press('h'); await settle(handsUp);                               // HANDS beside SWARM
    grab(`${marker}-cockpit-hands-${WIDE}`, 2.4);                          // THE SHOT: every hand on screen
    for (let i = 0; i < 4; i++) { await press('\x1b[C'); }                 // cursor walks R0 → R4
    grab(null, 0.8);
    await press('\r'); await settle(f => /prompt \S+ R\d/.test(f));        // [Enter] opens the cell's prompt
    grab(`${marker}-cockpit-hands-prompt-${WIDE}`, 2.4);
    await press('\x1b'); await sleep(200);                                 // Esc closes the viewer
    grab(null, 0.8);
  });
  await take(NARROW, async ({ press, settle, grab }) => {
    await press('6'); await settle(f => f.includes('[h] hands'));
    await press('h'); await settle(handsUp);
    grab(`${marker}-cockpit-hands-${NARROW}`, 2.0);                        // legibility check
  });
  if (!beats.every(b => handsUp(b.text) || b.text.includes('prompt '))) {
    return fail(`the board never settled on screen (hands: ${names.join(' ')})`);
  }

  // the frames are frozen-clock renders; everything from here on (files,
  // manifest, seal) carries the wall clock again — a seal never claims the
  // demo instant as its own time
  (globalThis as unknown as { Date: typeof Date }).Date = RealDate;

  // 3. the gate — every frame, before any byte is written (§12)
  const gate = ck.gateFrames(beats.map((b, i) => ({ name: b.name ?? `${marker}-beat-${i}`, width: b.width, text: b.text })));
  if (!gate.ok) return fail(String(gate.note));
  // the seal (and nothing else) lands on the invoking session's own chain
  for (const [k, v] of [['TIMMY_REPO_ROOT', saved.root], ['TIMMY_STORE', saved.store], ['TIMMY_DEMO', saved.demo]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  // 4. captures, cast, film, manifest
  mkdirSync(outDir, { recursive: true });
  const shots = beats.filter(b => b.name).map(b => {
    writeFileSync(join(outDir, b.name as string), b.text);
    return { name: b.name as string, sha256: sha(b.text), width: b.width, lines: b.text.split('\n').length };
  });
  const wide = beats.filter(b => b.width === WIDE);
  const height = Math.max(24, ...wide.map(b => b.text.split('\n').length));
  const castName = `${marker}-cockpit-hands.cast`;
  const castPath = join(outDir, castName);
  let t = 0;
  const lines = [JSON.stringify({ version: 2, width: WIDE, height, timestamp: Math.floor(NOW / 1000), env: { SHELL: '/bin/bash', TERM: 'xterm-256color' } })];
  // a pty carries \r\n; a bare \n is a line feed without carriage return and
  // staircases every line in an emulator (agg, asciinema play)
  for (const b of wide) { lines.push(JSON.stringify([Number(t.toFixed(3)), 'o', `\x1b[2J\x1b[H${b.text.replace(/\r?\n/g, '\r\n')}`])); t += b.hold; }
  writeFileSync(castPath, lines.join('\n') + '\n');
  const castBuf = readFileSync(castPath);
  let gif: { file: string; sha256: string } | null = null;
  let mp4: { file: string; sha256: string } | null = null;
  const notes: string[] = [];
  if (!args.includes('--no-film')) {
    const gifPath = join(outDir, `${marker}-cockpit-hands.gif`);
    const mp4Path = join(outDir, `${marker}-cockpit-hands.mp4`);
    const agg = spawnSync('agg', [castPath, gifPath], { encoding: 'utf8', timeout: 120000 });
    if (agg.status === 0 && existsSync(gifPath)) {
      gif = { file: basename(gifPath), sha256: sha(readFileSync(gifPath)) };
      const ff = spawnSync('ffmpeg', ['-y', '-i', gifPath, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', 'faststart', '-pix_fmt', 'yuv420p', mp4Path], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (ff.status === 0 && existsSync(mp4Path)) mp4 = { file: basename(mp4Path), sha256: sha(readFileSync(mp4Path)) };
      else notes.push(`ffmpeg: ${(ff.stderr ?? '').trim().split('\n').pop() ?? 'failed'}`);
    } else notes.push(`agg: ${agg.error ? agg.error.message : (agg.stderr ?? '').trim().split('\n').pop() ?? 'failed'}`);
  }
  const manifest = {
    v: 1,
    order: 'ui-cockpit-k7m3',
    checkpoint: 'C6',
    marker,
    source_commit: sourceCommit,
    board: { kind: boardKind, source: board.source, hands: board.hands.length, sha256: sha(JSON.stringify(board)) },
    shots,
    film: { cast: { file: castName, sha256: sha(castBuf), frames: wide.length, width: WIDE, height, seconds: Number(t.toFixed(1)) }, gif, mp4 },
    gate: { frames: gate.frames, findings: 0, patterns_sha256: gate.patterns_sha256 },
    deterministic: 'frozen-clock + throwaway-root + TIMMY_DEMO',
    notes,
  };
  const manifestName = `manifest-${marker}.json`;
  const manifestPath = join(outDir, manifestName);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');

  // 5. the seal — through sealCockpit, the only seal path cockpit code may use
  let sealed: string | null = null;
  if (!args.includes('--no-seal')) {
    const r = ck.sealCockpit('cockpit.shot', {
      marker, source_commit: sourceCommit, board_kind: boardKind, board_source: String(board.source ?? ''), hands: String(board.hands.length),
      shots: shots.map(s => `${s.name}:${s.sha256.slice(0, 12)}`).join(' '),
      cast_sha256: sha(castBuf), manifest: `${manifestName}:${sha(readFileSync(manifestPath)).slice(0, 12)}`,
      gate: `${gate.frames} frames · 0 findings · patterns ${gate.patterns_sha256.slice(0, 12)}`,
      deterministic: 'frozen-clock + throwaway-root + TIMMY_DEMO',
    });
    if (!r.ok) return fail(`seal refused: ${r.note}`);
    sealed = r.hash ?? null;
  }
  const summary = { ok: true, marker, source_commit: sourceCommit, board: manifest.board, out: outDir, shots: shots.map(s => `${s.name} ${s.sha256.slice(0, 12)}`), cast: `${castName} ${sha(castBuf).slice(0, 12)} · ${wide.length} frames · ${height} rows · ${t.toFixed(1)}s`, gif: gif?.file ?? null, mp4: mp4?.file ?? null, manifest: manifestName, gate: manifest.gate, notes, sealed };
  console.log(JSON.stringify(summary, null, json ? 0 : 1));
}

main().catch(e => fail(e instanceof Error ? e.message : String(e)));
