/**
 * The unified Workspace order (2026-10-27), in a real headless Chromium against the real companion: the canvas agent's panel.
 * The agent's model is a LABELLED FAKE Ollama (tests/fixtures/fake-ollama-chat.ts, its answers scripted here from what the
 * request names) and Stream Studio is the FAKE fixture app; everything else is real: the chat route that picks the harness,
 * the plan's admission against the board as saved, the page applying it through the person's own graph functions, the app's
 * job, its receipts and the board's save.
 *
 *   Run        goal → plan → an operation node marked AGENT, connected, its parameter set, run → results on the board
 *   Plan       proposed, nothing changes; Discard; again, Apply edits → the parameter changes and nothing runs
 *   Stop       while the model is being asked (nothing applied); and while the agent's run goes (the app cancels it)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { appRoot } from '../src/companion/timmy-app.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { projectId } from '../src/project/index.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { browserPath, launchBrowser } from './helpers/companion-page-kit.js';
import { existsSync } from 'node:fs';

const STREAM = fileURLToPath(new URL('./fixtures/fake-stream-studio', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const IMG = 'from-apps/card-lab/c1/card.png';
const MODEL = 'fake-qwen3:8b';
const shots = process.env.TIMMY_G_SHOTS;
type Script = (req: Record<string, any>) => { chunks?: Array<Record<string, unknown>>; status?: number; error?: string; hang?: boolean };
/** The handle the request names for a line of the prompt (the board as saved: "- shape:…: file <path>" / "operation node"). */
const handle = (req: Record<string, any>, re: RegExp): string => { const u = String(req.messages?.[1]?.content ?? ''); const m = new RegExp(`- (shape:[\\w-]+): ${re.source}`).exec(u); if (!m) throw new Error(`FAKE: no handle for ${re} in\n${u}`); return m[1]; };
const answer = (v: unknown) => ({ chunks: textChunks(MODEL, [JSON.stringify(v)]) });

