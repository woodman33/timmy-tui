// warroom-v2-c4m8 — the war room's second slide: SWARMS · ENGINES · BULKHEADS ·
// SKILLS. Everything here READS Claude Code's artifacts (lanes/swarm presets +
// runs, fleet/nodes.json, lanes/sandbox runs, lanes/abilities results, the
// project folders through fleet/harness-menu.mjs) and DRIVES their CLIs
// (swarm.mjs run/kill, tmux panes). Nothing is reimplemented: the presets are
// parsed from the committed .cue files, the run facts from the run JSONs the
// runtime wrote, the node facts from node.* receipts.
import { existsSync, createWriteStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readProject, PROJECTS_ROOT } from '../../fleet/harness-menu.mjs';
import { WAR_SESSION } from './warroom.js';

export interface SwarmMember {
  id: string; kind: 'model' | 'harness' | 'timmy' | string;
  model?: string; provider?: string; harness?: string; room?: string;
  node?: string; sandbox?: string; weight?: number; role?: string;
}
export interface SwarmPreset {
  name: string; topology: string; rounds: number; members: SwarmMember[];
  size: number; budget: { usd: number; max_calls: number };
  judge: { tier: string; model?: string }; policy: string;
}
export interface SwarmRun {
  id: string; preset: string; topology: string; size: number; usd: number;
  ms: number; tokensThinking: number; judge: string; policy: string;
  closed: boolean; ok: boolean; ts: number; members: SwarmMember[];
  airgap: { egress: string; policySha: string } | null; room: string;
}
export interface NodeStat {
  id: string; status: string; kind: string; reachable: boolean;
  memGb: number | null; models: string[]; tokPerS: number | null; ssh: string;
}
export interface SbxRun {
  id: string; label: string; image: string; model: string; platform: string;
  files: number; ok: boolean; ts: number; sandbox: string;
}
export interface AbilityRow { harness: string; skills: string[]; isolation: string; mcpMode: string }
export interface ProjectRow { name: string; skills: string[]; plans: string[]; drop: string[]; budget: number | null }

// TIMMY_REPO_ROOT lets tests point the readers at a placeholder fixture tree;
// production reads the live checkout.
const root = (): string => process.env.TIMMY_REPO_ROOT ?? process.cwd();
const num = (s: string, re: RegExp): number | null => { const m = s.match(re); return m ? Number(m[1]) : null; };
const str = (s: string, re: RegExp): string | null => { const m = s.match(re); return m ? m[1] : null; };
type ReceiptMeta = {
  subject: string; sources?: unknown[];
  run_id?: unknown; egress?: unknown; policy_sha256?: unknown;
  node?: unknown; model?: unknown; mem_total_gb?: unknown; eval_tok_per_s?: unknown; status?: unknown;
};
const sourceMeta = (r: { sources?: unknown[] }): Record<string, unknown> => {
  const s = Array.isArray(r.sources) ? r.sources[0] : null;
  return s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {};
};
const withReceiptMeta = (r: ReceiptMeta): ReceiptMeta => ({ ...sourceMeta(r), ...r, subject: String(r.subject) });

/** lanes/swarm/presets/*.cue — the twelve cue-vetted presets, parsed as committed. */
export function swarmPresets(): SwarmPreset[] {
  const dir = join(root(), 'lanes', 'swarm', 'presets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.cue')).sort().map(f => {
    const txt = readFileSync(join(dir, f), 'utf8');
    const membersBlock = txt.slice(txt.indexOf('members: ['), txt.indexOf(']', txt.indexOf('members: [')));
    const members: SwarmMember[] = [...membersBlock.matchAll(/\{([^}]+)\}/g)].map(m => {
      const b = m[1];
      return {
        id: str(b, /id:\s*"([^"]+)"/) ?? '?',
        kind: str(b, /kind:\s*"([^"]+)"/) ?? 'model',
        model: str(b, /model:\s*"([^"]+)"/) ?? undefined,
        provider: str(b, /provider:\s*"([^"]+)"/) ?? undefined,
        harness: str(b, /harness:\s*"([^"]+)"/) ?? undefined,
        room: str(b, /room:\s*"([^"]+)"/) ?? undefined,
        node: str(b, /node:\s*"([^"]+)"/) ?? undefined,
        sandbox: str(b, /sandbox:\s*"([^"]+)"/) ?? undefined,
        weight: num(b, /weight:\s*(\d+)/) ?? 1,
      };
    });
    return {
      name: str(txt, /id:\s*"([^"]+)"/) ?? f.replace(/\.cue$/, ''),
      topology: str(txt, /topology:\s*"([^"]+)"/) ?? 'fanout',
      rounds: num(txt, /rounds:\s*(\d+)/) ?? 1,
      members,
      size: num(txt, /size:\s*(\d+)/) ?? members.length,
      budget: { usd: num(txt, /usd:\s*([0-9.]+)/) ?? 0, max_calls: num(txt, /max_calls:\s*(\d+)/) ?? 12 },
      judge: { tier: str(txt, /tier:\s*"([^"]+)"/) ?? 'local', model: str(txt, /judge:\s*\{[^}]*model:\s*"([^"]+)"/) ?? undefined },
      policy: str(txt, /policy:\s*"([^"]+)"/) ?? 'open',
    };
  });
}

