/**
 * The unified Workspace order (2026-10-27, 16:56 PT): ONE searchable catalog of every integration Timmy already has, for the
 * Integrations page, the Workspace's node picker and the Control Room's selectors. It is a presentation over the existing
 * registries, never a copy of them and never a new source of truth:
 *
 *   inventory   src/capabilities/inventory.ts        models, tools, MCP routes and servers, lanes, OpenHands, vision bridge
 *   lanes       src/agent/lanes.ts (LANE_RUNNERS)    each lane's command, install step and one-shot task template
 *   native      src/native/index.ts (NATIVE_APPS)    the native engines, found the finder's way (an env var, /Applications, PATH)
 *   vision      src/vision/integrations/registry.ts  the optional vision adapters and their operation contracts
 *   providers   src/agent/provider-registry.ts       provider metadata (a provider with no runtime adapter stays metadata)
 *   apps        src/companion/miniapps/registry.ts   the hosted mini-apps (given by the companion: hostable, running, receipts)
 *   connectors  src/companion/connector-ops.ts       Treg's five words (given by the companion, each from a record)
 *   workflows   src/workflows/upmd.ts                the workflow runner (upmd) found the Workflows page's way
 *   spatial     src/spatial/tools.ts                 Brush, KIRI (Blender) and gsplat in the prepared spatial tools folder
 *
 * Each entry keeps its source registry and namespaced id, its supported operations (with WHERE each can be started today),
 * the adapter that actually routes it, its setup blocker, and six facts kept apart:
 *
 *   researched  it is named in one of Timmy's registries (that is all this says)
 *   installed   its files or program are here (a path, a found program; nothing run)
 *   configured  its key, sign-in or setting is set, or none is needed (never a key's value)
 *   discovered  a live listing of it was observed (a running app, a tools/list answered); configuration is not discovery
 *   callable    an adapter in this Timmy can start one of its operations now, and from where
 *   verified    a receipt of a real run of it exists for this project (read and verified), or a qualification record
 *
 * A fact is true, false, or unknown (null: not read on this surface, with the words saying how it would be read). Nothing is
 * run or contacted to build the catalog. Similarly named entries with different execution contracts (OpenHands as a Control
 * Room harness, as the vision registry's bounded review, as an inventory agent row) stay separate entries.
 */
import { existsSync } from 'node:fs';
import { LANE_RUNNERS } from '../agent/lanes.js';
import { auditProviders, getProviderRegistry, type ProviderId } from '../agent/provider-registry.js';
import { locateNative, NATIVE_APPS, type NativeApp } from '../native/index.js';
import { integrationCatalog } from '../vision/integrations/registry.js';
import { findUpmd } from '../workflows/upmd.js';
import { SPATIAL_TOOLS, spatialToolStates, type SpatialToolState } from '../spatial/tools.js';
import { readChain } from '../utils/receipts.js';
import { whichOnPath } from './live.js';
import type { Inventory, InventoryRow } from './inventory.js';

export const CATALOG_SCHEMA = 'timmy.integration-catalog/1' as const;
export type CatalogState = 'researched' | 'installed' | 'configured' | 'discovered' | 'callable' | 'verified';
export const CATALOG_STATES: readonly CatalogState[] = ['researched', 'installed', 'configured', 'discovered', 'callable', 'verified'];
export const CATALOG_STATE_MEANS: Readonly<Record<CatalogState, string>> = {
  researched: 'named in one of Timmy’s registries',
  installed: 'its files or program are here (nothing run)',
  configured: 'its key, sign-in or setting is set, or none is needed',
  discovered: 'a live listing of it was observed',
  callable: 'an adapter in this Timmy can start an operation now',
  verified: 'a receipt of a real run of it verifies for this project',
};

export type CatalogKind = 'model' | 'tool' | 'mcp' | 'lane' | 'harness' | 'vision' | 'native' | 'provider' | 'app' | 'connector';
export type CatalogRegistry = 'inventory' | 'lanes' | 'native' | 'vision' | 'providers' | 'apps' | 'connectors' | 'workflows' | 'spatial';
/** Where an operation can be started today: on the Workspace canvas (a node), in the Control Room, in the terminal, on its page. */
export type OperationWhere = 'canvas' | 'control-room' | 'terminal' | 'page';

