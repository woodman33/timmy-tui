#!/usr/bin/env node
// lanes/swarm/presets.mjs — the preset table behind lanes/swarm/presets/*.cue.
//
//   node lanes/swarm/presets.mjs list            print the table
//   node lanes/swarm/presets.mjs write           (re)write every preset .cue from the table
//   node lanes/swarm/presets.mjs vet             cue vet every preset against schemas/swarm.cue
//
// The .cue files are committed (a reader can open one), this table is the
// single source they are generated from, and `vet` is the check that the two
// agree with the schema. swarm.mjs loads presets by name from the .cue files.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const PRESETS_DIR = join(HERE, 'presets');
export const SCHEMA = join(HERE, 'schemas', 'swarm.cue');

const SPARK_MODEL = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q8_K_XL';
// The Mac runs the same Unsloth GGUF family (Q4_K_XL, 17.5 GB): Ollama 0.33's MLX
// runner (qwen3.8:27b-mlx) ignores OLLAMA_NUM_PARALLEL, the llama.cpp runner
// honours it — measured by lanes/swarm/slots.mjs prove (README-slots.md).
const MAC_MODEL = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL';
const FLASH = 'google/gemini-3.7-flash';
const GROK = 'x-ai/grok-4.6';

const slots = (n, model, provider, node, prefix = 'slot') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, kind: 'model', model, provider, node }));