describe.skipIf(!browserPath)('the canvas agent’s panel: Plan / Run / Stop through the board’s own operations (FAKE Ollama, FAKE Stream Studio)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let home = ''; let browser: Browser; let companion: CompanionServer; let origin = ''; let token = ''; let ollama: FakeOllama;
  const scripts: Script[] = [];
  const problems: string[] = [];

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'agent-browser-'));
    root = join(box, 'project'); home = join(box, 'home');
    mkdirSync(join(root, 'from-apps', 'card-lab', 'c1'), { recursive: true }); mkdirSync(home, { recursive: true });
    writeFileSync(join(root, IMG), PNG);
    appendReceipt('runs', {
      kind: 'miniapp', subject: 'miniapp · card-lab · inspection (FAKE)', policy: 'app-initiated', status: 'ok', project: 'project', project_id: projectId(root),
      job: { id: 'c1', kind: 'inspection', label: 'inspection', state: 'complete' }, outputs: [{ path: IMG, sha256: sha(PNG), bytes: PNG.length }],
      miniapp: { app: 'card-lab', title: 'Image Analysis', revision: null, record_sha256: sha('r'), started_by: 'test', principal: 'operator' },
    }, root);
    ollama = await startFakeOllama({ models: [{ name: MODEL }], chat: Array.from({ length: 20 }, () => (req: Record<string, any>) => { const s = scripts.shift(); return s ? s(req) : { status: 500, error: 'FAKE: nothing scripted' }; }) });
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host, model: MODEL } }));
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TIMMY_STREAM_STUDIO_DIR: STREAM };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, 600_000);
  afterAll(async () => {
    await companion?.shutdown();
    await browser?.close();
    await ollama?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
    expect(problems.filter((p) => !/favicon|WebGL/.test(p))).toEqual([]);
  });

  const open = async (width: number, height: number): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
    await page.goto(`${origin}/app#t=${token}`);
    await page.waitForSelector('.ta-rail', { state: 'attached', timeout: 60_000 });
    await page.click('.ta-rail-item[data-nav="canvas"]');
    await page.waitForSelector('.ta-stage .tl-container', { timeout: 60_000 });
    return page;
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  const op = '[data-op="stream-studio.animate-image"]';

  it('Run: the agent’s plan is applied visibly through the board’s own operations and its run’s results come back', async () => {
    const page = await open(1440, 900);
    await page.click('[data-tool="Import"]');
    await page.click(`[data-import="${IMG}"]`);
    await page.waitForSelector(`[data-node-path="${IMG}"]`, { timeout: 30_000 });
    await page.click('[data-agent-toggle]');
    await expect.poll(() => page.locator('[data-agent-harness]').getAttribute('data-agent-harness')).toBe('ready');
    expect(await page.locator('[data-agent-harness]').innerText()).toContain(`${MODEL} · Ollama on this computer · no charge`);
    scripts.push((req) => { const img = handle(req, /file from-apps\/card-lab\/c1\/card\.png/); return answer({ say: 'A pulse on the card, exported as an HTML player.', cites: [img], done: true, steps: [
      { do: 'add', ref: 'n1', operation: 'stream-studio.animate-image' }, { do: 'connect', node: 'n1', port: 'image', from: img },
      { do: 'set', node: 'n1', param: 'motion', value: 'pulse' }, { do: 'run', node: 'n1' }] }); });
    await page.fill('[data-agent-goal]', 'Animate the card image with a pulse and export an HTML player');
    await page.click('label:has([data-agent-mode="run"])');
    await page.click('[data-agent-go]');
    // the node is the agent's (marked), connected, its parameter set, and its run is the app's own job
    await page.waitForSelector(`${op} [data-op-by="agent"]`, { timeout: 30_000 });
    await expect.poll(() => page.locator(`${op} li[data-port="image"]`).getAttribute('data-connected'), { timeout: 20_000 }).toBe('yes');
    await expect.poll(() => page.locator(`${op} select[data-param="motion"]`).inputValue(), { timeout: 10_000 }).toBe('pulse');
    await shot(page, 'agent-1-applying');
    await expect.poll(() => page.locator(op).getAttribute('data-op-state'), { timeout: 40_000 }).toBe('completed');
    await expect.poll(() => page.locator('[data-agent-plan-state]').getAttribute('data-agent-plan-state'), { timeout: 20_000 }).toBe('applied');
    await expect.poll(() => page.locator('[data-agent-phase]').getAttribute('data-agent-phase'), { timeout: 30_000 }).toBe('done');
    expect(await page.locator('[data-agent-step][data-applied="yes"]').count()).toBe(4);
    expect(await page.locator('[data-agent-log]').innerText()).toMatch(/run w[0-9a-f]{12} completed, 2 file\(s\) on the board/);
    await page.waitForSelector(`${op} [data-op-output$="/index.html"]`, { timeout: 30_000 });
    await shot(page, 'agent-2-done');
    // the run was recorded as the agent's
    const runs = await page.evaluate(async (t) => (await fetch('/api/workflow/runs', { headers: { authorization: `Bearer ${t}` } })).json(), token);
    expect(runs.runs.filter((r: { by: string }) => r.by === 'agent').length).toBe(1);
    await page.context().close();
  }, 240_000);

  it('Plan: proposed and nothing changes; Discard; then Apply edits sets the parameter and runs nothing', async () => {
    const page = await open(1440, 900);
    await page.waitForSelector(op, { timeout: 30_000 });
    await page.click('[data-agent-toggle]').catch(() => undefined);
    await page.waitForSelector('[data-agent-goal]', { state: 'visible' });
    const runsBefore = (await page.evaluate(async (t) => (await fetch('/api/workflow/runs', { headers: { authorization: `Bearer ${t}` } })).json(), token)).runs.length;
    const spin = (req: Record<string, any>) => { const n = handle(req, /operation node stream-studio\.animate-image/); return answer({ say: 'Spin instead.', cites: [n], done: false, steps: [{ do: 'set', node: n, param: 'motion', value: 'spin' }] }); };
    scripts.push(spin, spin);
    await page.fill('[data-agent-goal]', 'Make it spin');
    await page.click('label:has([data-agent-mode="plan"])');
    await page.click('[data-agent-go]');
    await page.waitForSelector('[data-agent-apply]', { timeout: 20_000 });
    expect(await page.locator(`${op} select[data-param="motion"]`).inputValue()).toBe('pulse');
    expect(await page.locator('[data-agent-step]').innerText()).toMatch(/Set Motion of shape:[\w-]+ to spin/);
    await shot(page, 'agent-3-proposed');
    await page.click('[data-agent-discard]');
    await expect.poll(() => page.locator('[data-agent-words]').innerText()).toMatch(/Discarded: nothing was applied/);
    expect(await page.locator(`${op} select[data-param="motion"]`).inputValue()).toBe('pulse');
    await page.click('[data-agent-go]');
    await page.click('[data-agent-apply]', { timeout: 20_000 });
    await expect.poll(() => page.locator(`${op} select[data-param="motion"]`).inputValue(), { timeout: 10_000 }).toBe('spin');
    await expect.poll(() => page.locator('[data-agent-phase]').getAttribute('data-agent-phase')).toBe('done');
    const runsAfter = (await page.evaluate(async (t) => (await fetch('/api/workflow/runs', { headers: { authorization: `Bearer ${t}` } })).json(), token)).runs.length;
    expect(runsAfter).toBe(runsBefore);
    await page.context().close();
  }, 240_000);

  it('Stop while the model is asked applies nothing; Stop while the agent’s run goes has the app cancel it', async () => {
    const page = await open(1440, 900);
    await page.waitForSelector(op, { timeout: 30_000 });
    await page.click('[data-agent-toggle]').catch(() => undefined);
    await page.waitForSelector('[data-agent-goal]', { state: 'visible' });
    const ops = await page.locator(op).count();
    scripts.push(() => ({ hang: true }));
    await page.fill('[data-agent-goal]', 'Animate it again');
    await page.click('label:has([data-agent-mode="run"])');
    await page.click('[data-agent-go]');
    await page.waitForSelector('[data-agent-stop]');
    await page.click('[data-agent-stop]');
    await expect.poll(() => page.locator('[data-agent-phase]').getAttribute('data-agent-phase')).toBe('stopped');
    await page.waitForTimeout(500);
    expect(await page.locator(op).count()).toBe(ops);
    // the agent's run, stopped while it goes
    scripts.push((req) => { const n = handle(req, /operation node stream-studio\.animate-image/); return answer({ say: 'Run it again.', cites: [n], done: false, steps: [{ do: 'run', node: n }] }); });
    await page.click('[data-agent-go]');
    await expect.poll(() => page.locator('[data-agent-phase]').getAttribute('data-agent-phase'), { timeout: 20_000 }).toBe('waiting');
    await page.click('[data-agent-stop]');
    await expect.poll(() => page.locator(op).getAttribute('data-op-state'), { timeout: 20_000 }).toBe('cancelled');
    expect(await page.locator('[data-agent-words]').innerText()).toMatch(/asked to cancel/);
    await shot(page, 'agent-4-stopped');
    const plans = await page.evaluate(async (t) => (await fetch('/api/canvas-agent/plans?board=desk', { headers: { authorization: `Bearer ${t}` } })).json(), token);
    expect(plans.plans.filter((p: { state: string }) => p.state === 'stopped').length).toBeGreaterThanOrEqual(2);
    await page.context().close();
  }, 240_000);
});
