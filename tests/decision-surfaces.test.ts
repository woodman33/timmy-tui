/**
 * R9 (H162): the surfaces of a decision say the configured model, its pricing as declared (free: local; a price per
 * million input tokens with its billing; or unknown) and each refusal in its words: the decision view
 * (src/decision/view.ts), `timmy decide` (src/decision/cli.ts, read from what it prints), the MCP tool timmy_decide_route
 * (src/decision/mcp.ts) and tab 8's decision lines (src/workbench/fleet-tab.ts) at the Workbench's three sizes. Their words
 * are model-neutral ("decision-model routing"): nothing calls another model Clef. A recommendation stays a recommendation:
 * admission keeps the caller's own checks whatever the model says, and no chat or text-generation path exists.
 *
 * Every answer comes from a FAKE SystemOne server on 127.0.0.1 (node:http) that counts what it receives; a FAKE paid
 * address (systemone.fake-paid.example) is carried to it by the fetch seam. No real decision service is called.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideDo, decideHelp, decideMain } from '../src/decision/cli.js';
import { callDecisionTool, DECISION_TOOLS } from '../src/decision/mcp.js';
import { admission } from '../src/decision/policy.js';
import { decide } from '../src/decision/service.js';
import { DEFAULT_DECISION_SETTINGS, SETTING_LABELS } from '../src/decision/settings.js';
import type { AdmissionChecks, DecisionRecord } from '../src/decision/types.js';
import { decisionLines } from '../src/decision/view.js';
import { FLEET_LIST, fleetDetail, fleetView, readFleet, type FleetItem } from '../src/workbench/fleet-tab.js';
import { glyphsFor, innerWidth } from '../src/workbench/frame.js';
import { bodyKind, layoutFor } from '../src/workbench/layout.js';
import { lineCells, plain, type Line, type Role } from '../src/workbench/text.js';
import { fakeAnswer, gitProject } from './fixtures/clef-omni/fake.js';

interface FakeRequest { method: string; path: string; body: string }
interface Fake { base: string; requests: FakeRequest[]; set: (o: { answerModel?: string; tags?: unknown; top?: number }) => void; close: () => Promise<void> }

/** A FAKE SystemOne deployment on 127.0.0.1: it answers each choice question (its first option `top`), and lists FAKE models when told to. */
async function fakeSystemOne(): Promise<Fake> {
  const requests: FakeRequest[] = [];
  const st: { answerModel: string; tags?: unknown; top: number } = { answerModel: 'clef-flash:latest', top: 0.71 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      requests.push({ method: req.method ?? '', path, body: raw });
      const send = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && path === '/v1/systemone') {
        const qs = (JSON.parse(raw) as { questions: Record<string, { type: string; criteria?: Record<string, string> }> }).questions;
        const scored: Record<string, Record<string, number>> = {};
        for (const [id, q] of Object.entries(qs)) {
          if (q.type !== 'choice' || !q.criteria) continue;
          const ids = Object.keys(q.criteria);
          scored[id] = Object.fromEntries(ids.map((o, i) => [o, i === 0 ? st.top : (1 - st.top) / (ids.length - 1)]));
        }
        send(200, { ...fakeAnswer(scored, { model: st.answerModel, usage: { input_tokens: 812, output_tokens: 0 } }), model_version: '2026-10-01-FAKE' });
        return;
      }
      if (req.method === 'GET' && path === '/api/tags' && st.tags !== undefined) { send(200, st.tags); return; }
      send(404, { error: 'FAKE: no such route' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    set: (o) => { if (o.answerModel !== undefined) st.answerModel = o.answerModel; if ('tags' in o) st.tags = o.tags; if (o.top !== undefined) st.top = o.top; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const PAID_FAKE = 'https://systemone.fake-paid.example';
const seam = (f: Fake): typeof fetch => ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.startsWith(PAID_FAKE)) return fetch(`${f.base}${u.slice(PAID_FAKE.length)}`, init);
  if (u.startsWith('http://127.0.0.1:')) return fetch(u, init);
  throw new Error(`the FAKE seam refused ${u}`);
}) as typeof fetch;
const FAKE_DIGEST = 'fa4e'.repeat(16);

let fake: Fake;
let home: string;
let project: ReturnType<typeof gitProject>;
beforeEach(async () => {
  fake = await fakeSystemOne();
  home = mkdtempSync(join(tmpdir(), 'timmy-surf-home-'));
  project = gitProject('timmy-surf-proj-');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fake.close();
  for (const d of [home, project.root]) rmSync(d, { recursive: true, force: true });
});

const configure = (clef: Record<string, unknown>): Record<string, string | undefined> => {
  mkdirSync(join(home, 'decision'), { recursive: true });
  writeFileSync(join(home, 'decision', 'clef.json'), JSON.stringify(clef));
  return { ...process.env, TIMMY_HOME: home, TIMMY_CLEF: '1' };
};
const FLASH_FREE = (): Record<string, unknown> => ({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest', pricing: { free: 'local' } });
const route = (...more: string[]): string[] => ['route', '--option', 'codex:Codex', '--option', 'pi', '--option', 'openhands', '--deterministic', 'pi', '--project', project.root, ...more];
const textOf = (r: DecisionRecord): string => decisionLines(r).map((l) => l.text).join('\n');
const linesOf = (r: DecisionRecord, re: RegExp): Array<{ text: string; role: string }> => decisionLines(r).filter((l) => re.test(l.text));
/** Words that would call a model Clef: never on a surface about a model that is not Clef-Omni. */
const CLEF_WORDS = /clef-omni|Clef-Omni|Use Clef|Clef routing|\bClef\b/;

describe('the decision view says the model, its pricing as declared and each refusal in its words', () => {
  it('a local model declared free: the model asked and the one that answered, its version, its digest, its pricing and its limits', async () => {
    fake.set({ tags: { models: [{ name: 'clef-flash:latest', digest: FAKE_DIGEST }] } });
    const out = await decideDo(route('--free-only', '--local-only'), { env: configure(FLASH_FREE()), fetch: seam(fake) });
    const r = out.json as unknown as DecisionRecord;
    const t = textOf(r);
    expect(t).toContain('Model: clef-flash:latest · the answer names clef-flash:latest · model_version 2026-10-01-FAKE');
    expect(t).toContain(`Digest: ${FAKE_DIGEST.slice(0, 12)} (the first 12 hex digits of its sha256; the record keeps all of it) from Ollama's list on this computer (GET /api/tags; no inference)`);
    expect(t).toContain('Pricing: free: local (declared in clef.json: hardware you control, no per-call charge)');
    expect(t).toMatch(/^Limits: clef-flash:latest's limits are not published here and clef\.json states none: a conservative default applies/m);
    expect(t).toMatch(/^clef-flash:latest via SystemOne on this computer · 812 input tokens reported · cost not measured · \d+ ms$/m);
    expect(t).not.toMatch(CLEF_WORDS);
    expect(linesOf(r, /^Pricing:/)[0].role).toBe('muted');
  });

  it('a refusal: "Why:" in its words, the pricing unknown (a policy line), the model not asked, no digest read', async () => {
    const out = await decideDo(route('--free-only'), { env: configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest' }), fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    const r = out.json as unknown as DecisionRecord;
    const t = textOf(r);
    expect(t).toMatch(/^Fallback used: pi by the existing route the caller named$/m);
    expect(t).toMatch(/^Why: free only: the pricing of clef-flash:latest on the SystemOne endpoint on this computer is unknown \(clef\.json declares no pricing for clef-flash:latest; declare \{"free": "local"\} for a model you run on hardware you control, or \{"usd_per_million_input": <dollars>, "billing": "per-request" \| "per-question"\}\), so it cannot be shown to be free; unknown pricing is never taken as free, and no call is made$/m);
    expect(t).toContain('Model: clef-flash:latest · not asked');
    expect(t).toContain('Digest: not available (no call was made, so no model list was read)');
    expect(linesOf(r, /^Pricing:/)).toEqual([{ role: 'policy', text: 'Pricing: unknown: clef.json declares none' }]);
    expect(t).toMatch(/^Not asked: clef-flash:latest via SystemOne on this computer · cost not measured$/m);
    expect(t).not.toMatch(CLEF_WORDS);
  });

  it('a declared price, with its billing; and a model that answers for another, said as a policy line', async () => {
    const paid = await decideDo(route('--budget-usd', '1'), { env: configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', pricing: { usd_per_million_input: 2, billing: 'per-question' } }), fetch: seam(fake) });
    const p = textOf(paid.json as unknown as DecisionRecord);
    expect(p).toContain('Pricing: $2 per million input tokens, billed per question (declared in clef.json)');
    expect(p).toContain('Digest: not available (the endpoint is not on this computer, so there is no local digest to read)');
    expect(p).toMatch(/^clef-flash:latest via SystemOne on another computer · 812 input tokens reported · cost not measured \(estimate \$0\.\d{6}\)/m);
    // the FAKE answered "clef-flash:latest" while d1-ultra was asked: recorded and said
    expect(linesOf(paid.json as unknown as DecisionRecord, /^Model differs:/)).toEqual([{ role: 'policy', text: 'Model differs: asked for d1-ultra; the answer names clef-flash:latest' }]);
  });

  it('Workers AI names its model and the body\'s name for it; the endpoint\'s words never say paid; a record before R9 says it has neither', async () => {
    const before = { model: undefined, provider: { id: 'clef-omni:fixture', transport: 'fixture', endpoint: 'fixture-file', paid: false, local: true } };
    const r = await decide({ kind: 'route', operationId: 'o0000bb01', project: { root: project.root, revision: project.head }, instructions: 'Which runtime?', options: [{ id: 'codex', label: 'Codex', description: 'Codex', available: true }, { id: 'pi', label: 'Pi', description: 'Pi', available: true }], state: {}, deterministic: { option: 'pi', rule: 'the existing route' } }, { settings: DEFAULT_DECISION_SETTINGS, env: configure({ transport: 'workers-ai', account_id: 'FAKEaccount0000tests', token_file: '/nonexistent/FAKE.token', pricing: { usd_per_million_input: 0.15, billing: 'per-request' } }) });
    const t = textOf(r);
    expect(t).toContain('Model: @cf/cloudflare/clef-omni (the request named it clef-omni) · not asked');
    expect(t).toContain('Pricing: $0.15 per million input tokens, billed per request (declared in clef.json)');
    expect(t).toMatch(/Not asked: @cf\/cloudflare\/clef-omni via Workers AI \(Cloudflare\)/);
    expect(t).not.toMatch(/Cloudflare, paid/);
    const old = textOf({ ...r, ...before } as unknown as DecisionRecord);
    expect(old).toContain('Model and pricing: not recorded (a record made before R9 names neither)');
  });
});

describe('timmy decide and timmy_decide_route say the same, in model-neutral words', () => {
  it('timmy decide prints the model, its pricing and the refusal; --json carries those lines as words; its help says the pricing rule', async () => {
    vi.stubEnv('TIMMY_HOME', home);
    vi.stubEnv('TIMMY_CLEF', '1');
    configure({ transport: 'systemone', systemone_url: fake.base, model: 'kimi-k3:cloud', pricing: { free: 'local' } });
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out.push(String(c)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await decideMain(route('--free-only'))).toBe(0);
    const printed = out.join('');
    expect(printed).toMatch(/^Why: free only: the pricing of kimi-k3:cloud on the SystemOne endpoint on this computer is unknown \(kimi-k3:cloud is a cloud model tag \(its name says cloud, as Ollama names the models it sends to its cloud\): it is never free, even though clef\.json declares \{"free": "local"\}; declare its price instead\), so it cannot be shown to be free/m);
    expect(printed).toContain('Pricing: unknown: kimi-k3:cloud is a cloud model tag, never free (the declared {"free": "local"} is refused)');
    expect(printed).toContain('Model: kimi-k3:cloud · not asked');
    expect(printed).not.toMatch(CLEF_WORDS);
    expect(fake.requests).toEqual([]);
    out.length = 0;
    expect(await decideMain(route('--free-only', '--operation', 'o0000bb02', '--json'))).toBe(0);
    const j = JSON.parse(out.join('').trim()) as Record<string, unknown>;
    expect(j.words).toEqual(expect.arrayContaining(['Pricing: unknown: kimi-k3:cloud is a cloud model tag, never free (the declared {"free": "local"} is refused)']));
    const help = decideHelp();
    expect(help).toMatch(/while decision-model routing is on/);
    expect(help).toMatch(/Pricing is declared in clef\.json, never inferred from the transport, a label or a localhost address/);
    expect(help).toMatch(/Unknown pricing \(none declared, or a cloud model tag such as kimi-k3:cloud declared free\) is refused before anything/);
    expect(help).not.toMatch(/Use Clef routing|asks Clef-Omni/);
    expect(SETTING_LABELS.find((x) => x.key === 'useClef')?.label).toBe('Use decision-model routing');
  });

  it('the MCP tool says the pricing rule and returns the CLI\'s words: the model, its pricing and the refusal', async () => {
    const tool = DECISION_TOOLS[0];
    expect(tool.description).toMatch(/the decision model Timmy's decision\/clef\.json names/);
    expect(tool.description).toMatch(/Pricing is declared in clef\.json, never inferred: unknown pricing is refused before anything is sent/);
    expect(tool.description).not.toMatch(/Use Clef routing|with Cloudflare Clef-Omni when/);
    const env = configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra' });
    const j = await callDecisionTool('timmy_decide_route', { options: [{ id: 'codex' }, { id: 'pi' }], deterministic: 'pi', project: project.root, budget_usd: 1 }, { env, fetch: seam(fake) });
    expect(fake.requests).toEqual([]);
    const words = (j.words as string[]).join('\n');
    expect(words).toMatch(/^Why: unknown pricing cannot be checked against the budget, so no call is made: the pricing of d1-ultra on the SystemOne endpoint on another computer is unknown/m);
    expect(words).toContain('Pricing: unknown: clef.json declares none');
    expect(words).toContain('Model: d1-ultra · not asked');
    expect(j).toMatchObject({ model: { requested: 'd1-ultra', digest: 'not available' }, provider: { id: 'systemone:d1-ultra', pricing: { kind: 'unknown' } }, fallback: { reasonKind: 'pricing' } });
  });
});

describe('a recommendation stays a recommendation', () => {
  const ALL_OK: AdmissionChecks = {
    projectScope: { ok: true, words: 'inside the project' }, privacy: { ok: true, words: 'nothing private leaves' }, budget: { ok: true, words: 'within budget' },
    concurrency: { ok: false, words: 'FAKE: 4 of 4 running' }, isolation: { ok: true, words: 'a container per worker' }, approvals: { ok: true, words: 'approved' },
  };

  it('a 99% answer from the FAKE never changes admission: the caller\'s refused check stays refused, decided apart from the model', async () => {
    fake.set({ top: 0.99 });
    const env = configure(FLASH_FREE());
    const settings = { ...DEFAULT_DECISION_SETTINGS, useClef: true, requireReview: false };
    const r = await decide({ kind: 'route', operationId: 'o0000cc01', project: { root: project.root, revision: project.head }, instructions: 'Which runtime?', options: [{ id: 'codex', label: 'Codex', description: 'Codex', available: true }, { id: 'pi', label: 'Pi', description: 'Pi', available: true }], state: {}, deterministic: { option: 'pi', rule: 'the existing route' } }, { settings, env, fetch: seam(fake), checks: ALL_OK, currentRevision: project.head });
    expect(r).toMatchObject({ outcome: 'recommend', recommendation: { option: 'codex', top: 0.99 } });
    // admission is the caller's checks alone: the same answer the deterministic function gives without any model
    const alone = admission({ of: 'recommendation', option: 'codex' }, ALL_OK, { requireReview: false });
    expect(r.admission).toMatchObject({ admitted: false, needsReview: true, checked: alone.checked, reasons: alone.reasons });
    expect(textOf(r)).toMatch(/^Admission: not admitted: concurrency: FAKE: 4 of 4 running$/m);
    expect(textOf(r)).toMatch(/^Recommendation: Codex \(codex\), 99\.0%.* — a model recommendation, not evidence$/m);
  });

  it('no chat or text-generation path exists in the decision code: only the scoring path and Ollama\'s read-only list', () => {
    const dir = join(__dirname, '..', 'src', 'decision');
    const source = readdirSync(dir).filter((n) => n.endsWith('.ts')).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
    for (const path of ['/api/chat', '/api/generate', '/chat/completions', '/v1/completions', '/v1/responses', '/v1/messages']) expect(source).not.toContain(path);
    expect(source).toContain("'/v1/systemone'");
    expect(source).toContain('/api/tags');
  });
});

// ── tab 8 ──────────────────────────────────────────────────────────────────────

const g = glyphsFor(true);
const SIZES = [[160, 45], [120, 40], [100, 30]] as const;
function bodyAt(columns: number, rows: number): { width: number; height: number } {
  const l = layoutFor({ columns, rows, body: bodyKind(false, 'fleet') });
  return { width: innerWidth(l.center!.w), height: l.center!.h - 2 };
}
const ctxAt = (columns: number, rows: number, cursor = 0) => ({ ui: { cursor: { [FLEET_LIST]: cursor } }, g, ...bodyAt(columns, rows), now: Date.now(), columns });
const text = (lines: readonly Line[]): string => lines.map(plain).join('\n');
/** The left column's words (side by side: before each row's rule; stacked: the whole row), wrapped rows joined. */
const leftColumn = (lines: readonly Line[]): string => lines.map((l) => plain(l).split('│')[0]).join(' ').replace(/\s+/g, ' ');
const rolesOf = (lines: readonly Line[], re: RegExp): Role[] => lines.flat().filter((s) => re.test(s.text)).map((s) => s.role ?? 'text');
/** The decision model's section of the stacked tab: from its heading to Cloudflare's (the services below are the frame's). */
const section = (lines: readonly Line[]): string => {
  // each row as it reads: a row is padded with spaces to its column's width
  const t = lines.map((l) => plain(l).trimEnd());
  const a = t.findIndex((l) => /^DECISION MODEL ·/.test(l));
  const b = t.findIndex((l) => /^CLOUDFLARE ·/.test(l));
  expect(a).toBeGreaterThanOrEqual(0);
  return t.slice(a, b < 0 ? undefined : b).join('\n');
};

describe('tab 8 says the configured model, its pricing as declared and each refusal\'s words', () => {
  it('a local model declared free, with a recommendation from it: by its name at every size, never Clef', async () => {
    fake.set({ tags: { models: [{ name: 'clef-flash:latest', digest: FAKE_DIGEST }] } });
    const env = configure(FLASH_FREE());
    expect((await decideDo(route(), { env, fetch: seam(fake) })).json.outcome).toBe('recommend');
    const d = readFleet({ home, root: project.root, env });
    expect(d.clef.model).toMatchObject({ name: 'clef-flash:latest', id: 'systemone:clef-flash:latest', pricing: { kind: 'free-local' }, limitsSource: 'default' });
    for (const [c, r] of SIZES) {
      const v = fleetView(ctxAt(c, r, 0), d);
      const all = leftColumn(v.lines);
      expect(all, `${c}x${r}`).toMatch(/DECISION MODEL · clef-flash:latest/);
      expect(all, `${c}x${r}`).toMatch(/Model: clef-flash:latest/);
      expect(all, `${c}x${r}`).toMatch(/Pricing: free: local/);
      expect(all, `${c}x${r}`).toMatch(/recommended Codex[^\n]*not a run/);
      for (const l of v.lines) expect(lineCells(l)).toBeLessThanOrEqual(bodyAt(c, r).width);
    }
    const stacked = fleetView(ctxAt(100, 30, 0), d).lines;
    const s = section(stacked);
    expect(s).toMatch(/^DECISION MODEL · clef-flash:latest · a recommender$/m);
    expect(s).toMatch(/^ {2}Decision-model routing: on \(TIMMY_CLEF=1, for this process\): clef-flash:latest (scores the options|is asked)$/m);
    expect(s).toMatch(/^ {2}Transport: SystemOne on this computer$/m);
    expect(s).toMatch(/^ {2}Model: clef-flash:latest \(systemone:clef-flash:latest\) · conservative default limits$/m);
    expect(s).toMatch(/^ {2}Pricing: free: local \(declared in clef\.json: hardware you control, no per-call charge\)$/m);
    expect(s).toMatch(/clef-flash:latest recommended Codex 71\.0%, ahead by \d+\.\d%: a recommendation, not a run/);
    expect(s).toMatch(/clef-flash:latest via SystemOne on this computer · cost not measured/);
    expect(s.replace(/\n\s+/g, ' ')).toMatch(/pricing: free: local \(declared in clef\.json: hardware you control, no per-call charge\)/);
    expect(s).not.toMatch(CLEF_WORDS);
    expect(rolesOf(stacked, /^Codex$/)).toEqual(['accent']);
    // the Inspector: the record's own lines, the model and the digest among them
    const item = fleetView(ctxAt(100, 30, 0), d).items[0].item as FleetItem;
    const detail = text(fleetDetail(item, 60, g)).replace(/\s+/g, ' ');
    expect(detail).toMatch(/Model: clef-flash:latest · the answer names clef-flash:latest · model_version 2026-10-01-FAKE/);
    expect(detail).toMatch(new RegExp(`Digest: ${FAKE_DIGEST.slice(0, 12)} \\(the first 12 hex digits`));
  });

  it('unknown pricing: amber, with what every call is then refused for; a refused decision, selected, says why in its words', async () => {
    const env = configure({ transport: 'systemone', systemone_url: fake.base, model: 'clef-flash:latest' });
    expect((await decideDo(route('--budget-usd', '2'), { env, fetch: seam(fake) })).json.fallback).toMatchObject({ reasonKind: 'pricing' });
    expect(fake.requests).toEqual([]);
    const d = readFleet({ home, root: project.root, env });
    for (const [c, r] of SIZES) {
      const v = fleetView(ctxAt(c, r, 0), d);
      const all = leftColumn(v.lines);
      // the selected refused decision is in view at every size, with its pricing and its refusal in its words
      expect(all, `${c}x${r}`).toMatch(/pricing: unknown: clef\.json declares none/);
      expect(all, `${c}x${r}`).toMatch(/why: unknown pricing cannot be checked against the budget, so no call is made: the pricing of clef-flash:latest/);
      for (const l of v.lines) expect(lineCells(l)).toBeLessThanOrEqual(bodyAt(c, r).width);
      // the model's own rows, where the column holds them above the selection (at 120x40 they scroll above "↑ 21–33 of 33 rows")
      if (c === 120) { expect(all).toMatch(/↑ \d+–\d+ of \d+ rows/); continue; }
      expect(all, `${c}x${r}`).toMatch(/Pricing: unknown: clef\.json declares none/);
      expect(all, `${c}x${r}`).toMatch(/⚠ every call is refused before anything is sent: clef\.json declares no pricing for clef-flash:latest/);
      expect(rolesOf(v.lines, /^unknown: clef\.json declares none$/), `${c}x${r}`).toEqual(['attention']);
      expect(rolesOf(v.lines, /every call is refused before anything is sent/), `${c}x${r}`).toEqual(['attention']);
    }
    const s = section(fleetView(ctxAt(100, 30, 0), d).lines).replace(/\n\s+/g, ' ');
    expect(s).toMatch(/deterministic: pi by the existing route the caller named/);
    expect(s).toMatch(/why: unknown pricing cannot be checked against the budget, so no call is made: the pricing of clef-flash:latest on the SystemOne endpoint on this computer is unknown/);
    expect(s).toMatch(/pricing: unknown: clef\.json declares none/);
  });

  it('a declared price, Workers AI\'s transport by its model, and an answer from another model, amber', async () => {
    const env = configure({ transport: 'systemone', systemone_url: PAID_FAKE, model: 'd1-ultra', pricing: { usd_per_million_input: 2, billing: 'per-question' } });
    fake.set({ answerModel: 'jev-1' });
    expect((await decideDo(route('--budget-usd', '1'), { env, fetch: seam(fake) })).json.model).toMatchObject({ differs: 'asked for d1-ultra; the answer names jev-1' });
    const d = readFleet({ home, root: project.root, env });
    const stacked = fleetView(ctxAt(100, 30, 0), d).lines;
    const s = section(stacked);
    expect(s).toMatch(/^ {2}Transport: SystemOne on another computer$/m);
    expect(s).toMatch(/^ {2}Pricing: \$2 per million input tokens, billed per question \(declared in clef\.json\)$/m);
    expect(s).toMatch(/d1-ultra recommended Codex/);
    expect(s).toMatch(/⚠ asked for d1-ultra; the answer names jev-1/);
    expect(rolesOf(stacked, /asked for d1-ultra; the answer names jev-1/)).toEqual(['attention']);
    const wa = readFleet({ home, root: project.root, env: configure({ transport: 'workers-ai', account_id: 'FAKEaccount0000tests', token_file: '/nonexistent/FAKE.token', pricing: { usd_per_million_input: 0.15, billing: 'per-request' } }) });
    const w = text(fleetView(ctxAt(100, 30, 0), wa).lines);
    expect(w).toMatch(/Workers AI: the decision model's transport \(@cf\/cloudflare\/clef-omni\)/);
    expect(w).toMatch(/Model: @cf\/cloudflare\/clef-omni( \(workers-ai:@cf\/cloudflare\/clef-omni\))? · Clef-Omni's published limits/);
    expect(w).not.toMatch(/Cloudflare, paid|\(paid\)/);
  });
});
