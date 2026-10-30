/**
 * The spatial tools order (2026-10-28): Brush, KIRI 3DGS Render and gsplat, prepared outside Timmy in one private folder (the
 * "timmy-spatial" package: its README, BRUSH.md, KIRI.md, GSPLAT.md and catalog.json). This module is how Timmy finds them and
 * what it says about each; it runs nothing. The package's own status is evidence of ITS checks (a version probe, a hash, a
 * refusal), never of Timmy's integration: a present executable or a downloaded wheel is "installed", not "qualified".
 *
 *   TIMMY_SPATIAL_TOOLS   the package folder (absolute). Unset: every tool is "not installed" with that one step.
 *   TIMMY_KIRI_BLENDER    the Blender KIRI runs in (5.1 or 5.2, as KIRI 5.1.0 supports). Unset: the Applications folder is
 *                         searched for a Blender*.app whose own Info.plist says 5.1 or 5.2 (a 5.3 beta is never chosen).
 *
 * Splats are appearance reconstructions (Gaussian position, scale, rotation, opacity and colour): not measured geometry, a
 * watertight mesh, an occupancy field or verified CAD. Nothing here upgrades them.
 */
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;
export type SpatialToolId = 'brush' | 'kiri' | 'gsplat';

export interface SpatialToolDef {
  id: SpatialToolId; name: string; version: string; license: string; source: string;
  /** where it runs: this Mac, or an NVIDIA worker (CUDA) */
  runs: 'this computer' | 'an NVIDIA worker';
  /** what it makes or edits, in a sentence */
  what: string;
  /** the Workspace operations that route to it (src/companion/workflow-ops.ts) */
  operations: string[];
}

export const SPATIAL_TOOLS: Readonly<Record<SpatialToolId, SpatialToolDef>> = Object.freeze({
  brush: {
    id: 'brush', name: 'Brush', version: '0.3.0', license: 'Apache-2.0', source: 'https://github.com/ArthurBrussee/brush (release v0.3.0, 3edecbb2)',
    runs: 'this computer', what: 'Trains a Gaussian splat from posed photographs (a COLMAP or Nerfstudio dataset) and exports Gaussian PLY.',
    operations: ['spatial.brush-train'],
  },
  kiri: {
    id: 'kiri', name: 'KIRI 3DGS Render (Blender)', version: '5.1.0', license: 'see its release (GPL-3.0 Blender addon)', source: 'https://github.com/Kiri-Innovation/3dgs-render-blender-addon (v5.1.0, 3df2955a)',
    runs: 'this computer', what: 'Imports a Gaussian PLY into Blender with KIRI’s own importer; Timmy’s bounded route crops it, saves and reopens a native .blend, exports raw Gaussian PLY and reimports it, checking every value.',
    operations: ['spatial.kiri-crop-export'],
  },
  gsplat: {
    id: 'gsplat', name: 'gsplat (CUDA)', version: '1.5.3', license: 'Apache-2.0', source: 'https://github.com/nerfstudio-project/gsplat (1.5.3, 937e2991)',
    runs: 'an NVIDIA worker', what: 'A differentiable CUDA rasterizer and trainer for Gaussian splats; its prepared check renders one synthetic Gaussian at 16 × 16 and runs its gradients.',
    operations: ['spatial.gsplat-smoke'],
  },
});

/** Where each tool's entry point is in the package (its own layout). */
const ENTRY: Record<SpatialToolId, string> = { brush: 'brush/brush', kiri: 'kiri/versions/5.1.0/__init__.py', gsplat: 'gsplat/gsplat_worker.py' };

export interface SpatialToolState {
  id: SpatialToolId;
  /** the package folder, or null (not set / not there) */
  root: string | null;
  installed: { ok: boolean; words: string };
  configured: { ok: boolean | null; words: string };
  /** a Timmy job can start its operations on this computer now */
  callable: { ok: boolean; words: string };
  /** the one step that would move it on, or the precise reason it cannot run here */
  blocker: string | null;
  /** what the package itself recorded about its own checks (read from its files, never re-run here) */
  packageSays: string;
  /** resolved paths for the executor (never shown to a page: the catalog keeps words, not home paths) */
  paths: { entry: string | null; blender?: string | null; launcher?: string | null };
}

