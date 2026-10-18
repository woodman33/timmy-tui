/**
 * R6 (H140; the R5 interaction review, defect 2: on a Linux machine whose Ollama answered, after a chat turn was stopped the
 * page said Ollama "needs setup · brew install ollama" and one thing "waiting on you"): with Ollama answering at the address
 * the chat setup names, and a stopped chat turn sealed, nothing says "needs setup", nothing waits on you, and the turn is said
 * "stopped" with who asked; a job a cancel ended is said "cancelled" beside it. Every surface here is a real one in a process
 * of its own: `timmy tools ollama`, `timmy workspace check` and `timmy receipts` (the dev CLI), and the companion page in a
 * headless Chromium served by a browser companion (tests/fixtures/h140-companion-child.mts).
 *
 * FAKE, labelled: Ollama (tests/fixtures/fake-ollama-chat.ts: a real HTTP server on 127.0.0.1 with no model behind it; its one
 * model is named fake-ollama:8b), the project folder (FAKE-ollama-project), and the two receipts: a Workbench chat turn
 * stopped from the companion (FIXTURE facts, sealed by the real sealer, no model asked) and a workflow job's receipt sealed
 * cancelled (no job ran). No `ollama` program is on the PATH the processes get (/usr/bin:/bin). No key is set, so nothing is
 * asked of OpenRouter. With TIMMY_CAPTURE_DIR set, the CLI's words and the page are saved there (no address or token, and
 * the test's folders are said as <test folder>).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closedPort, startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { sealTurn } from '../src/repl/seal.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { projectId } from '../src/project/index.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-ollama-browser: no Chromium or Chrome found, so the real-browser check is skipped here');

const LOADER = createRequire(import.meta.url).resolve('tsx');
const REPO = join(import.meta.dirname, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const CHILD = join(import.meta.dirname, 'fixtures', 'h140-companion-child.mts');
const MODEL = 'fake-ollama:8b';
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
});

/** One run of the dev CLI in a process of its own (async: the FAKE Ollama answers from this process while it runs). */
function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--import', LOADER, CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new Error(`timmy ${args.join(' ')} did not end in 90 s: ${err.slice(-400)}`)); }, 90_000);
    c.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    c.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    c.once('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

describe.skipIf(!browserPath)('Ollama answering through a FAKE after a stopped chat turn: no "needs setup", nothing waiting, the stop in words (real CLI, a real companion, a real browser)', () => {
  let box = '';
  let browser: Browser;
  let ollama: FakeOllama | undefined;
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'h140-ollama-browser-'));
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 120_000);
  afterAll(async () => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* ended */ } }
    await browser?.close();
    await ollama?.close();
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('`timmy tools ollama` says reachable at the chat setup\'s address; `timmy workspace check` 0 waiting on you, Ollama live, the turn "stopped (asked from the companion)"; `timmy receipts` the turn stopped, the job cancelled; the page the same', async () => {
    ollama = await startFakeOllama({ models: [{ name: MODEL, capabilities: ['completion', 'tools'] }] });
    const project = join(box, 'FAKE-ollama-project');
    mkdirSync(join(project, '.timmy', 'receipts'), { recursive: true });
    const home = process.env.TIMMY_HOME!;
    mkdirSync(home, { recursive: true });
    // a home a setup wrote (as applySetup writes it): chat on the local model, at the FAKE Ollama's address; no OLLAMA_HOST
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama.url, project: 'FAKE-ollama-project', chat: 'local', model: MODEL } }));
    // FIXTURE facts of a Workbench chat turn stopped from the companion (no model asked), sealed as every surface seals one
    const turn = sealTurn({
      prompt: 'FIXTURE prompt words, never shown', answer: '', steps: 0, spend: 0, costMeasured: false, ms: 900, status: 'cancelled', cancelledAt: 'before-tools',
      stoppedBy: 'companion', surface: 'workbench', model: MODEL, project: 'FAKE-ollama-project', projectId: projectId(project),
    }, project);
    expect(turn.verified).toBe(true);
    // FAKE: a workflow job's receipt sealed cancelled (no job ran): the job's word beside the turn's
    appendReceipt('runs', { kind: 'workflow', subject: 'workflow · FAKE.md › wait · cancelled', status: 'cancelled', policy: 'human-gated', project: 'FAKE-ollama-project', project_id: projectId(project) }, project);

    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      HOME: box, PATH: '/usr/bin:/bin', TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR ?? join(box, 'settings'),
      TIMMY_REPO: project, TIMMY_COMPANION_PORT: String(port), TIMMY_STUDIO_URL: `http://127.0.0.1:${await closedPort()}`,
    };
    const scrub = (t: string): string => t.split(box).join('<test folder>').split(ollama!.url).join('http://127.0.0.1:<FAKE Ollama port>');
    const save = (name: string, text: string): void => { if (process.env.TIMMY_CAPTURE_DIR) writeFileSync(join(process.env.TIMMY_CAPTURE_DIR, name), scrub(text)); };

    // the companion, in a process of its own, at the address the frame names
    const child = spawn(process.execPath, ['--import', LOADER, CHILD], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const hello = await new Promise<{ port: number; url: string; pid: number }>((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => reject(new Error(`the companion child said nothing in 30 s: ${err.slice(-400)}`)), 30_000);
      child.stderr!.setEncoding('utf8').on('data', (d: string) => { err += d; });
      child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d; const i = out.indexOf('\n'); if (i >= 0) { clearTimeout(timer); resolve(JSON.parse(out.slice(0, i))); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the companion child ended (${code}): ${err.slice(-400)}`)); });
    });
    expect(hello.port).toBe(port);

    // 1. /tools: Ollama's rung follows its HTTP route (the address the chat setup names), not a program on the PATH
    const toolsJson = await cli(['tools', 'ollama', '--json'], project, env);
    expect(toolsJson.code, toolsJson.err).toBe(0);
    const row = (JSON.parse(toolsJson.out) as { rows: Array<{ id: string; rung: string; detail: string; setup?: string | null }> }).rows[0];
    expect(row).toMatchObject({ id: 'ollama', rung: 'reachable' });
    expect(JSON.stringify(row)).not.toMatch(/needs setup|brew/);
    const tools = await cli(['tools', 'ollama'], project, env);
    expect(tools.code, tools.err).toBe(0);
    expect(tools.out).not.toMatch(/needs setup|brew/);
    save('tools-ollama-fake.txt', `$ timmy tools ollama   (FAKE Ollama at the chat setup's address; no ollama program on PATH)\n${tools.out}`);

    // 2. timmy workspace check: asks Ollama (the FAKE) and the companion, then prints the frame in words
    const check = await cli(['workspace', 'check'], project, env);
    expect(check.code, check.err).toBe(0);
    const lines = check.out.split('\n');
    expect(lines.find((l) => l.startsWith('Activity '))).toMatch(/^Activity 0 running · 0 waiting on you · /);
    expect(lines.find((l) => l.trim().startsWith('Ollama (local models)'))).toMatch(/● live\s+answered just now \(1 local model[^;]*\); live: an answer within the last 30 min$/);
    expect(check.out).not.toMatch(/needs setup|brew|Start Ollama/);
    expect(check.out).toContain('Chat turns (1 sealed; every surface\'s, read from their receipts)');
    expect(check.out).toMatch(new RegExp(`\\n  ■ \\S+  turn stopped \\(asked from the companion\\) in the Workbench · ${MODEL} · receipt ${turn.id} · 0\\.9 s\\n`));
    save('workspace-check-turns.txt', `$ timmy workspace check\n${check.out}`);

    // 3. timmy receipts: the turn's sealed "cancelled" is said stopped, with who asked; the job's cancelled as sealed
    const receipts = await cli(['receipts'], project, env);
    expect(receipts.code, receipts.err).toBe(0);
    expect(receipts.out).toContain(`chat.turn · workbench · stopped (asked from the companion) · 0 steps · ${MODEL}`);
    expect(receipts.out).toContain('workflow · FAKE.md › wait · cancelled');
    save('receipts-stop-words.txt', `$ timmy receipts\n${receipts.out}`);

    // 4. the page: Ollama's card live, 0 waiting on you, no "needs setup" or brew anywhere on it; the Control Room's turn stopped
    const context = await browser.newContext({ viewport: { width: 1376, height: 900 } });
    const errors: string[] = [];
    try {
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(hello.url);
      const ol = '#home-connections [data-connection="ollama"]';
      await page.waitForFunction((sel) => document.querySelector(`${sel} .conn-state`)?.textContent === '● live', ol, { timeout: 30_000 });
      expect(await page.getAttribute(`${ol} .conn-state`, 'class')).toContain('is-live');
      expect(await page.textContent(`${ol} .conn-words`)).toMatch(/^answered (just now|\d+ s ago) \(1 local model[^;]*\); live: an answer within the last 30 min$/);
      await page.waitForFunction(() => document.getElementById('ws-activity-counts')?.textContent === '0 running · 0 waiting on you', undefined, { timeout: 10_000 });
      expect(await page.locator('#ws-tabs .tab-waiting:not([hidden])').count()).toBe(0);
      const body = await page.evaluate(() => document.body.innerText);
      expect(body).not.toMatch(/needs setup|brew install/i);
      if (process.env.TIMMY_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TIMMY_CAPTURE_DIR, 'companion-ollama-fake-after-stop-home.png'), fullPage: false });
      await page.click('#ws-tab-control');
      const list = '#control-now [data-control="chat-turn-list"]';
      await page.waitForSelector(list, { timeout: 10_000 });
      expect(await page.textContent(list)).toContain(`turn stopped (asked from the companion) in the Workbench · ${MODEL} · receipt ${turn.id}`);
      expect(await page.textContent('#control-now .activity-words')).toBe('0 running · 0 waiting on you');
      if (process.env.TIMMY_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TIMMY_CAPTURE_DIR, 'companion-ollama-fake-after-stop-control.png'), fullPage: false });
      expect(errors).toEqual([]);
    } finally { await context.close(); }
    // nothing was asked of the FAKE but its list and its model check: no chat request was ever sent
    expect(ollama.requests.every((r) => r.path === '/api/tags' || r.path === '/api/show')).toBe(true);
  }, 240_000);
});
