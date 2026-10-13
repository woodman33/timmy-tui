/**
 * Round R4 (helper H73): a native run's handoffs for the Control Room, from its own folder. An Unreal run's first pass is
 * never trusted alone: a second Unreal process reads each level it saved back, and that readback's verdict decides the run
 * (src/native/unreal-readback.ts); a FreeCAD run's STEP may be read back by `/freecad readback`; an Illustrator run's export
 * is read by Timmy itself (src/native/svg-readback.ts). Before, the Control Room showed such a run as its first pass alone
 * ("ok (judged by its result file)"), with no handoff. Here, each step in order: the run (its job, its verdict, its
 * receipt), then each readback (its job, its verdict, its receipt or why there is none), each only as its record says.
 * Read only; a line that cannot be read is skipped, never repaired.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanText } from '../connectors/mcp-records.js';
import type { NativeVerdictLine } from '../native/index.js';
import type { RoomStep } from './index.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const LINES_MAX = 8 * 1024 * 1024;
const words = (t: unknown, scrub: (s: string) => string, max = 140): string => {
  const s = scrub(cleanText(String(t ?? ''))).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** A run's readbacks.jsonl (Unreal's and FreeCAD's), oldest first. */
export function readbackLines(dir: string): Obj[] {
  let text = '';
  try {
    const abs = path.join(dir, 'readbacks.jsonl');
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > LINES_MAX) return [];
    text = fs.readFileSync(abs, 'utf8');
  } catch { return []; }
  const out: Obj[] = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const o = obj(JSON.parse(line)); if (o && o.readback === 1) out.push(o); } catch { /* skipped */ } }
  return out;
}

/** Who reads a run of this app back, when the line does not name its worker. */
const READER: Readonly<Record<string, string>> = {
  unreal: 'a second UnrealEditor-Cmd process (workers/unreal/unreal_readback.py)',
  freecad: "the STEP readback worker (OCP), Timmy's own",
};

/**
 * The handoff of a native run: its run, then each readback; an Unreal run not read back yet says so (its first pass alone is
 * not trusted). Empty for a run nothing reads back (the Control Room shows its verdict alone).
 */
export function nativeHandoff(o: {
  app: string; owner: string; dir?: string; verdict?: NativeVerdictLine; job?: string; receipt?: string; running: boolean; scrub: (t: string) => string;
}): RoomStep[] {
  const lines = o.dir ? readbackLines(o.dir) : [];
  const own = obj((o.verdict as unknown as Obj | undefined)?.readback);
  if (o.app !== 'unreal' && !lines.length && !str(own?.verdict)) return [];
  const v = o.verdict;
  const stopped = v?.exit?.state === 'cancelled';
  const first: RoomStep = {
    name: o.app === 'unreal' ? 'first pass' : 'run', owner: o.owner,
    state: v ? (stopped ? 'stopped' : v.outcome) : o.running ? 'running' : 'not judged yet',
    ...(o.job ? { job: o.job } : {}), ...(o.receipt ? { receipt: o.receipt } : {}),
    ...(v?.why ? { detail: words(v.why, o.scrub) } : {}),
  };
  const steps: RoomStep[] = [first];
  if (str(own?.verdict)) {
    steps.push({ name: "Timmy's reading", owner: str(own?.by) ? words(own!.by, o.scrub, 80) : 'Timmy, reading the exported SVG itself', state: String(own!.verdict) });
  }
  for (const l of lines) {
    const worker = obj(l.worker);
    const verdict = str(l.verdict);
    steps.push({
      name: 'readback', owner: str(worker?.name) ? words(`${String(worker!.name)}${str(worker?.version) ? ` ${String(worker!.version)}` : ''}`, o.scrub, 80) : READER[o.app] ?? 'its readback worker',
      state: verdict ?? (l.state === 'cancelled' ? 'stopped' : str(l.state) ?? 'not judged'),
      ...(str(l.job) ? { job: String(l.job) } : {}), ...(str(l.receipt) ? { receipt: String(l.receipt) } : {}),
      ...(str(l.reason) ? { detail: words(l.reason, o.scrub) } : {}),
    });
  }
  if (o.app === 'unreal' && !lines.length && !o.running) {
    steps.push({
      name: 'readback', owner: READER.unreal,
      state: v && !stopped && v.outcome === 'ok' ? 'not run yet' : 'not run',
      detail: !v ? 'its first pass has no verdict here, and a run not judged ok is not read back'
        : stopped || v.outcome !== 'ok' ? 'a run not judged ok is not read back' : 'the first pass alone is not trusted: /unreal readback reads it',
    });
  }
  // An Unreal run's newest readback decides it (unrealRunOutcome).
  const decides = o.app === 'unreal' && lines.length ? steps.at(-1)! : undefined;
  if (decides) decides.here = 'its verdict decides the run';
  return steps;
}