export interface CatalogFact { ok: boolean | null; words: string; source: string }
export interface CatalogOperation { id: string; label: string; where: OperationWhere[]; how: string }
export interface CatalogEntry {
  /** namespaced: <registry>:<its own id> (the inventory's ids already carry their group: inventory:model:openrouter) */
  id: string;
  name: string;
  kind: CatalogKind;
  /** every registry that names it, with the id each uses (a lane is named by the inventory and by LANE_RUNNERS) */
  sources: Array<{ registry: CatalogRegistry; id: string; file: string }>;
  operations: CatalogOperation[];
  /** the code that actually routes it, or null (metadata only) */
  adapter: string | null;
  /** the one step that would move it on, or the precise reason it cannot be used here */
  setup: string | null;
  /** native engines: authoring (it edits a document) or render-only (it renders one) */
  role?: 'authoring' | 'render-only';
  /** a registry entry with no runtime adapter in this Timmy (kept visible, never offered as an operation) */
  metadataOnly?: boolean;
  states: Record<CatalogState, CatalogFact>;
}

export interface Catalog {
  schema: typeof CATALOG_SCHEMA;
  readAt: string;
  states: readonly CatalogState[];
  means: Readonly<Record<CatalogState, string>>;
  read: string;
  entries: CatalogEntry[];
  /** the registries read, each with how many entries it gave (a registry that failed to read says so) */
  registries: Array<{ registry: CatalogRegistry; file: string; entries: number; error?: string }>;
}

/** The hosted apps as the companion lists them for the request's principal and project (src/companion/miniapps/routes.ts). */
export interface AppListingRow {
  id: string; title: string; kind: string; lead: string; availability: string;
  hostable: boolean; problem: string | null; running: boolean;
  /** what the installed copy names: its commit or the package's label (src/companion/miniapps/host.ts installedSource) */
  installed: string | null;
  /** this principal's ok receipts for the app in this project, newest first (hash prefixes) */
  receipts?: string[];
  /** the operations the host itself can start for the app (each a host route) */
  operations?: CatalogOperation[];
}
/** Treg's five words as src/companion/connector-ops.ts tregState gives them. */
export interface TregRungs {
  title: string; next: string;
  installed: { ok: boolean; words: string }; signed_in: { ok: boolean; words: string }; discovered: { ok: boolean; words: string };
  ran_here: { ok: boolean; words: string }; qualified: { ok: boolean; words: string };
  tools?: Array<{ name: string; paid: boolean }>;
}

export interface CatalogParts {
  inventory?: Inventory | null;
  inventoryError?: string;
  apps?: AppListingRow[] | null;
  treg?: TregRungs | null;
  env?: Record<string, string | undefined>;
  /** the project's folder (the vision adapters' paths are relative to it) */
  cwd?: string;
  /** seams for a test: the native finder and the vision catalog */
  native?: (app: NativeApp) => { found: { path: string; how: string } | null; problem?: string };
  vision?: () => ReturnType<typeof integrationCatalog>;
  /** where a program is on the PATH (findUpmd's seam), or null; nothing is run */
  which?: (program: string) => string | null;
  /** the spatial tools' states (a test's seam; src/spatial/tools.ts spatialToolStates from env otherwise) */
  spatial?: () => SpatialToolState[];
  now?: number;
}

const F = (ok: boolean | null, words: string, source: string): CatalogFact => ({ ok, words, source });
const SRC = {
  inventory: 'src/capabilities/inventory.ts', lanes: 'src/agent/lanes.ts', native: 'src/native/index.ts', vision: 'src/vision/integrations/registry.ts',
  providers: 'src/agent/provider-registry.ts', apps: 'src/companion/miniapps/registry.ts', connectors: 'src/companion/connector-ops.ts',
  workflows: 'src/workflows/upmd.ts', spatial: 'src/spatial/tools.ts',
} as const;
const researched = (registry: CatalogRegistry): CatalogFact => F(true, `named in ${SRC[registry]}`, SRC[registry]);
const notDiscovered = (how: string, source: string): CatalogFact => F(null, `not observed on this surface: ${how}`, source);

// ── the inventory's rows (and LANE_RUNNERS, merged into their lane rows) ─────────────────────────────────────────────────

