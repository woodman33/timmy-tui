import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, watch } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { appendReceipt } from '../utils/receipts.js';
import { createPlan, armPlan, type DispatchPlan } from '../utils/dispatch.js';
import { issueApproval } from '../utils/approvals.js';
import { publish } from '../bus/index.js';
import { hashFile } from '../project/intake.js';
import { sameFolder } from '../project/index.js';

// CONTROL PLANE (ORDER control-plane-k3e7) — HOT-DROP. ~/timmy/drop/<lane>/ is
// a watched inbox; folder name = lane; .rules.cue per folder maps glob -> plan
// template. On drop: drop.intake receipt (path, sha, lane) -> dispatch ->
// result to ~/timmy/out/<lane>/ + a board shape via the slate compiler.
// R4 H19: `timmy drop` (src/drop/cli.ts) and the watched folder (startDropWatcher) both process a file through
// dropInPlace. No rule starts its tool yet and the dispatch plan drafted below is refused by schemas/dispatch.cue,
// so a drop's result is unrouted, not_configured or not_started: never dispatched.
export const dropRoot = (): string => process.env.TIMMY_DROP_ROOT || join(homedir(), 'timmy', 'drop');
export const outRoot = (): string => process.env.TIMMY_OUT_ROOT || join(homedir(), 'timmy', 'out');

export const SHIPPED_RULES: Record<string, string> = {
  defold: `// defold lane: Spine/rive sources trigger a build\n"*.riv": "defold-build"\n"*.spine": "defold-build"\n`,
  houdini: `// houdini lane: reference sheets feed SceneForge\n"*.png": "houdini-sceneforge"\n"*.jpg": "houdini-sceneforge"\n`,
  observer: `// observer lane: stills/clips go to Roboflow detection (honest not_configured without key)\n"*.png": "observer-roboflow"\n"*.mp4": "observer-roboflow"\n`,
};

export function ensureDropLanes(dir?: string): string[] {
  const root = dir ?? dropRoot();
  const lanes = Object.keys(SHIPPED_RULES);
  for (const lane of lanes) {
    const d = join(root, lane);
    mkdirSync(d, { recursive: true });
    const rp = join(d, '.rules.cue');
    if (!existsSync(rp)) writeFileSync(rp, SHIPPED_RULES[lane], 'utf8');
  }
  return lanes;
}

export function loadRules(lane: string, dir?: string): { glob: string; template: string }[] {
  const rp = join(dir ?? dropRoot(), lane, '.rules.cue');
  if (!existsSync(rp)) return [];
  return parseRules(readFileSync(rp, 'utf8'));
}

/** A lane's rules: its .rules.cue, or the shipped rules while a shipped lane has not been made yet. */
export function laneRules(lane: string, dir?: string): { glob: string; template: string }[] {
  if (existsSync(join(dir ?? dropRoot(), lane, '.rules.cue')) || !SHIPPED_RULES[lane]) return loadRules(lane, dir);
  return parseRules(SHIPPED_RULES[lane]);
}

/** The lanes: the shipped ones and every visible folder of the drop root that has a .rules.cue. */
export function laneNames(dir?: string): string[] {
  const root = dir ?? dropRoot();
  const own = readFileSyncDir(root).filter(n => !n.startsWith('.') && existsSync(join(root, n, '.rules.cue')));
  return [...new Set([...Object.keys(SHIPPED_RULES), ...own])].sort();
}

function parseRules(text: string): { glob: string; template: string }[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//'))
    .map(l => {
      const m = l.match(/^"([^"]+)"\s*:\s*"([^"]+)"/);
      return m ? { glob: m[1], template: m[2] } : null;
    })
    .filter((x): x is { glob: string; template: string } => Boolean(x));
}

const globToRe = (g: string): RegExp =>
  new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

/** The first rule of the lane whose glob takes the file's name. */
export function matchRule(lane: string, file: string, dir?: string): { glob: string; template: string } | null {
  for (const r of loadRules(lane, dir)) {
    if (globToRe(r.glob).test(basename(file))) return r;
  }
  return null;
}

export function matchTemplate(lane: string, file: string, dir?: string): string | null {
  return matchRule(lane, file, dir)?.template ?? null;
}

// Read in pieces, so a large drop is never held whole.
const shaOfFile = (p: string): string => hashFile(p);

