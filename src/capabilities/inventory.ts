/**
 * R11 Phase 2 (H170): the one capability inventory both surfaces read (the terminal's Chat rail, H167; the browser
 * companion, H171). Three words for a capability, kept apart everywhere, never a fourth:
 *
 *   available    the files or binaries are here (a path, a version; nothing run)
 *   configured   the key, setting or address is set (whether a key is present and where it is kept; never its value)
 *   exercised    a receipt of a real run exists on the project's runs chain, which verifies here
 *
 * Nothing is run to compute it and nothing is contacted: files, settings and receipts only, in well under a second. The
 * ladder (src/capabilities/index.ts, `timmy tools`) stays what it is: it probes; this reads. Every fact names the function
 * it came from (`source`), and `next` is the one step that would move the row to its next word, in the product's own
 * setup words. The sentences each word carries come from ./inventory-words.ts, the one words file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloudModelTag } from '../setup/ollama-models.js';
import { resolveChatRoute, type ChatRoute } from '../agent/chat-route.js';
import { listLanes } from '../utils/dispatch.js';
import { keyWhere, type KeyedProvider } from '../setup/provider-keys.js';
import { ollamaInstalled } from '../setup/ollama-local.js';
import { providerStates, PROVIDER_LABEL, type ProviderState } from '../setup/providers-state.js';
import { workspaceRoot, type Env } from '../setup/home.js';
import { mcpRoutes, type McpRoute } from '../connectors/mcp-cli.js';
import { mcporterConfigFiles, parseJsonc } from '../connectors/mcp-configured.js';
import { OPENHANDS_ROUTE, OPENHANDS_IMAGE } from '../code-agents/openhands.js';
import { openHandsWorker } from '../code-agents/openhands-run.js';
import { BUILD_CONTENTS } from '../utils/doctor.js';
import { packagedPath } from '../utils/asset-dirs.js';
import { toolStatuses, type ToolStatus } from '../vox/tools.js';
import { VISION_BRIDGE } from '../vision/runtime.js';
import { readChain, verifyChain, type Receipt, type VerifyResult } from '../utils/receipts.js';
import { chainEvidence, type ChainEvidence, type RunMark } from './evidence.js';
import { whichOnPath } from './live.js';
import { scrubHomes, scrubStrings } from '../utils/home-scrub.js';
import { rowWords } from './inventory-words.js';

export type InventoryGroup = 'Models' | 'Tools' | 'Integrations' | 'Lanes' | 'Vision' | 'Receipts';
export const INVENTORY_GROUPS: readonly InventoryGroup[] = ['Models', 'Tools', 'Integrations', 'Lanes', 'Vision', 'Receipts'];

/** The three words, and what each means (the common brief's rule: never a fourth). */
export type StateWord = 'available' | 'configured' | 'exercised';
export const STATE_MEANS: Readonly<Record<StateWord, string>> = {
  available: 'the files or binaries are here',
  configured: 'the key, setting or address is set',
  exercised: 'a receipt of a real run exists',
};

/** One fact behind a word: whether it holds, what was found or set (never a key's value), and the function that read it. */
export interface FactFound {
  ok: boolean;
  /** what was found (paths, versions) or what is set (key present yes/no and where, an address, a model) */
  found: string;
  /** the function this fact came from, e.g. "ollamaInstalled (src/setup/ollama-local.ts)" */
  source: string;
}
/** The fact with the sentence a surface shows for its word (./inventory-words.ts). */
export interface Fact extends FactFound { words: string }

/** The exercised word's fact: the receipt of a real run, or why none counts. */
export type ExercisedFound =
  | { ok: true; receipt: string; hash: string; when: string; what: string; record?: string; source: string }
  | { ok: false; found: string; source: string };
export type Exercised = ExercisedFound & { words: string };

export interface InventoryRow {
  /** stable: model:openrouter, vox:look, mcp:route:mcporter, mcp:server:<name>, lane:<id>, agent:openhands, vision:bridge, receipts:chain */
  id: string;
  /** an existing name, as the product already says it */
  name: string;
  group: InventoryGroup;
  available: Fact;
  configured: Fact;
  exercised: Exercised;
  /** the one step that would move this row to its next word, in the product\'s existing setup words; absent once exercised */
  next?: string;
}

