/**
 * Round R4 (H76): the evidence behind the ladder's two upper rungs, read from what Timmy sealed (src/capabilities/ladder.ts).
 *
 * exercised: a run of Timmy's own here, judged and sealed, on a chain that verifies. Which run counts is decided by each
 * subsystem's own reviewed rule, reused here, and the receipt it chose is then found on the chain and checked: its epoch's
 * links and body hashes verify (verifyChain) and its own signature verifies. A chain that does not verify vouches for
 * nothing; a record with no receipt on it is not a run that counts.
 *   tools      a turn sealed under outcome rule 2 in which the tool completed (src/capabilities/live.ts exercisedTools)
 *   native     a receipt of that app judged ok (src/native nativeRunIndex)
 *   agents     a completed run of that agent, by its own route (src/code-agents agentExercisedIndex)
 *   VoxVision  a vox action whose record settled ok, for each tool it ran (never a viewer's launch: /vox view)
 *   MCP        a call answered through a command-line route (its mcp.call receipt; an error result does not count)
 *   Look       an /observe run whose measurements were parsed and sealed ok
 *   models     an /observe --qualify exchange whose answer was admitted (the route is OpenRouter's)
 *   the recipe a succeeded job of its real worker, its signed result verified now (src/recipes recipeExercisedAt)
 *
 * qualified: a formal qualification record only. An admitted /observe --qualify answer qualifies that model for that
 * protocol only. A qualification record kept in this repository (QUALIFICATION_RECORDS) qualifies only while every source
 * its seal names still has the sha256 it sealed; otherwise it is said to cover earlier sources. Development runs never
 * qualify anything.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentExercisedIndex } from '../code-agents/index.js';
import { CODEX_LOCAL_ROUTE } from '../code-agents/codex-local.js';
import { QUALIFIED_PROTOCOL } from '../evidence/observation-check.js';
import { nativeRunIndex } from '../native/index.js';
import { listRecipeJobs, recipeExercisedAt, verifiedResult } from '../recipes/index.js';
import { verifySignature, type Receipt, type VerifyResult } from '../utils/receipts.js';
import { VOX_SCHEMA } from '../vox/record.js';
import type { ExercisedEvidence, QualifiedEvidence } from './ladder.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const short = (hash: string): string => hash.replace(/^sha256_/, '').slice(0, 8);

/** What verified a run's receipt (the words every exercised entry from the chain carries). */
export const CHAIN_WORDS = 'on the runs chain, which verifies here (its links and body hashes), with its own signature';

/** One run that counts, as the ladder shows it. */
export interface RunMark { at: string; what: string; receipt: string; hash: string; record?: string; chain: string }

/** The exercised runs and the admitted qualified answers found on a verified chain, by what they are about. */
export interface ChainEvidence {
  /** tool name, `native:<app>`, `agent:<key>`, `vox:<tool>`, `mcp:<route>`, `observe:look`, `model:openrouter` → the newest run that counts */
  runs: Map<string, RunMark>;
  /** `model:openrouter` → the newest admitted /observe --qualify answer */
  qualified: Map<string, QualifiedEvidence>;
  /** why nothing counts, when the chain does not verify */
  broken?: string;
}

/** Turns sealed under this outcome rule or later say what each tool did (src/repl/seal.ts OUTCOME_RULE). */
const OUTCOME_RULE = 2;

/** The receipts of a chain that may vouch for a run: in an epoch whose segment verifies, with a signature that verifies. */
function vouches(verify: VerifyResult): (r: Obj) => boolean {
  const ok = new Set(verify.segments.filter((s) => s.ok).map((s) => s.epoch));
  return (r) => ok.has(typeof r.epoch === 'number' ? r.epoch : 1) && verifySignature(r as unknown as Receipt);
}

const mark = (r: Obj, what: string, record?: string): RunMark => ({
  at: String(r.ts), what, receipt: short(String(r.hash)), hash: String(r.hash), ...(record ? { record } : {}), chain: CHAIN_WORDS,
});