export function spatialRoot(env: Env = process.env): string | null {
  const v = env.TIMMY_SPATIAL_TOOLS;
  if (!v || !isAbsolute(v)) return null;
  const root = resolve(v);
  try { return statSync(root).isDirectory() ? root : null; } catch { return null; }
}

const executable = (p: string): boolean => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/** A Blender app's version from its own Info.plist (CFBundleShortVersionString), or null. */
export function blenderAppVersion(app: string): string | null {
  try {
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() ?? null;
  } catch { return null; }
}
/** KIRI 5.1.0 supports Blender 5.1 and 5.2. */
export const kiriSupports = (version: string | null): boolean => Boolean(version && /^5\.[12](\.|$)/.test(version));

/** The Blender KIRI runs in: TIMMY_KIRI_BLENDER, else a 5.1/5.2 Blender*.app in /Applications (by its own plist). */
export function locateKiriBlender(env: Env = process.env, applications = '/Applications'): { path: string | null; version: string | null; how: string } {
  const given = env.TIMMY_KIRI_BLENDER;
  if (given) {
    if (!isAbsolute(given) || !executable(given)) return { path: null, version: null, how: 'TIMMY_KIRI_BLENDER is not an executable path' };
    const app = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(given)?.[1];
    return { path: given, version: app ? blenderAppVersion(app) : null, how: 'TIMMY_KIRI_BLENDER' };
  }
  let names: string[] = [];
  try { names = readdirSync(applications).filter((n) => /^Blender.*\.app$/.test(n)).sort(); } catch { /* no Applications folder (Linux) */ }
  const found = names.map((n) => ({ app: join(applications, n), version: blenderAppVersion(join(applications, n)) }));
  const ok = found.find((f) => kiriSupports(f.version) && executable(join(f.app, 'Contents', 'MacOS', 'Blender')));
  if (ok) return { path: join(ok.app, 'Contents', 'MacOS', 'Blender'), version: ok.version, how: 'the Applications folder (its Info.plist version)' };
  const seen = found.map((f) => f.version ?? 'unknown').join(', ');
  return { path: null, version: null, how: found.length ? `no Blender 5.1 or 5.2 in Applications (found ${seen}; KIRI 5.1.0 supports 5.1 and 5.2)` : 'no Blender in Applications' };
}

