/**
 * Round R4 (lead): `timmy fleet` — plan, run and follow a fleet of workers on an execution backend, with the same service
 * (src/fleet/service.ts) the MCP tools and surfaces call. Backends: the FAKE one (an offline simulation, said on every
 * line); Cloudroom Core (R4 H121's adapter: one self-hosted Core a person connected, each worker a session on that shared
 * machine; not verified until a live check passes) and its FAKE Core (cloudroom-fake, a simulation over real HTTP). Modal
 * and Hostinger are named and unavailable, with why.
 *
 *   timmy fleet connect [cloudroom <url> --token-file <file> [--label NAME] [--max-concurrent N]]   (a person's step; not MCP)
 *
 *   timmy fleet providers
 *   timmy fleet plan --workers N [--concurrency N] [--provider fake] [--isolation vm|microvm|provider-sandbox|container|shared-session]
 *                    [--per-worker dedicated|shared] [--harness NAME] [--model NAME] [--cpu N] [--ram GB] [--disk GB] [--ttl MIN]
 *                    [--infra-budget USD] [--inference-budget USD] [--prompt TEXT] [--local-only] [--allow-paid] [--no-review]
 *   timmy fleet run <plan> [--approve TOKEN]     (stays until the run ends; Ctrl-C or `timmy fleet stop` cancels)
 *   timmy fleet status [<plan>]
 *   timmy fleet events <plan> [--worker N] [--after N] [--limit N]
 *   timmy fleet stop <plan>
 *   timmy fleet reconcile <plan>
 *   timmy fleet collect <plan>
 *
 * Every verb takes --project <dir|name> (default: the current folder) and --json (one line, schema timmy.fleet/1).
 * Exit codes: 0 done; 1 refused, or a run with a failed, unknown or refused worker; 2 usage; 3 a run that was stopped.
 */
import { chooseProject } from '../project/index.js';
import { timmyHome } from '../setup/home.js';
import { cloudroomAvailability, writeCloudroomConfig } from './cloudroom/index.js';
import { HARNESS_DEFAULT_MODEL, ISOLATION_CLASSES, MAX_WORKERS, type IsolationClass } from './plan.js';
import {
  adviseRoute, collectPlan, fleetEvents, knownProviders, listFleetViews, planFleet, prepareProvider, readFleetView, readRouteAdvice, reconcilePlan, runPlan, stopPlan,
  type FleetView, type RouteAdvice, type RunPlanOptions, type ServiceOptions,
} from './service.js';

export const FLEET_SCHEMA = 'timmy.fleet/1';
export const FLEET_VERBS = ['providers', 'connect', 'plan', 'run', 'status', 'events', 'stop', 'reconcile', 'collect'] as const;
export type FleetVerb = (typeof FLEET_VERBS)[number];

export interface FleetSaid {
  code: number;
  lines: string[];
  json: Record<string, unknown>;
}

const USAGE = 'timmy fleet providers | connect [cloudroom <url> --token-file <file>] | plan --workers N [options] | run <plan> | status [<plan>] | events <plan> | stop <plan> | reconcile <plan> | collect <plan>';

export function fleetHelp(): string {
  return [
    `Usage: ${USAGE}`,
    '',
    'timmy fleet: plan a fleet of workers (1 to 100), run it on an execution backend at a bounded concurrency, and follow it.',
    'Counts are kept apart: requested, admitted, queued, running, live and unknown allocations, delivered, verified, failed.',
    'Backends: FAKE (an offline simulation: no compute, no harness, no model, no cost); Cloudroom Core, one self-hosted Core',
    'whose workers are sessions on its shared machine (TIMMY_FLEET_CLOUDROOM=1 and timmy fleet connect cloudroom; not verified',
    'until a live check passes), and its FAKE Core (TIMMY_FLEET_CLOUDROOM=fake: provider cloudroom-fake, a simulation). Modal',
    'and Hostinger are named and unavailable; `timmy fleet providers` says why.',
    'connect cloudroom <url> --token-file <file> [--label NAME] [--max-concurrent N]: records which Core to use and where its',
    '  token file is (0600; never read here, never copied); a person runs it (it is not an MCP tool).',
    '',
    'plan options: --workers N (required) --concurrency N (default 4) --provider fake --isolation vm --per-worker dedicated',
    '  --harness codex --model NAME --cpu 2 --ram 4 --disk 10 --ttl 30 --infra-budget 0 --inference-budget 0 --prompt TEXT',
    '  --local-only --allow-paid (default: free only) --no-review (default: review before dispatch)',
    '  With "Use Clef routing" on (timmy decide; off by default), the plan asks once which harness should take its tasks and',
    '  shows the answer as a recommendation, never applied (--decide-fixture <file>: a FAKE answer, for tests and the offline slice).',
    'run: stays until every worker has ended; a provider that costs money needs --approve <token> (timmy approve <hash>).',
    'Every verb: --project <dir|name> (default: this folder), --json.',
    '',
    'Exit codes: 0 done; 1 refused, or a run with a failed, unknown or refused worker; 2 usage; 3 a stopped run.',
  ].join('\n');
}