/** The adapter and operations of an inventory row, by its id (the inventory names rows; this names the code that routes them). */
function inventoryRoute(r: InventoryRow): { kind: CatalogKind; adapter: string | null; operations: CatalogOperation[] } {
  const id = r.id;
  if (id.startsWith('model:')) return { kind: 'model', adapter: 'src/agent/chat-route.ts (the chat turn)', operations: [{ id: 'chat', label: 'Answer in the chat', where: ['page', 'terminal'], how: 'Chat (each answered turn seals a receipt)' }] };
  if (id.startsWith('vox:')) return { kind: 'tool', adapter: 'src/vox/tools.ts', operations: [{ id: 'run', label: 'Run the tool', where: ['terminal'], how: 'the REPL\'s vox commands' }] };
  if (id.startsWith('mcp:route:')) return { kind: 'mcp', adapter: 'src/connectors/mcp-cli.ts (an MCP → CLI route)', operations: [{ id: 'list', label: 'List a server\'s tools', where: ['page', 'terminal'], how: 'MCP → CLI page, or /mcp' }, { id: 'call', label: 'Call a tool', where: ['page', 'terminal'], how: 'MCP → CLI page, or /mcp call' }] };
  if (id.startsWith('mcp:server:')) return { kind: 'mcp', adapter: 'src/mcp/inspector.ts (through an MCP → CLI route)', operations: [{ id: 'list', label: 'List its tools', where: ['page'], how: 'MCP → CLI page' }] };
  if (id.startsWith('lane:')) return { kind: 'lane', adapter: 'src/utils/dispatch.ts (a dispatch into its lane)', operations: [{ id: 'dispatch', label: 'Dispatch a task', where: ['terminal'], how: `/lanes dispatch ${id.slice(5)}` }] };
  if (id.startsWith('agent:')) return { kind: 'harness', adapter: 'src/companion/control-runs.ts → timmy act "/agent …" (src/code-agents/openhands-run.ts)', operations: [{ id: 'agent', label: 'Run on a copy of the project', where: ['control-room', 'terminal'], how: 'Control Room, or /agent' }] };
  if (id.startsWith('vision:')) return { kind: 'vision', adapter: 'src/vision/runtime.ts (the vision bridge)', operations: [{ id: 'run', label: 'Inspect an image', where: ['terminal'], how: 'timmy vision run --image PATH --model ID' }] };
  return { kind: 'tool', adapter: null, operations: [] };
}

function inventoryEntries(inv: Inventory): CatalogEntry[] {
  return inv.rows.filter((r) => r.group !== 'Receipts').map((r) => {
    const route = inventoryRoute(r);
    const sources: CatalogEntry['sources'] = [{ registry: 'inventory', id: r.id, file: SRC.inventory }];
    const laneKey = r.id.startsWith('lane:') ? r.id.slice(5) : null;
    const lane = laneKey ? LANE_RUNNERS[laneKey] : undefined;
    if (lane && laneKey) sources.push({ registry: 'lanes', id: laneKey, file: SRC.lanes });
    const usable = Boolean(r.available.ok && r.configured.ok && route.adapter);
    const discovered = r.id.startsWith('mcp:server:')
      ? F(null, 'named in MCPorter’s configuration: that is configuration, not discovery. Listing its tools on MCP → CLI is the check', SRC.inventory)
      : notDiscovered('the inventory reads files, settings and receipts; it lists nothing live', SRC.inventory);
    return {
      id: `inventory:${r.id}`, name: r.name, kind: route.kind, sources,
      operations: lane && lane.task ? [...route.operations, { id: 'delegate', label: 'Delegate a one-shot task', where: ['terminal'] as OperationWhere[], how: lane.task }] : route.operations,
      adapter: route.adapter,
      setup: r.next ?? null,
      states: {
        researched: researched('inventory'),
        installed: F(r.available.ok, r.available.words, r.available.source),
        configured: F(r.configured.ok, r.configured.words, r.configured.source),
        discovered,
        callable: usable
          ? F(true, `through ${route.adapter}: ${route.operations.map((o) => `${o.label} (${o.how})`).join('; ')}`, SRC.inventory)
          : F(false, !route.adapter ? 'no adapter in this Timmy routes it' : !r.available.ok ? `not installed: ${r.available.words}` : `not configured: ${r.configured.words}`, SRC.inventory),
        verified: F(r.exercised.ok, r.exercised.words, r.exercised.source),
      },
    };
  });
}

