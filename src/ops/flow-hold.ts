/**
 * Round R4 (H51): one flow at a time in a project across processes. src/repl/flow-lock.ts holds a project for a start in
 * this process; a REPL and a `timmy act` (inside a workflow block, say) can work in the same project at once, so a start
 * also leaves a hold file in the project, .timmy/flow-holds/<name>.json, from before its first await until its flow ends,
 * and a start or a parameter save sees a hold another live process left there.
 *
 * A hold names its writer by pid and process start (src/ops/process-proof.ts, the proof rule recovery uses): a hold whose
 * writer is gone is stale, never trusted, and removed when it is seen. Taking a hold writes it first (a complete file,
 * renamed into place) and then reads the others: two starts at the same moment each see the other and both are refused
 * (fail closed), never both let through. A hold file that cannot be read is not a live hold, and is left as it is.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { THIS_PROCESS, writerState } from './process-proof.js';

export const HOLDS_DIR = '.timmy/flow-holds';
export const HOLD_SCHEMA = 'timmy.flow-hold/1';
const HOLD_FILE = /^h[0-9]+-[0-9a-f]{8}\.json$/;

export interface HoldRecord {
  schema: typeof HOLD_SCHEMA;
  /** the flow's kind (tray, blender, scad, freecad, ae) and, once its start has named it, its id */
  kind: string;
  flow?: string;
  /** the operation (one request) that started it, when it has one */
  operation?: string;
  owner: { pid: number; started: string };
  taken: string;
}

/** A hold another process (or another flow lock of this one) has on the project now. */
export interface OtherHold { rel: string; kind: string; flow?: string; operation?: string; pid: number; taken: string; proof: 'alive' | 'unknown' }

/** A hold this flow lock took: named once its flow has an id, released when its flow ends. */
export interface ProjectHold { readonly rel: string; name(id: string): void; release(): void }

/**
 * The holds folder, inside the project and through no link; undefined (with why) when it cannot be used. `made`: the
 * folders this call made (outermost first), so a hold given back leaves the project as it found it.
 */
function holdsDir(root: string, make: boolean): { ok: true; abs: string; made: string[] } | { ok: false; error: string; missing?: true } {
  let real: string;
  try { real = fs.realpathSync(root); } catch { return { ok: false, error: 'the project folder is not there', missing: true }; }
  let at = real;
  const made: string[] = [];
  for (const part of HOLDS_DIR.split('/')) {
    at = path.join(at, part);
    try {
      if (fs.lstatSync(at).isSymbolicLink()) return { ok: false, error: `${path.relative(real, at).split(path.sep).join('/')} is a symbolic link` };
    } catch {
      if (!make) return { ok: false, error: 'no holds', missing: true };
      try { fs.mkdirSync(at); made.push(at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, error: `${(e as NodeJS.ErrnoException).code ?? 'error'} making ${HOLDS_DIR}` }; }
    }
  }
  return { ok: true, abs: at, made };
}

/** Removes the holds folder when it is empty, and the folders a take made when they are empty too (never anything else). */
function tidy(dir: string, made: readonly string[]): void {
  for (const d of [dir, ...[...made].reverse().filter((m) => m !== dir)]) { try { fs.rmdirSync(d); } catch { return; } }
}

function writeHold(dir: string, name: string, rec: HoldRecord): void {
  const tmp = path.join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, path.join(dir, name));
}

function readHold(file: string): HoldRecord | undefined {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 16 * 1024) return undefined;
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as HoldRecord;
    if (!r || r.schema !== HOLD_SCHEMA || typeof r.kind !== 'string' || !r.owner || typeof r.owner.pid !== 'number') return undefined;
    return r;
  } catch { return undefined; }
}

/**
 * The live holds in the project other than `mine` (file names), oldest first; a stale one (its writer gone) is removed
 * as it is seen. A writer that runs but whose start cannot be read is counted live ('unknown').
 */
export function otherHolds(root: string, mine: ReadonlySet<string> = new Set()): OtherHold[] {
  const dir = holdsDir(root, false);
  if (!dir.ok) return [];
  let names: string[];
  try { names = fs.readdirSync(dir.abs).filter((n) => HOLD_FILE.test(n) && !mine.has(n)); } catch { return []; }
  const out: OtherHold[] = [];
  for (const n of names) {
    const file = path.join(dir.abs, n);
    const r = readHold(file);
    if (!r) continue;
    const proof = writerState(r.owner);
    if (proof === 'gone') { try { fs.unlinkSync(file); } catch { /* already gone */ } continue; }
    out.push({ rel: `${HOLDS_DIR}/${n}`, kind: r.kind, ...(typeof r.flow === 'string' ? { flow: r.flow } : {}), ...(typeof r.operation === 'string' ? { operation: r.operation } : {}), pid: r.owner.pid, taken: r.taken, proof });
  }
  return out.sort((a, b) => a.taken.localeCompare(b.taken));
}

/**
 * Takes the project for a start of `kind`: writes this hold, then reads the others. Another live hold refuses it (this
 * hold is removed again). A project folder that is not there takes no file (nothing can run in it); a hold that cannot
 * be written refuses the start, with why.
 */
export function takeProjectHold(root: string, o: { kind: string; operation?: string; mine?: ReadonlySet<string> }):
  { ok: true; hold?: ProjectHold } | { ok: false; by: OtherHold } | { ok: false; error: string } {
  const name = `h${THIS_PROCESS.pid}-${randomBytes(4).toString('hex')}.json`;
  const rec: HoldRecord = { schema: HOLD_SCHEMA, kind: o.kind, ...(o.operation ? { operation: o.operation } : {}), owner: { pid: THIS_PROCESS.pid, started: THIS_PROCESS.started }, taken: new Date().toISOString() };
  let dir: ReturnType<typeof holdsDir> = { ok: false, error: 'not tried' };
  // Written, or tried again when another process's hold given back took the empty folder away meanwhile.
  for (let attempt = 0; ; attempt++) {
    dir = holdsDir(root, true);
    if (!dir.ok) return dir.missing ? { ok: true } : { ok: false, error: dir.error };
    try { writeHold(dir.abs, name, rec); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && attempt < 3) continue;
      tidy(dir.abs, dir.made);
      return { ok: false, error: `the project's hold file could not be written (${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : 'error')} in ${HOLDS_DIR})` };
    }
  }
  const { abs, made } = dir;
  const file = path.join(abs, name);
  // Given back: its file, then the holds folder if it is empty, and what this take made (.timmy itself in a new project).
  const release = (): void => { try { fs.unlinkSync(file); } catch { /* already gone */ } tidy(abs, made); };
  const by = otherHolds(root, new Set([name, ...(o.mine ?? [])]))[0];
  if (by) { release(); return { ok: false, by }; }
  let released = false;
  return {
    ok: true,
    hold: {
      rel: name,
      name: (id: string) => { if (released) return; rec.flow = id; try { writeHold(abs, name, rec); } catch { /* the hold stands without its flow's id */ } },
      release: () => { if (!released) { released = true; release(); } },
    },
  };
}

/** A hold in words, for a refusal: whose flow, in which process, under which operation. */
export function holdWords(h: OtherHold): string {
  return `in another Timmy process (pid ${h.pid}${h.operation ? `, operation ${h.operation}` : ''}${h.proof === 'unknown' ? '; its start could not be read, so it is taken as running' : ''})`;
}