export interface InventoryContext {
  env?: Env;
  /** the project (the receipts chain, the vox venv, MCPorter's project config); process.cwd() when absent */
  cwd?: string;
  platform?: NodeJS.Platform;
  /** the account\'s home (Ollama\'s app, MCPorter\'s home config); the env\'s HOME when absent */
  home?: string;
  now?: number;
  // seams, so a test stands in for the machine with a FAKE home: files and the PATH only, nothing run
  exists?: (p: string) => boolean;
  /** where a program is on the PATH (the first executable file), or null; nothing is run */
  which?: (program: string) => string | null;
  /** the project\'s runs chain as read and verified here (readChain + verifyChain of src/utils/receipts.ts) */
  chain?: () => { receipts: Receipt[]; verify: VerifyResult };
  /** whether a packaged file (doctor.ts BUILD_CONTENTS) is in this build */
  packaged?: (rel: string) => boolean;
}

export interface Inventory {
  schema: 'timmy.capability-inventory/1';
  readAt: string;
  means: Readonly<Record<StateWord, string>>;
  groups: readonly InventoryGroup[];
  rows: InventoryRow[];
}

/** Every row, grouped in INVENTORY_GROUPS order. Read only: files, settings and receipts; nothing run, nothing contacted. */
export function capabilityInventory(ctx: InventoryContext = {}): InventoryRow[] {
  return inventory(ctx).rows;
}

/** The rows with the words they are read under (one object a surface can keep or send whole). */
export function inventory(ctx: InventoryContext = {}): Inventory {
  const c = resolved(ctx);
  const chain = readChainOnce(c);
  const rows: InventoryRow[] = [
    ...modelRows(c, chain),
    ...voxRows(c, chain),
    ...integrationRows(c, chain),
    ...laneRows(c, chain),
    ...visionRows(c, chain),
    receiptsRow(c, chain),
  ];
  // no row shows a path under a home folder as absolute (src/utils/home-scrub.ts), and no row ever carries a key\'s value
  const homes = (t: string): string => scrubHomes(t, c.env as NodeJS.ProcessEnv);
  const scrubbed = rows.map((r) => scrubStrings(r, homes));
  return { schema: 'timmy.capability-inventory/1', readAt: new Date(c.now).toISOString(), means: STATE_MEANS, groups: INVENTORY_GROUPS, rows: scrubbed };
}

// ── the context, resolved ─────────────────────────────────────────────────────

interface Ctx {
  env: Env; cwd: string; platform: NodeJS.Platform; home: string | undefined; now: number;
  exists: (p: string) => boolean; which: (program: string) => string | null;
  chain?: () => { receipts: Receipt[]; verify: VerifyResult };
  packaged: (rel: string) => boolean;
}

function resolved(ctx: InventoryContext): Ctx {
  const env = ctx.env ?? process.env;
  return {
    env, cwd: ctx.cwd ?? process.cwd(), platform: ctx.platform ?? process.platform, home: ctx.home ?? env.HOME, now: ctx.now ?? Date.now(),
    exists: ctx.exists ?? ((p) => existsSync(p)),
    which: ctx.which ?? ((program) => whichOnPath(program, env)),
    ...(ctx.chain ? { chain: ctx.chain } : {}),
    packaged: ctx.packaged ?? ((rel) => packagedPath(rel, import.meta.url, { kind: 'file' }) !== undefined),
  };
}

// ── the chain, read once ──────────────────────────────────────────────────────

interface Chain {
  receipts: Receipt[];
  verify: VerifyResult;
  evidence: ChainEvidence;
  /** why nothing could be read, when the chain itself could not be */
  unread?: string;
}

const SRC = {
  chain: 'readChain + verifyChain (src/utils/receipts.ts)',
  evidence: 'chainEvidence (src/capabilities/evidence.ts)',
  turns: 'turnReceipts (src/capabilities/inventory.ts, over the sealed turns of src/repl/seal.ts)',
  mcpCalls: 'mcpCallReceipts (src/capabilities/inventory.ts, over the mcp.call receipts of src/connectors/mcp-records.ts)',
  dispatches: 'dispatchReceipts (src/capabilities/inventory.ts, over the dispatch receipts of src/utils/dispatch.ts)',
} as const;