// What each shipped template's tool needs before it could run. No drop rule starts its tool yet (there is no runner),
// so a tool that is set up is reported as not started.
const TOOLS: Record<string, { id: 'roboflow' | 'sceneforge' | 'defold'; label: string; ready: () => boolean; unset: string }> = {
  'observer-roboflow': { id: 'roboflow', label: 'Roboflow detection', ready: () => Boolean(process.env.ROBOFLOW_API_KEY), unset: 'Roboflow detection needs ROBOFLOW_API_KEY' },
  // SceneForge is in the forge lane, inert unless TIMMY_FORGE=1 (DOCTRINE §1, decisions.md D1). It used to count as
  // ready whenever the working folder held src/forge/sheet.ts, which said nothing about the tool.
  'houdini-sceneforge': { id: 'sceneforge', label: 'SceneForge', ready: () => process.env.TIMMY_FORGE === '1', unset: 'SceneForge is in the forge lane, which is off unless TIMMY_FORGE=1 (decisions.md D1)' },
  'defold-build': { id: 'defold', label: 'a Defold build', ready: () => Boolean(process.env.TIMMY_DEFOLD_BUILD), unset: 'a Defold build needs TIMMY_DEFOLD_BUILD' },
};

/** What became of the work a drop's rule names. No rule starts its tool yet, so a drop is never dispatched or run. */
export type DropStatus = 'unrouted' | 'not_configured' | 'not_started';

export interface DropResult {
  lane: string; file: string; sha: string; template: string | null; status: DropStatus; out?: string;
  /** The glob of the rule that took the file (`*.png`), or null. */
  rule: string | null;
  /** The status in plain words. */
  why: string;
  /** Whether the dispatch plan was armed. Its draft is refused by schemas/dispatch.cue, so false. */
  armed: boolean;
  /** The two receipts sealed for the drop. */
  receipts: { intake: string; result: string };
}

export function processDrop(file: string, dir?: string): DropResult {
  const root = dir ?? dropRoot();
  const lane = basename(dirname(file));
  const name = basename(file);
  // Receipts and events name the file by where it sits in the drop folder (lane/name), never by a full path.
  const at = `${lane}/${name}`;
  const sha = shaOfFile(file);
  const intake = appendReceipt('runs', { kind: 'run', subject: `drop.intake ${at}`, policy: 'human-gated', status: 'ok', path: at, sha, lane, spans: [], artifacts: [] } as unknown as Parameters<typeof appendReceipt>[1], dir);
  publish('drop.intake', { lane, path: at, sha }, dir);
  const rule = matchRule(lane, file, root);
  const template = rule?.template ?? null;
  const outDir = join(outRoot(), lane);
  mkdirSync(outDir, { recursive: true });
  const tool = template ? TOOLS[template] ?? null : null;
  // dispatch (plan -> approval -> arm) so the drop is on the governed spine
  const plan = {
    schema_version: 'dispatch/0.1',
    objective: `hot-drop ${lane}: ${basename(file)} via ${template ?? 'unrouted'}`,
    deliverables: [basename(file)],
    acceptance_tests: ['true'],
    harnesses: ['local'],
    workspace: { kind: 'host-ephemeral' },
  } as unknown as DispatchPlan;
  const cp = createPlan(plan, dir);
  let armed: { ok: boolean; note?: string } = { ok: false, note: 'no plan' };
  if (cp.ok && cp.id && cp.plan_hash) {
    const ap = issueApproval(cp.plan_hash);
    armed = armPlan(cp.id, ap.token, dir);
  }
  // Said plainly. Nothing is started from a drop, armed or not: no rule has a runner, and no armed plan is launched.
  const status: DropStatus = !template ? 'unrouted' : tool && !tool.ready() ? 'not_configured' : 'not_started';
  const why = !template ? `no rule in the ${lane} lane takes ${name}`
    : status === 'not_configured' ? tool!.unset
    : `nothing starts ${tool?.label ?? template} from a drop yet`;
  // board shape via the slate compiler (ForgeSheet), honest about tool state
  const board = { lane, file: name, sha, template, rule: rule?.glob ?? null, status, why, armed: armed.ok, tool: tool?.id ?? 'none', nodes: [{ id: `drop-${sha.slice(0, 8)}`, type: 'drop', lane, sha }] };
  const outPath = join(outDir, `${name}.board.json`);
  writeFileSync(outPath, JSON.stringify(board, null, 2), 'utf8');
  const outAt = `${lane}/${name}.board.json`; // under the out folder
  const result = appendReceipt('runs', { kind: 'run', subject: `drop.result ${at}`, policy: 'auto', status: 'failed', error_class: status, lane, sha, template, rule: rule?.glob ?? null, out: outAt, spans: [], artifacts: [outAt] } as unknown as Parameters<typeof appendReceipt>[1], dir);
  publish('drop.result', { lane, sha, status, out: outAt }, dir);
  return { lane, file, sha, template, status, out: outPath, rule: rule?.glob ?? null, why, armed: armed.ok, receipts: { intake: intake.hash, result: result.hash } };
}