/**
 * The exercised runs and admitted qualified answers of a chain. `verify` is verifyChain's result for the same chain; when
 * the current epoch does not verify, nothing counts (as the rows' "used" dates have always been read). The chain is read
 * newest first, and a receipt's signature is checked only when it would be the run shown, so a long chain stays quick.
 */
export function chainEvidence(chain: readonly Obj[], verify: VerifyResult): ChainEvidence {
  const runs = new Map<string, RunMark>();
  const qualified = new Map<string, QualifiedEvidence>();
  if (!verify.ok) return { runs, qualified, broken: verify.reason ?? 'the receipts chain does not verify' };
  const vouch = vouches(verify);
  const checked = new Map<string, boolean>();
  const ok = (r: Obj): boolean => { const h = String(r.hash); let v = checked.get(h); if (v === undefined) checked.set(h, (v = vouch(r))); return v; };
  /** Whether `r` would be newer than what `key` holds already (so its signature is worth checking). */
  const newer = (key: string, r: Obj): boolean => { const was = runs.get(key); return !was || was.at < String(r.ts); };
  const list = chain as Obj[];
  const newestFirst = [...list].reverse();

  // Tools: a turn sealed under outcome rule 2 in which the tool completed (the rule of exercisedTools).
  for (const r of newestFirst) {
    if (r.kind !== 'turn' || !Array.isArray(r.tool_outcomes) || typeof r.ts !== 'string' || typeof r.hash !== 'string') continue;
    if (typeof r.outcome_rule !== 'number' || r.outcome_rule < OUTCOME_RULE) continue;
    const done = (r.tool_outcomes as unknown[]).map(obj).filter((t) => t?.outcome === 'completed' && typeof t.name === 'string').map((t) => String(t!.name));
    const open = done.filter((t) => newer(t, r));
    if (!open.length || !ok(r)) continue;
    for (const t of open) runs.set(t, mark(r, `${t} completed in a sealed turn (outcome rule ${String(r.outcome_rule)}: the tool's own answer decided)`));
  }

  // Native apps: the receipt nativeRunIndex chose (judged ok, status ok), found on the chain by its time and short hash.
  for (const [app, s] of nativeRunIndex(list as Array<Record<string, unknown>>)) {
    const d = s.demonstrated;
    if (!d) continue;
    const r = list.find((x) => x.kind === 'native' && x.ts === d.at && typeof x.hash === 'string' && (!d.receipt || short(x.hash) === d.receipt) && obj(x.native)?.app === app);
    if (!r || !ok(r)) continue;
    const n = obj(r.native)!;
    const run = str(n.run);
    const version = [n.blender_version, n.c4d_version, n.unreal_version].map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined)).find(Boolean);
    runs.set(`native:${app}`, mark(r, `a ${app} run judged ok from its own result file${version ? ` (the app said version ${version})` : ''}`, run ? `.timmy/native/${run}/job.json` : undefined));
  }

  // Code agents: the run agentExercisedIndex chose for each route.
  const agentKey = (a: Obj): string => (a.name === 'codex' && a.endpoint === 'local' ? CODEX_LOCAL_ROUTE : String(a.name));
  for (const [key, at] of agentExercisedIndex(list as Array<Record<string, unknown>>)) {
    const r = list.find((x) => x.kind === 'agent' && x.status === 'ok' && x.ts === at && obj(x.agent) && agentKey(obj(x.agent)!) === key && obj(x.agent)!.outcome === 'completed');
    if (!r || typeof r.hash !== 'string' || !ok(r)) continue;
    const a = obj(r.agent)!;
    const said = [str(a.version) ? `version ${String(a.version)} as it reported` : '', str(a.model) ? `model ${String(a.model)}` : '', a.endpoint === 'local' ? 'a local endpoint' : a.endpoint === 'remote' ? 'a remote endpoint' : ''].filter(Boolean).join(', ');
    runs.set(`agent:${key}`, mark(r, `a completed run of ${String(a.name)}${said ? ` (${said})` : ''}`, str(a.run) ? `.timmy/agents/${String(a.run)}/result.json` : undefined));
  }

  // VoxVision: an action whose record settled ok, for each tool that ran in it (a viewer's launch is not a judged run).
  for (const r of newestFirst) {
    if (r.kind !== 'vox' || r.status !== 'ok' || typeof r.ts !== 'string' || typeof r.hash !== 'string' || !Array.isArray(r.sources)) continue;
    const src = obj(r.sources[0]);
    if (!src || src.schema !== VOX_SCHEMA || src.status !== 'ok' || typeof src.action !== 'string' || src.action === 'view' || !Array.isArray(src.tools)) continue;
    const tools = src.tools.map(obj).filter((t): t is Obj => Boolean(t && str(t.tool) && newer(`vox:${String(t.tool)}`, r)));
    if (!tools.length || !ok(r)) continue;
    const record = Array.isArray(r.outputs) ? str(obj(r.outputs[0])?.path) : undefined;
    for (const t of tools) {
      const tool = String(t.tool);
      const said = [str(t.name), str(t.version)].filter(Boolean).join(' ');
      runs.set(`vox:${tool}`, mark(r, `/${String(src.action)}: ${tool} ran${said ? ` (${said}, as it reported)` : ''} and its record settled ok`, record));
    }
  }

  // MCP: a call answered through a command-line route (its mcp.call receipt: the route's own outcome, not an error result).
  for (const r of newestFirst) {
    if (r.kind !== 'mcp.call' || r.status !== 'ok' || typeof r.ts !== 'string' || typeof r.hash !== 'string' || !Array.isArray(r.sources)) continue;
    const src = obj(r.sources[0]);
    const route = str(src?.route);
    if (!src || !route || src.outcome !== 'answered' || src.called !== true || src.isError === true || !newer(`mcp:${route}`, r) || !ok(r)) continue;
    const record = Array.isArray(r.outputs) ? str(obj(r.outputs[0])?.path) : undefined;
    runs.set(`mcp:${route}`, mark(r, `an MCP call answered through the ${route} route`, record));
  }

  // Look: an /observe run whose measurements were parsed and sealed ok (its observation file is the record).
  for (const r of newestFirst) {
    if (r.kind !== 'observe' || r.status !== 'ok' || typeof r.ts !== 'string' || typeof r.hash !== 'string') continue;
    const worker = str(obj(r.observation)?.worker);
    if (!worker || !newer('observe:look', r) || !ok(r)) continue;
    const record = Array.isArray(r.outputs) ? str(obj(r.outputs[0])?.path) : undefined;
    runs.set('observe:look', mark(r, `an /observe run: ${worker} measured the image, and its observation was sealed ok`, record));
  }

  // Models: an /observe --qualify exchange whose answer was admitted (through OpenRouter, the route's only client).
  for (const r of newestFirst) {
    if (r.kind !== 'observe' || r.status !== 'ok' || typeof r.ts !== 'string' || typeof r.hash !== 'string') continue;
    const q = obj(obj(r.observation)?.qualified);
    if (!q || q.status !== 'admitted' || !str(q.model) || !newer('model:openrouter', r) || !ok(r)) continue;
    const model = String(q.model);
    const cites = Array.isArray(q.cites) ? q.cites.map(String).filter(Boolean) : [];
    const record = Array.isArray(r.outputs) ? str(obj(r.outputs[0])?.path) : undefined;
    const m = mark(r, `/observe --qualify: ${model} answered through OpenRouter and Timmy admitted the answer`, record);
    runs.set('model:openrouter', m);
    const was = qualified.get('model:openrouter');
    if (!was || (was.at ?? '') < m.at) {
      qualified.set('model:openrouter', {
        at: m.at,
        what: `${model}: an answer admitted under the ${QUALIFIED_PROTOCOL} protocol (/observe --qualify)${cites.length ? `, citing ${cites.length} observed ${cites.length === 1 ? 'handle' : 'handles'}` : ''}`,
        scope: 'that model, for that protocol, on that image; not the chat model, any other model or any other task',
        record: record ?? 'its observe receipt',
        receipt: m.receipt, hash: m.hash,
      });
    }
  }
  return { runs, qualified };
}