// ── native engines ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** What each engine does in Timmy (aerender renders a project; the others edit or build a document) and its terminal command. */
const NATIVE_USE: Record<NativeApp, { role: 'authoring' | 'render-only'; command: string; label: string }> = {
  c4dpy: { role: 'authoring', command: '/c4d', label: 'Run a Cinema 4D Python script on a scene' },
  aerender: { role: 'render-only', command: '/ae render', label: 'Render an After Effects composition' },
  blender: { role: 'authoring', command: '/blender', label: 'Run a Blender Python script (headless)' },
  afterfx: { role: 'authoring', command: '/ae', label: 'Run an After Effects script inside the application' },
  openscad: { role: 'authoring', command: '/scad', label: 'Build an OpenSCAD model to STL and read it back' },
  freecad: { role: 'authoring', command: '/freecad', label: 'Run a FreeCAD script (headless)' },
  unreal: { role: 'authoring', command: '/unreal', label: 'Run an Unreal Editor Python script (headless)' },
  illustrator: { role: 'authoring', command: '/illustrator', label: 'Run an Illustrator script' },
};

function nativeEntries(parts: CatalogParts): CatalogEntry[] {
  const env = parts.env ?? process.env;
  const find = parts.native ?? ((app: NativeApp) => locateNative(app, env));
  return (Object.keys(NATIVE_APPS) as NativeApp[]).map((app) => {
    const info = NATIVE_APPS[app];
    const use = NATIVE_USE[app];
    let found: { path: string; how: string } | null = null; let problem: string | undefined;
    try { const r = find(app); found = r.found; problem = r.problem; } catch (e) { problem = e instanceof Error ? e.message : String(e); }
    const how = found ? (found.how === 'env' ? 'its environment variable' : found.how === 'applications' ? 'the Applications folder' : 'PATH') : '';
    return {
      id: `native:${app}`, name: info.name, kind: 'native' as const, role: use.role,
      sources: [{ registry: 'native' as const, id: app, file: SRC.native }],
      operations: [{ id: 'run', label: use.label, where: ['terminal'] as OperationWhere[], how: `${use.command} in the REPL (a native job; it asks before it starts)` }],
      adapter: 'src/native/index.ts (a native job through the REPL\'s job manager)',
      setup: found ? null : info.setup,
      states: {
        researched: researched('native'),
        installed: found ? F(true, `found by ${how} (its path is not shown here; nothing was run)`, 'locateNative (src/native/index.ts)') : F(false, problem ? `not found: ${problem}` : `not found: ${info.setup}`, 'locateNative (src/native/index.ts)'),
        configured: F(true, 'no key or sign-in (a licensed application’s own licence is not checked here)', SRC.native),
        discovered: notDiscovered('a native engine is found, not listed live', SRC.native),
        callable: found ? F(true, `from the terminal: ${use.command}. Not yet a Workspace node`, SRC.native) : F(false, `not installed: ${info.setup}`, SRC.native),
        verified: F(null, 'not matched to receipts on this surface: a native run’s receipt is in Runs & receipts', SRC.native),
      },
    };
  });
}

// ── vision adapters ─────────────────────────────────────────────────────────────────────────────────────────────────────

function visionEntries(parts: CatalogParts): CatalogEntry[] {
  const list = (parts.vision ?? (() => integrationCatalog(parts.cwd)))();
  return list.map((v) => ({
    // vision:openhands is the vision registry's bounded review (a fixed local Qwen, no shell): not the Control Room harness
    id: `vision:${v.id}`, name: v.name, kind: 'vision' as const,
    sources: [{ registry: 'vision' as const, id: v.id, file: SRC.vision }],
    operations: v.operations.filter((o) => o !== 'probe').map((o) => ({ id: o, label: o, where: ['terminal'] as OperationWhere[], how: `timmy vision integrations run ${v.id} --request FILE (operation ${o})` })),
    adapter: `src/vision/integrations/runner.ts (${v.executionKind})`,
    setup: v.installedAdapter ? null : 'its adapter runtime is missing: timmy vision integrations list names what each needs',
    states: {
      researched: researched('vision'),
      installed: F(v.installedAdapter, v.installedAdapter ? 'its runtime and adapter script are here (presence is not qualification)' : 'its runtime or adapter script is not here', 'integrationCatalog (src/vision/integrations/registry.ts)'),
      configured: F(v.executionKind === 'gpu-model' ? null : true, v.executionKind === 'gpu-model' ? 'its GPU and model are not checked here' : 'no key or sign-in', SRC.vision),
      discovered: notDiscovered('a probe operation is the check', SRC.vision),
      callable: v.installedAdapter ? F(true, 'from the terminal: timmy vision integrations run. Not yet a Workspace node', SRC.vision) : F(false, 'its runtime is missing', SRC.vision),
      verified: F(false, v.qualification, SRC.vision),
    },
  }));
}