interface Parsed { verb?: FleetVerb; plan?: string; flags: Map<string, string | true>; project?: string; json: boolean; help: boolean; args?: string[] }

const VALUE_FLAGS = new Set(['workers', 'concurrency', 'provider', 'isolation', 'per-worker', 'harness', 'model', 'cpu', 'ram', 'disk', 'ttl', 'infra-budget', 'inference-budget', 'prompt', 'approve', 'worker', 'after', 'limit', 'project', 'decide-fixture', 'token-file', 'label', 'max-concurrent']);
const BOOL_FLAGS = new Set(['local-only', 'allow-paid', 'no-review', 'json', 'help']);

export function parseFleetArgs(argv: string[], o: { json?: boolean } = {}): Parsed | { error: string } {
  const p: Parsed = { flags: new Map(), json: o.json === true, help: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === '-h') { p.help = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(w);
    if (m) {
      const [, name, inline] = m;
      if (BOOL_FLAGS.has(name)) {
        if (name === 'json') p.json = true; else if (name === 'help') p.help = true; else p.flags.set(name, true);
        continue;
      }
      if (!VALUE_FLAGS.has(name)) return { error: `No option --${name}. Usage: ${USAGE}` };
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') return { error: `--${name} needs a value. Usage: ${USAGE}` };
      if (name === 'project') p.project = v; else p.flags.set(name, v);
      continue;
    }
    if (w.startsWith('-')) return { error: `No option ${w}. Usage: ${USAGE}` };
    words.push(w);
  }
  if (p.help && !words.length) return p;
  const verb = words.shift();
  if (verb === undefined) { p.help = true; return p; }
  if (!(FLEET_VERBS as readonly string[]).includes(verb)) return { error: `No verb "${verb}". Usage: ${USAGE}` };
  p.verb = verb as FleetVerb;
  if (['run', 'events', 'stop', 'reconcile', 'collect'].includes(verb)) {
    if (!words[0]) return { error: `timmy fleet ${verb} needs a plan id (timmy fleet status lists them)` };
    if (!/^f[0-9a-f]{8}$/.test(words[0])) return { error: `"${words[0]}" is not a plan id (f and 8 hex digits)` };
    p.plan = words.shift();
  } else if (verb === 'connect') {
    p.args = words.splice(0, words.length);
    if (p.args.length && (p.args[0] !== 'cloudroom' || p.args.length !== 2)) return { error: 'timmy fleet connect cloudroom <url> --token-file <file> (or no arguments, to see what is set up)' };
  } else if (verb === 'status' && words[0]) {
    if (!/^f[0-9a-f]{8}$/.test(words[0])) return { error: `"${words[0]}" is not a plan id (f and 8 hex digits)` };
    p.plan = words.shift();
  }
  if (words.length) return { error: `Unexpected: ${words.join(' ')}. Usage: ${USAGE}` };
  return p;
}

const num = (p: Parsed, name: string, dflt: number | undefined, min: number, max: number, whole = true): number | { error: string } | undefined => {
  const v = p.flags.get(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || (whole && !Number.isInteger(n)) || n < min || n > max) return { error: `--${name} must be ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}, not ${String(v)}` };
  return n;
};