/** The recipe's run that counts in a project (recipeExercisedAt's rule), with the job and its own signed result. */
export function recipeMark(root: string): RunMark | undefined {
  let at: string | undefined;
  try { at = recipeExercisedAt(root); } catch { return undefined; }
  if (!at) return undefined;
  for (const j of listRecipeJobs(root)) {
    if (j.state !== 'succeeded' || !j.resultReceipt) continue;
    const got = verifiedResult(root, j.id);
    if (!got.ok) continue;
    const when = got.v.buildTs ?? (j.created ? new Date(j.created).toISOString() : undefined);
    if (when !== at) continue;
    return {
      at, what: 'a succeeded job of the recipe\'s real worker', receipt: got.v.resultReceipt, hash: got.v.resultHash,
      record: `.timmy/recipe-jobs/${j.id}/job.json`, chain: 'the job\'s own signed result, verified now, and every copied file matching its sha256',
    };
  }
  return undefined;
}

/** A mark as the ladder's exercised evidence. */
export const exercisedOf = (m: RunMark): ExercisedEvidence => ({
  at: m.at, what: m.what, receipt: m.receipt, hash: m.hash, ...(m.record ? { record: m.record } : {}), chain: m.chain,
});

// ── qualification records kept in this repository ─────────────────────────────