/** Each tool's state, read from files only (nothing is run). `hasCuda`: whether this host offers an NVIDIA worker (it does not). */
export function spatialToolStates(env: Env = process.env, o: { applications?: string; platform?: NodeJS.Platform } = {}): SpatialToolState[] {
  const root = spatialRoot(env);
  const platform = o.platform ?? process.platform;
  const noRoot = env.TIMMY_SPATIAL_TOOLS ? 'TIMMY_SPATIAL_TOOLS does not name a folder here' : 'set TIMMY_SPATIAL_TOOLS to the prepared spatial tools folder (the one with timmy-spatial)';
  const pkg = (file: string): Record<string, unknown> | null => { if (!root) return null; try { return JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>; } catch { return null; } };
  const launcher = root && isFile(join(root, 'timmy-spatial')) ? join(root, 'timmy-spatial') : null;
  const out: SpatialToolState[] = [];
  // Brush: the Apple Silicon release, through the package's own launcher (it passes its arguments to the native binary)
  {
    const entry = root ? join(root, ENTRY.brush) : null;
    const has = Boolean(entry && executable(entry));
    const mac = platform === 'darwin';
    const m = pkg('brush/install-manifest.json');
    out.push({
      id: 'brush', root,
      installed: { ok: has, words: !root ? noRoot : has ? 'the Apple Silicon release (0.3.0) is in the spatial tools folder (nothing run here)' : 'brush/brush is not in the spatial tools folder' },
      configured: { ok: true, words: 'no account or key' },
      callable: { ok: has && mac, words: has && mac ? 'a Timmy job runs it on this computer (Workspace node, Control Room)' : !mac ? 'its release here is the macOS build' : 'not installed' },
      blocker: !root ? noRoot : !has ? 'brush/brush is missing from the spatial tools folder' : 'needs a posed dataset (COLMAP or Nerfstudio, zipped); it does not solve camera poses from loose photos. Reconstruction, the GPU, cancellation mid-training and resume are not yet exercised here',
      packageSays: m ? `the package verified the archive hash (${String(m.archive_sha256 ?? '').slice(0, 12)}…) and ran --version and --help (exit 0); no training ran` : 'the package’s install manifest is not readable',
      paths: { entry: has ? entry : null, launcher },
    });
  }
  // KIRI: the extracted addon, loaded by Timmy's own worker inside a 5.1/5.2 Blender (never the user's Blender profile)
  {
    const entry = root ? join(root, ENTRY.kiri) : null;
    const has = Boolean(entry && isFile(entry));
    const b = locateKiriBlender(env, o.applications);
    const m = pkg('kiri/install-manifest.json');
    out.push({
      id: 'kiri', root,
      installed: { ok: has, words: !root ? noRoot : has ? 'KIRI 5.1.0 is extracted in the spatial tools folder (hash-verified by the package; nothing run here)' : 'kiri/versions/5.1.0 is not in the spatial tools folder' },
      configured: { ok: Boolean(b.path), words: b.path ? `Blender ${b.version ?? '(version not read)'} found by ${b.how}` : b.how },
      callable: { ok: has && Boolean(b.path), words: has && b.path ? 'a Timmy job runs Blender in the background with Timmy’s KIRI worker (Workspace node, Control Room)' : !has ? 'not installed' : 'no supported Blender' },
      blocker: !root ? noRoot : !has ? 'KIRI 5.1.0 is not extracted in the spatial tools folder' : !b.path ? b.how : 'the bounded route only: raw local-coordinate crop and raw Gaussian PLY export (not KIRI’s full export, render or relighting)',
      packageSays: m ? 'the package verified the release hash and extracted it; its own first Blender start failed (-11) in a sandboxed shell, before KIRI loaded' : 'the package’s install manifest is not readable',
      paths: { entry: has ? entry : null, blender: b.path },
    });
  }
  // gsplat: prepared for an NVIDIA worker; this host has none (the Sparks are unplugged), so it is never callable here
  {
    const entry = root ? join(root, ENTRY.gsplat) : null;
    const has = Boolean(entry && isFile(entry));
    out.push({
      id: 'gsplat', root,
      installed: { ok: false, words: !root ? noRoot : has ? 'prepared, not installed: the pinned wheel and source are verified in the spatial tools folder; no CUDA Python environment has it' : 'its worker is not in the spatial tools folder' },
      configured: { ok: false, words: 'needs an NVIDIA worker with CUDA, a matching PyTorch build and nvcc; this Mac has no CUDA backend (Metal/MPS is not gsplat’s)' },
      callable: { ok: false, words: 'awaiting a powered NVIDIA worker' },
      blocker: 'awaiting a powered NVIDIA worker: the Sparks are unplugged, and this Mac has no CUDA backend. Its doctor reports blocked (exit 2) here',
      packageSays: has ? 'the package verified the wheel and source hashes; its doctor refused correctly on this Mac (exit 2); no CUDA kernel ran' : 'not prepared here',
      paths: { entry: has ? entry : null, launcher },
    });
  }
  return out;
}

/** Whether a file's first bytes are a Gaussian-splat PLY (a vertex element with the 3DGS fields), and its vertex count. */
export function gaussianPlyHeader(bytes: Buffer): { ok: boolean; format: string | null; vertices: number | null; fields: string[]; fixture: boolean; why?: string } {
  const head = bytes.subarray(0, Math.min(bytes.length, 65536)).toString('latin1');
  const end = head.indexOf('end_header');
  if (!head.startsWith('ply') || end < 0) return { ok: false, format: null, vertices: null, fields: [], fixture: false, why: 'not a PLY file' };
  const lines = head.slice(0, end).split(/\r?\n/);
  const format = /^format (\S+)/m.exec(head)?.[1] ?? null;
  let vertices: number | null = null; let inVertex = false; const fields: string[] = [];
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'element') { inVertex = p[1] === 'vertex'; if (inVertex) vertices = Number(p[2]); }
    else if (p[0] === 'property' && inVertex) fields.push(p[p.length - 1]);
  }
  const need = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const missing = need.filter((n) => !fields.includes(n));
  const fixture = /^comment .*SYNTHETIC FIXTURE/m.test(head.slice(0, end));
  if (missing.length) return { ok: false, format, vertices, fields, fixture, why: `not a Gaussian splat: missing ${missing.join(', ')}` };
  if (!vertices || !Number.isFinite(vertices) || vertices < 1) return { ok: false, format, vertices, fields, fixture, why: 'no vertices' };
  return { ok: true, format, vertices, fields, fixture };
}