export function viewLines(v: FleetView, o: { workers?: boolean; route?: RouteAdvice } = {}): string[] {
  const c = v.counts;
  const lines = [
    `Fleet ${v.planId} — ${v.status}${v.simulation ? ' — SIMULATION (FAKE backend)' : ''}`,
    `  ${v.backend}; ${v.isolationWords}${v.perWorker === 'dedicated' ? ', one per worker' : ', shared'}; harness ${v.harness}, model ${v.model}; operation ${v.operationId}`,
    `  requested ${c.requested} · admitted ${c.admitted} · queued ${c.queued} · running ${c.running} · live allocations ${c.liveAllocations} · unknown ${c.unknownAllocations}`,
    `  delivered ${c.delivered} (not verified) · verified ${c.verified} · failed ${c.failed} · cancelled ${c.cancelled} · refused ${c.refused}`,
  ];
  if (v.runner) lines.push(`  running in process ${v.runner.pid} since ${v.runner.started}${v.cancelAsked ? '; a stop was asked' : ''}`);
  if (o.route) lines.push(`  ${o.route.words} (decision ${o.route.decision})`);
  for (const n of v.needsYou) lines.push(`  NEEDS YOU: ${n}`);
  if (o.workers) {
    for (const w of v.workers) {
      lines.push(`  w${String(w.index).padStart(3, '0')} ${w.phase.padEnd(11)} compute ${w.compute}${w.providerId ? ` (${w.providerId})` : ''} · session ${w.sessionState}${w.session ? ` (${w.session})` : ''} · ${w.events} events · ${w.collected ? `${w.files} file(s) collected` : 'nothing collected'}${w.reason ? ` — ${w.reason}` : ''}`);
    }
  }
  return lines;
}