// ── providers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The providers a runtime adapter in this Timmy actually calls (checked by tests/catalog.test.ts: each module exists). */
export const PROVIDER_ADAPTERS: Partial<Record<ProviderId, string>> = {
  openrouter: 'src/agent/chat-route.ts',
  fal: 'src/utils/fal3d-adapter.ts',
  higgsfield: 'src/forge/gen.ts',
};

function providerEntries(parts: CatalogParts): CatalogEntry[] {
  const audits = new Map(auditProviders((parts.env ?? process.env) as NodeJS.ProcessEnv).map((a) => [a.id, a]));
  return getProviderRegistry().map((p) => {
    const a = audits.get(p.id)!;
    const adapter = PROVIDER_ADAPTERS[p.id] ?? null;
    const ready = a.readiness === 'ready';
    return {
      id: `provider:${p.id}`, name: p.label, kind: 'provider' as const,
      sources: [{ registry: 'providers' as const, id: p.id, file: SRC.providers }],
      operations: adapter ? p.services.map((s) => ({ id: String(s), label: String(s), where: ['terminal'] as OperationWhere[], how: `through ${adapter}` })) : [],
      adapter, metadataOnly: !adapter,
      setup: !adapter ? `metadata only: no runtime adapter in this Timmy calls ${p.label}${p.notes ? ` (${p.notes})` : ''}` : ready ? null : `set ${a.missingRequiredEnvVars.length ? a.missingRequiredEnvVars.join(', ') : p.envVars.map((e) => e.name).join(' or ')}`,
      states: {
        researched: researched('providers'),
        installed: F(null, p.classification === 'external' ? 'a hosted service: nothing to install' : 'its machine or storage is not checked here', SRC.providers),
        configured: F(ready, ready ? `set: ${a.presentEnvVars.join(', ')} (values never shown)` : a.readiness === 'needs_config' ? `missing ${a.missingRequiredEnvVars.join(', ')}` : `not set: ${a.checkedEnvVars.join(', ') || 'no variable'}`, 'auditProvider (src/agent/provider-registry.ts)'),
        discovered: notDiscovered('no call to the provider is made to build this catalog', SRC.providers),
        callable: !adapter ? F(false, 'metadata only: no runtime adapter', SRC.providers) : F(ready, ready ? `through ${adapter}` : 'not configured', SRC.providers),
        verified: F(null, 'not matched to receipts on this surface', SRC.providers),
      },
    };
  });
}

// ── hosted apps (given by the companion) ────────────────────────────────────────────────────────────────────────────────

function appEntries(apps: AppListingRow[]): CatalogEntry[] {
  return apps.map((a) => {
    const ops = a.operations ?? [];
    const hostable = a.availability === 'hostable';
    const receipts = a.receipts ?? [];
    return {
      id: `apps:${a.id}`, name: a.title, kind: 'app' as const,
      sources: [{ registry: 'apps' as const, id: a.id, file: SRC.apps }],
      operations: [{ id: 'open', label: `Open ${a.title}`, where: ['page'] as OperationWhere[], how: 'its page in the menu (hosted in Timmy’s frame)' }, ...ops],
      adapter: hostable ? 'src/companion/miniapps/host.ts (a worker per principal and project, behind a gateway)' : null,
      setup: a.problem ?? (hostable ? null : `not hostable here (${a.availability})`),
      states: {
        researched: researched('apps'),
        installed: F(a.hostable, a.hostable ? `its source is here${a.installed ? ` (${/^[0-9a-f]{7,40}$/.test(a.installed) ? a.installed.slice(0, 8) : a.installed})` : ''}` : a.problem ?? `not hostable (${a.availability})`, 'hostProblem / installedSource (src/companion/miniapps/host.ts)'),
        configured: F(true, 'no sign-in of its own: the host’s principal, project and provider connections are shared', SRC.apps),
        discovered: F(a.running, a.running ? 'running now for this principal and project (observed in the host)' : 'not running for this principal and project now', 'MiniAppHost (src/companion/miniapps/host.ts)'),
        callable: !a.hostable ? F(false, a.problem ?? 'not hostable', SRC.apps)
          : ops.length
            ? F(true, `the host can start: ${ops.map((o) => `${o.label} (${o.how})`).join('; ')}`, 'src/companion/miniapps/routes.ts')
            : F(false, 'opened and edited in its own page; the host starts none of its operations yet', 'src/companion/miniapps/routes.ts'),
        verified: F(receipts.length > 0, receipts.length ? `${receipts.length} receipt${receipts.length === 1 ? '' : 's'} of its ended jobs in this project (newest ${receipts[0]})` : 'no receipt of its jobs in this project yet', 'readChain (src/utils/receipts.ts)'),
      },
    };
  });
}