/** name → { comment, swarm } */
export const PRESETS = {
  'local-5': {
    comment: '"Local 5" — five parallel Ollama slots on spark2 (Level 0). fanout, then a\n// second run as fusion, is the proof the order asks for.',
    swarm: { topology: 'fanout', members: slots(5, SPARK_MODEL, 'ollama:spark2', 'spark2'), budget: { usd: 0, max_calls: 12 }, judge: { tier: 'local', model: SPARK_MODEL }, network: { policy: 'tailnet' } }
  },
  'local-5-mac': {
    comment: '"Local 5" on this Mac\'s second Ollama server (port 11435, OLLAMA_NUM_PARALLEL=5):\n// the fallback proof while spark2 is off the tailnet.',
    swarm: { topology: 'fanout', members: slots(5, MAC_MODEL, 'ollama:mac', 'mac'), budget: { usd: 0, max_calls: 12 }, judge: { tier: 'local', model: MAC_MODEL }, network: { policy: 'tailnet' } }
  },
  'kimi-5': {
    comment: '"Kimi 5" — five Kimi sessions through Ollama Cloud (the local daemon proxies\n// kimi-k3:cloud to ollama.com). Metered on the operator\'s Ollama account.',
    swarm: { topology: 'fusion', members: slots(5, 'kimi-k3:cloud', 'ollama-cloud', 'mac', 'kimi'), budget: { usd: 0.5, max_calls: 8 }, judge: { tier: 'local', model: 'kimi-k3:cloud' }, network: { policy: 'open' } }
  },
  'timmy-x3': {
    comment: '"Timmy ×3" — Level 2: the root commander (war-room) runs three project\n// Timmys as tools over MCP (Durable Object RPC) and fuses their answers.',
    swarm: { topology: 'fusion', members: [{ id: 'ship', kind: 'timmy', room: 'project:ship' }, { id: 'shelf', kind: 'timmy', room: 'project:shelf' }, { id: 'swarm', kind: 'timmy', room: 'project:swarm' }], budget: { usd: 0.25, max_calls: 8 }, judge: { tier: 'edge', model: FLASH }, network: { policy: 'open' } }
  },
  'relay-3': {
    comment: 'relay — a handoff chain: each member improves the previous member\'s answer.',
    swarm: { topology: 'relay', members: [{ id: 'draft', kind: 'model', model: FLASH }, { id: 'critic', kind: 'model', model: GROK }, { id: 'final', kind: 'model', model: FLASH }], budget: { usd: 0.2, max_calls: 6 }, judge: { tier: 'edge' }, network: { policy: 'open' } }
  },
  'tournament-4': {
    comment: 'tournament — N candidates, the judge picks one, the losers are sealed too.',
    swarm: { topology: 'tournament', members: [{ id: 'cand-1', kind: 'model', model: FLASH }, { id: 'cand-2', kind: 'model', model: GROK }, { id: 'cand-3', kind: 'model', model: FLASH }, { id: 'cand-4', kind: 'model', model: GROK }], budget: { usd: 0.3, max_calls: 8 }, judge: { tier: 'edge', model: GROK }, network: { policy: 'open' } }
  },
  'council-3': {
    comment: 'council — rounds of positions, then a vote; no member may vote for itself.',
    swarm: { topology: 'council', rounds: 2, members: [{ id: 'seat-1', kind: 'model', model: FLASH }, { id: 'seat-2', kind: 'model', model: GROK }, { id: 'seat-3', kind: 'model', model: FLASH, weight: 2 }], budget: { usd: 0.4, max_calls: 12 }, judge: { tier: 'edge', model: GROK }, network: { policy: 'open' } }
  },
  'crew-3': {
    comment: 'crew — local harnesses with roles derived from harness.abilities\n// (builder / operator / bridge / answerer), planned and composed by the judge.',
    swarm: { topology: 'crew', members: [{ id: 'jcode', kind: 'harness', harness: 'jcode', node: 'mac', model: FLASH }, { id: 'opencode', kind: 'harness', harness: 'opencode', node: 'mac', model: FLASH }, { id: 'hermes', kind: 'harness', harness: 'hermes', node: 'mac', model: FLASH }], budget: { usd: 0.5, max_calls: 12, max_ms: 900000 }, judge: { tier: 'edge', model: FLASH }, network: { policy: 'open' } }
  },
  'coordinator-3': {
    comment: 'coordinator — the judge-tier model splits the task, members take a part each,\n// the coordinator composes the answer.',
    swarm: { topology: 'coordinator', members: [{ id: 'w-1', kind: 'model', model: FLASH }, { id: 'w-2', kind: 'model', model: GROK }, { id: 'w-3', kind: 'model', model: FLASH }], budget: { usd: 0.3, max_calls: 8 }, judge: { tier: 'edge', model: GROK }, network: { policy: 'open' } }
  },
  'closed-3': {
    comment: 'closed — air-gapped: local slots only, a local judge, deny-all egress, hands\n// under sbx lockdown. The lane seals swarm.airgap with the policy hash and the\n// egress count mcpsnoop saw on the wire (must be 0).',
    swarm: { topology: 'closed', members: slots(3, MAC_MODEL, 'ollama:mac', 'mac', 'air').map((m) => ({ ...m, sandbox: 'closed' })), budget: { usd: 0, max_calls: 8 }, judge: { tier: 'local', model: MAC_MODEL }, network: { policy: 'closed', egress_allow: [] } }
  },
  'fanout-2': {
    comment: 'fanout — every member answers; all answers are kept side by side.',
    swarm: { topology: 'fanout', members: [{ id: 'a', kind: 'model', model: FLASH }, { id: 'b', kind: 'model', model: GROK }], budget: { usd: 0.1, max_calls: 4 }, judge: { tier: 'edge' }, network: { policy: 'open' } }
  },
  'fusion-2': {
    comment: 'fusion — every member answers, one judge merges.',
    swarm: { topology: 'fusion', members: [{ id: 'a', kind: 'model', model: FLASH }, { id: 'b', kind: 'model', model: GROK }], budget: { usd: 0.15, max_calls: 4 }, judge: { tier: 'edge', model: GROK }, network: { policy: 'open' } }
  }
};

const q = (s) => JSON.stringify(String(s));

function memberCue(m) {
  const parts = [`id: ${q(m.id)}`, `kind: ${q(m.kind)}`];
  if (m.kind === 'model') { parts.push(`model: ${q(m.model)}`); parts.push(`provider: ${q(m.provider ?? 'openrouter')}`); }
  if (m.kind === 'harness') { parts.push(`harness: ${q(m.harness)}`); if (m.model) parts.push(`model: ${q(m.model)}`); }
  if (m.kind === 'timmy') parts.push(`room: ${q(m.room)}`);
  if (m.node) parts.push(`node: ${q(m.node)}`);
  if (m.sandbox) parts.push(`sandbox: ${q(m.sandbox)}`);
  if (m.role) parts.push(`role: ${q(m.role)}`);
  if (m.weight) parts.push(`weight: ${m.weight}`);
  return `\t\t{${parts.join(', ')}},`;
}

