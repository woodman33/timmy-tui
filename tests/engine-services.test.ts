// Service shelf (engine-shelf/v0, kind "service"): RouteMux, Runable, AgentPass and TaskForge sit on the same shelf
// as the creative engines — registry entry, env-lock, README, three templates (plan.cue + rules + blueprint) and a
// dependency-free bridge. These tests need no network and no keys: they check the shelf's shape, the binary
// resolver, and the honesty clause (no key → status=not_configured, non-zero exit, report still written).
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBin, whichOnPath } from '../lanes/engines/lane.mjs';

const ROOT = join(__dirname, '..');
const SHELF = join(ROOT, 'lanes', 'engines');
const engines = JSON.parse(readFileSync(join(SHELF, 'engines.json'), 'utf8'));
const services = engines.engines.filter((e: any) => e.kind === 'service');
const node = process.execPath;
const run = (args: string[], env: Record<string, string | undefined> = {}) => spawnSync(node, args, { encoding: 'utf8', env: { ...process.env, ...env } });

describe('service shelf registry', () => {
  it('registers the four services with three templates each', () => {
    expect(services.map((s: any) => s.id).sort()).toEqual(['agentpass', 'routemux', 'runable', 'taskforge']);
    for (const s of services) {
      expect(s.templates, s.id).toHaveLength(3);
      expect(s.config_env?.length, `${s.id} names its env`).toBeGreaterThan(0);
      expect(s.note).not.toMatch(/sk-|Bearer [A-Za-z0-9]/);
    }
  });

  it('every engine id in the registry is allowed by the CUE schema (the reallusion lane was missing)', () => {
    const schema = readFileSync(join(SHELF, 'schemas', 'engine-workflow.cue'), 'utf8');
    const line = schema.split('\n').find((l) => l.startsWith('#EngineId:')) ?? '';
    for (const e of engines.engines) expect(line, e.id).toContain(`"${e.id}"`);
  });

  it('each service template ships plan.cue, <workflow>.rules.cue and a blueprint that names it', () => {
    for (const s of services) {
      expect(existsSync(join(SHELF, s.id, 'README.md')), `${s.id} README`).toBe(true);
      const lock = JSON.parse(readFileSync(join(SHELF, s.id, 'env-lock.json'), 'utf8'));
      expect(lock.engine).toBe(s.id);
      expect(existsSync(join(SHELF, s.id, 'bridge.mjs')), `${s.id} bridge`).toBe(true);
      expect(run(['--check', join(SHELF, s.id, 'bridge.mjs')]).status, `${s.id} bridge syntax`).toBe(0);
      for (const w of s.templates) {
        const dir = join(SHELF, s.id, 'templates', w);
        const plan = readFileSync(join(dir, 'plan.cue'), 'utf8');
        expect(plan).toContain(`engine:         "${s.id}"`);
        expect(plan).toContain(`id:             "${w}"`);
        expect(plan).toContain('kind: "engine.run"');
        const rules = readFileSync(join(dir, `${w}.rules.cue`), 'utf8');
        expect(rules).toContain(`workflow:       "${w}"`);
        const bp = JSON.parse(readFileSync(join(dir, 'blueprint.json'), 'utf8'));
        expect(bp).toMatchObject({ kind: 'blueprint', engine: s.id, workflow: w });
        expect(bp.sheets.map((x: any) => x.id)).toEqual(expect.arrayContaining(['inputs', 'steps', 'outputs', 'receipt']));
        // no home paths, hostnames or keys in anything that ships
        for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/\/Users\/[a-z]|\/home\/[a-z]+\/|sk-[A-Za-z0-9]{10}|192\.168\./);
      }
    }
  });
});

describe('binary resolver', () => {
  it('finds a bare command on PATH and falls back to the running node for "node"', () => {
    const n = whichOnPath('node');
    expect(n && existsSync(n)).toBe(true);
    expect(whichOnPath('definitely-not-a-binary-xyz-123')).toBeNull();
    expect(resolveBin({ binaries: { node: 'node' } }, 'node')).toBeTruthy();
    expect(resolveBin({ binaries: {} }, 'node')).toBeTruthy();          // a plan may name "node" directly (reallusion report steps)
  });
  it('expands <home> so engines.json never carries a home path', () => {
    expect(resolveBin({ binaries: { x: '<home>' } }, 'x')).toBe(process.env.HOME);
    expect(resolveBin({ binaries: { x: '<home>/definitely/not/here' } }, 'x')).toBeNull();
  });
});