function tregEntry(t: TregRungs): CatalogEntry {
  return {
    id: 'connectors:treg', name: t.title, kind: 'connector',
    sources: [{ registry: 'connectors', id: 'treg', file: SRC.connectors }],
    operations: (t.tools ?? []).map((x) => ({ id: x.name, label: x.paid ? `${x.name} (paid: waits for your approval of its quote)` : `${x.name} (free)`, where: ['page'] as OperationWhere[], how: 'Integrations page (a host operation with Stop and Recover)' })),
    adapter: 'src/companion/connector-ops.ts (Timmy’s Treg bridge through an MCP → CLI route)',
    setup: t.next,
    states: {
      researched: researched('connectors'),
      installed: F(t.installed.ok, t.installed.words, SRC.connectors),
      configured: F(t.signed_in.ok, t.signed_in.words, SRC.connectors),
      discovered: F(t.discovered.ok, t.discovered.words, SRC.connectors),
      callable: F(t.installed.ok && t.signed_in.ok, t.installed.ok && t.signed_in.ok ? 'from the Integrations page (free tools; a paid call only from an approved quote)' : 'needs the bridge and a sign-in', SRC.connectors),
      verified: F(t.ran_here.ok, `${t.ran_here.words} ${t.qualified.words}`, SRC.connectors),
    },
  };
}

function upmdEntry(parts: CatalogParts): CatalogEntry {
  const env = (parts.env ?? process.env) as NodeJS.ProcessEnv;
  const found = findUpmd(env, parts.which ?? ((p) => whichOnPath(p, env)));
  return {
    id: 'workflows:upmd', name: 'UPMD (workflow runner)', kind: 'tool',
    sources: [{ registry: 'workflows', id: 'upmd', file: SRC.workflows }],
    operations: [{ id: 'run-block', label: 'Run a workflow document’s block', where: ['terminal'], how: 'the Workbench’s R, or /run in the REPL' }],
    adapter: 'src/workflows/run-blocks.ts (a workflow job)',
    setup: found ? null : 'install upmd so it is on PATH (or set TIMMY_UPMD)',
    states: {
      researched: researched('workflows'),
      installed: F(Boolean(found), found ? 'upmd is on this computer’s PATH' : 'upmd is not on this computer’s PATH', 'findUpmd (src/workflows/upmd.ts)'),
      configured: F(true, 'no sign-in needed', SRC.workflows),
      discovered: notDiscovered('a runner is found, not listed live', SRC.workflows),
      callable: F(Boolean(found), found ? 'from the terminal (the Workflows page copies the command). Not yet a Workspace node' : 'upmd is missing', SRC.workflows),
      verified: F(null, 'a run’s block receipts are on the Workflows page', SRC.workflows),
    },
  };
}

// ── spatial tools (the 2026-10-28 order) ────────────────────────────────────────────────────────────────────────────────