function readChainOnce(c: Ctx): Chain {
  const none: Chain = { receipts: [], verify: { ok: true, count: 0, current_epoch: 1, segments: [] } as unknown as VerifyResult, evidence: { runs: new Map(), qualified: new Map() } };
  try {
    const got = c.chain ? c.chain() : { receipts: readChain('runs', c.cwd), verify: verifyChain('runs', c.cwd) };
    const evidence = chainEvidence(got.receipts as unknown as Array<Record<string, unknown>>, got.verify);
    return { receipts: got.receipts, verify: got.verify, evidence };
  } catch (e) {
    return { ...none, unread: `the receipts could not be read (${e instanceof Error ? e.message : String(e)})` };
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const short = (hash: string): string => hash.replace(/^sha256_/, '').slice(0, 8);

/** The receipts that may vouch for a run: on a chain that verifies, in an epoch whose segment verifies (as evidence.ts reads it). */
function vouching(chain: Chain): Obj[] {
  if (!chain.verify.ok) return [];
  const ok = new Set(chain.verify.segments.filter((s) => s.ok).map((s) => s.epoch));
  return (chain.receipts as unknown as Obj[]).filter((r) => ok.has(typeof r.epoch === 'number' ? r.epoch : 1) && typeof r.hash === 'string' && typeof r.ts === 'string');
}

const markOf = (r: Obj, what: string, record?: string): RunMark => ({ at: String(r.ts), what, receipt: short(String(r.hash)), hash: String(r.hash), ...(record ? { record } : {}), chain: 'on the runs chain, which verifies here' });

/** The newest sealed chat turn (kind turn or chat, status ok) by route: OpenRouter, Ollama on this computer, or a cloud-backed Ollama model. */
function turnReceipts(chain: Chain): { openrouter?: RunMark; ollamaLocal?: RunMark; ollamaCloud?: RunMark } {
  const out: { openrouter?: RunMark; ollamaLocal?: RunMark; ollamaCloud?: RunMark } = {};
  for (const r of [...vouching(chain)].reverse()) {
    if ((r.kind !== 'turn' && r.kind !== 'chat') || r.status !== 'ok') continue;
    const model = str(r.model_resolved) ?? str(r.model_requested) ?? 'a model';
    if (r.via === 'ollama') {
      const src = Array.isArray(r.sources) ? obj(r.sources.find((s) => obj(s)?.kind === 'ollama')) : undefined;
      const host = str(src?.host);
      if (cloudModelTag(model)) { if (!out.ollamaCloud) out.ollamaCloud = markOf(r, `a sealed chat turn answered by ${model}, a cloud-backed model through Ollama${host ? ` at ${host}` : ''}`); }
      else if (!out.ollamaLocal) out.ollamaLocal = markOf(r, `a sealed chat turn answered by ${model} through Ollama${host ? ` at ${host}` : ''}`);
    } else if (!out.openrouter) out.openrouter = markOf(r, `a sealed chat turn answered by ${model} through OpenRouter`);
    if (out.openrouter && out.ollamaLocal && out.ollamaCloud) break;
  }
  return out;
}

/** The newest MCP call answered through a command-line route, by server name (the mcp.call receipt\'s own outcome). */
function mcpCallReceipts(chain: Chain): Map<string, RunMark> {
  const out = new Map<string, RunMark>();
  for (const r of [...vouching(chain)].reverse()) {
    if (r.kind !== 'mcp.call' || r.status !== 'ok' || !Array.isArray(r.sources)) continue;
    const src = obj(r.sources[0]);
    const server = str(src?.server); const route = str(src?.route);
    if (!src || !server || src.outcome !== 'answered' || src.called !== true || src.isError === true || out.has(server)) continue;
    const record = Array.isArray(r.outputs) ? str(obj(r.outputs[0])?.path) : undefined;
    out.set(server, markOf(r, `an MCP call to ${server} answered through the ${route ?? 'command-line'} route`, record));
  }
  return out;
}

/** The newest dispatch of each lane (the launch\'s receipt, status ok: a run was started; its result is the job\'s own record). */
function dispatchReceipts(chain: Chain): Map<string, RunMark> {
  const out = new Map<string, RunMark>();
  for (const r of [...vouching(chain)].reverse()) {
    if (r.kind !== 'run' || r.status !== 'ok') continue;
    const m = /^dispatch (\S+) · (\S+) · (\d+)x$/.exec(String(r.subject ?? ''));
    if (!m || out.has(m[2])) continue;
    out.set(m[2], markOf(r, `dispatch ${m[1]} started ${m[3]} ${m[3] === '1' ? 'copy' : 'copies'} of this lane (the launch\'s receipt; the result is in the job\'s own record)`));
  }
  return out;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const fact = (ok: boolean, found: string, source: string): FactFound => ({ ok, found, source });
const ran = (m: RunMark | undefined, source: string, none: string): ExercisedFound => (m
  ? { ok: true, receipt: m.receipt, hash: m.hash, when: m.at, what: m.what, ...(m.record ? { record: m.record } : {}), source }
  : { ok: false, found: none, source });
/** The exercised word when the chain cannot vouch: broken, or none read. */
const chainNone = (chain: Chain, none: string): string => chain.unread ?? (chain.verify.ok ? none : `no run counts: ${chain.evidence.broken ?? 'the receipts chain does not verify'}`);

type Draft = { id: string; name: string; group: InventoryGroup; available: FactFound; configured: FactFound; exercised: ExercisedFound; next?: string };

/** A row with its sentences (./inventory-words.ts); `next` only while a word is still to be earned. */
function row(d: Draft): InventoryRow {
  const words = rowWords(d);
  const r: InventoryRow = {
    id: d.id, name: d.name, group: d.group,
    available: { ...d.available, words: words.available },
    configured: { ...d.configured, words: words.configured },
    exercised: { ...d.exercised, words: words.exercised },
  };
  if (!d.exercised.ok && d.next) r.next = d.next;
  return r;
}

// ── Models: the four chat providers ───────────────────────────────────────────

const PROVIDER_SRC = 'providerStates (src/setup/providers-state.ts)';
const KEY_SRC = 'keyWhere (src/setup/provider-keys.ts)';
const ROUTE_SRC = 'resolveChatRoute (src/agent/chat-route.ts)';

function modelRows(c: Ctx, chain: Chain): InventoryRow[] {
  const states = providerStates({ env: c.env, cwd: c.cwd, platform: c.platform, ...(c.home ? { home: c.home } : {}), now: c.now, exists: c.exists });
  const state = (id: ProviderState['id']): ProviderState => states.find((s) => s.id === id)!;
  const route = ((): ChatRoute | null => { try { return resolveChatRoute({ env: c.env }); } catch { return null; } })();
  const turns = turnReceipts(chain);
  const keyFact = (id: KeyedProvider): FactFound => {
    const k = ((): ReturnType<typeof keyWhere> => { try { return keyWhere(id, c.env, c.cwd); } catch { return null; } })();
    return k ? fact(true, `a key is present (${k.fingerprint}), from ${k.words}`, KEY_SRC) : fact(false, 'no key is set', KEY_SRC);
  };
  const chatIs = (r: ChatRoute | null): string => (r?.kind === 'local' ? (r.model ? `the chat is set to local ${r.model}${r.cloud ? ' (a cloud-backed name)' : ''}${r.from ? ` from ${r.from}` : ''}` : 'the chat is set to local, and no model is chosen') : 'the chat is set to OpenRouter');

  // OpenRouter: the client is Timmy's own (@openrouter/sdk); configured when a key is kept; exercised by a sealed turn or an admitted /observe --qualify answer
  const orKey = keyFact('openrouter');
  const orQualify = chain.evidence.runs.get('model:openrouter');
  const orRun = [turns.openrouter, orQualify].filter((m): m is RunMark => Boolean(m)).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const openrouter = row({
    id: 'model:openrouter', name: PROVIDER_LABEL.openrouter, group: 'Models',
    available: fact(true, 'built in: Timmy\'s OpenRouter client (@openrouter/sdk); no install needed', 'capabilityInventory (src/capabilities/inventory.ts: the dependency is Timmy\'s own)'),
    configured: { ...orKey, found: `${orKey.found}; ${chatIs(route)}`, source: `${KEY_SRC}; ${ROUTE_SRC}` },
    exercised: ran(orRun, orRun === orQualify ? SRC.evidence : SRC.turns, chainNone(chain, 'no sealed chat turn through OpenRouter yet')),
    next: !orKey.ok ? state('openrouter').next ?? 'Sign in with OpenRouter, or paste a key from openrouter.ai/keys' : route?.kind === 'openrouter' ? 'Send a message in the chat (each answered turn seals a receipt)' : 'Set the chat to OpenRouter (timmy init --chat openrouter, or /setup chat in the REPL), then send a message',
  });

  // Ollama on this computer: the program or app here; the chat set to a local model at a loopback address; a sealed local turn
  const inst = ollamaInstalled({ env: c.env, platform: c.platform, ...(c.home ? { home: c.home } : {}), exists: c.exists });
  const local = state('ollama-local');
  const localCfg = route?.kind === 'local' && route.model && !route.cloud
    ? fact(true, `${chatIs(route)}; Ollama at ${route.host}`, ROUTE_SRC)
    : route?.kind === 'local' && route.cloud ? fact(false, `${chatIs(route)}: it runs in Ollama Cloud, not on this computer; Ollama at ${route.host}`, ROUTE_SRC)
      : route?.kind === 'local' ? fact(false, `${chatIs(route)}; Ollama at ${route.host}`, ROUTE_SRC) : fact(false, `${chatIs(route)}; no local model is chosen`, ROUTE_SRC);
  const ollamaLocal = row({
    id: 'model:ollama-local', name: PROVIDER_LABEL['ollama-local'], group: 'Models',
    available: fact(inst.installed, `Ollama is ${inst.words}${inst.how ? ` (${inst.how})` : ''}`, 'ollamaInstalled (src/setup/ollama-local.ts)'),
    configured: localCfg,
    exercised: ran(turns.ollamaLocal, SRC.turns, chainNone(chain, 'no sealed chat turn through the Ollama on this computer yet')),
    next: !inst.installed ? local.next ?? 'Install Ollama, then start it' : !localCfg.ok ? 'Choose a local model: timmy init --chat local --model <name>, or /model in the REPL' : local.next ?? 'Send a message in the chat (each answered turn seals a receipt)',
  });

  // Ollama Cloud: no local install; a key kept, or a cloud-backed model name (":cloud", as Ollama lists it) chosen for the chat,
  // which Ollama runs under the person's account; a sealed turn answered by such a model
  const ocKey = keyFact('ollama-cloud');
  const cloudChosen = route?.kind === 'local' && Boolean(route.model) && route.cloud;
  const ollamaCloud = row({
    id: 'model:ollama-cloud', name: PROVIDER_LABEL['ollama-cloud'], group: 'Models',
    available: fact(true, 'built in: Ollama Cloud needs no local install or download; a cloud-backed model (its name says cloud, as Ollama lists it under /api/tags) runs under your Ollama account', 'capabilityInventory (src/capabilities/inventory.ts; cloudModelTag of src/setup/ollama-models.ts names the cloud-backed models)'),
    configured: ocKey.ok || cloudChosen
      ? fact(true, `${ocKey.found}${cloudChosen ? `; ${chatIs(route)}` : '; no cloud-backed model is chosen for the chat'}`, `${KEY_SRC}; ${ROUTE_SRC}`)
      : fact(false, `${ocKey.found}; no cloud-backed model is chosen for the chat`, `${KEY_SRC}; ${ROUTE_SRC}`),
    exercised: ran(turns.ollamaCloud, SRC.turns, chainNone(chain, 'no sealed chat turn answered by a cloud-backed Ollama model yet')),
    next: !ocKey.ok && !cloudChosen ? state('ollama-cloud').next ?? 'Paste an Ollama API key from ollama.com/settings/keys' : 'Choose a cloud-backed model (/model lists them as cloud-backed), then send a message: the chat then leaves this computer',
  });

  // Cloudflare: optional and read only; nothing is ever sent to check it, and nothing runs through it to seal a receipt
  const cf = state('cloudflare');
  const cloudflare = row({
    id: 'model:cloudflare', name: PROVIDER_LABEL.cloudflare, group: 'Models',
    available: fact(true, 'built in: the decision model\'s Workers AI transport and the Worker\'s /health check; no install needed', 'capabilityInventory (src/capabilities/inventory.ts; src/decision/config.ts holds the one Cloudflare model path)'),
    configured: fact(cf.state !== 'not set up', (cf.lines ?? []).join(' · ') || 'nothing is set', PROVIDER_SRC),
    exercised: { ok: false, found: 'never: Timmy sends Cloudflare no request to check it (a request to an AI Gateway can create one and bill), and no chat turn runs through it', source: PROVIDER_SRC },
    next: cf.state === 'not set up' ? 'Optional: set TIMMY_EDGE_HOST (or the private overlay\'s edge host) for the Worker; the local app needs no Cloudflare account' : undefined,
  });
  return [openrouter, ollamaLocal, ollamaCloud, cloudflare];
}

// ── Tools: VoxVision's readers and viewers (toolStatuses) ─────────────────────

function voxRows(c: Ctx, chain: Chain): InventoryRow[] {
  const onPath = (bin: string): string | null => c.which(bin);
  let statuses: ToolStatus[] = [];
  try { statuses = toolStatuses({ env: c.env as NodeJS.ProcessEnv, onPath, root: c.cwd }); } catch { statuses = []; }
  const SRC_TOOLS = 'toolStatuses (src/vox/tools.ts)';
  return statuses.map((s) => {
    const keyed = s.tool === 'roboflow';
    const keyPresent = Boolean(c.env.ROBOFLOW_API_KEY?.trim());
    const available = s.state === 'built in' ? fact(true, `built in: ${s.detail}`, SRC_TOOLS)
      : s.state === 'found' ? fact(true, s.detail, SRC_TOOLS)
        : keyed && /ROBOFLOW_API_KEY/.test(s.detail) ? fact(c.packaged('scripts/roboflow-bridge.py'), c.packaged('scripts/roboflow-bridge.py') ? 'the Roboflow bridge (scripts/roboflow-bridge.py) is in this build' : 'the Roboflow bridge (scripts/roboflow-bridge.py) is missing from this installation', 'checkBuildContents (src/utils/doctor.ts)')
          : fact(false, s.detail, SRC_TOOLS);
    const configured = keyed
      ? fact(keyPresent, keyPresent ? 'ROBOFLOW_API_KEY is set (its value is never shown)' : 'ROBOFLOW_API_KEY is not set', 'roboflowReady (src/vox/tools.ts: the key\'s presence only)')
      : fact(true, 'no key or address is needed', SRC_TOOLS);
    const m = chain.evidence.runs.get(`vox:${s.tool}`) ?? (s.tool === 'look' ? chain.evidence.runs.get('observe:look') : undefined);
    const exercised = ran(m, SRC.evidence, chainNone(chain, `no vox record settled ok with ${s.name} yet`));
    return row({
      id: `vox:${s.tool}`, name: s.name, group: 'Tools', available, configured, exercised,
      next: !available.ok ? s.setup ?? 'see /vox' : !configured.ok ? s.setup ?? 'set ROBOFLOW_API_KEY' : `Run it once: ${voxAction(s.tool)} (its record and receipt seal the run)`,
    });
  });
}

function voxAction(tool: string): string {
  switch (tool) {
    case 'look': return '/observe <image>, or /detect <image> color 255,0,0';
    case 'roboflow': return '/detect <image> --model <id> (a hosted model, with your key; Roboflow inference is unverified until a real authorized run succeeds)';
    case 'stl': case 'spatial': case 'step': case 'blend': return '/inspect <file>';
    case 'video': return '/inspect <video>';
    case 'geo': return '/measure <file>';
    case 'rerun': case 'viser': case 'fiftyone': return '/vox view (a viewer\'s launch is not a judged run)';
    default: return '/inspect <file>';
  }
}

// ── Integrations: the MCP-to-CLI routes, the servers named for them, OpenHands ─

function integrationRows(c: Ctx, chain: Chain): InventoryRow[] {
  const routes = ((): McpRoute[] => { try { return mcpRoutes(c.env, { onPath: (p) => c.which(p) !== null }); } catch { return []; } })();
  const servers = mcporterServersNamed(c);
  const calls = mcpCallReceipts(chain);
  const SRC_ROUTES = 'mcpRoutes (src/connectors/mcp-cli.ts)';
  const SRC_CFG = 'mcporterConfigFiles + parseJsonc (src/connectors/mcp-configured.ts)';
  const routeRows = routes.map((r) => {
    const cfg = r.id === 'mcporter'
      ? (servers.files.length ? fact(servers.names.length > 0, `${servers.names.length} server${servers.names.length === 1 ? '' : 's'} named in ${servers.files.join(', ')}${servers.names.length ? `: ${servers.names.join(', ')}` : ''}`, SRC_CFG) : fact(false, 'no MCPorter config file (mcporter.json) in the home or the project', SRC_CFG))
      : fact(true, 'no configuration: it runs ad-hoc stdio servers from a command line after --', SRC_ROUTES);
    const m = chain.evidence.runs.get(`mcp:${r.id}`);
    return row({
      id: `mcp:route:${r.id}`, name: r.label.trim(), group: 'Integrations',
      available: fact(r.available, r.details, SRC_ROUTES), configured: cfg,
      exercised: ran(m, SRC.evidence, chainNone(chain, `no MCP call answered through the ${r.id} route yet`)),
      next: !r.available ? r.setup ?? 'see /mcp' : !cfg.ok ? 'Name a server in ~/.mcporter/mcporter.json (or config/mcporter.json in the project)' : `/mcp call <server>.<tool> (its mcp.call receipt seals the answer)`,
    });
  });
  const mcporter = routes.find((r) => r.id === 'mcporter');
  const serverRows = servers.names.map((name) => row({
    id: `mcp:server:${name}`, name, group: 'Integrations',
    available: fact(Boolean(mcporter?.available), mcporter?.available ? `through ${mcporter.label.trim()} (${mcporter.details})` : 'its route, MCP to CLI · MCPorter, is not installed here', SRC_ROUTES),
    configured: fact(true, `named in ${servers.where.get(name) ?? 'MCPorter\'s config'}; the server itself is not contacted here`, SRC_CFG),
    exercised: ran(calls.get(name), SRC.mcpCalls, chainNone(chain, `no MCP call to ${name} answered yet`)),
    next: !mcporter?.available ? mcporter?.setup ?? 'install mcporter' : `/mcp call ${name}.<tool>`,
  }));

  // OpenHands in a container with a local model: docker and the worker here; a local model named; a sealed completed run
  const docker = c.env.TIMMY_AGENT_DOCKER_BIN?.trim() || 'docker';
  const dockerAt = c.which(docker);
  const worker = ((): boolean => { try { return Boolean(openHandsWorker()); } catch { return false; } })();
  const model = c.env.TIMMY_AGENT_MODEL?.trim() || null;
  const base = c.env.TIMMY_AGENT_BASE_URL?.trim() || null;
  const oh = chain.evidence.runs.get(`agent:${OPENHANDS_ROUTE}`);
  const ohAvail = fact(Boolean(dockerAt) && worker, [dockerAt ? `${docker} at ${dockerAt} (its daemon and the ${OPENHANDS_IMAGE} image are not asked here)` : `${docker} is not on PATH`, worker ? 'the OpenHands worker is in this build' : 'the OpenHands worker is not in this build'].join('; '), 'whichOnPath (src/capabilities/live.ts); openHandsWorker (src/code-agents/openhands-run.ts)');
  const ohCfg = fact(Boolean(model), model ? `TIMMY_AGENT_MODEL ${model}${base ? `, TIMMY_AGENT_BASE_URL set` : ', the default local endpoint'}` : 'no local model named (TIMMY_AGENT_MODEL)', 'capabilityInventory (src/capabilities/inventory.ts: the variables openHandsCapabilityRow reads)');
  const openhands = row({
    id: `agent:${OPENHANDS_ROUTE}`, name: 'OpenHands, local model', group: 'Integrations',
    available: ohAvail, configured: ohCfg,
    exercised: ran(oh, SRC.evidence, chainNone(chain, 'no sealed, completed OpenHands run yet')),
    next: !ohAvail.ok ? (dockerAt ? 'npm run build (the worker ships with the build)' : 'install Docker (brew install --cask docker), then start it') : !ohCfg.ok ? 'set TIMMY_AGENT_MODEL to a model from ollama list' : `/agent ${OPENHANDS_ROUTE} <task> (a job; its run seals a receipt when it completes)`,
  });
  return [...routeRows, ...serverRows, openhands];
}

/** The servers MCPorter's config files name, read as mcporterServerConfigured reads them (files only). */
function mcporterServersNamed(c: Ctx): { names: string[]; files: string[]; where: Map<string, string> } {
  const names: string[] = []; const files: string[] = []; const where = new Map<string, string>();
  let found: ReturnType<typeof mcporterConfigFiles>;
  try { found = mcporterConfigFiles({ env: c.env, cwd: c.cwd }); } catch { return { names, files, where }; }
  for (const file of found.files) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const shown = file.startsWith(found.home) ? `${found.homeName}${file.slice(found.home.length)}` : file.startsWith(found.cwd) ? file.slice(found.cwd.length + 1) : file;
    files.push(shown);
    const value = parseJsonc(text);
    const servers = obj(obj(value)?.mcpServers);
    if (!servers) continue;
    for (const name of Object.keys(servers)) if (!where.has(name)) { names.push(name); where.set(name, shown); }
  }
  return { names, files, where };
}

// ── Lanes: each lane's command, its key or server, its dispatches ─────────────

function laneRows(c: Ctx, chain: Chain): InventoryRow[] {
  let lanes: ReturnType<typeof listLanes> = [];
  try { lanes = listLanes(c.env as NodeJS.ProcessEnv, { cwd: c.cwd }); } catch { lanes = []; }
  const dispatched = dispatchReceipts(chain);
  const SRC_LANES = 'listLanes (src/utils/dispatch.ts: the command on PATH, the key\'s presence, the MCP server named; nothing run)';
  return lanes.map((l) => {
    const keyNeeded = Boolean(l.key);
    const keySet = keyNeeded && Boolean(c.env[l.key!]?.trim());
    const mcp = l.mcp;
    // listLanes folds the command, the key and the server into `available`; the words are kept apart here: its command is
    // found when the lane is available, or when only its key or server is missing (listLanes says which)
    const found = mcp ? mcp.found : l.available || (keyNeeded && !keySet);
    const program = mcp?.program ?? l.id;
    const available = fact(found, found ? `${program} is on PATH` : `${program} is not on PATH`, SRC_LANES);
    const configured = mcp
      ? fact(mcp.configured, mcp.configured ? `its MCP server ${mcp.server} is named in ${mcp.where ?? 'MCPorter\'s config'}` : `its MCP server ${mcp.server} is not named in MCPorter\'s config (${mcp.checked.join(', ') || 'no file'})`, SRC_LANES)
      : keyNeeded ? fact(keySet, keySet ? `${l.key} is set (its value is never shown)` : `${l.key} is not set`, SRC_LANES)
        : fact(true, 'no key or server is needed', SRC_LANES);
    return row({
      id: `lane:${l.id}`, name: l.label, group: 'Lanes', available, configured,
      exercised: ran(dispatched.get(l.id), SRC.dispatches, chainNone(chain, 'no dispatch of this lane sealed yet')),
      next: !available.ok ? l.install ?? 'see /lanes' : !configured.ok ? (mcp ? `name ${mcp.server} in MCPorter\'s config` : `set ${l.key}`) : `/lanes dispatch ${l.id} (it asks before it starts; the launch seals a receipt)`,
    });
  });
}

// ── Vision: the vision bridge (Roboflow stays unverified) ─────────────────────

function visionRows(c: Ctx, chain: Chain): InventoryRow[] {
  const bridge = BUILD_CONTENTS.find((b) => b.rel === VISION_BRIDGE)!;
  const here = c.packaged(VISION_BRIDGE);
  const key = Boolean(c.env.ROBOFLOW_API_KEY?.trim());
  // the settings the runtime reads (src/vision/runtime.ts settings()): a model, a workspace + workflow, the server, the Python
  const model = c.env.TIMMY_VISION_MODEL_ID?.trim() || null;
  const workspace = c.env.ROBOFLOW_WORKSPACE?.trim() || null;
  const workflow = c.env.TIMMY_VISION_WORKFLOW_ID?.trim() || null;
  const server = c.env.TIMMY_VISION_SERVER_URL?.trim() || null;
  const runtime = c.env.TIMMY_VISION_RUNTIME?.trim() || 'http';
  const SRC_BUILD = 'checkBuildContents (src/utils/doctor.ts BUILD_CONTENTS)';
  const configured = fact(key && Boolean(model || (workspace && workflow)),
    `${key ? 'ROBOFLOW_API_KEY is set (its value is never shown)' : 'ROBOFLOW_API_KEY is not set'}; ${model ? `model ${model} (TIMMY_VISION_MODEL_ID)` : workspace && workflow ? `workspace ${workspace}, workflow ${workflow}` : 'no model (TIMMY_VISION_MODEL_ID) and no workspace + workflow'}; runtime ${runtime}, ${server ? `server ${server} (TIMMY_VISION_SERVER_URL)` : 'the default server http://localhost:9001 (a local Inference server)'}`,
    'capabilityInventory (src/capabilities/inventory.ts: the settings src/vision/runtime.ts reads; the bridge is not run here)');
  // a vision receipt would be kind vision.inspection; none is read as a Roboflow run that counts: Roboflow inference is unverified
  const vision = row({
    id: 'vision:bridge', name: bridge.name, group: 'Vision',
    available: fact(here, here ? `in this build: ${VISION_BRIDGE} (a file, not a verified model)` : `missing from this installation: ${VISION_BRIDGE} (the npm package carries it)`, SRC_BUILD),
    configured,
    exercised: { ok: false, found: 'Roboflow inference is unverified: no real authorized run has succeeded, so no receipt counts here', source: 'capabilityInventory (src/capabilities/inventory.ts; docs/VISION-REAL-CHECKS.md)' },
    next: !here ? 'reinstall Timmy, or run it from a checkout of its repository' : !configured.ok ? 'set ROBOFLOW_API_KEY, a Python with inference-sdk and a configured model or server' : 'timmy vision run <image> (a real authorized run; until one succeeds, Roboflow inference stays unverified)',
  });
  return [vision];
}

// ── Receipts: the project's runs chain ────────────────────────────────────────

function receiptsRow(c: Ctx, chain: Chain): InventoryRow {
  const dir = join(c.cwd, '.timmy', 'receipts', 'runs.jsonl');
  const here = c.exists(dir);
  const pin = c.exists(join(c.cwd, '.timmy', 'store-pin'));
  const n = chain.verify.count;
  const newest = [...vouching(chain)].reverse()[0];
  const m = newest && chain.verify.ok && n > 0 ? markOf(newest, `the newest receipt on the chain (${String(newest.kind)}: ${str(newest.subject) ?? 'no subject'}); ${n} receipt${n === 1 ? '' : 's'}, chain verified`) : undefined;
  return row({
    id: 'receipts:chain', name: 'Receipts (timmy receipts)', group: 'Receipts',
    available: fact(here, here ? 'the runs chain is here (.timmy/receipts/runs.jsonl)' : 'no runs chain in this project yet (.timmy/receipts/runs.jsonl)', 'capabilityInventory (src/capabilities/inventory.ts: the files of src/utils/receipts.ts)'),
    configured: fact(pin, pin ? 'the store pin names this project\'s store (.timmy/store-pin)' : 'no store pin (.timmy/store-pin): timmy init writes it', 'rootStoreDir (src/utils/receipts.ts: the pin, never bypassed)'),
    exercised: m ? ran(m, SRC.chain, '') : { ok: false, found: chain.unread ?? (!chain.verify.ok ? `the chain does not verify: ${chain.verify.reason ?? 'its links or hashes fail'}` : 'no receipt sealed yet'), source: SRC.chain },
    next: !here || !pin ? 'timmy init (it makes the store and its pin)' : 'any sealed run (a chat turn, /observe, /mcp call) appends a signed receipt',
  });
}