export function presetCue(name, p) {
  const s = p.swarm;
  const budget = Object.entries(s.budget).map(([k, v]) => `${k}: ${v}`).join(', ');
  const judge = Object.entries(s.judge).map(([k, v]) => `${k}: ${q(v)}`).join(', ');
  const network = [`policy: ${q(s.network.policy)}`, ...(s.network.egress_allow ? [`egress_allow: [${s.network.egress_allow.map(q).join(', ')}]`] : [])].join(', ');
  return [
    `// ${p.comment}`,
    '// Generated by lanes/swarm/presets.mjs write — edit the table there, then vet.',
    'package swarm',
    '',
    'swarm: {',
    '\tv:        1',
    `\tid:       ${q(name)}`,
    `\tpreset:   ${q(name)}`,
    `\ttopology: ${q(s.topology)}`,
    ...(s.rounds ? [`\trounds:   ${s.rounds}`] : []),
    '\tmembers: [',
    ...s.members.map(memberCue),
    '\t]',
    `\tsize:    ${s.members.length}`,
    `\tbudget:  {${budget}}`,
    `\tjudge:   {${judge}}`,
    `\tnetwork: {${network}}`,
    '}',
    ''
  ].join('\n');
}

/** The preset as the JSON the runtime takes (same shape the CUE unifies to). */
export function presetSpec(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown preset ${name}; known: ${Object.keys(PRESETS).join(', ')}`);
  const s = p.swarm;
  return {
    v: 1, id: name, preset: name, topology: s.topology,
    members: s.members.map((m) => ({ node: m.kind === 'timmy' ? 'edge' : (m.node ?? 'edge'), sandbox: m.sandbox ?? 'none', weight: m.weight ?? 1, ...(m.kind === 'model' ? { provider: m.provider ?? 'openrouter' } : {}), ...m })),
    size: s.members.length,
    budget: { max_calls: 64, max_ms: 600000, ...s.budget },
    judge: s.judge,
    network: { egress_allow: [], ...s.network },
    rounds: s.rounds ?? 2
  };
}

export function vetPreset(file) {
  const r = spawnSync('cue', ['vet', '-c', SCHEMA, file], { encoding: 'utf8' });
  return { ok: r.status === 0, note: (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ') || 'ok' };
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const cmd = isEntry ? process.argv[2] : null;
if (!isEntry) {
  // imported by swarm.mjs: only the table and the helpers, no CLI
} else if (cmd === 'write') {
  mkdirSync(PRESETS_DIR, { recursive: true });
  for (const [name, p] of Object.entries(PRESETS)) writeFileSync(join(PRESETS_DIR, `${name}.cue`), presetCue(name, p));
  console.log(JSON.stringify({ ok: true, written: Object.keys(PRESETS).length, dir: PRESETS_DIR }));
} else if (cmd === 'vet') {
  const files = existsSync(PRESETS_DIR) ? readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.cue')) : [];
  const out = {};
  let ok = true;
  for (const f of files) { const v = vetPreset(join(PRESETS_DIR, f)); out[f] = v; if (!v.ok) ok = false; }
  console.log(JSON.stringify({ ok, schema: SCHEMA, presets: out }, null, 1));
  process.exit(ok ? 0 : 1);
} else if (cmd === 'list' || cmd === undefined) {
  for (const [name, p] of Object.entries(PRESETS)) console.log(`${name.padEnd(14)} ${p.swarm.topology.padEnd(12)} size ${p.swarm.members.length}  budget $${p.swarm.budget.usd}  judge ${p.swarm.judge.tier}${p.swarm.judge.model ? ' ' + p.swarm.judge.model : ''}  net ${p.swarm.network.policy}`);
} else if (cmd === 'json') {
  console.log(JSON.stringify(presetSpec(process.argv[3]), null, 1));
} else {
  console.error('usage: node lanes/swarm/presets.mjs list|write|vet|json <name>');
  process.exit(2);
}
