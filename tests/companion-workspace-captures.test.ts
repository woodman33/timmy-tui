/**
 * R5 (H132): captures of the companion's page as the workspace's browser view, for the review against references 01, 02,
 * 10, 11, 12 and 13: Home, Chat, Workflows and Logs at 1376 x 768 and 390 x 844 (and Home at 390 the whole page long),
 * taken from the real served page: the real companion server on 127.0.0.1, its token, the real frame producer
 * (src/ops/workspace-frame.ts), in a real headless Chromium. Made only when TIMMY_COMPANION_CAPTURES names the folder to
 * write them in; skipped otherwise, saying so:
 *
 *   TIMMY_COMPANION_CAPTURES=docs/ui-cockpit/captures/r5/companion npx vitest run tests/companion-workspace-captures.test.ts
 *
 * FAKE, labelled (each file is named …-FAKE-fixtures.png, the project is FAKE-project, each record says FAKE): the jobs
 * (records given to the producer; no process ran), the connection observations (no service was asked), the frame's clock,
 * one run's detail (a FAKE producer), the project's event bus lines and one REPL turn on it (no REPL ran, no model was
 * asked). No network but 127.0.0.1. The page's words are checked for this computer's home folder and its name first.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunDetail } from '../src/contracts/run-detail.js';
import type { JobRecord, JobStep } from '../src/jobs/index.js';
import { CONNECTIONS_SCHEMA, buildWorkspaceFrame, writeConnections } from '../src/ops/workspace-frame.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { projectId } from '../src/project/index.js';

const OUT = process.env.TIMMY_COMPANION_CAPTURES ? resolve(process.env.TIMMY_COMPANION_CAPTURES) : '';
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!OUT) console.warn('companion-workspace-captures: TIMMY_COMPANION_CAPTURES is not set, so no capture is made here (skipped)');
else if (!browserPath) console.warn('companion-workspace-captures: no Chromium or Chrome found, so no capture is made here (skipped)');

/** FAKE: the frame's clock, held at the second this file was loaded; the jobs and observations are made up as this long before it */
const NOW = Math.floor(Date.now() / 1000) * 1000;
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();

describe.skipIf(!OUT || !browserPath)('captures of the companion\'s workspace page over FAKE records (R5 H132)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let root = '';
  let browser: Browser;
  let companion: CompanionServer;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'timmy-captures-'));
    root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'runs'), { recursive: true });
    mkdirSync(join(box, 'logs'), { recursive: true });
    const env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), OLLAMA_HOST: 'http://127.0.0.1:11434', OPENROUTER_API_KEY: 'FAKE-openrouter-key-captures' };
    process.env.TIMMY_HOME = env.TIMMY_HOME;
    writeConnections({
      schema: CONNECTIONS_SCHEMA,
      checks: {
        openrouter: { answer: 'refused', at: ago(180), detail: 'FAKE: HTTP 401' },
        ollama: { answer: 'accepted', at: ago(12), detail: 'FAKE: 2 models' },
        companion: { answer: 'accepted', at: ago(5), detail: 'FAKE: this page connected' },
        studio: { answer: 'not running', at: ago(300) },
      },
    }, env);
    const job = (o: { id: string; label: string; kind: 'task' | 'workflow'; state: 'completed' | 'failed'; op: string; startedS: number; tookS: number; code: number; steps?: JobStep[] }): JobRecord => {
      const logPath = join(box, 'logs', `${o.id}.log`);
      writeFileSync(logPath, `FAKE: ${o.label}\nFAKE: done\n`);
      return {
        id: o.id, kind: o.kind, label: o.label, project: 'FAKE-project', root, command: 'FAKE', args: [], state: o.state,
        startedAt: ago(o.startedS), endedAt: ago(o.startedS - o.tookS), exitCode: o.code, steps: o.steps ?? [], logPath, lines: 2, operation: o.op,
      };
    };
    const jobs: JobRecord[] = [
      job({ id: 'j1a2b3c', label: 'FAKE: APPROVAL.md › tidy', kind: 'workflow', state: 'completed', op: 'o1a2b3c4d', startedS: 900, tookS: 72, code: 0, steps: [
        { name: 'predict', state: 'completed', code: 0 }, { name: 'inspect', state: 'completed', code: 0 }, { name: 'result', state: 'completed', code: 0 },
      ] }),
      job({ id: 'j4d5e6f', label: 'FAKE: npm test', kind: 'task', state: 'failed', op: 'o5e6f7a8b', startedS: 2400, tookS: 95, code: 1 }),
      job({ id: 'j7a8b9c', label: 'FAKE: RENDER.md › preview', kind: 'workflow', state: 'completed', op: 'o9c8d7e6f', startedS: 5400, tookS: 40, code: 0, steps: [{ name: 'render', state: 'completed', code: 0 }] }),
    ];
    process.env.TIMMY_REPO = root;
    try {
      companion = await startCompanionServer(0, {
        workspace: { env, frame: (o) => buildWorkspaceFrame({ ...o, now: NOW, jobs: () => jobs, chain: () => [] }), shareMs: 0 },
        runDetail: (op) => fakeDetail(op, root),
      });
    } finally { if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO; }
    // FAKE: the project's event bus as the companion tails it: two job lines, then one REPL turn sealed after the companion
    // started (the mirror shows this session's turns only)
    const bus = join(root, '.timmy', 'runs', 'timmy-events.jsonl');
    for (const e of [
      { v: 1, ts: ago(828), kind: 'job.completed', payload: { note: 'FAKE', job: 'j1a2b3c', operation: 'o1a2b3c4d' } },
      { v: 1, ts: ago(2305), kind: 'job.failed', payload: { note: 'FAKE', job: 'j4d5e6f', operation: 'o5e6f7a8b' } },
      { v: 1, ts: new Date().toISOString(), kind: 'receipt.sealed', payload: { stream: 'runs', id: 'FAKE-turn-receipt', hash: `sha256_${randomBytes(32).toString('hex')}`, kind: 'turn', subject: 'repl · 2 steps', epoch: 1 } },
    ]) appendFileSync(bus, `${JSON.stringify(e)}\n`);
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    mkdirSync(OUT, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('Home, Chat, Workflows and Logs at 1376 x 768 and 390 x 844, from the served page; no home folder or computer name in its words', async () => {
    const made: string[] = [];
    const origin = `http://127.0.0.1:${companion.port}`;
    for (const [width, height] of [[1376, 768], [390, 844]] as const) {
      // one clock for every time on the page: UTC, 24 hours
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, timezoneId: 'UTC', locale: 'en-GB' });
      await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient')));
      const page = await context.newPage();
      try {
        await page.goto(companion.url);
        await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
        await page.waitForSelector('#home-connections .conn-card', { timeout: 15_000 });
        await page.waitForFunction(() => /Event bus: \d+ recent event/.test(document.getElementById('logs-list')?.textContent ?? ''), null, { timeout: 15_000 });
        for (const [tab, key] of [['home', '1'], ['chat', '2'], ['workflows', '3'], ['logs', '0']] as const) {
          // by its key, as a person would: no pointer resting on anything
          await page.keyboard.press(key);
          await page.waitForFunction((t) => !(document.getElementById(`ws-${t}`) as HTMLElement).hidden, tab);
          if (tab === 'chat') await page.waitForSelector('#console-logs [data-mirror="repl-turn"]', { timeout: 15_000 });
          if (tab === 'workflows') await page.waitForSelector('#run-detail .run-view', { timeout: 15_000 });
          await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
          const words = await page.evaluate(() => document.body.innerText);
          expect(words, tab).not.toContain(homedir());
          if (hostname().length >= 4) expect(words, tab).not.toContain(hostname());
          const file = join(OUT, `${tab}-${width}x${height}-FAKE-fixtures.png`);
          await page.screenshot({ path: file });
          made.push(file);
          if (tab === 'home' && width === 390) {
            const whole = join(OUT, `home-${width}x${height}-full-FAKE-fixtures.png`);
            await page.screenshot({ path: whole, fullPage: true });
            made.push(whole);
          }
        }
      } finally { await context.close(); }
    }
    console.log(`captures:\n${made.map((f) => `  ${basename(f)}`).join('\n')}`);
    expect(made).toHaveLength(9);
  });
});

