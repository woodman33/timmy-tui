// Higgsfield generation adapter. Stub mode is fully dependency-free: no
// network, no live-client import; stable synthetic artifact content and a
// unique request identity, shaped like the live result so downstream stages
// (ledger, judges, timeline) run unmodified. Live mode denies BEFORE any spend: resolveHfCredentials() throws
// before the client package is even located or loaded.
//
// The @higgsfield/client package is a GLOBAL tool install, not a repo
// dependency, so the live path resolves it lazily at call time: first via
// normal require resolution (covers local installs and NODE_PATH), then via
// the npm global root, then via prefix-relative candidates derived from
// process.execPath. Stub mode never touches any of this.
//
// Spend reconciliation: any live-path throw carries a `spend=unknown` marker
// when the request was accepted server-side (we have a request_id, so the
// outcome is unknown and the receipt layer must reconcile), or `spend=unlikely`
// when there is no request_id (the request was likely rejected before
// acceptance). Never report an unknown live cost as measured $0 — see the
// cost_measured flag on HfGenResult.
//
// Probe/render classification (forge stop-and-review limitation (b), CLOSED at
// the adapter layer): HfGenInput.kind ('probe' default | 'render') drives
// result.probe, so full renders are distinguishable from probes in the ledger.
// Classification is caller-driven: the rehearsal runner (pipeline/rehearse.ts,
// Task 20) passes kind per script stage, so the kind note on HfGenInput below
// is TRUE for rehearsal. The gen.ts live dispatch still omits kind and
// therefore defaults to 'probe' — the documented remaining gap until dispatch
// wires stage context. An advisory catalog helper (probeEligible, config.ts)
// exists for preflight lint but is wired into nothing yet.

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { resolveHfCredentials, redact } from './config.js';

export interface HfGenInput {
  endpoint: string; input: Record<string, unknown>; mode: 'stub' | 'live';
  // Probe/render classification — limitation (b) is closed at the adapter
  // layer: kind defaults to 'probe' (backward compatible; callers that
  // predate kind are unchanged), and the rehearsal runner (rehearse.ts)
  // passes kind: 'render' for full-render stages so the ledger can tell
  // them apart. Remaining gap: gen.ts live dispatch omits kind (probe
  // default) until dispatch wires stage context.
  kind?: 'probe' | 'render';
}
export interface HfGenResult {
  request_id: string; status: 'completed' | 'failed' | 'nsfw';
  artifact_url: string; cost_usd: number; probe: boolean;
  // Additive honesty flag (review-sanctioned amendment): true means cost_usd
  // was genuinely measured ($0 stub); false means cost_usd is a placeholder and
  // the true live cost is UNKNOWN until Higgsfield exposes usage. The receipt
  // layer MUST treat cost_measured:false as 'declared-unknown', never as a
  // measured $0.
  cost_measured?: boolean;
}

// Minimal structural typing of the real @higgsfield/client/v2 surface we use
// (the package is not in tsgo's scope, so we type it locally instead of
// importing its .d.ts — keeps typecheck clean without adding a dependency).
export interface HfV2Response {
  status: string;
  request_id: string;
  video?: { url: string };
  images?: Array<{ url: string }>;
}
export interface HfV2Module {
  config: (cfg: { credentials: string }) => void;
  higgsfield: {
    subscribe: (endpoint: string, options: { input: unknown; withPolling: boolean }) => Promise<HfV2Response>;
  };
}

// Single source of status truth. Anything that is not a terminal status —
// 'queued', 'in_progress', garbage, empty — maps to 'unknown' so callers can
// never mistake a still-running or malformed status for a finished one.
export function mapHfStatus(raw: string): 'completed' | 'failed' | 'nsfw' | 'unknown' {
  if (raw === 'completed') return 'completed';
  if (raw === 'nsfw') return 'nsfw';
  if (raw === 'failed') return 'failed';
  return 'unknown';
}

