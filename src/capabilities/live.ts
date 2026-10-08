/**
 * The capability checks against this machine (round R1). Each is free and quick: PATH lookups, file
 * checks, and local requests with short timeouts; the one network call is OpenRouter's key endpoint,
 * which costs nothing. Nothing here writes a file or a receipt, starts a server, or prints a key.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { probeOllama } from '../agent/providers.js';
import { studioBaseUrl } from '../studio/config.js';
import { studioHealth } from '../studio/health.js';
import { studioRoot } from '../studio/server.js';
import { listLanes } from '../utils/dispatch.js';
import { edgeUrlOrNull } from '../utils/edge-host.js';
import { modelKeySource } from '../utils/model-key.js';
import { onPath } from '../utils/on-path.js';
import { readChain, verifyChain } from '../utils/receipts.js';
import { integrationCatalog } from '../vision/integrations/registry.js';
import type { OpenRouterAnswer, ProbeDeps } from './index.js';

type Env = Record<string, string | undefined>;

/** Whether OpenRouter accepts `key`, asked of its key endpoint (no model call, no charge). */
export async function openRouterProbe(key: string | null, fetcher: typeof fetch = fetch, timeoutMs = 3000): Promise<OpenRouterAnswer> {
  if (!key) return 'no-key';
  try {
    const res = await fetcher('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) return 'rejected';
    return res.ok ? 'accepted' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

async function httpStatus(url: string, timeoutMs: number): Promise<number | null> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })).status;
  } catch {
    return null;
  }
}

/** Tool name → the last time it completed in a sealed REPL turn. */
export function exercisedTools(chain: Array<Record<string, unknown>>): Map<string, string> {
  const last = new Map<string, string>();
  for (const r of chain) {
    if (r.kind !== 'turn' || !Array.isArray(r.tool_outcomes) || typeof r.ts !== 'string') continue;
    for (const t of r.tool_outcomes as Array<{ name?: unknown; outcome?: unknown }>) {
      if (t?.outcome !== 'completed' || typeof t.name !== 'string') continue;
      if (!last.has(t.name) || (last.get(t.name) ?? '') < r.ts) last.set(t.name, r.ts);
    }
  }
  return last;
}

export interface LiveOptions {
  env?: Env;
  /** The model key, when the caller has loaded it (the REPL has); without it OpenRouter is not contacted. */
  key?: () => string | null;
  model: string;
}

export function liveDeps(o: LiveOptions): ProbeDeps {
  const env = o.env ?? process.env;
  let chain: Array<Record<string, unknown>> | null = null;
  const receipts = (): Array<Record<string, unknown>> => (chain ??= readChain('runs') as unknown as Array<Record<string, unknown>>);
  return {
    env,
    onPath: (bin) => onPath(bin, env),
    exists: (path) => existsSync(path),
    canvasBuilt: () => existsSync(join(studioRoot(), 'dist', 'canvas.js')),
    studio: () => studioHealth(studioBaseUrl(env), 800),
    studioBase: studioBaseUrl(env),
    ollama: () => probeOllama(1500),
    openrouter: () => (o.key ? openRouterProbe(o.key()) : Promise.resolve<OpenRouterAnswer>('not-asked')),
    modelKeySource: () => modelKeySource(env),
    model: o.model,
    http: httpStatus,
    lanes: () => listLanes(),
    adapters: () => integrationCatalog(),
    receipts: () => {
      const v = verifyChain('runs');
      return { ok: v.ok, count: v.count, ...(v.reason ? { reason: v.reason } : {}) };
    },
    exercised: () => exercisedTools(receipts()),
    edgeSet: () => edgeUrlOrNull() !== null,
  };
}