/** lanes/swarm/runs/swarm_*.json — what the runtime recorded, newest first. */
export function swarmRuns(airgapRecs: ReceiptMeta[]): SwarmRun[] {
  const dir = join(root(), 'lanes', 'swarm', 'runs');
  if (!existsSync(dir)) return [];
  const airgap = airgapRecs.map(withReceiptMeta);
  return readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m).slice(0, 10)
    .map(({ f, m }) => {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const spec = j.spec ?? {};
        const res = j.result ?? {};
        const calls: { tokens_reasoning?: number }[] = res.calls ?? [];
        const ag = airgap.find(r => String(r.subject).includes('swarm.airgap') && r.run_id === res.run_id) ?? null;
        return {
          id: String(res.run_id ?? f.replace(/\.json$/, '')),
          preset: String(spec.preset ?? spec.id ?? '?'),
          topology: String(spec.topology ?? '?'),
          size: Number(spec.size ?? (spec.members ?? []).length),
          usd: Number(res.usd ?? 0),
          ms: Number(res.ms ?? 0),
          tokensThinking: calls.reduce((a, c) => a + Number(c.tokens_reasoning ?? 0), 0),
          judge: `${(spec.judge ?? {}).tier ?? '?'}${(spec.judge ?? {}).model ? `:${String((spec.judge as { model: string }).model).split('/').pop()}` : ''}`,
          policy: String((spec.network ?? {}).policy ?? 'open'),
          closed: String((spec.network ?? {}).policy ?? '') === 'closed' || String(spec.topology ?? '') === 'closed',
          ok: Boolean(res.ok),
          ts: m,
          members: (spec.members ?? []) as SwarmMember[],
          airgap: ag ? { egress: String(ag.egress ?? '?'), policySha: String(ag.policy_sha256 ?? '').slice(0, 8) } : null,
          room: String(j.room ?? 'war-room'),
        };
      } catch { return null; }
    })
    .filter((x): x is SwarmRun => x !== null);
}

/** fleet/nodes.json + node.* receipts: reachable · memory · loaded models · tok-per-s. */
export function nodeStats(recs: ReceiptMeta[]): NodeStat[] {
  const p = join(root(), 'fleet', 'nodes.json');
  if (!existsSync(p)) return [];
  const nodes: { id: string; status: string; kind: string; ssh: string }[] = (JSON.parse(readFileSync(p, 'utf8')).nodes ?? []);
  const meta = recs.map(withReceiptMeta);
  return nodes.map(n => {
    const joins = meta.filter(r => String(r.subject).startsWith('node.join') && r.node === n.id);
    const turns = meta.filter(r => String(r.subject).startsWith('chat.turn') && r.node === n.id && r.eval_tok_per_s !== undefined);
    const regs = meta.filter(r => String(r.subject).startsWith('provider.register') && r.node === n.id);
    const mem = joins.length ? Number(joins[joins.length - 1].mem_total_gb ?? 0) || null : null;
    const models = [...new Set([...regs.map(r => String(r.model ?? '')), ...turns.map(r => String(r.model ?? ''))].filter(Boolean))];
    const lastTurn = turns[turns.length - 1];
    return {
      id: n.id, status: n.status, kind: n.kind,
      reachable: joins.length > 0 && n.status !== 'waiting-on-will',
      memGb: mem, models,
      tokPerS: lastTurn ? Number(lastTurn.eval_tok_per_s) || null : null,
      ssh: n.ssh,
    };
  });
}