/** A formal qualification record kept in the repository: its acceptance evidence and the seal over its sources. */
export interface QualificationRecord {
  /** the /tools row it qualifies */
  row: string;
  evidence: string;
  seal: string;
  schema: string;
  what: string;
  scope: string;
}

export const QUALIFICATION_RECORDS: readonly QualificationRecord[] = [{
  row: 'recipe-tray',
  evidence: 'docs/orders/spatial-t5k1/evidence.json',
  seal: 'docs/orders/spatial-t5k1/seal.json',
  schema: 'timmy.spatial-t5k1.acceptance/1',
  what: 'the tray recipe\'s native acceptance (lanes/recipes/qualify.ts: three builds, the ±20 mm comparison, a refused zero wall, a tampered mesh and a missing check rejected)',
  scope: 'the recipe at the sources its seal names, as built where it ran; not a later revision, and not a physical part',
}];

/** Whether a repository qualification record qualifies its row here now; why not, in words, when it does not. */
export function checkQualificationRecord(rec: QualificationRecord, root: string | undefined): { ok: true; evidence: QualifiedEvidence } | { ok: false; why: string } {
  if (!root) return { ok: false, why: `no qualification record: ${rec.evidence} is kept in Timmy's repository, which this Timmy was not run from` };
  let evidence: Obj | undefined;
  let seal: Obj | undefined;
  try { evidence = obj(JSON.parse(readFileSync(join(root, rec.evidence), 'utf8'))); } catch { return { ok: false, why: `no qualification record: ${rec.evidence} is not here` }; }
  try { seal = obj(JSON.parse(readFileSync(join(root, rec.seal), 'utf8'))); } catch { return { ok: false, why: `${rec.evidence} is here, but its seal ${rec.seal} is not` }; }
  if (evidence?.schema !== rec.schema || evidence.state !== 'passed') return { ok: false, why: `${rec.evidence} is not a passed ${rec.schema} record` };
  const id = str(seal?.id);
  const sources = Array.isArray(seal?.sources) ? seal!.sources.map(obj).filter((s): s is Obj => Boolean(s && str(s.path) && str(s.sha256))) : [];
  if (!id || !sources.length) return { ok: false, why: `${rec.seal} names no seal or no sources` };
  const changed: string[] = [];
  for (const s of sources) {
    let now: string | undefined;
    try { now = createHash('sha256').update(readFileSync(join(root, String(s.path)))).digest('hex'); } catch { now = undefined; }
    if (now !== s.sha256) changed.push(String(s.path));
  }
  if (changed.length) {
    return { ok: false, why: `the qualification record ${rec.evidence} (seal ${id}, passed) covers earlier sources: ${changed.length} of ${sources.length} have changed since (${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ', …' : ''}), so it does not qualify this revision` };
  }
  return { ok: true, evidence: { what: rec.what, scope: rec.scope, record: rec.evidence, receipt: id, ...(str(seal?.hash) ? { hash: String(seal!.hash) } : {}) } };
}