const SPATIAL_OP_LABEL: Record<string, string> = {
  'spatial.kiri-crop-export': 'Crop and export a splat (KIRI in Blender)', 'spatial.brush-train': 'Reconstruct a splat (Brush)', 'spatial.gsplat-smoke': 'Check gsplat on an NVIDIA worker',
};
function spatialEntries(parts: CatalogParts): CatalogEntry[] {
  const states = (parts.spatial ?? (() => spatialToolStates(parts.env ?? process.env)))();
  let chain: ReturnType<typeof readChain> = [];
  try { if (parts.cwd) chain = readChain('runs', parts.cwd); } catch { chain = []; }
  return states.map((st) => {
    const def = SPATIAL_TOOLS[st.id];
    const mine = chain.filter((r) => r.kind === 'spatial' && r.spatial?.tool === st.id);
    const ok = mine.filter((r) => r.status === 'ok');
    const fixtureOnly = ok.length > 0 && ok.every((r) => r.spatial?.fixture);
    return {
      id: `spatial:${st.id}`, name: `${def.name} ${def.version}`, kind: 'tool' as const,
      sources: [{ registry: 'spatial' as const, id: st.id, file: SRC.spatial }],
      operations: def.operations.map((o) => ({ id: o, label: SPATIAL_OP_LABEL[o] ?? o, where: (st.callable.ok ? ['canvas', 'control-room'] : []) as OperationWhere[], how: st.callable.ok ? `a Workspace operation node, or the Control Room's app operation (a Timmy job on ${def.runs})` : `not runnable here: ${st.blocker ?? st.callable.words}` })),
      adapter: st.id === 'gsplat' ? null : 'src/spatial/jobs.ts (a Timmy process job through src/companion/workflow-ops.ts)',
      setup: st.blocker,
      states: {
        researched: researched('spatial'),
        installed: F(st.installed.ok, st.installed.words, SRC.spatial),
        configured: F(st.configured.ok, st.configured.words, SRC.spatial),
        discovered: F(null, `not listed live: the package recorded its own checks (${st.packageSays})`, SRC.spatial),
        callable: F(st.callable.ok, st.callable.words, 'src/spatial/jobs.ts'),
        verified: F(ok.length > 0 ? true : mine.length ? false : null, ok.length
          ? `${ok.length} ok run${ok.length === 1 ? '' : 's'} with receipts in this project${fixtureOnly ? ' (synthetic fixture only: not a qualification on real data)' : ''}; newest ${ok.at(-1)!.hash.slice(7, 15)}`
          : mine.length ? `${mine.length} run${mine.length === 1 ? '' : 's'} in this project, none ok (newest ${mine.at(-1)!.status ?? 'unknown'})` : 'no run of it in this project yet', 'readChain (src/utils/receipts.ts)'),
      },
    };
  });
}

/** The catalog: every registry's entries, each fact from its own source. Nothing is run or contacted. */
export function buildCatalog(parts: CatalogParts): Catalog {
  const registries: Catalog['registries'] = [];
  const entries: CatalogEntry[] = [];
  const take = (registry: CatalogRegistry, fn: () => CatalogEntry[]): void => {
    try { const got = fn(); entries.push(...got); registries.push({ registry, file: SRC[registry], entries: got.length }); }
    catch (e) { registries.push({ registry, file: SRC[registry], entries: 0, error: e instanceof Error ? e.message : String(e) }); }
  };
  if (parts.inventory) take('inventory', () => inventoryEntries(parts.inventory!));
  else registries.push({ registry: 'inventory', file: SRC.inventory, entries: 0, error: parts.inventoryError ?? 'not read' });
  take('native', () => nativeEntries(parts));
  take('vision', () => visionEntries(parts));
  take('providers', () => providerEntries(parts));
  if (parts.apps) take('apps', () => appEntries(parts.apps!));
  else registries.push({ registry: 'apps', file: SRC.apps, entries: 0, error: 'the companion gave no app listing (no project open)' });
  if (parts.treg) take('connectors', () => [tregEntry(parts.treg!)]);
  else registries.push({ registry: 'connectors', file: SRC.connectors, entries: 0, error: 'Treg’s state was not given (the operator’s connection)' });
  take('workflows', () => [upmdEntry(parts)]);
  take('spatial', () => spatialEntries(parts));
  return {
    schema: CATALOG_SCHEMA, readAt: new Date(parts.now ?? Date.now()).toISOString(), states: CATALOG_STATES, means: CATALOG_STATE_MEANS,
    read: 'files, settings, this project’s receipts and the host’s own state; nothing run, nothing contacted',
    entries, registries,
  };
}

/** Whether an adapter module named by the catalog is in this source tree (the tests' check that PROVIDER_ADAPTERS is not invented). */
export function adapterModuleExists(root: string, module: string): boolean {
  return existsSync(`${root}/${module.split(' ')[0]}`);
}