describe('routemux bridge (offline)', () => {
  const bridge = join(SHELF, 'routemux', 'bridge.mjs');
  it('predict seals a request hash and idempotency key without touching the network', () => {
    const out = mkdtempSync(join(tmpdir(), 'rm-'));
    const drop = join(out, 'hello.routemux.json');
    writeFileSync(drop, JSON.stringify({ model: 'anthropic/claude-sonnet-5-5', messages: [{ role: 'user', content: 'say hi' }], max_tokens: 16 }));
    const r = run([bridge, 'predict', drop, out, 'hello']);
    expect(r.status).toBe(0);
    const pred = JSON.parse(readFileSync(join(out, 'hello.predict.json'), 'utf8'));
    expect(pred.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pred.idempotency_key).toBe(`timmy-${pred.request_sha256.slice(0, 48)}`);
    expect(pred.predicted.tokens_in).toBeGreaterThan(0);
    expect(pred.predicted.cost_usd).toBeNull();           // no pricing snapshot in a fresh project → honest null
  });
  it('chat without a key writes status=not_configured and exits 3 (honesty clause)', () => {
    const out = mkdtempSync(join(tmpdir(), 'rm-'));
    writeFileSync(join(out, 'x.predict.json'), JSON.stringify({ protocol: 'openai', idempotency_key: 'timmy-abc', body: {} }));
    const r = run([bridge, 'chat', out, 'x'], { ROUTEMUX_API_KEY: '' });
    expect(r.status).toBe(3);
    expect(JSON.parse(readFileSync(join(out, 'x.routemux.json'), 'utf8'))).toMatchObject({ ok: false, status: 'not_configured' });
  });
  it('report scores a prediction against usage, headers and latency', () => {
    const out = mkdtempSync(join(tmpdir(), 'rm-'));
    writeFileSync(join(out, 'x.predict.json'), JSON.stringify({ model: 'm', idempotency_key: 'timmy-abc', predicted: { tokens_in: 100, tokens_out: 50, cost_usd: 0.001, latency_ms: 1000, outcome: 'ok' }, price_source: { price: { input_per_1m: 1, output_per_1m: 4 } } }));
    writeFileSync(join(out, 'x.headers.json'), JSON.stringify({ status: 200, latency_ms: 800, request_id: 'req_1', billed: 'true', replayed: false }));
    writeFileSync(join(out, 'x.response.json'), JSON.stringify({ model: 'm', usage: { prompt_tokens: 120, completion_tokens: 40 }, choices: [{ finish_reason: 'stop' }] }));
    const r = run([bridge, 'report', 'chat-receipted', out, 'x']);
    expect(r.status).toBe(0);
    const rep = JSON.parse(readFileSync(join(out, 'x.routemux.json'), 'utf8'));
    expect(rep).toMatchObject({ ok: true, status: 'ok', request_id: 'req_1', billed: 'true', tokens_in: 120, tokens_out: 40, latency_ms: 800 });
    expect(rep.cost_usd).toBeCloseTo((120 * 1 + 40 * 4) / 1e6, 9);
    expect(rep.analysis.tokens_in_error_pct).toBeCloseTo(16.7, 1);
    expect(rep.analysis.outcome_as_predicted).toBe(true);
  });
});

describe('agentpass bridge (offline)', () => {
  const bridge = join(SHELF, 'agentpass', 'bridge.mjs');
  it('without the AgentPass repo the lane reports not_configured instead of guessing', () => {
    const out = mkdtempSync(join(tmpdir(), 'ap-'));
    const r = run([bridge, 'cli', out, 'h.health.json', 'taskforge', 'health'], { AGENTPASS_REPO_PATH: join(out, 'no-repo-here') });
    expect(r.status).toBe(3);
    const rep = JSON.parse(readFileSync(join(out, 'h.agentpass.json'), 'utf8'));
    expect(rep).toMatchObject({ ok: false, status: 'not_configured' });
    expect(rep.note).not.toContain(process.env.HOME ?? '/nonexistent');   // paths are scrubbed to ~
  });
  it('passport-issue prediction mirrors the request field by field', () => {
    const out = mkdtempSync(join(tmpdir(), 'ap-'));
    const drop = join(out, 'p.passport.json');
    writeFileSync(drop, JSON.stringify({ agent: 'lab.timmy', tool: 'openrouter.chat', scope: 'chat:write', ttl: 300, budget: 0.1 }));
    const r = run([bridge, 'predict', 'passport-issue', drop, out, 'p']);
    expect(r.status).toBe(0);
    const pred = JSON.parse(readFileSync(join(out, 'p.predict.json'), 'utf8'));
    expect(pred.predicted).toMatchObject({ agent: 'lab.timmy', tool: 'openrouter.chat', scope: 'chat:write', ttl: 300, budget_usd: 0.1, outcome: 'issued' });
    expect(pred.request_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
