import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import crypto from 'crypto';
import { appendReceipt } from './receipts.js';
import { publish as appendEvent } from '../bus/index.js';

// TIMMY Generation Ledger — every prompt → generation → capture → critique
// cycle lands here as a reviewable, sha256-stamped record. Async by design:
// runs execute detached; /gens derives live status from the run log lazily.

export type GenerationStatus = 'queued' | 'running' | 'done' | 'failed';

export interface GenerationRecord {
  id: string;
  prompt: string;
  prompt_hash: string;
  provider: string;
  model?: string;
  kind: string;
  transport: string;
  status: GenerationStatus;
  artifact?: string;
  framesDir?: string;
  frameCount?: number;
  cost_usd?: number;
  critique?: string;
  log?: string;
  project?: string;
  recursion_of?: string;
  spans?: { name: string; kind: string }[];
  decisions?: { decision: string; effect: string; tier: string; reason: string }[];
  stamp: string;
  created_at: string;
}

export interface GenEvent {
  ts: string;
  genId: string;
  event: string;
  detail?: string;
}

export interface ProviderStats {
  provider: string;
  models: Record<string, number>;
  total: number;
  done: number;
  failed: number;
  cost: number;
  last_at?: string;
}

interface LedgerFile {
  schema: 1;
  generations: GenerationRecord[];
}

const now = () => new Date().toISOString();
const stampOf = (payload: string) => 'sha256_' + crypto.createHash('sha256').update(payload).digest('hex');

export function generationsPath(dir: string = process.cwd()): string {
  return join(dir, '.timmy', 'generations.json');
}

export function loadGenerations(dir?: string): GenerationRecord[] {
  const path = generationsPath(dir);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || !Array.isArray(data.generations)) return [];
    return data.generations.filter((g: any) => g && typeof g.id === 'string' && typeof g.prompt === 'string');
  } catch {
    return [];
  }
}

export function saveGenerations(records: GenerationRecord[], dir?: string): void {
  const path = generationsPath(dir);
  mkdirSync(join(path, '..'), { recursive: true });
  const file: LedgerFile = { schema: 1, generations: records };
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf8');
}

export function recordGeneration(
  input: Omit<GenerationRecord, 'id' | 'prompt_hash' | 'stamp' | 'created_at'>,
  dir?: string
): GenerationRecord {
  const records = loadGenerations(dir);
  const record: GenerationRecord = {
    ...input,
    id: `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    prompt_hash: stampOf(input.prompt),
    stamp: stampOf(JSON.stringify({ prompt: input.prompt, provider: input.provider })),
    created_at: now()
  };
  records.push(record);
  saveGenerations(records, dir);
  appendGenEvent(record.id, 'recorded', `${record.provider}/${record.kind}`, dir);
  appendReceipt('gens', {
    kind: 'generation',
    subject: record.id,
    prompt_hash: record.prompt_hash,
    cost_usd: record.cost_usd,
    policy: 'human-gated',
    spans: record.spans as { name: string; kind: 'root' | 'chat' | 'execute_tool' | 'deny' }[] | undefined,
    decisions: record.decisions
  }, dir);
  return record;
}

// Timestamped JSONL event log — the reviewable trail behind the ledger.
export function appendGenEvent(genId: string, event: string, detail: string = '', dir?: string): void {
  const path = join(dir || process.cwd(), '.timmy', 'runs', 'events.jsonl');
  try {
    mkdirSync(dirname(path), { recursive: true });
    const line: GenEvent = { ts: now(), genId, event, detail };
    appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
    appendEvent(`gen.${event}`, { genId, detail }, dir);
  } catch {
    // event log is best-effort; never block the ledger
  }
}

export function updateGeneration(id: string, patch: Partial<GenerationRecord>, dir?: string): GenerationRecord | undefined {
  const records = loadGenerations(dir);
  const rec = records.find(r => r.id === id);
  if (!rec) return undefined;
  Object.assign(rec, patch, { stamp: stampOf(JSON.stringify({ ...rec, ...patch, stamp: undefined })) });
  saveGenerations(records, dir);
  appendGenEvent(id, 'update', Object.keys(patch).join(','), dir);
  return rec;
}

export function listGenerations(filter: { id?: string; provider?: string; kind?: string } = {}, dir?: string): GenerationRecord[] {
  return loadGenerations(dir)
    .filter(g =>
      (!filter.id || g.id.includes(filter.id) || g.prompt.toLowerCase().includes(filter.id.toLowerCase())) &&
      (!filter.provider || g.provider.includes(filter.provider.toLowerCase())) &&
      (!filter.kind || g.kind === filter.kind))
    .reverse();
}

// Lazy status derivation from a detached run log written by genbridge:
// the wrapper appends EXIT=<code> when the npm script finishes.
export function deriveStatusFromLog(logText: string, fallback: GenerationStatus): GenerationStatus {
  const m = logText.match(/EXIT=(\d+)/);
  if (m) return m[1] === '0' ? 'done' : 'failed';
  if (logText.trim()) return 'running';
  return fallback === 'done' || fallback === 'failed' ? fallback : 'running';
}

export function extractArtifactFromLog(logText: string): string | undefined {
  const m = logText.match(/(out\/[^\s"']+\.(png|jpe?g|webp|mp4|webm|gif))/i);
  return m ? m[1] : undefined;
}

export function parseCostFromLog(logText: string): number | undefined {
  const m = logText.match(/\$\s?(\d+\.\d{1,6})/);
  return m ? parseFloat(m[1]) : undefined;
}

// Provider/model-specific prompt+result database over the ledger.
export function aggregateGenerations(providerFilter?: string, dir?: string): ProviderStats[] {
  const map = new Map<string, ProviderStats>();
  for (const g of loadGenerations(dir)) {
    if (providerFilter && !g.provider.includes(providerFilter.toLowerCase())) continue;
    let s = map.get(g.provider);
    if (!s) {
      s = { provider: g.provider, models: {}, total: 0, done: 0, failed: 0, cost: 0 };
      map.set(g.provider, s);
    }
    const model = g.model || '(unspecified)';
    s.models[model] = (s.models[model] || 0) + 1;
    s.total += 1;
    if (g.status === 'done') s.done += 1;
    if (g.status === 'failed') s.failed += 1;
    s.cost += g.cost_usd || 0;
    if (!s.last_at || g.created_at > s.last_at) s.last_at = g.created_at;
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function countFrames(framesDir: string): number {
  try {
    return readdirSync(framesDir).filter(f => f.endsWith('.png')).length;
  } catch {
    return 0;
  }
}

export function generationsOverview(dir?: string): string {
  const all = loadGenerations(dir);
  const by = (s: GenerationStatus) => all.filter(g => g.status === s).length;
  return `generations:${all.length} (done:${by('done')} running:${by('running')} queued:${by('queued')} failed:${by('failed')})`;
}