// Defensive request-id extraction from a thrown client error: ids are not
// secret, so this runs BEFORE any redaction. Any of the three common shapes
// may carry the id depending on where the client failed.
function extractRequestId(err: unknown): string | undefined {
  const e = err as { request_id?: unknown; response?: { request_id?: unknown }; body?: { request_id?: unknown } } | null | undefined;
  const rid = e?.request_id ?? e?.response?.request_id ?? e?.body?.request_id;
  return typeof rid === 'string' && rid.length > 0 ? rid : undefined;
}

// Only sanitized diagnostic copies cross the public boundary. Provider errors
// may carry headers, body fields, custom inspect hooks and nested raw causes.
function publicCause(error: unknown, scrub: (text: string) => string, seen = new Set<unknown>()): Error {
  if (seen.has(error) || seen.size >= 8) return new Error('provider cause omitted (cycle or depth limit)');
  seen.add(error);
  const result = new Error(scrub(error instanceof Error ? error.message : String(error)));
  if (error instanceof Error && error.cause !== undefined) result.cause = publicCause(error.cause, scrub, seen);
  return result;
}

// Preserve reconciliation: spend=unknown with a request id, otherwise unlikely.
function reconcileError(detail: string, opts: { cause?: unknown; requestId?: string }, scrub: (text: string) => string): Error {
  const rid = opts.requestId ? ` request_id=${opts.requestId}` : '';
  const spend = opts.requestId ? 'spend=unknown' : 'spend=unlikely';
  return new Error(scrub(`${detail}${rid} ${spend}`),
    opts.cause === undefined ? undefined : { cause: publicCause(opts.cause, scrub) });
}

function assertHfV2Module(v2: unknown, path: string): HfV2Module {
  const m = v2 as HfV2Module;
  if (typeof m?.config !== 'function' || typeof m?.higgsfield?.subscribe !== 'function') {
    throw new Error(`live mode requires global @higgsfield/client (incompatible build at ${path})`);
  }
  return m;
}

function loadHfV2(): HfV2Module {
  const req = createRequire(import.meta.url);
  try {
    return assertHfV2Module(req('@higgsfield/client/v2'), '@higgsfield/client/v2');
  } catch {
    // not resolvable from this repo (expected — global install); keep looking
  }
  const roots: string[] = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim());
  } catch {
    // npm not on PATH; prefix-relative candidates below still apply
  }
  // Common prefix layouts: <prefix>/bin/node → <prefix>/lib/node_modules
  // (two levels), plus Homebrew's realpath depth (Cellar/<name>/<ver>/bin/node
  // → Homebrew <prefix>/lib/node_modules, three levels).
  roots.push(resolve(process.execPath, '..', '..', 'lib', 'node_modules'));
  roots.push(resolve(process.execPath, '..', '..', '..', 'lib', 'node_modules'));
  for (const root of roots) {
    const candidate = join(root, '@higgsfield/client/dist/v2/index.js');
    try {
      // Direct file path intentionally bypasses the package exports map.
      return assertHfV2Module(req(candidate), candidate);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Missing candidate file → try the next root. A MODULE_NOT_FOUND whose
      // message does NOT name our candidate means the module exists but broke
      // while loading its own dependencies — that is a real load failure, not
      // a missing install, so surface it immediately.
      if (e?.code === 'MODULE_NOT_FOUND' && String(e.message).includes(candidate)) continue;
      throw new Error(`@higgsfield/client at ${root} failed to load: ${e?.message ?? String(err)}`, { cause: err });
    }
  }
  throw new Error('live mode requires the global @higgsfield/client package (npm i -g @higgsfield/client); stub mode needs no dependency');
}

// TEST-ONLY hook: unit tests inject a mocked @higgsfield/client/v2 module
// instead of the global install. Pass undefined to restore the real loader.
type HfV2Loader = () => HfV2Module;
const defaultLoader: HfV2Loader = loadHfV2;
let hfV2Loader: HfV2Loader = defaultLoader;
export function _setHfV2LoaderForTests(loader: HfV2Loader | undefined): void {
  hfV2Loader = loader ?? defaultLoader;
}

// Sort JSON object keys recursively so equivalent input maps produce the same
// synthetic artifact bytes. Request identity remains unique for every attempt.
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalJson(item)]));
  return value;
}