/** One verb, done; shared by the CLI and the MCP tools. */
export async function fleetDo(p: Parsed, root: string, opts: ServiceOptions & { signal?: AbortSignal; progress?: (line: string) => void; by?: 'person' | 'agent'; consume?: RunPlanOptions['consume'] } = {}): Promise<FleetSaid> {
  const said = (code: number, lines: string[], json: Record<string, unknown>): FleetSaid => ({ code, lines, json: { schema: FLEET_SCHEMA, verb: p.verb, ok: code === 0, ...json } });
  switch (p.verb) {
    case 'providers': {
      const providers = knownProviders();
      return said(0, providers.map((x) => `${x.available ? 'available  ' : 'unavailable'} ${x.id.padEnd(14)} ${x.label}: ${x.about}${x.why ? ` — ${x.why}` : ''}`), { providers });
    }
    case 'connect': {
      // R4 (lead): which Core the fleet uses and where its token file is; the token is never read or copied here
      if (!p.args?.length) {
        const a = cloudroomAvailability();
        return said(0, [`Cloudroom: ${a.available ? 'available' : 'unavailable'} (${a.mode}): ${a.why}`], { cloudroom: a });
      }
      const tokenFile = p.flags.get('token-file');
      if (typeof tokenFile !== 'string') return said(2, ['timmy fleet connect cloudroom <url> --token-file <file>: the token file (0600) is required'], { error: 'usage' });
      const max = num(p, 'max-concurrent', undefined, 1, 100);
      if (max && typeof max === 'object') return said(2, [max.error], { error: 'usage' });
      const label = p.flags.get('label');
      try {
        const w = writeCloudroomConfig(timmyHome(), { url: p.args[1], tokenFile, ...(typeof label === 'string' ? { label } : {}), ...(typeof max === 'number' ? { maxConcurrent: max } : {}) });
        return said(0, [
          `Recorded: the Cloudroom Core at ${w.config.url}${w.config.label ? ` ("${w.config.label}")` : ''}, its token in the file you named (0600; not read now, never copied).`,
          'Nothing was contacted. TIMMY_FLEET_CLOUDROOM=1 turns it on; then timmy fleet providers checks it, and a plan uses --provider cloudroom --isolation shared-session.',
        ], { written: true, url: w.config.url, ...(w.config.label ? { label: w.config.label } : {}) });
      } catch (e) {
        return said(1, [`Not recorded: ${e instanceof Error ? e.message : String(e)}`], { written: false });
      }
    }
    case 'plan': {
      const workers = num(p, 'workers', undefined, 1, MAX_WORKERS);
      if (workers === undefined) return said(2, [`timmy fleet plan needs --workers N (1 to ${MAX_WORKERS})`], { error: 'usage' });
      const vals: Record<string, number | { error: string } | undefined> = {
        workers,
        concurrency: num(p, 'concurrency', Math.min(4, typeof workers === 'number' ? workers : 4), 1, MAX_WORKERS),
        cpu: num(p, 'cpu', 2, 0.25, 256, false), ram: num(p, 'ram', 4, 0.25, 4096, false), disk: num(p, 'disk', 10, 1, 65536, false),
        ttl: num(p, 'ttl', 30, 1, 24 * 60), infra: num(p, 'infra-budget', 0, 0, 100_000, false), inference: num(p, 'inference-budget', 0, 0, 100_000, false),
      };
      for (const v of Object.values(vals)) if (v && typeof v === 'object') return said(2, [v.error], { error: 'usage' });
      const isolation = String(p.flags.get('isolation') ?? 'vm');
      if (!(ISOLATION_CLASSES as readonly string[]).includes(isolation)) return said(2, [`--isolation must be one of ${ISOLATION_CLASSES.join(', ')}`], { error: 'usage' });
      const perWorker = String(p.flags.get('per-worker') ?? (isolation === 'shared-session' ? 'shared' : 'dedicated'));
      if (perWorker !== 'dedicated' && perWorker !== 'shared') return said(2, ['--per-worker must be dedicated or shared'], { error: 'usage' });
      const provider = String(p.flags.get('provider') ?? 'fake');
      await prepareProvider(provider); // a Cloudroom backend is opened and refreshed so its capabilities can answer the checks
      const res = planFleet(root, {
        agents: vals.workers as number, concurrency: vals.concurrency as number, provider,
        isolation: isolation as IsolationClass, perWorker, harness: String(p.flags.get('harness') ?? 'codex'), model: String(p.flags.get('model') ?? HARNESS_DEFAULT_MODEL),
        limits: { cpu: vals.cpu as number, ramGb: vals.ram as number, diskGb: vals.disk as number }, ttlMinutes: vals.ttl as number,
        budgets: { infraUsd: vals.infra as number, inferenceUsd: vals.inference as number }, prompt: String(p.flags.get('prompt') ?? ''),
        policy: { localOnly: p.flags.has('local-only'), freeOnly: !p.flags.has('allow-paid'), requireReview: !p.flags.has('no-review') },
      }, opts);
      if (!res.ok) return said(1, res.preview.lines, { refused: true, refusals: res.refusals, preview: res.preview });
      // R4 (lead): one route question per plan when "Use Clef routing" is on; shown, never applied
      const fixture = p.flags.get('decide-fixture');
      let route: RouteAdvice | { error: string } | undefined;
      try { route = await adviseRoute(root, res.plan, { ...opts, decide: typeof fixture === 'string' ? { fixture } : {} }); } catch (e) { route = { error: e instanceof Error ? e.message : String(e) }; }
      const routeLine = route ? ('error' in route ? `  route: not asked (${route.error}); the plan keeps ${res.plan.harness}` : `  ${route.words} (decision ${route.decision})`) : undefined;
      return said(0, [...res.preview.lines, ...(routeLine ? [routeLine] : []), `Planned ${res.plan.id} (operation ${res.plan.operationId}); nothing started. Run it: timmy fleet run ${res.plan.id}`], { plan: res.plan.id, operation: res.plan.operationId, preview: res.preview, ...(route ? { route } : {}) });
    }
    case 'run': {
      let ended = 0;
      const planned = readFleetView(root, p.plan!);
      if (planned) await prepareProvider(planned.provider);
      const report = await runPlan(root, p.plan!, {
        ...opts,
        approval: typeof p.flags.get('approve') === 'string' ? String(p.flags.get('approve')) : undefined,
        by: opts.by ?? (process.stdin.isTTY ? 'person' : 'agent'),
        onChange: (w) => {
          if (['delivered', 'failed', 'expired', 'interrupted', 'cancelled', 'refused', 'unknown'].includes(w.phase)) {
            ended += 1;
            if (w.phase !== 'delivered' || ended % 10 === 0) opts.progress?.(`  w${String(w.index).padStart(3, '0')} ${w.phase}${w.reason ? ` — ${w.reason}` : ''} (${ended} ended)`);
          }
        },
      });
      const code = report.status === 'refused' ? 1 : report.status === 'stopped' ? 3 : report.counts.delivered === report.counts.requested ? 0 : 1;
      return said(code, report.lines, { plan: p.plan, status: report.status, counts: report.counts, refusals: report.refusals, operation: report.operationId, receipts: { prediction: report.predictReceipt, run: report.runReceipt }, simulation: report.simulation, backend: report.backend, peakActive: report.peakActive });
    }
    case 'status': {
      if (p.plan) {
        const v = readFleetView(root, p.plan);
        if (!v) return said(1, [`no plan ${p.plan} in this project`], { error: 'no such plan' });
        const route = readRouteAdvice(root, v.planId);
        return said(0, viewLines(v, { workers: v.workers.length <= 20, ...(route ? { route } : {}) }), { view: v, ...(route ? { route } : {}) });
      }
      const all = listFleetViews(root);
      if (!all.length) return said(0, ['no fleet plans in this project (timmy fleet plan --workers N makes one)'], { plans: [] });
      return said(0, all.flatMap((v) => { const route = readRouteAdvice(root, v.planId); return viewLines(v, route ? { route } : {}); }), { plans: all });
    }
    case 'events': {
      const after = num(p, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
      const worker = num(p, 'worker', undefined, 1, MAX_WORKERS);
      const limit = num(p, 'limit', 200, 1, 100_000);
      for (const v of [after, worker, limit]) if (v && typeof v === 'object') return said(2, [v.error], { error: 'usage' });
      if (!readFleetView(root, p.plan!)) return said(1, [`no plan ${p.plan} in this project`], { error: 'no such plan' });
      const evs = fleetEvents(root, p.plan!, { worker: worker as number | undefined, after: after as number, limit: limit as number });
      return said(0, evs.length ? evs.map((e) => `w${String(e.worker).padStart(3, '0')} #${e.n} ${e.kind.padEnd(15)} ${e.text}`) : ['no events'], { events: evs });
    }
    case 'stop': {
      const r = stopPlan(root, p.plan!);
      return said(r.asked ? 0 : 1, [r.words], { asked: r.asked, runner: r.runner ?? null });
    }
    case 'reconcile': {
      const v = readFleetView(root, p.plan!);
      if (v) await prepareProvider(v.provider);
      const r = await reconcilePlan(root, p.plan!, opts);
      return said(r.ok ? 0 : 1, r.lines, { lines: r.lines });
    }
    case 'collect': {
      const v = readFleetView(root, p.plan!);
      if (v) await prepareProvider(v.provider);
      const r = await collectPlan(root, p.plan!, opts);
      return said(r.ok ? 0 : 1, r.lines, { lines: r.lines });
    }
    default:
      return said(2, [fleetHelp()], { error: 'usage' });
  }
}

export async function fleetMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  const p = parseFleetArgs(argv, o);
  if ('error' in p) {
    process.stderr.write(`${p.error}\n`);
    if (o.json) process.stdout.write(`${JSON.stringify({ schema: FLEET_SCHEMA, ok: false, error: p.error, exit_code: 2 })}\n`);
    return 2;
  }
  if (p.help || !p.verb) {
    process.stdout.write(`${fleetHelp()}\n`);
    return 0;
  }
  let root = process.cwd();
  if (p.project) {
    const chosen = chooseProject(p.project);
    if ('error' in chosen) {
      process.stderr.write(`${chosen.error}\n`);
      return 1;
    }
    root = chosen.root;
  }
  const abort = new AbortController();
  let signals = 0;
  const onSig = () => {
    signals += 1;
    if (signals === 1) {
      process.stderr.write('Stopping: queued workers will not start; running ones are stopped, collected and torn down (Ctrl-C again leaves at once).\n');
      abort.abort();
    } else process.exit(130);
  };
  if (p.verb === 'run') process.on('SIGINT', onSig);
  try {
    const said = await fleetDo(p, root, { signal: abort.signal, progress: p.json ? undefined : (l) => process.stdout.write(`${l}\n`) });
    if (p.json) process.stdout.write(`${JSON.stringify({ ...said.json, exit_code: said.code })}\n`);
    else (said.code === 2 ? process.stderr : process.stdout).write(`${said.lines.join('\n')}\n`);
    return said.code;
  } finally {
    if (p.verb === 'run') process.off('SIGINT', onSig);
  }
}