/** A file handed to the drop processor: its result, or why it was not processed (nothing is sealed for a refusal). */
export type DropOutcome = { ok: true; result: DropResult } | { ok: false; file: string; reason: string };

/** Plain words for a file that cannot be read. */
export function cannotRead(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return `cannot be read (${code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code ?? 'error'})`;
}

/**
 * The one way a file in a lane folder is processed, for `timmy drop` and for the watched folder alike: a visible,
 * readable regular file directly inside a lane folder of the drop root, whose name a rule of that lane takes, goes to
 * processDrop. Anything else is refused: left as it is, with nothing sealed.
 */
export function dropInPlace(file: string, dir?: string): DropOutcome {
  const root = dir ?? dropRoot();
  const name = basename(file);
  const lane = basename(dirname(file));
  const refuse = (reason: string): DropOutcome => ({ ok: false, file, reason });
  let st;
  try { st = lstatSync(file); } catch { return refuse('no such file'); }
  if (st.isSymbolicLink()) return refuse('a symbolic link: a lane folder takes the file itself');
  if (st.isDirectory()) return refuse('a folder: a lane folder takes files');
  if (!st.isFile()) return refuse('not a regular file');
  if (name.startsWith('.')) return refuse('a hidden file: the drop folders skip hidden files');
  if (!sameFolder(dirname(dirname(file)), root)) return refuse('not in a lane folder of the drop folder');
  try { accessSync(file, constants.R_OK); } catch (err) { return refuse(cannotRead(err)); }
  if (!matchRule(lane, file, root)) return refuse(`no rule in the ${lane} lane takes ${name}`);
  try { return { ok: true, result: processDrop(file, dir) }; } catch (err) {
    return refuse(`could not be processed (${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))})`);
  }
}

/**
 * Watches the lane folders and hands each new or changed file to dropInPlace, the path `timmy drop` uses, once it has
 * stopped changing: two scans `settleMs` apart must see the same size and modification time, so a copy still being
 * written is not taken half-way (unless its writer pauses longer than that). Hidden files (.rules.cue, .DS_Store) and
 * folders are skipped; a refusal is passed on like a result. Files already in the lanes are taken at the first change
 * in the drop folder after the start, as before.
 */
export function startDropWatcher(cb: (r: DropOutcome) => void, dir?: string, opts: { settleMs?: number } = {}): { stop(): void } {
  const root = dir ?? dropRoot();
  ensureDropLanes(root);
  const settleMs = opts.settleMs ?? 300;
  const handed = new Map<string, string>(); // file -> the size:mtime it was handed on at
  const seen = new Map<string, { sig: string; since: number }>(); // file -> its size:mtime, unchanged since `since`
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const later = (ms: number) => { if (!stopped && !timer) timer = setTimeout(() => { timer = null; scan(); }, ms); };
  const scan = () => {
    let wait = Infinity;
    for (const lane of laneNames(root)) {
      const d = join(root, lane);
      for (const f of readFileSyncDir(d)) {
        if (f.startsWith('.')) continue;
        const p = join(d, f);
        let st;
        try { st = lstatSync(p); } catch { continue; }
        if (st.isDirectory()) continue;
        const sig = `${st.size}:${st.mtimeMs}`;
        if (handed.get(p) === sig) continue;
        const now = Date.now();
        const s = seen.get(p);
        if (!s || s.sig !== sig) { seen.set(p, { sig, since: now }); wait = Math.min(wait, settleMs); continue; }
        // Whatever woke this scan (a change elsewhere, or the timer), a file goes on only after settleMs unchanged.
        if (now - s.since < settleMs) { wait = Math.min(wait, s.since + settleMs - now); continue; }
        seen.delete(p);
        handed.set(p, sig);
        cb(dropInPlace(p, dir));
      }
    }
    if (wait !== Infinity) later(wait);
  };
  const w = watch(root, { recursive: true }, () => later(50));
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); w.close(); } };
}

import { readdirSync } from 'fs';
function readFileSyncDir(d: string): string[] { try { return readdirSync(d); } catch { return []; } }
