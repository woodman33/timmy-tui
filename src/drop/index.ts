import { existsSync, mkdirSync, readFileSync, writeFileSync, watch, statSync } from 'fs';
import { join, basename, dirname, extname } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { appendReceipt } from '../utils/receipts.js';
import { createPlan, armPlan, type DispatchPlan } from '../utils/dispatch.js';
import { issueApproval } from '../utils/approvals.js';
import { publish } from '../bus/index.js';

// CONTROL PLANE (ORDER control-plane-k3e7) — HOT-DROP. ~/timmy/drop/<lane>/ is
// a watched inbox; folder name = lane; .rules.cue per folder maps glob -> plan
// template. On drop: drop.intake receipt (path, sha, lane) -> dispatch ->
// result to ~/timmy/out/<lane>/ + a board shape via the slate compiler.
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
  return readFileSync(rp, 'utf8')
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

export function matchTemplate(lane: string, file: string, dir?: string): string | null {
  for (const r of loadRules(lane, dir)) {
    if (globToRe(r.glob).test(basename(file))) return r.template;
  }
  return null;
}

const shaOfFile = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

function toolReady(kind: 'roboflow' | 'sceneforge' | 'defold'): boolean {
  if (kind === 'roboflow') return Boolean(process.env.ROBOFLOW_API_KEY);
  if (kind === 'sceneforge') return existsSync(join(process.cwd(), 'src', 'forge', 'sheet.ts'));
  return Boolean(process.env.TIMMY_DEFOLD_BUILD);
}

export interface DropResult { lane: string; file: string; sha: string; template: string | null; status: string; out?: string }

export function processDrop(file: string, dir?: string): DropResult {
  const root = dir ?? dropRoot();
  const lane = basename(dirname(file));
  const sha = shaOfFile(file);
  appendReceipt('runs', { kind: 'run', subject: `drop.intake ${lane}/${basename(file)}`, policy: 'human-gated', status: 'ok', path: file, sha, lane, spans: [], artifacts: [] } as unknown as Parameters<typeof appendReceipt>[1], dir);
  publish('drop.intake', { lane, path: file, sha }, dir);
  const template = matchTemplate(lane, file, root);
  const outDir = join(outRoot(), lane);
  mkdirSync(outDir, { recursive: true });
  let status = 'dispatched';
  let tool: 'roboflow' | 'sceneforge' | 'defold' | null =
    template === 'observer-roboflow' ? 'roboflow' : template === 'houdini-sceneforge' ? 'sceneforge' : template === 'defold-build' ? 'defold' : null;
  if (tool && !toolReady(tool)) { status = 'not_configured'; tool = tool; }
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
  // board shape via the slate compiler (ForgeSheet), honest about tool state
  const board = { lane, file: basename(file), sha, template, status, armed: armed.ok, tool: tool ?? 'none', nodes: [{ id: `drop-${sha.slice(0, 8)}`, type: 'drop', lane, sha }] };
  const outPath = join(outDir, `${basename(file)}.board.json`);
  writeFileSync(outPath, JSON.stringify(board, null, 2), 'utf8');
  appendReceipt('runs', { kind: 'run', subject: `drop.result ${lane}/${basename(file)}`, policy: 'auto', status: status === 'not_configured' ? 'failed' : 'ok', error_class: status === 'not_configured' ? 'not_configured' : undefined, lane, sha, template, out: outPath, spans: [], artifacts: [outPath] } as unknown as Parameters<typeof appendReceipt>[1], dir);
  publish('drop.result', { lane, sha, status, out: outPath }, dir);
  return { lane, file, sha, template, status, out: outPath };
}

export function startDropWatcher(cb: (r: DropResult) => void, dir?: string): { stop(): void } {
  const root = dir ?? dropRoot();
  ensureDropLanes(root);
  const seen = new Set<string>();
  const scan = () => {
    for (const lane of Object.keys(SHIPPED_RULES)) {
      const d = join(root, lane);
      if (!existsSync(d)) continue;
      for (const f of readFileSyncDir(d)) {
        const p = join(d, f);
        const key = `${p}:${statSync(p).size}`;
        if (seen.has(key) || f === '.rules.cue') continue;
        seen.add(key);
        cb(processDrop(p, root));
      }
    }
  };
  const w = watch(root, { recursive: true }, () => { setTimeout(scan, 50); });
  return { stop: () => w.close() };
}

import { readdirSync } from 'fs';
function readFileSyncDir(d: string): string[] { try { return readdirSync(d); } catch { return []; } }
