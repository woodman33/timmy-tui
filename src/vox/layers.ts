/**
 * Timmy VoxVision (round R4, helper H61): the viewer layers, an advanced and opt-in way to look at a record's files.
 *
 *   Rerun     `/vox view <record id> [rerun]` (and the live board's View in Rerun) opens a record's inputs and highlights
 *             in Rerun's own viewer, the `rerun` program found by TIMMY_RERUN or on the PATH: `rerun <files…>`. Its
 *             built-in loaders read images, meshes (.stl, .obj, .glb, .gltf), point clouds (.ply) and video (.mp4), and
 *             pick a loader by a file's name; so each file is checked by its bytes and its name before it is passed, and
 *             every file not passed is said with why. Only files whose bytes now are the bytes the record names are
 *             passed. Two meshes or point clouds are shown together (a 3D overlay) only when they share a known frame
 *             and unit (src/vox/frames.ts): an STL or a PLY declares no unit, so a record of two shows the first alone.
 *             The viewer is a window on the user's computer, started apart from Timmy (detached), which Timmy never
 *             stops. It shows the files as they are and measures nothing: no value of the record comes from it.
 *             R4 (H70): it is told to listen on this computer only (`--bind 127.0.0.1`, RERUN_BIND), and a rerun whose
 *             --help lacks that option is not started; a STEP is given as its tessellation (src/vox/tessellate.ts).
 *   Viser     not used by VoxVision yet: a "needs setup" row with its install step and what it would add
 *   FiftyOne  likewise
 *
 * Readiness is said from configuration and the files present, never by running anything: found is not working.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import type { VoxKind } from './kinds.js';
import type { Readiness, ToolEnv, ToolStatus } from './tools.js';
import { together, type VoxFrame } from './frames.js';

/** Rerun's setup step, short enough for a /tools row (no link: Timmy cannot check one). */
export const RERUN_SETUP = "cargo install rerun-cli --locked, or Rerun's release from its site";
export const RERUN_NAME = "Rerun's viewer (/vox view)";
/**
 * R4 (H70): Rerun's viewer is told to listen on this computer only. Without it `rerun <files>` hosts its local viewer
 * server on all interfaces (r20 saw *:9876 on the Mac). `--bind <BIND>` ("What bind address IP to use", default
 * 0.0.0.0) is in Rerun's CLI reference (docs/content/reference/cli.md on its main branch, read through Context7 on
 * 2026-10-10) and in the --help of Rerun 0.37.1 (the operator's Mac, r20) and of Rerun 0.38.1 (read where Timmy is
 * developed). A found rerun whose own --help does not list it is not started (rerunTakesBind).
 */
export const RERUN_BIND = { flag: '--bind', address: '127.0.0.1', known: "Rerun 0.37.1's and 0.38.1's --help, and Rerun's current CLI reference" } as const;
export const rerunBindArgs = (): string[] => [RERUN_BIND.flag, RERUN_BIND.address];
/** How long a found rerun's --help may take, and the most of it read. */
const HELP_TIMEOUT_MS = 20_000;
const HELP_MAX = 256 * 1024;
/** The option's line in clap's help: `      --bind <BIND>` (long help) or `  -b, --bind <BIND>  …` (short help). */
const BIND_LINE = /^[ \t]*(?:-[A-Za-z0-9], +)?--bind(?:[ =<\t]|$)/m;

/**
 * R4 (H70): whether a found rerun takes `--bind`: its own --help (exit 0) lists the option. Running --help opens no
 * window and listens on nothing. Anything else (no such option, an error, no answer in time) is a reason not to start
 * it, since started without the option it would listen on all interfaces.
 */