/** lanes/sandbox/runs/sb_*.json — the sbx bulkheads. */
export function sbxRuns(): SbxRun[] {
  const dir = join(root(), 'lanes', 'sandbox', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.startsWith('sb_') && f.endsWith('.json'))
    .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m).slice(0, 8)
    .map(({ f, m }) => {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        return {
          id: String(j.id ?? f), label: String(j.label ?? 'adhoc'),
          image: String(j.image ?? '?').split(':').pop() ?? '?',
          model: String(j.model ?? '?').split('/').pop() ?? '?',
          platform: String(j.platform ?? '?').split('/').pop() ?? '?',
          files: Number(j.files ?? 0), ok: (j.result ?? {}).ok !== false && j.driver_exit === 0,
          ts: m, sandbox: 'openhands',
        };
      } catch { return null; }
    })
    .filter((x): x is SbxRun => x !== null);
}

/** live docker published ports, name → ports; {} when docker is down. */
export function dockerPorts(): Record<string, string> {
  const r = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], { encoding: 'utf8', timeout: 4000 });
  if (r.status !== 0) return {};
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const [name, ports] = line.split('\t');
    if (name) out[name] = (ports ?? '').trim() || 'none';
  }
  return out;
}

/** lanes/abilities/results/*.json — harness.abilities: skills · isolation · MCP mode. */
export function abilities(): AbilityRow[] {
  const dir = join(root(), 'lanes', 'abilities', 'results');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const files: { path?: string }[] = j.mcp_setup_files ?? [];
      return {
        harness: String(j.harness ?? f.replace(/\.json$/, '')),
        skills: Object.keys((j.abilities ?? {}) as Record<string, unknown>),
        isolation: String(j.isolation ?? 'none').slice(0, 40),
        mcpMode: files.length ? (String(files[0].path ?? '').endsWith('.json') ? 'stdio' : 'file') : 'none',
      };
    } catch { return null; }
    }).filter((x): x is AbilityRow => x !== null);
}

/** the project folders (profile.cue + shelves), via Claude Code's harness-menu reader. */
export function projects(): ProjectRow[] {
  const projectsRoot = process.env.TIMMY_PROJECTS_ROOT ?? PROJECTS_ROOT;
  if (!existsSync(projectsRoot)) return [];
  return readdirSync(projectsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map(d => {
    try {
      const p = readProject(d.name, projectsRoot);
      return {
        name: d.name,
        skills: (p.skills ?? []).map((s: { path?: string; name?: string }) => String(s.name ?? s.path ?? '?')),
        plans: (p.plans ?? []).map((s: { path?: string; name?: string }) => String(s.name ?? s.path ?? '?')),
        drop: (p.drop ?? []).map((s: { path?: string; name?: string }) => String(s.name ?? s.path ?? '?')),
        budget: p.profile?.budget?.max_spend_usd ?? null,
      };
    } catch { return null; }
  }).filter((x): x is ProjectRow => x !== null);
}

const tmux = (args: string[]): { status: number; out: string } => {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, out: r.stdout ?? '' };
};

// FIT for a model tag on a node, through lanes/swarm/fit.mjs (the order's math,
// not a copy of it). Spawned, never imported: fit.mjs runs its CLI dispatch at
// module top level, so an import would print a fit report into the TUI.
const fitCache = new Map<string, boolean | null>();
const fitPending = new Set<string>();
export function modelFit(node: string, tag: string): boolean | null {
  const key = `${node}:${tag}`;
  if (fitCache.has(key)) return fitCache.get(key) ?? null;
  if (fitPending.has(key)) return null;
  fitPending.add(key);
  let stdout = '';
  let settled = false;
  const finish = (v: boolean | null): void => {
    if (settled) return;
    settled = true;
    fitPending.delete(key);
    fitCache.set(key, v);
  };
  try {
    const child = spawn(process.execPath, [join(root(), 'lanes', 'swarm', 'fit.mjs'), '--node', node, '--model', tag, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(null); }, 20000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) { finish(null); return; }
      try {
        const j = JSON.parse(stdout) as { rows?: { fits?: boolean | null }[] };
        finish(j.rows?.[0]?.fits ?? null);
      } catch { finish(null); }
    });
  } catch {
    finish(null);
  }
  return null;
}