/** FAKE: one run's detail as the run-detail producer gives it (src/contracts/run-detail.ts) */
function fakeDetail(operation: string, root: string): RunDetail {
  return {
    version: 1, operation, parent: null, children: [],
    project: { name: basename(root), root, id: projectId(root) },
    objective: { value: 'FAKE: tidy the tray inbox (APPROVAL.md › tidy)', from: `.timmy/operations/${operation}.json` },
    sourceRevision: { value: 'FAKE-rev-0001', from: `.timmy/operations/${operation}.json` },
    verdict: { state: 'completed', words: 'FAKE: the three blocks ran and exited 0; the result is current', from: 'receipt FAKE-rc-1' },
    stage: { current: 'result', done: 3, total: 3, from: '.timmy/jobs/j1a2b3c.json' },
    exits: [{ who: 'runner', code: 0, from: '.timmy/jobs/j1a2b3c.json' }],
    freshness: { state: 'current', why: 'FAKE: its inputs are as they were when it ran', from: `.timmy/operations/${operation}.json` },
    acceptance: { state: 'not reviewed' },
    worker: { model: { value: 'FAKE-model (no model was asked)', from: 'receipt FAKE-rc-1' } },
    time: { startedAt: ago(900), endedAt: ago(828), elapsedMs: 72_000 },
    prediction: { words: 'FAKE: predict, then inspect, then result, each exits 0', receipt: 'FAKE-rc-0', frozenAt: ago(902) },
    checks: [
      { name: 'inspect', predicted: 'exits 0', actual: 'exited 0', differs: false, from: '.timmy/jobs/j1a2b3c.log' },
      { name: 'result', predicted: 'exits 0', actual: 'exited 0', differs: false, from: '.timmy/jobs/j1a2b3c.log' },
    ],
    files: [
      { path: 'inbox/FAKE-note.txt', role: 'input', sha256: 'ab'.repeat(32), from: `.timmy/operations/${operation}.json` },
      { path: '.timmy/jobs/j1a2b3c.log', role: 'log', from: '.timmy/jobs/j1a2b3c.json' },
    ],
    receipts: [{ id: 'FAKE-rc-0', kind: 'predict', subject: 'workflow · predict' }, { id: 'FAKE-rc-1', kind: 'workflow' }],
    cost: { usd: null, measured: false, why: 'FAKE: no model was asked in this run' },
    summary: { path: null },
    next: { words: 'FAKE: review the result, then accept it', command: `/op ${operation}` },
    unknown: [{ field: 'acceptance', why: 'FAKE: no person has reviewed this result' }],
  };
}