export function rerunTakesBind(o: { command: string; env: NodeJS.ProcessEnv; cwd: string }): Promise<{ ok: true } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    let out = '';
    let ended = false;
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;
    const end = (r: { ok: true } | { ok: false; why: string }): void => { if (ended) return; ended = true; if (timer) clearTimeout(timer); resolve(r); };
    try {
      child = spawn(o.command, ['--help'], { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { end({ ok: false, why: `its --help could not be run (${e instanceof Error ? e.message : String(e)})` }); return; }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } end({ ok: false, why: `its --help gave no answer in ${HELP_TIMEOUT_MS / 1000} s, so whether it takes ${RERUN_BIND.flag} is not known` }); }, HELP_TIMEOUT_MS);
    const take = (b: Buffer): void => { if (out.length < HELP_MAX) out += b.toString('utf8'); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.once('error', (e) => end({ ok: false, why: `its --help could not be run (${e.message})` }));
    child.once('close', (code, signal) => {
      if (code !== 0) end({ ok: false, why: `its --help ended with ${code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`}, so whether it takes ${RERUN_BIND.flag} is not known` });
      else if (!BIND_LINE.test(out)) end({ ok: false, why: `its --help lists no ${RERUN_BIND.flag} option, so started it would listen on all interfaces` });
      else end({ ok: true });
    });
  });
}
/** What Rerun's built-in loaders read, as the rows and /vox say it. */
export const RERUN_READS = 'images (PNG, JPEG, GIF, WebP), meshes (.stl, .obj, .glb, .gltf), point clouds (.ply), video (.mp4)';

/** The layers VoxVision does not use yet: their install step and what each would add, one line each. */
export const LATER_LAYERS = [
  {
    tool: 'viser' as const, name: 'Viser', setup: 'pip install viser', reads: 'meshes, point clouds and camera frames, in a browser tab',
    adds: 'an interactive 3D scene in a browser tab that a Python script updates live: meshes, point clouds and camera frames with sliders and buttons',
  },
  {
    tool: 'fiftyone' as const, name: 'FiftyOne', setup: 'pip install fiftyone', reads: 'image datasets with labels and predictions',
    adds: "a browsable dataset of the project's images with their labels and model predictions side by side, to find duplicates and mistakes",
  },
];

const runnable = (file: string): boolean => { try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true; } catch { return false; } };

/** Rerun's viewer: TIMMY_RERUN (an absolute path to a runnable file) first, else `rerun` on the PATH. */
export function rerunReady(t: ToolEnv): Readiness {
  const given = t.env.TIMMY_RERUN?.trim();
  if (given) {
    if (!isAbsolute(given)) return { ready: false, why: 'TIMMY_RERUN is set, but not to an absolute path', setup: "set TIMMY_RERUN to the rerun program's absolute path, or unset it" };
    if (!runnable(given)) return { ready: false, why: 'TIMMY_RERUN is set, but nothing runnable is there', setup: "set TIMMY_RERUN to the rerun program's absolute path, or unset it" };
    return { ready: true, command: given, via: 'set by TIMMY_RERUN' };
  }
  const found = t.onPath('rerun');
  if (!found) return { ready: false, why: 'rerun is not on the PATH and TIMMY_RERUN is not set', setup: RERUN_SETUP };
  return { ready: true, command: found, via: 'rerun on the PATH' };
}

/** The layers' rows in VoxVision's tools panel (and /tools): Rerun found or needs setup; Viser and FiftyOne need setup. */
export function layerStatuses(t: ToolEnv): ToolStatus[] {
  const r = rerunReady(t);
  return [
    r.ready
      ? { tool: 'rerun', name: RERUN_NAME, reads: RERUN_READS, state: 'found', detail: `${r.via}; found is not run: /vox view <record> starts it, a window on your computer` }
      : { tool: 'rerun', name: RERUN_NAME, reads: RERUN_READS, state: 'needs setup', detail: r.why, setup: r.setup },
    ...LATER_LAYERS.map((l): ToolStatus => ({
      tool: l.tool, name: l.name, reads: l.reads, state: 'needs setup', setup: l.setup,
      detail: `VoxVision has no ${l.name} layer yet, so nothing checks for it here; it would add ${l.adds}`,
    })),
  ];
}

// ── which files Rerun's loaders read ───────────────────────────────────────────

export type RerunLoader = 'image' | 'mesh' | 'point cloud' | 'video';

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'mp71']);
/** What a file's first bytes say, as far as a viewer's loader cares. */
function bytesSay(head: Buffer): string | undefined {
  const at = (s: string, offset = 0): boolean => head.length >= offset + s.length && head.subarray(offset, offset + s.length).toString('latin1') === s;
  if (at('\x89PNG\r\n\x1a\n')) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (at('GIF87a') || at('GIF89a')) return 'gif';
  if (at('RIFF') && at('WEBP', 8)) return 'webp';
  if (at('ftyp', 4)) {
    const brand = head.subarray(8, 12).toString('latin1').toLowerCase();
    if (MP4_BRANDS.has(brand)) return 'mp4';
    if (brand === 'qt  ') return 'quicktime';
    return `an ISO media file (brand ${brand.trim() || 'none'})`;
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (at('ply\n') || at('ply\r\n')) return 'ply';
  if (at('glTF')) return 'glb';
  if (at('ISO-10303-21;')) return 'step';
  if (at('BLENDER')) return 'blend';
  if (at('<svg') || (at('<?xml') && head.toString('latin1').includes('<svg'))) return 'svg';
  return undefined;
}
const WORDS: Record<string, string> = {
  png: 'a PNG', jpeg: 'a JPEG', gif: 'a GIF', webp: 'a WebP image', mp4: 'an MP4', quicktime: 'a QuickTime movie', webm: 'a WebM video',
  ply: 'a PLY', glb: 'a binary glTF (GLB)', step: 'a STEP', blend: 'a .blend', svg: 'an SVG drawing',
};
const IMAGE_EXT: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif', '.webp': 'webp' };

/**
 * Whether Rerun's built-in loaders read a file, by its name (Rerun picks a loader by it) and its first bytes (which must
 * agree): the loader and the format, or why not.
 */
export function rerunLoaderFor(rel: string, head: Buffer): { loader: RerunLoader; format: string } | { why: string } {
  const ext = extname(rel).toLowerCase();
  const said = bytesSay(head);
  const disagree = (): { why: string } => ({ why: `its name says ${ext} but its bytes are ${said ? WORDS[said] ?? said : 'not that format'}: Rerun picks a loader by the name, so it is not passed` });
  if (IMAGE_EXT[ext]) return said === IMAGE_EXT[ext] ? { loader: 'image', format: IMAGE_EXT[ext] } : disagree();
  if (ext === '.stl' || ext === '.obj') return said ? disagree() : { loader: 'mesh', format: ext.slice(1) };
  if (ext === '.glb') return said === 'glb' ? { loader: 'mesh', format: 'glb' } : disagree();
  if (ext === '.gltf') return !said && head.toString('latin1').trimStart().startsWith('{') ? { loader: 'mesh', format: 'gltf' } : disagree();
  if (ext === '.ply') return said === 'ply' ? { loader: 'point cloud', format: 'ply' } : disagree();
  if (ext === '.mp4') return said === 'mp4' ? { loader: 'video', format: 'mp4' } : disagree();
  if (said === 'quicktime' || said === 'webm') return { why: `${WORDS[said]} by its bytes: Rerun's video loader reads MP4 only` };
  if (ext === '.step' || ext === '.stp' || said === 'step') return { why: "Rerun's viewer has no STEP loader (a STEP is CAD, not a mesh): /measure reads it with OCP" };
  if (ext === '.blend' || said === 'blend') return { why: "Rerun's viewer has no .blend loader: Blender opens it" };
  if (ext === '.svg' || said === 'svg') return { why: "an SVG drawing: Rerun's viewer reads no SVG (the board shows it)" };
  if (ext === '.heic' || ext === '.heif') return { why: "Rerun's image loader does not read HEIC" };
  return { why: `Rerun's viewer has no loader for ${ext ? `${ext} files` : 'a file without an extension'}` };
}

// ── a view's plan ──────────────────────────────────────────────────────────────

export interface ViewCandidate {
  path: string;
  /** the file's sha256 the record names; `now` its sha256 now (null: gone; undefined: cannot be read) */
  sha256?: string;
  now: string | null | undefined;
  head: Buffer;
  role?: 'a' | 'b' | 'both';
  /** an input's kind and frame (for the overlay rule), or a highlight */
  kind?: VoxKind;
  frame?: VoxFrame;
  highlight?: { shown: boolean; why?: string };
}
export interface ViewPlan {
  pass: Array<{ path: string; sha256: string; loader: RerunLoader; format: string; role?: 'a' | 'b' | 'both' }>;
  refused: Array<{ path: string; why: string }>;
}

/**
 * What a view gives Rerun: each input and highlight whose bytes now are the bytes the record names, of a format its
 * loaders read; at most one mesh or point cloud unless they share a known frame and unit. Everything else, with why.
 */
export function planView(files: readonly ViewCandidate[]): ViewPlan {
  const plan: ViewPlan = { pass: [], refused: [] };
  const spatial: ViewCandidate[] = [];
  for (const f of files) {
    if (f.highlight && !f.highlight.shown) { plan.refused.push({ path: f.path, why: `a highlight not shown on the board: ${f.highlight.why ?? 'not checked'}` }); continue; }
    if (!f.sha256) { plan.refused.push({ path: f.path, why: 'the record names no sha256 for it' }); continue; }
    if (f.now === null) { plan.refused.push({ path: f.path, why: 'it is gone since the record' }); continue; }
    if (f.now === undefined) { plan.refused.push({ path: f.path, why: 'it cannot be read now' }); continue; }
    if (f.now !== f.sha256) { plan.refused.push({ path: f.path, why: `it changed since the record (sha256 ${f.now.slice(0, 12)} now, ${f.sha256.slice(0, 12)} recorded): Rerun would show other bytes than the record's` }); continue; }
    const l = rerunLoaderFor(f.path, f.head);
    if ('why' in l) { plan.refused.push({ path: f.path, why: l.why }); continue; }
    if (l.loader === 'mesh' || l.loader === 'point cloud') {
      const first = spatial[0];
      if (first) {
        const t = first.kind && f.kind && first.frame && f.frame ? together({ kind: first.kind, frame: first.frame }, { kind: f.kind, frame: f.frame }) : { drawn: false, words: 'their frames are not known' };
        if (!t.drawn) {
          plan.refused.push({ path: f.path, why: `in one Rerun view with ${first.path} it would be a 3D overlay, and ${t.words.replace(/^no drawing of both: /, '')}; /inspect it and view that record to see it alone` });
          continue;
        }
      }
      spatial.push(f);
    }
    plan.pass.push({ path: f.path, sha256: f.sha256, loader: l.loader, format: l.format, ...(f.role ? { role: f.role } : {}) });
  }
  return plan;
}

/**
 * Starts a viewer apart from Timmy: detached (its own process group), no stdio, unreferenced, so it outlives Timmy and is
 * never stopped by it. Resolves when it has started (with its pid) or could not start.
 */
export function launchDetached(o: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): Promise<{ ok: true; pid?: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: 'ignore' });
    } catch (e) { resolve({ ok: false, error: e instanceof Error ? e.message : String(e) }); return; }
    child.once('error', (e) => resolve({ ok: false, error: e.message }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, ...(child.pid ? { pid: child.pid } : {}) }); });
  });
}