export async function hfGenerate(req: HfGenInput): Promise<HfGenResult> {
  // Runtime callers (MCP/JS) are not protected by the TypeScript union. An
  // invalid mode must never fall into live execution; invalid kinds must not
  // silently relabel a full render as a probe.
  if (req.mode !== 'stub' && req.mode !== 'live') throw new Error('higgsfield mode must be stub or live');
  if (req.kind !== undefined && req.kind !== 'probe' && req.kind !== 'render') {
    throw new Error('higgsfield kind must be probe or render');
  }
  // Classification is caller-driven (the runner knows probe vs render by
  // stage); the adapter only records it. Absent kind means 'probe'.
  const probe = req.kind !== 'render';
  if (req.mode === 'stub') {
    const id = randomUUID();
    const content = JSON.stringify(canonicalJson(JSON.parse(JSON.stringify({
      schema: 'timmy-hf-stub/1', endpoint: req.endpoint, input: req.input, kind: probe ? 'probe' : 'render',
    }))));
    const artifactId = createHash('sha256').update(content).digest('hex');
    // cost_usd is a genuinely known $0 in stub mode, so cost_measured is true.
    return {
      request_id: id, status: 'completed', artifact_url: `stub://forge/${artifactId}.mp4`,
      cost_usd: 0, probe, cost_measured: true,
    };
  }
  // Throws before the client is located or any request is made — deny first.
  const creds = resolveHfCredentials();
  // Pin redaction to the credentials actually used, even if env changes mid-job.
  const scrub = (text: string) => redact(text, `${creds.keyId}:${creds.keySecret}`);
  let v2: HfV2Module;
  try {
    v2 = hfV2Loader();
  } catch (err) {
    const detail = scrub(err instanceof Error ? err.message : String(err));
    throw new Error(`live mode requires global @higgsfield/client (npm i -g @higgsfield/client); loader failed: ${detail}`, { cause: publicCause(err, scrub) });
  }
  let res: HfV2Response;
  try {
    // ASSUMPTION (unverifiable offline): the external @higgsfield/client's own
    // credentials parsing may split on EVERY colon, so a keySecret containing
    // colons could be misparsed downstream. Timmy's internal parse
    // (resolveHfCredentials, config.ts) is first-colon and round-trips a
    // multi-colon secret safely — we rejoin as keyId:keySecret here. If live
    // auth fails only with a multi-colon secret, the external client's
    // colon-split is the suspected cause.
    v2.config({ credentials: `${creds.keyId}:${creds.keySecret}` });
    res = await v2.higgsfield.subscribe(req.endpoint, { input: req.input, withPolling: true });
  } catch (err) {
    // Extract the request id BEFORE redaction (ids aren't secret): with an id
    // the request was accepted server-side and spend is unknown; without one
    // it was likely rejected before acceptance.
    const requestId = extractRequestId(err);
    const detail = scrub(err instanceof Error ? err.message : String(err));
    throw reconcileError(`higgsfield request failed: ${detail}`, { cause: err, requestId }, scrub);
  }
  const status = mapHfStatus(res.status);
  if (status === 'unknown') {
    // Non-terminal or unparseable status after polling ended: the request may
    // still be running (or spending) server-side — never report it as failed.
    throw reconcileError(
      `higgsfield request ended in non-terminal status '${res.status}'`,
      { requestId: res.request_id }, scrub,
    );
  }
  return {
    // Results also reach public errors/receipts; provider IDs are untrusted.
    request_id: typeof res.request_id === 'string' ? scrub(res.request_id) : '',
    status,
    artifact_url: res.video?.url ?? res.images?.[0]?.url ?? '',
    // TODO(measured): live cost is UNKNOWN until Higgsfield exposes usage —
    // cost_measured:false tells the receipt layer to treat this as
    // 'declared-unknown', never as a measured $0.
    cost_usd: 0,
    // probe comes from req.kind (see HfGenInput) — limitation (b) closed:
    // full renders are no longer indistinguishable from probes in the ledger.
    probe,
    cost_measured: false,
  };
}