/** which node serves a model id (node.* receipts), else null (edge-served). */
export function nodeForModel(modelId: string, nodes: NodeStat[]): NodeStat | null {
  const last = modelId.split('/').pop() ?? modelId;
  return nodes.find(n => n.models.some(m => m === modelId || m.split('/').pop() === last || m.includes(last) || last.includes(m.split('/').pop() ?? '§'))) ?? null;
}

/** the harness argv a swarm pane attaches with (jcode attaches via `jcode connect`). */
export const harnessCmd = (id: string): string[] => (id === 'jcode' ? ['jcode', 'connect'] : [id]);

export interface SwarmLaunch { ok: boolean; note?: string; specPath?: string; runIdHint?: string }

/** compose the picked spec, hand it to lanes/swarm/swarm.mjs run, materialize panes. */
export function launchSwarm(preset: SwarmPreset, over: { topology: string; size: number; budgetUsd: number; judgeTier: string; policy: string }, task: string, room: string): SwarmLaunch {
  const members = preset.members.slice(0, Math.max(1, Math.min(over.size, preset.members.length)));
  const spec = {
    v: 1, id: preset.name, preset: preset.name, topology: over.topology,
    rounds: preset.rounds, members, size: members.length,
    budget: { usd: over.budgetUsd, max_calls: preset.budget.max_calls },
    judge: { tier: over.judgeTier, model: preset.judge.model },
    network: { policy: over.policy },
  };
  const dir = join(root(), '.timmy', 'swarm');
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, `launch-${Date.now().toString(36)}.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 1));
  const log = join(root(), '.timmy', 'runs', `swarm-launch-${Date.now().toString(36)}.log`);
  mkdirSync(join(root(), '.timmy', 'runs'), { recursive: true });
  const script = join(root(), 'lanes', 'swarm', 'swarm.mjs');
  if (!existsSync(script)) return { ok: false, note: 'swarm CLI missing', specPath };
  const vet = spawnSync(process.execPath, [script, 'run', specPath, task, '--room', room, '--dry', '--edge', '--no-seal', '--no-record'], { encoding: 'utf8', timeout: 10000, cwd: root() });
  if (vet.status !== 0) return { ok: false, note: (vet.stderr || vet.stdout || 'swarm spec rejected').trim().split('\n').slice(-1)[0], specPath };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [script, 'run', specPath, task, '--room', room], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: root(),
    });
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : 'swarm launch failed', specPath };
  }
  const out = createWriteStream(log);
  child.stdout?.pipe(out); child.stderr?.pipe(out);
  child.unref();
  // materialize a pane per harness member, sized by activity like the rest
  for (const m of members.filter(x => x.kind === 'harness' && x.harness)) {
    if (tmux(['has-session', '-t', WAR_SESSION]).status !== 0) break;
    tmux(['split-window', '-t', `${WAR_SESSION}:0`, '-d', '-l', '4', ...harnessCmd(String(m.harness))]);
    const ps = tmux(['list-panes', '-t', `${WAR_SESSION}:0`, '-F', '#{pane_id}']);
    const last = ps.out.trim().split('\n').pop();
    if (last) tmux(['select-pane', '-t', last, '-T', `sw:${m.id}:${m.harness}`]);
  }
  return { ok: true, specPath };
}

/** [X] — the whole swarm dies through the governor's kill file, then its panes. */
export function killSwarm(room: string): { ok: boolean; panes: number } {
  const r = spawnSync('node', [join(root(), 'lanes', 'swarm', 'swarm.mjs'), 'kill', '--room', room], { encoding: 'utf8', timeout: 20000 });
  let killed = 0;
  if (tmux(['has-session', '-t', WAR_SESSION]).status === 0) {
    const ps = tmux(['list-panes', '-t', `${WAR_SESSION}:0`, '-F', '#{pane_id}|#{pane_title}']);
    for (const line of ps.out.trim().split('\n')) {
      const [id, title] = line.split('|');
      if (id && String(title).startsWith('sw:')) { tmux(['kill-pane', '-t', id]); killed += 1; }
    }
  }
  return { ok: r.status === 0, panes: killed };
}
