/**
 * Round R4 (helper H25): Codex with a local model, `codex exec --oss`, a second free code-agent route beside Qwen
 * Code: `/agent codex --local <task>` and `/iterate tray "<instruction>" --agent codex`. Real files, real child
 * processes and real job lifecycles; the FAKE pieces, each labelled:
 * - tests/fixtures/fake-codex.mjs, a TEST DOUBLE of codex-cli (no model, nothing sent): it checks the command line it
 *   is given, edits a file, prints JSONL events shaped as Timmy's parser assumes, and reports what it was given;
 * - a FAKE Ollama: an HTTP server on 127.0.0.1 answering GET /api/tags with a model list, and nothing else;
 * - for /iterate, the fakes tests/iterate.test.ts uses: the SYNTHETIC recipe executor
 *   (tests/fixtures/fake-recipe-executor.ts) and tests/fixtures/fake-step-readback.mjs.
 * The command line is checked against the recorded `codex exec --help` of codex-cli 0.153.2
 * (tests/fixtures/agent-help/codex-exec-help.txt; round R4, H37: byte for byte the text recorded in R3 as codex-cli
 * 0.140.0's). No test runs the real Codex, a real Ollama or a model. Round R4 (H37): the event sequence one real
 * codex-cli 0.153.2 run printed (reported from the operator's Mac) is replayed by the FAKE codex (its OBSERVED word) and
 * fed to the parser directly; the sandbox's -c keys are checked as given, not as a real Codex applies them.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilities, type ProbeDeps } from '../src/capabilities/index.js';
import { capabilityLines } from '../src/capabilities/render.js';
import {
  agentExercisedIndex, AGENTS_DIR, judgeAgentRun, listAgentRuns, newProgress, parseAgentLine, planAgent, progressLine, type AgentRunRecord,
} from '../src/code-agents/index.js';
import {
  CODEX_CLI_CHECKED, CODEX_EVENTS, CODEX_EVENTS_ASSUMED, CODEX_EVENTS_OBSERVED, CODEX_ITEMS_ASSUMED, CODEX_ITEMS_OBSERVED, CODEX_LOCAL_COMMANDS_NOTE,
  CODEX_LOCAL_SANDBOX_OVERRIDES, CODEX_OBSERVED_WITH, codexLocalPreflight, ollamaRoot,
} from '../src/code-agents/codex-local.js';
import { JobManager } from '../src/jobs/index.js';
import { folderProject } from '../src/project/index.js';
import { parseIterateLine } from '../src/repl/iterate.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { FlowRecord } from '../src/flows/iterate.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { writeFakeRecipeExecutor } from './fixtures/fake-recipe-executor.js';

const FAKE_CODEX = resolve('tests/fixtures/fake-codex.mjs');
const FAKE_READBACK = resolve('tests/fixtures/fake-step-readback.mjs');
const HELP = readFileSync(resolve('tests/fixtures/agent-help/codex-exec-help.txt'), 'utf8');
const PARAMS = 'recipes/tray.params.json';

const dirs: string[] = [];
const spaces: Workspace[] = [];
const servers: Server[] = [];
let supervisors: Promise<void>[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  await Promise.race([Promise.all(supervisors), new Promise((r) => setTimeout(r, 25000))]);
  supervisors = [];
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 60000);

/** A FAKE Ollama on 127.0.0.1: GET /api/tags lists `models`; anything else is 404. Each request is recorded. */
async function fakeOllama(models: string[], o: { status?: number } = {}): Promise<{ server: Server; url: string; host: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/tags' && !o.status) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name, size: 1 })) }));
      return;
    }
    res.writeHead(o.status ?? 404, { 'content-type': 'text/plain' });
    res.end('not here (a FAKE Ollama)');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return { server, url: `http://127.0.0.1:${port}/v1`, host: `127.0.0.1:${port}`, requests };
}

function project(): string {
  const root = temp('codex-proj-');
  put(root, 'src/a.txt', 'first line\n');
  return root;
}

function make(root: string, env: Record<string, string>) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const fixtures = temp('codex-fixtures-');
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env,
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('codex-jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, ts: new Date(Date.now() + i).toISOString(), hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    // FAKE (for /iterate): the jobs.ts executor seam with a SYNTHETIC executor, and the readback test double.
    recipeTest: {
      executor: writeFakeRecipeExecutor(fixtures, 'complete'),
      pollMs: 100,
      onSupervisor: (child: ChildProcess) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); },
    },
    iterateTest: { readback: (step) => ({ command: process.execPath, args: [FAKE_READBACK, 'match', step.abs, '--as', step.rel] }), settleMs: 15000 },
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

/** The local route's settings, with the FAKE codex and a FAKE Ollama's address. */
const localEnv = (url: string, extra: Record<string, string> = {}): Record<string, string> => ({ TIMMY_AGENT_CODEX_BIN: FAKE_CODEX, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_AGENT_BASE_URL: url, ...extra });
const jobIdOf = (out: string): string => { const m = out.match(/\b(j[0-9a-f]{6})\b/); if (!m) throw new Error(`no job id in: ${out}`); return m[1]; };
const resultOf = (root: string): AgentRunRecord => listAgentRuns(root)[0];
const reportOf = (root: string, run: string): { argv: string[]; config: string[]; cwd: string; stdin: { open: boolean; bytes: number; tty?: boolean }; env: Record<string, string | null> } => JSON.parse(readFileSync(join(root, AGENTS_DIR, run, 'fake-codex-report.json'), 'utf8'));
const runTask = async (ws: Workspace, line: string): Promise<{ out: string; job: Awaited<ReturnType<Workspace['jobs']['done']>> }> => {
  const out = text(await ws.agent(line));
  return { out, job: await ws.jobs.done(jobIdOf(out)) };
};
/** R4 (H37): the sandbox overrides, each after -c (the keys ASSUMED from Codex's config documentation). */
const OVERRIDES = ['-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.network_access=false'];
/** The command line the local route plans for `task` in `root` (its run id from the result). */
const localArgs = (root: string, run: string, task: string, model = 'qwen3:4b'): string[] => [
  'exec', '--oss', '--local-provider', 'ollama', '-m', model, '--json', '--skip-git-repo-check', '-s', 'workspace-write', ...OVERRIDES, '-C', root,
  '--ignore-user-config', '--ignore-rules', '--ephemeral', '-o', `${AGENTS_DIR}/${run}/codex-last-message.txt`, task,
];
/** The note a local run is started with (the plan's note, on /agent's start). */
const NOTE_SHARED = 'codex exec --oss on this machine\'s Ollama; your codex folder (~/.codex or CODEX_HOME) is used, not its config.toml or rules files; TIMMY_AGENT_HOME gives it its own. Codex may run commands inside its sandbox (workspace-write, asked to write only in the project, not in the temporary folders, and to keep the network off); Timmy checks changes inside the project only';
const NOTE_OWN_HOME = 'codex exec --oss on this machine\'s Ollama; its own HOME and CODEX_HOME (TIMMY_AGENT_HOME): your codex settings and sign-in are not used. Codex may run commands inside its sandbox (workspace-write, asked to write only in the project, not in the temporary folders, and to keep the network off); Timmy checks changes inside the project only';

/** Every option a command line uses is one its --help text lists (as tests/code-agent.test.ts checks). */
function flagsIn(args: string[], help: string): string[] {
  const missing: string[] = [];
  for (const a of args) {
    if (!a.startsWith('-')) continue;
    const flag = a.split('=')[0];
    const re = new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}(?=[\\s,=<\\[]|$)`, 'm');
    if (!re.test(help)) missing.push(flag);
  }
  return missing;
}

// ── the plan ─────────────────────────────────────────────────────────────────────

describe('the plan: codex exec --oss on this machine\'s Ollama', () => {
  it('the exact command line, every flag in the recorded codex exec help, no bypass flag', () => {
    const root = temp('codex-plan-');
    const r = planAgent('codex', 'add a test', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b' }, paid: false, local: true, run: 'a00000001', bin: 'codex', root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.args).toEqual(localArgs(root, 'a00000001', 'add a test'));
    expect(r.plan).toMatchObject({
      agent: 'codex', command: 'codex', model: 'qwen3:4b', endpoint: 'local', where: '127.0.0.1:11434', charge: 'local endpoint, no charge', costBasis: 'local endpoint',
      lastMessageFile: `${AGENTS_DIR}/a00000001/codex-last-message.txt`, oss: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b' },
      wallTime: '15m', timeoutMs: 15 * 60_000 + 30_000,
      // its help: "If stdin is piped and a prompt is also provided, stdin is appended": the job's stdin is ended at once
      stdin: 'closed',
    });
    expect(HELP).toContain('If stdin is piped and a prompt is also provided, stdin');
    // keys are blanked in the child's environment; the Ollama address is the one the rule judged
    expect(r.plan.env).toEqual({ CODEX_OSS_BASE_URL: 'http://127.0.0.1:11434/v1', CODEX_OSS_PORT: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', OPENROUTER_API_KEY: '', TIMMY_AGENT_API_KEY: '' });
    expect(r.plan.makeDirs).toBeUndefined();
    expect(r.plan.note).toBe(NOTE_SHARED);
    expect(r.plan.note).toContain(CODEX_LOCAL_COMMANDS_NOTE);
    expect(flagsIn(r.plan.args, HELP)).toEqual([]);
    expect(HELP).toMatch(/--local-provider <OSS_PROVIDER>\s+Specify which local provider to use \(lmstudio or ollama\)/);
    expect(HELP).toMatch(/possible values: read-only, workspace-write, danger-full-access/);
    expect(r.plan.args.join(' ')).not.toMatch(/dangerously|danger-full-access|--full-auto|--yolo|bypass|--add-dir/);
    // R4 (H37): the flags rechecked against codex-cli 0.153.2's help: -c and --ignore-rules are in it; the -c keys are not
    // (they are ASSUMED from Codex's config documentation, to be confirmed by a real run)
    expect(CODEX_CLI_CHECKED).toBe('codex-cli 0.153.2');
    expect(HELP).toMatch(/-c, --config <key=value>\s+Override a configuration value that would otherwise be loaded from `~\/\.codex\/config\.toml`/);
    expect(HELP).toMatch(/--ignore-rules\s+Do not load user or project execpolicy `\.rules` files/);
    expect([...CODEX_LOCAL_SANDBOX_OVERRIDES]).toEqual(['sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.network_access=false']);
    for (const kv of CODEX_LOCAL_SANDBOX_OVERRIDES) {
      expect(r.plan.args[r.plan.args.indexOf(kv) - 1]).toBe('-c');
      expect(HELP).not.toContain(kv.split('=')[0]);
    }
    expect(r.plan.args).toContain('--ignore-user-config');
    expect(r.plan.args).toContain('--ignore-rules');
    // a task that begins with "-" is never read as an option
    const dash = planAgent('codex', '--dangerously-bypass-approvals-and-sandbox do it', { env: { TIMMY_AGENT_MODEL: 'm' }, paid: false, local: true, run: 'a00000002', bin: 'codex', root });
    expect(dash.ok && dash.plan.args.at(-1)).toBe('Task: --dangerously-bypass-approvals-and-sandbox do it');
  });

  it('TIMMY_AGENT_HOME: its own HOME and a CODEX_HOME inside it (made before the run), and the plan says so', () => {
    const root = temp('codex-plan-');
    const home = temp('codex-home-');
    const r = planAgent('codex', 'x', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_AGENT_HOME: home }, paid: false, local: true, run: 'a00000003', bin: 'codex', root });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.env).toEqual({ HOME: home, CODEX_HOME: join(home, '.codex'), CODEX_OSS_BASE_URL: 'http://127.0.0.1:11434/v1', CODEX_OSS_PORT: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', OPENROUTER_API_KEY: '', TIMMY_AGENT_API_KEY: '' });
    expect(r.plan.makeDirs).toEqual([join(home, '.codex')]);
    expect(r.plan.note).toBe(NOTE_OWN_HOME);
    // the same command line, rules files ignored there too (its own CODEX_HOME has none, but a project could)
    expect(r.plan.args).toEqual(localArgs(root, 'a00000003', 'x'));
  });

  it('free only on this machine with a model whose tag does not end in cloud; anything else is refused, with no --paid', () => {
    const plan = (env: Record<string, string>) => planAgent('codex', 'x', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b', ...env }, paid: false, local: true, run: 'a00000004', bin: 'codex', root: '/proj' });
    for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://[::1]:11434/v1']) expect(plan({ TIMMY_AGENT_BASE_URL: url }).ok, url).toBe(true);
    for (const model of ['gpt-oss:120b-cloud', 'glm-5.3:cloud', 'qwen3-coder:480b:cloud']) {
      const r = plan({ TIMMY_AGENT_MODEL: model });
      expect(r).toMatchObject({ ok: false, refused: 'paid', error: expect.stringContaining('is a cloud model') });
      expect(r.ok ? '' : r.error).not.toContain('--paid');
    }
    expect(plan({ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' })).toMatchObject({ ok: false, refused: 'paid', error: expect.stringContaining('models.example.com is not this machine') });
    const creds = plan({ TIMMY_AGENT_BASE_URL: 'http://user:pw@127.0.0.1:11434/v1' });
    expect(creds).toMatchObject({ ok: false, refused: 'setup' });
    expect(JSON.stringify(creds)).not.toContain('pw@');
    expect(planAgent('codex', 'x', { env: {}, paid: false, local: true, run: 'a00000005', bin: 'codex', root: '/proj' })).toMatchObject({ ok: false, refused: 'setup', error: expect.stringContaining('Set TIMMY_AGENT_MODEL') });
  });

  it('the paid route is unchanged; --paid and --local count only right after the agent\'s name, and do not mix', () => {
    const paid = planAgent('codex', 'fix it', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b' }, paid: true, run: 'a00000006', bin: 'codex', root: '/proj' });
    if (!paid.ok) throw new Error(paid.error);
    expect(paid.plan.args).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '-o', `${AGENTS_DIR}/a00000006/codex-last-message.txt`, 'fix it']);
    expect(paid.plan).toMatchObject({ endpoint: 'remote', where: 'your OpenAI account', costBasis: 'unknown', charge: 'your Codex account: costs money (--paid)', model: null });
    // the one change to the paid route: its job's stdin is ended at its start too (the same codex exec, the same help text)
    expect(paid.plan.stdin).toBe('closed');
    expect(paid.plan.oss).toBeUndefined();
    expect(paid.plan.env).toBeUndefined();
    expect(planAgent('codex', 'fix it', { env: {}, paid: false, run: 'a00000007', bin: 'codex' })).toEqual({ ok: false, refused: 'paid', error: 'Codex runs on your own account and costs money. Nothing was started. To run it anyway: /agent codex --paid <task>' });
    expect(parseAgentLine('codex --local fix the bug')).toEqual({ name: 'codex', word: 'codex', paid: false, local: true, task: 'fix the bug' });
    expect(parseAgentLine('codex --paid fix the bug')).toEqual({ name: 'codex', word: 'codex', paid: true, task: 'fix the bug' });
    expect(parseAgentLine('codex explain what --local and --paid mean')).toEqual({ name: 'codex', word: 'codex', paid: false, task: 'explain what --local and --paid mean' });
    expect(parseAgentLine('codex --local --local fix')).toEqual({ name: 'codex', word: 'codex', paid: false, local: true, task: '--local fix' });
    expect(parseAgentLine('codex --paid --local fix')).toEqual({ name: 'codex', word: 'codex', paid: true, local: true, task: 'fix' });
    expect(parseAgentLine('claude explain what the --paid flag of our CLI does')).toEqual({ name: 'claude', word: 'claude', paid: false, task: 'explain what the --paid flag of our CLI does' });
    const both = planAgent('codex', 'fix', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b' }, paid: true, local: true, run: 'a00000008', bin: 'codex', root: '/proj' });
    expect(both).toMatchObject({ ok: false, refused: 'usage', error: expect.stringContaining('takes no --paid') });
    expect(planAgent('qwen', 'fix', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b' }, paid: false, local: true, run: 'a00000009', bin: 'qwen', root: '/proj' })).toMatchObject({ ok: false, refused: 'usage', error: expect.stringContaining('Qwen Code has no --local') });
    expect(planAgent('claude', 'fix', { env: {}, paid: false, local: true, run: 'a0000000a', bin: 'claude', root: '/proj' })).toMatchObject({ ok: false, refused: 'usage', error: expect.stringContaining('Claude Code has no local route') });
  });

  it('/agent: codex without --local is the paid route, refused without --paid; --local with --paid is refused; nothing starts', async () => {
    const root = project();
    // (the FAKE agent of tests/code-agent.test.ts stands in for qwen; nothing runs it here)
    const { ws, sealed } = make(root, { TIMMY_AGENT_CODEX_BIN: FAKE_CODEX, TIMMY_AGENT_QWEN_BIN: resolve('tests/fixtures/fake-code-agent.mjs'), TIMMY_AGENT_MODEL: 'qwen3:4b' });
    expect(text(await ws.agent('codex fix the bug'))).toMatch(/Codex runs on your own account and costs money\. Nothing was started\. To run it anyway: \/agent codex --paid <task>/);
    expect(text(await ws.agent('codex --local --paid fix the bug'))).toContain('takes no --paid');
    expect(text(await ws.agent('qwen --local fix the bug'))).toContain('Qwen Code has no --local');
    expect(ws.jobs.list()).toEqual([]);
    expect(sealed).toEqual([]);
    expect(existsSync(join(root, AGENTS_DIR))).toBe(false);
    // /agent's list names the local route and what it needs
    const list = text(await ws.agent(''));
    expect(list).toContain('--local: model qwen3:4b on this machine\'s Ollama (127.0.0.1:11434), no charge');
    const bare = make(root, { TIMMY_AGENT_CODEX_BIN: FAKE_CODEX });
    expect(text(await bare.ws.agent(''))).toContain('--local: needs TIMMY_AGENT_MODEL (a model from ollama list)');
  });
});

// ── before the run ───────────────────────────────────────────────────────────────

describe('before the run: the model must already be in the local Ollama (codex --oss downloads a missing one)', () => {
  it('Ollama\'s own API root from its OpenAI-compatible address', () => {
    expect(ollamaRoot('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(ollamaRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434');
    expect(ollamaRoot('http://[::1]:11434/v1')).toBe('http://[::1]:11434');
    expect(ollamaRoot('http://127.0.0.1:8080/ollama/v1')).toBe('http://127.0.0.1:8080/ollama');
  });

  it('a model listed by its exact name passes; anything else is refused, with nothing started and nothing written', async () => {
    const ollama = await fakeOllama(['qwen3:latest', 'qwen3:4b-q8', 'llama3.2:3b']);
    expect(await codexLocalPreflight({ provider: 'ollama', baseUrl: ollama.url, model: 'llama3.2:3b' })).toEqual({ ok: true, models: ['qwen3:latest', 'qwen3:4b-q8', 'llama3.2:3b'] });
    expect(ollama.requests).toEqual(['GET /api/tags']);
    const root = project();
    const { ws, sealed } = make(root, localEnv(ollama.url, { TIMMY_AGENT_MODEL: 'qwen3' }));
    const out = text(await ws.agent('codex --local fix it'));
    expect(out).toContain(`The Ollama at ${ollama.host} does not list qwen3 (it lists qwen3:latest, qwen3:4b-q8)`);
    expect(out).toContain('codex --oss downloads a model it does not find, so Timmy starts it only with a model already there');
    expect(out).toContain('Nothing was started.');
    expect(ws.jobs.list()).toEqual([]);
    expect(sealed).toEqual([]);
    expect(existsSync(join(root, AGENTS_DIR))).toBe(false);
    // something on that address that is not an Ollama
    const other = await fakeOllama([], { status: 404 });
    const notOllama = make(root, localEnv(other.url));
    expect(text(await notOllama.ws.agent('codex --local fix it'))).toContain(`${other.host} did not answer as an Ollama (GET /api/tags: HTTP 404)`);
    // nothing listening there
    await new Promise((r) => other.server.close(() => r(undefined)));
    const gone = make(root, localEnv(other.url));
    expect(text(await gone.ws.agent('codex --local fix it'))).toContain(`The Ollama at ${other.host} did not answer: start it (ollama serve, or brew services start ollama)`);
    expect(gone.ws.jobs.list()).toEqual([]);
    expect(existsSync(join(root, AGENTS_DIR))).toBe(false);
  });
});

// ── a run ────────────────────────────────────────────────────────────────────────

describe('a run of the local route (FAKE codex, FAKE Ollama on 127.0.0.1)', () => {
  it('a job: the planned command line (checked by the fake), the file it changed, its events, its final message, result and receipt', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const root = project();
    const { ws, sealed, notes } = make(root, localEnv(ollama.url));
    const task = 'append a line to src/a.txt';
    const { out, job } = await runTask(ws, `codex --local ${task}`);
    expect(out).toMatch(/agent codex a[0-9a-f]{8}: append a line to src\/a\.txt/);
    expect(out).toContain('codex-cli 0.0.0-fake (a FAKE Codex, not the real one)');
    expect(out).toContain(`model qwen3:4b at ${ollama.host}`);
    expect(out).toContain('local endpoint, no charge');
    expect(out).toContain('codex exec --oss on this machine\'s Ollama');
    // R4 (H37): /agent's start says plainly that Codex may run commands in its sandbox, and what Timmy checks
    expect(out).toContain(`Note       ${NOTE_SHARED}`);
    expect(job.state).toBe('completed');
    const r = resultOf(root);
    expect(r).toMatchObject({ agent: 'codex', outcome: 'completed', why: 'it exited 0 and reported success', endpoint: 'local', where: ollama.host, model: 'qwen3:4b', cost_usd: 0, cost_basis: 'local endpoint', exit_code: 0 });
    expect(r.files).toMatchObject({ added: [], deleted: [], truncated: false });
    expect(r.files!.changed.map((f) => f.path)).toEqual(['src/a.txt']);
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('first line\none more line (a FAKE codex)\n');
    expect(r.progress).toEqual({ tool_calls: 2, files_edited: ['src/a.txt'], tool_errors: 0, denied: [], structured_lines: 9, raw_lines: 0 });
    const dir = join(root, AGENTS_DIR, r.run);
    expect(readFileSync(join(dir, 'final-message.md'), 'utf8')).toBe('Done: FINAL (a FAKE codex).');
    expect(readFileSync(join(dir, 'codex-last-message.txt'), 'utf8')).toBe('Done: FINAL (a FAKE codex).');
    expect(readFileSync(join(dir, 'progress.log'), 'utf8').trim().split('\n')).toEqual([
      'started', 'plan  2 steps', 'command  cat src/a.txt  exit 0', 'files  src/a.txt', 'plan  2 of 2 done', 'says  Done: FINAL (a FAKE codex).',
      'done  turn completed · 1,200 tokens in (1,000 cached), 34 out',
    ]);
    expect(readFileSync(join(dir, 'transcript.log'), 'utf8')).toContain('"type":"turn.completed"');
    // what the FAKE codex was given: exactly the planned command line, in the project's folder
    const report = reportOf(root, r.run);
    expect(report.argv).toEqual(localArgs(root, r.run, task));
    expect(report.config).toEqual([...CODEX_LOCAL_SANDBOX_OVERRIDES]);
    expect(realpathSync(report.cwd)).toBe(realpathSync(root));
    // its stdin was ended at its start: it read nothing from it, and did not wait
    expect(report.stdin).toEqual({ open: false, bytes: 0 });
    // the FAKE Ollama was asked for its model list (before the run), and for nothing else
    expect(ollama.requests).toEqual(['GET /api/tags']);
    // one receipt, kind agent, through the job's seal: local endpoint, cost 0
    const rec = sealed.filter((s) => s.kind === 'agent');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      status: 'ok', cost_usd: 0, model_requested: 'qwen3:4b',
      agent: { name: 'codex', run: r.run, outcome: 'completed', endpoint: 'local', added: 0, changed: 1, deleted: [], tool_calls: 2, cost_basis: 'local endpoint' },
      job: { id: job.id, state: 'completed', exit_code: 0 },
    });
    expect(rec[0].files!.map((f) => f.path)).toEqual(['src/a.txt']);
    // its run marks the local route exercised, never the paid Codex row
    const index = agentExercisedIndex(sealed.map((s) => ({ ...s, ts: '2026-10-09T10:00:00Z' })) as unknown as Array<Record<string, unknown>>);
    expect([...index]).toEqual([['codex-local', '2026-10-09T10:00:00Z']]);
    // no absolute path in what the operator sees, the result or the receipt
    await new Promise((res) => setTimeout(res, 50));
    expect(notes.join('\n')).toMatch(new RegExp(`${job.id} completed  agent codex ${r.run}: 0 added, 1 changed, 0 deleted · cost \\$0\\.0000 \\(local endpoint\\)`));
    const last = text(await ws.agent('last'));
    expect(last).toContain('Said       Done: FINAL (a FAKE codex).');
    expect(last).toContain(`qwen3:4b · local endpoint ${ollama.host} · cost $0.0000 (local endpoint)`);
    for (const shown of [out, last, notes.join('\n'), JSON.stringify(rec[0]), readFileSync(join(dir, 'result.json'), 'utf8')]) {
      expect(shown).not.toContain(root);
      expect(shown).not.toContain(tmpdir());
    }
  });

  it('R4 (H37): the FAKE codex replays the sequence codex-cli 0.153.2 printed: completed; its warning and note shown as its own; its commands counted; the change found by Timmy\'s comparison', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const root = project();
    const { ws, sealed } = make(root, localEnv(ollama.url));
    const { out, job } = await runTask(ws, 'codex --local OBSERVED append a line to src/a.txt and run no commands');
    expect(job.state).toBe('completed');
    expect(out).toContain(`Note       ${NOTE_SHARED}`);
    const r = resultOf(root);
    expect(r).toMatchObject({ outcome: 'completed', why: 'it exited 0 and reported success' });
    // no file_change item named the file: Timmy's own before/after comparison of the project found the change
    expect(r.files!.changed.map((f) => f.path)).toEqual(['src/a.txt']);
    expect(r.progress).toEqual({ tool_calls: 5, files_edited: [], tool_errors: 0, denied: [], structured_lines: 16, raw_lines: 1 });
    const log = readFileSync(join(root, AGENTS_DIR, r.run, 'progress.log'), 'utf8').trim().split('\n');
    // Codex's own note comes on stderr: its place among the JSON lines is not fixed
    expect(log).toContain('codex note  Reading additional input from stdin...');
    const fromJson = log.filter((l) => !l.startsWith('codex note  '));
    expect(fromJson.slice(0, 2)).toEqual(['started', 'codex warning  Model metadata for `<model>` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.']);
    expect(fromJson.slice(2, 7).every((l) => l.startsWith('command  bash -lc ') && l.endsWith('  exit 0'))).toBe(true);
    expect(fromJson[4]).toMatch(/^command {2}bash -lc "cat > \/tmp\/patch\.txt << 'EOF' \*\*\* Begin Patch/);
    expect(fromJson.slice(7)).toEqual(['says  Done: FINAL (a FAKE codex, the observed sequence).', 'done  turn completed · 2,400 tokens in, 120 out']);
    expect(sealed.filter((s) => s.kind === 'agent').map((s) => s.status)).toEqual(['ok']);
  });

  it('no key reaches its environment; TIMMY_AGENT_HOME gives it its own HOME and CODEX_HOME; an inherited Ollama address is replaced', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const root = project();
    const home = temp('codex-agent-home-');
    // Built at run time, so no key-shaped literal sits in the source (the privacy gate); not a real key.
    const fake = ['sk', 'test', 'not', 'a', 'key', '0001'].join('-');
    const names = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY', 'TIMMY_AGENT_API_KEY', 'CODEX_HOME', 'CODEX_OSS_BASE_URL', 'CODEX_OSS_PORT'] as const;
    const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY', 'TIMMY_AGENT_API_KEY'] as const) process.env[k] = fake;
    process.env.CODEX_HOME = join(temp('operator-codex-'), '.codex');
    process.env.CODEX_OSS_BASE_URL = 'https://models.example.com/v1';
    process.env.CODEX_OSS_PORT = '9';
    try {
      const { ws } = make(root, localEnv(ollama.url, { TIMMY_AGENT_HOME: home }));
      const { out, job } = await runTask(ws, 'codex --local append a line');
      expect(job.state).toBe('completed');
      expect(out).toContain('its own HOME (TIMMY_AGENT_HOME)');
      expect(out).toContain('its own HOME and CODEX_HOME (TIMMY_AGENT_HOME): your codex settings and sign-in are not used');
      expect(out).not.toContain(home);
      const run = resultOf(root).run;
      const report = reportOf(root, run);
      expect(report.env).toEqual({
        HOME: home, CODEX_HOME: join(home, '.codex'), CODEX_OSS_BASE_URL: ollama.url, CODEX_OSS_PORT: '',
        OPENAI_API_KEY: '', CODEX_API_KEY: '', OPENROUTER_API_KEY: '', TIMMY_AGENT_API_KEY: '',
      });
      expect(existsSync(join(home, '.codex'))).toBe(true);
      expect(report.argv.join(' ')).not.toContain(fake);
      expect(JSON.stringify(ws.jobs.get(job.id))).not.toContain(fake);
    } finally {
      for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  it('the outcome comes from its own events: a failed turn is failed (at exit 0 too); a retried stream error, then a completed turn, is completed', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const root = project();
    const { ws, sealed } = make(root, localEnv(ollama.url));
    const failed = await runTask(ws, 'codex --local FAILTURN now');
    expect(failed.job).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(resultOf(root)).toMatchObject({ outcome: 'failed', why: 'it reported model qwen3:4b ran out of context (a FAKE failure)' });
    expect(sealed.at(-1)).toMatchObject({ kind: 'agent', status: 'failed', agent: { outcome: 'failed' } });
    const exit0 = await runTask(ws, 'codex --local FAILEXIT0 now');
    expect(exit0.job).toMatchObject({ state: 'completed', exitCode: 0 });
    expect(resultOf(root)).toMatchObject({ outcome: 'failed', why: 'it exited 0 but reported model qwen3:4b ran out of context (a FAKE failure)' });
    await runTask(ws, 'codex --local TRANSIENT then edit');
    const transient = resultOf(root);
    expect(transient).toMatchObject({ outcome: 'completed' });
    expect(readFileSync(join(root, AGENTS_DIR, transient.run, 'progress.log'), 'utf8')).toContain('error  Reconnecting... 1/5 (a FAKE stream error)');
    expect([...agentExercisedIndex(sealed.map((s) => ({ ...s, ts: '2026-10-09T10:00:00Z' })) as unknown as Array<Record<string, unknown>>).keys()]).toEqual(['codex-local']);
  });

  it('unknown, never completed: a stream that never says its turn completed, one with no event Timmy reads, and a silent run', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const root = project();
    const { ws, sealed } = make(root, localEnv(ollama.url));
    await runTask(ws, 'codex --local NOEND please');
    const noEnd = resultOf(root);
    expect(noEnd).toMatchObject({ outcome: 'unknown', why: expect.stringContaining('its event stream never said its turn completed (no turn.completed)') });
    expect(readFileSync(join(root, AGENTS_DIR, noEnd.run, 'final-message.md'), 'utf8')).toBe('Done: FINAL (a FAKE codex).');
    await runTask(ws, 'codex --local ALIEN please');
    const alien = resultOf(root);
    expect(alien).toMatchObject({ outcome: 'unknown', progress: { structured_lines: 0, raw_lines: 3 } });
    expect(readFileSync(join(root, AGENTS_DIR, alien.run, 'progress.log'), 'utf8').trim().split('\n')).toEqual([
      'event  session.configured: not one Timmy reads (kept in the transcript)', 'event  response.delta: not one Timmy reads (kept in the transcript)',
    ]);
    await runTask(ws, 'codex --local SILENT please');
    expect(resultOf(root)).toMatchObject({ outcome: 'unknown', why: expect.stringContaining('reported nothing Timmy could read'), progress: { structured_lines: 0, raw_lines: 0 } });
    // none of them marks the route exercised
    expect(sealed.filter((s) => s.kind === 'agent').map((s) => s.status)).toEqual(['failed', 'failed', 'failed']);
    expect(agentExercisedIndex(sealed.map((s) => ({ ...s, ts: '2026-10-09T10:00:00Z' })) as unknown as Array<Record<string, unknown>>).size).toBe(0);
  });
});

describe('the FAKE codex\'s own checks, as negative controls (they fail on purpose)', () => {
  it('it refuses a command line without --oss, with a bypass flag or a full-access sandbox, or with -C elsewhere; its report shows a key it is given', () => {
    const root = project();
    const elsewhere = temp('codex-elsewhere-');
    const fake = ['sk', 'test', 'not', 'a', 'key', '0002'].join('-');
    const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [FAKE_CODEX, ...args], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 });
    const good = localArgs(root, 'a0000000b', 'append a line');
    const ok = run(good, { OPENAI_API_KEY: fake });
    expect(ok.status).toBe(0);
    // had Timmy not blanked a key, the report would show it: the run tests above rely on this
    expect(reportOf(root, 'a0000000b').env.OPENAI_API_KEY).toBe(fake);
    const task = good.at(-1)!;
    const without = (drop: string): string[] => { const i = good.indexOf(drop); return [...good.slice(0, i - 1), ...good.slice(i + 1)]; };
    const cases: Array<[string[], string]> = [
      [good.filter((a) => a !== '--oss'), 'no --oss'],
      [[...good.slice(0, -1), '--dangerously-bypass-approvals-and-sandbox', task], 'it was given --dangerously-bypass-approvals-and-sandbox'],
      [good.map((a) => (a === 'workspace-write' ? 'danger-full-access' : a)), 'the sandbox is danger-full-access, not workspace-write'],
      [good.map((a) => (a === root ? elsewhere : a)), `-C ${elsewhere} is not the folder it runs in`],
      [good.map((a) => (a === 'ollama' ? 'lmstudio' : a)), '--local-provider is lmstudio, not ollama'],
      // R4 (H37): the sandbox overrides, each required; no other override; the rules files and the user's config ignored
      [without('sandbox_workspace_write.exclude_slash_tmp=true'), 'no -c sandbox_workspace_write.exclude_slash_tmp=true'],
      [without('sandbox_workspace_write.exclude_tmpdir_env_var=true'), 'no -c sandbox_workspace_write.exclude_tmpdir_env_var=true'],
      [without('sandbox_workspace_write.network_access=false'), 'no -c sandbox_workspace_write.network_access=false'],
      [good.map((a) => (a === 'sandbox_workspace_write.network_access=false' ? 'sandbox_workspace_write.network_access=true' : a)), 'an override it does not expect: -c sandbox_workspace_write.network_access=true'],
      [[...good.slice(0, -1), '-c', 'sandbox_mode="danger-full-access"', task], 'an override it does not expect: -c sandbox_mode="danger-full-access"'],
      [good.filter((a) => a !== '--ignore-rules'), 'no --ignore-rules'],
      [good.filter((a) => a !== '--ignore-user-config'), 'no --ignore-user-config'],
      [[...good.slice(0, -1), '--add-dir', elsewhere, task], 'it was given --add-dir'],
    ];
    for (const [args, why] of cases) {
      const r = run(args);
      expect(r.status, why).toBe(2);
      const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events.at(-1)).toMatchObject({ type: 'turn.failed', error: { message: expect.stringContaining(why) } });
    }
  });

  it('it refuses a run whose stdin stays open (where the real codex exec would wait for it)', async () => {
    const root = project();
    const child = spawn(process.execPath, [FAKE_CODEX, ...localArgs(root, 'a0000000c', 'append a line')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    const code = await new Promise<number | null>((r) => child.once('close', (c) => r(c)));
    expect(code).toBe(2);
    expect(out).toContain('its stdin stayed open');
    expect(reportOf(root, 'a0000000c').stdin).toEqual({ open: true, bytes: 0 });
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('first line\n');
  });
});

describe('a job\'s stdin (JobSpec.stdin, round R4): ended at once when asked, left open otherwise', () => {
  it('a real child reads the end of its input at once with stdin "closed", and finds it open without', async () => {
    const jobs = new JobManager({ dir: join(temp('codex-stdin-jobs-'), 'jobs') });
    const root = temp('codex-stdin-root-');
    // a real child: says EOF when its stdin ends, OPEN when it is still open after 1.5 s
    const reader = 'let n=0;process.stdin.on("data",c=>n+=c.length);process.stdin.on("end",()=>{console.log("EOF "+n);process.exit(0)});setTimeout(()=>{console.log("OPEN");process.exit(0)},1500)';
    const start = (stdin?: 'closed') => jobs.start({ kind: 'task', label: 'stdin check', project: 'p', root, command: process.execPath, args: ['-e', reader], ...(stdin ? { stdin } : {}) });
    const closed = await jobs.done(start('closed').id);
    expect(closed.state).toBe('completed');
    expect(jobs.tail(closed.id)).toEqual(['EOF 0']);
    const open = await jobs.done(start().id);
    expect(jobs.tail(open.id)).toEqual(['OPEN']);
    // a program that cannot start: the job fails with the reason, and ending its stdin throws nothing
    const missing = await jobs.done(jobs.start({ kind: 'task', label: 'no such program', project: 'p', root, command: join(root, 'no-such-program'), args: [], stdin: 'closed' }).id);
    expect(missing).toMatchObject({ state: 'failed', error: expect.stringContaining('ENOENT') });
    await jobs.stopAll();
  });
});

// ── its events, read defensively ──────────────────────────────────────────────────

describe('Codex\'s events, read defensively (some names observed with codex-cli 0.153.2, the rest assumed)', () => {
  it('R4 (H37): which names a real run printed (observed with codex-cli 0.153.2) and which are still assumed', () => {
    expect(CODEX_OBSERVED_WITH).toBe('codex-cli 0.153.2');
    expect([...CODEX_EVENTS_OBSERVED]).toEqual(['thread.started', 'turn.started', 'item.started', 'item.completed', 'turn.completed']);
    expect([...CODEX_EVENTS_ASSUMED]).toEqual(['turn.failed', 'item.updated', 'error']);
    expect([...CODEX_ITEMS_OBSERVED]).toEqual(['reasoning', 'agent_message', 'command_execution', 'error']);
    expect([...CODEX_ITEMS_ASSUMED]).toEqual(['file_change', 'mcp_tool_call', 'web_search', 'todo_list']);
    // every event Timmy reads is either observed or assumed, never both
    expect([...CODEX_EVENTS].sort()).toEqual([...CODEX_EVENTS_OBSERVED, ...CODEX_EVENTS_ASSUMED].sort());
  });

  it('R4 (H37) regression: the observed 0.153.2 sequence (a first item of type error, then a completed turn) is completed; the error item is Codex\'s own warning; its stdin line is Codex\'s own note', () => {
    const root = '/proj';
    const s = newProgress();
    // as printed by codex-cli 0.153.2 on the operator's Mac (the model name replaced by a placeholder)
    const lines = [
      'Reading additional input from stdin...',
      { type: 'thread.started', thread_id: 't-0001' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `<model>` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'Looking at the file.' } },
      { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: "bash -lc 'cat src/a.txt'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: "bash -lc 'cat src/a.txt'", aggregated_output: 'first line\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 4 } },
    ];
    const shown = lines.map((l) => progressLine(typeof l === 'string' ? l : JSON.stringify(l), s, root, 'codex'));
    expect(shown).toEqual([
      'codex note  Reading additional input from stdin...',
      'started', undefined,
      'codex warning  Model metadata for `<model>` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
      undefined, undefined,
      'command  bash -lc \'cat src/a.txt\'  exit 0',
      'says  Done.',
      'done  turn completed · 20 tokens in, 4 out',
    ]);
    // the warning decided nothing: no error held, the turn's own end is completed, the run is completed
    expect(s.reportedError).toBeUndefined();
    expect(s.reportedEnd).toBe('completed');
    expect(s).toMatchObject({ toolCalls: 1, toolErrors: 0, structured: 8, raw: 1 });
    expect(judgeAgentRun({ state: 'completed', exitCode: 0 }, s, 'codex')).toEqual({ outcome: 'completed', why: 'it exited 0 and reported success' });
    // the same warning with no later turn.completed is not a success either (the turn's end is what decides)
    const t = newProgress();
    for (const l of lines.slice(0, 5)) progressLine(typeof l === 'string' ? l : JSON.stringify(l), t, root, 'codex');
    expect(judgeAgentRun({ state: 'completed', exitCode: 0 }, t, 'codex').outcome).toBe('unknown');
    // a plain line that is not one of Codex's known notes is still shown as it came
    expect(progressLine('thread panicked at codex-rs/core', newProgress(), root, 'codex')).toBe('thread panicked at codex-rs/core');
  });

  it('messages, commands, file changes, tool calls, plans, usage and errors; any other type is counted raw and named once', () => {
    expect([...CODEX_EVENTS]).toEqual(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);
    const root = '/proj';
    const s = newProgress();
    const lines = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: '1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'npm test', exit_code: 1, status: 'failed' } },
      { type: 'item.completed', item: { id: '2', type: 'command_execution', command: ['rm', '-rf', 'x'], status: 'declined' } },
      { type: 'item.completed', item: { id: '3', type: 'file_change', changes: [{ path: '/proj/src/x.ts', kind: 'update' }, { path: '/elsewhere/y.ts', kind: 'add' }], status: 'completed' } },
      { type: 'item.completed', item: { id: '4', type: 'file_change', changes: [{ path: '/proj/src/z.ts', kind: 'update' }], status: 'failed' } },
      { type: 'item.completed', item: { id: '5', type: 'mcp_tool_call', server: 'docs', tool: 'search', status: 'failed', error: { message: 'no' } } },
      { type: 'item.completed', item: { id: '6', type: 'web_search', query: 'cadquery fillet' } },
      { type: 'item.completed', item: { id: '7', type: 'reasoning', text: 'hmm' } },
      { type: 'item.completed', item: { id: '8', type: 'error', message: 'a tool is not available' } },
      { type: 'item.completed', item: { id: '9', item_type: 'assistant_message', text: 'First draft.' } },
      { type: 'item.completed', item: { id: '10', type: 'agent_message', text: 'Fixed /proj/src/x.ts.' } },
      { type: 'item.completed', item: { id: '11', type: 'future_item' } },
      { type: 'item.completed', item: { id: '12', type: 'future_item' } },
      { type: 'session.configured' },
      { type: 'session.configured' },
      'plain text on stderr',
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
    ];
    const shown = lines.map((l) => progressLine(typeof l === 'string' ? l : JSON.stringify(l), s, root, 'codex'));
    expect(shown).toEqual([
      'started', undefined, undefined,
      'command  npm test  exit 1  failed',
      'command  rm -rf x  declined',
      'files  src/x.ts, <outside the project>',
      'files failed  src/z.ts',
      'tool  docs.search  failed',
      'search  cadquery fillet',
      undefined,
      'codex warning  a tool is not available',
      'says  First draft.',
      'says  Fixed ./src/x.ts.',
      'item  future_item: not one Timmy reads (kept in the transcript)', undefined,
      'event  session.configured: not one Timmy reads (kept in the transcript)', undefined,
      'plain text on stderr',
      'done  turn completed · 10 tokens in, 2 out',
    ]);
    expect(s).toMatchObject({ toolCalls: 6, toolErrors: 3, denied: ['command_execution'], filesEdited: ['src/x.ts'], finalMessage: 'Fixed /proj/src/x.ts.', reportedEnd: 'completed', usage: { input: 10, cached: 0, output: 2 }, structured: 16, raw: 3 });
    expect(s.reportedError).toBeUndefined();
  });

  it('an error holds the run as failed until a later turn.completed; turn.failed holds it for good', () => {
    const a = newProgress();
    progressLine(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }), a, '/proj', 'codex');
    expect(a.reportedError).toBe('Reconnecting... 1/5');
    progressLine(JSON.stringify({ type: 'turn.completed', usage: {} }), a, '/proj', 'codex');
    expect(a.reportedError).toBeUndefined();
    expect(a.reportedEnd).toBe('completed');
    const b = newProgress();
    progressLine(JSON.stringify({ type: 'turn.failed', error: { message: 'context window exceeded' } }), b, '/proj', 'codex');
    progressLine(JSON.stringify({ type: 'error', message: 'later' }), b, '/proj', 'codex');
    progressLine(JSON.stringify({ type: 'turn.completed' }), b, '/proj', 'codex');
    expect(b.reportedError).toBe('context window exceeded');
    const c = newProgress();
    progressLine(JSON.stringify({ type: 'turn.completed' }), c, '/proj', 'codex');
    progressLine(JSON.stringify({ type: 'error', message: 'after its end' }), c, '/proj', 'codex');
    expect(c.reportedError).toBe('after its end');
  });
});

// ── /tools ───────────────────────────────────────────────────────────────────────

describe('/tools: Codex with a local model is a row of its own', () => {
  const base: ProbeDeps = {
    env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
    lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
  };
  const row = async (d: Partial<ProbeDeps>) => (await capabilities({ ...base, ...d })).find((r) => r.id === 'codex-local')!;
  const receipt = (endpoint: string, ts: string) => ({ kind: 'agent', status: 'ok', ts, agent: { name: 'codex', outcome: 'completed', endpoint }, job: { state: 'completed' } });

  it('"implemented; not run" until a sealed, completed run of this route; a paid Codex run never marks it, nor it the paid row', async () => {
    expect(await row({})).toMatchObject({ rung: 'needs setup', detail: 'codex is not on PATH; implemented; not run', setup: 'brew install --cask codex (or npm install -g @openai/codex)', exercisedBy: 'agent:codex-local' });
    expect(await row({ onPath: () => true })).toMatchObject({ rung: 'needs setup', detail: 'no local model named; implemented; not run', setup: 'set TIMMY_AGENT_MODEL to a model from ollama list' });
    expect(await row({ onPath: () => true, env: { TIMMY_AGENT_MODEL: 'gpt-oss:120b-cloud' } })).toMatchObject({ rung: 'needs setup', detail: expect.stringMatching(/^not local: gpt-oss:120b-cloud is a cloud model.*; implemented; not run$/) });
    const ready = { onPath: () => true, env: { TIMMY_AGENT_MODEL: 'qwen3:4b' } };
    expect(await row(ready)).toMatchObject({ rung: 'installed', detail: 'implemented; not run: /agent codex --local <task>, free on this machine\'s Ollama (qwen3:4b)' });
    expect((await row(ready)).exercised).toBeUndefined();
    const paidOnly = agentExercisedIndex([receipt('remote', '2026-10-09T10:00:00Z')]);
    const rows = Object.fromEntries((await capabilities({ ...base, ...ready, agentRuns: () => paidOnly })).map((r) => [r.id, r]));
    expect(rows.codex.exercised).toBe('2026-10-09T10:00:00Z');
    expect(rows['codex-local'].exercised).toBeUndefined();
    expect(rows['codex-local'].detail).toContain('implemented; not run');
    const localRun = agentExercisedIndex([receipt('local', '2026-10-09T11:00:00Z'), { ...receipt('local', '2026-10-09T12:00:00Z'), status: 'failed', agent: { name: 'codex', outcome: 'failed', endpoint: 'local' } }]);
    const after = Object.fromEntries((await capabilities({ ...base, ...ready, agentRuns: () => localRun })).map((r) => [r.id, r]));
    expect(after['codex-local']).toMatchObject({ rung: 'installed', exercised: '2026-10-09T11:00:00Z', detail: '/agent codex --local <task>: a job; free on this machine\'s Ollama (qwen3:4b)' });
    expect(after.codex.exercised).toBeUndefined();
    // the rows fit an 80-column terminal, and each setup step prints whole
    for (const l of capabilityLines(await capabilities({ ...base, ...ready }), glyphSet(true), 80).map((x) => x.map((s) => s.text).join(''))) expect(l.length).toBeLessThanOrEqual(80);
    for (const r of await capabilities(base)) if (r.setup) expect(r.setup.length, r.id).toBeLessThanOrEqual(69);
  });
});

// ── /iterate ─────────────────────────────────────────────────────────────────────

describe('/iterate tray … --agent codex (FAKE codex, FAKE Ollama, FAKE recipe executor, FAKE readback)', () => {
  const iterateEnv = (url: string, fakePython: string, extra: Record<string, string> = {}): Record<string, string> => ({ ...localEnv(url), TIMMY_CADQUERY_PYTHON: fakePython, ...extra });
  const fakePythonIn = (dir: string): string => {
    const p = join(dir, 'fake-python');
    writeFileSync(p, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
    return p;
  };
  const flowIdIn = (out: string): string => { const m = out.match(/Flow\s+(f[0-9a-f]{8})/); if (!m) throw Error(`no flow in: ${out}`); return m[1]; };
  async function until(pred: () => boolean, ms = 90000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
  }

  it('--agent codex is the local route; paid agents and --paid stay refused', () => {
    expect(parseIterateLine('tray "make it 180 mm wide" --agent codex --model qwen3:4b')).toEqual({ ok: true, request: { recipe: 'tray', instruction: 'make it 180 mm wide', agent: 'codex', model: 'qwen3:4b' } });
    expect(parseIterateLine('tray --agent=codex widen it')).toMatchObject({ ok: true, request: { agent: 'codex', instruction: 'widen it' } });
    expect(parseIterateLine('tray widen it')).toMatchObject({ ok: true, request: { agent: 'qwen' } });
    expect(parseIterateLine('tray widen it --agent claude')).toMatchObject({ ok: false, error: expect.stringContaining('Claude Code runs on your own account and costs money; /iterate runs only a local, free route (--agent qwen or --agent codex') });
    expect(parseIterateLine('tray widen it --agent opencode')).toMatchObject({ ok: false, error: expect.stringContaining('OpenCode runs on your own account and costs money') });
    expect(parseIterateLine('tray --paid widen it --agent codex')).toMatchObject({ ok: false, error: expect.stringContaining('it has no --paid') });
  });

  it('refused before anything is written: a cloud model, an endpoint off this machine, a model its Ollama does not list', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const fakePython = fakePythonIn(temp('codex-python-'));
    const cases: Array<[Record<string, string>, string, RegExp]> = [
      [{}, 'tray widen it --agent codex --model gpt-oss:120b-cloud', /is a cloud model[\s\S]*Codex's local route runs only on this machine's Ollama[\s\S]*\/iterate runs only a local, free route, and has no --paid/],
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'tray widen it --agent codex', /models\.example\.com is not this machine/],
      [{}, 'tray widen it --agent codex --model llama3.2:3b', /does not list llama3\.2:3b[\s\S]*codex --oss downloads a model it does not find/],
    ];
    for (const [env, line, want] of cases) {
      const root = temp('codex-iterate-');
      const { ws, sealed } = make(root, iterateEnv(ollama.url, fakePython, env));
      const out = text(await ws.iterate(line));
      expect(out).toMatch(want);
      expect(existsSync(join(root, PARAMS))).toBe(false);
      expect(existsSync(join(root, AGENTS_DIR))).toBe(false);
      expect(ws.jobs.list()).toEqual([]);
      expect(sealed).toEqual([]);
    }
  });

  it('end to end: the FAKE codex changes only the parameter file, the recipe rebuilds, the readback matches; the record names codex at no charge', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const root = temp('codex-iterate-');
    const { ws, sealed, notes } = make(root, iterateEnv(ollama.url, fakePythonIn(temp('codex-python-'))));
    const out = text(await ws.iterate('tray "make it 180 mm wide PARAM:width=180" --agent codex'));
    const id = flowIdIn(out);
    expect(out).toContain(`agent codex a`);
    expect(out).toContain(`Codex codex-cli 0.0.0-fake (a FAKE Codex, not the real one) · model qwen3:4b at ${ollama.host} · local endpoint, no charge`);
    expect(out).not.toContain(root);
    await until(() => sealed.some((r) => r.kind === 'flow' && String(r.subject).includes(id)));
    const rec = JSON.parse(readFileSync(join(root, 'results', 'flows', `${id}.json`), 'utf8')) as FlowRecord;
    expect(rec).toMatchObject({ outcome: 'succeeded', ended_in: 'readback', instruction: 'make it 180 mm wide PARAM:width=180' });
    expect(rec.agent).toMatchObject({ agent: 'codex', model: 'qwen3:4b', where: ollama.host, outcome: 'completed', route: 'local endpoint, no charge', cost_usd: 0, cost_basis: 'local endpoint' });
    expect(rec.agent!.files_changed!.map((f) => [f.path, f.how])).toEqual([[PARAMS, 'changed']]);
    expect(rec.parameters.diff!.filter((d) => d.changed)).toEqual([{ name: 'width', before: 140, after: 180, changed: true }]);
    expect(rec.readback).toMatchObject({ verdict: 'matches', worker: { name: 'fake-step-readback' } });
    // the agent's own run: the planned local command line, in the project
    const report = reportOf(root, rec.agent!.run);
    expect(report.argv.slice(0, 18)).toEqual(['exec', '--oss', '--local-provider', 'ollama', '-m', 'qwen3:4b', '--json', '--skip-git-repo-check', '-s', 'workspace-write', ...OVERRIDES, '-C', root]);
    expect(report.argv).toContain('--ignore-rules');
    expect(report.argv.at(-1)!.split('\n')[0]).toBe('make it 180 mm wide PARAM:width=180');
    expect(report.env).toMatchObject({ OPENAI_API_KEY: '', CODEX_API_KEY: '', OPENROUTER_API_KEY: '', TIMMY_AGENT_API_KEY: '', CODEX_OSS_BASE_URL: ollama.url });
    // the receipts: agent (local, cost 0), prediction, build, readback, then the flow's own, with cost 0
    expect(sealed.find((r) => r.kind === 'agent')).toMatchObject({ status: 'ok', cost_usd: 0, agent: { name: 'codex', endpoint: 'local', outcome: 'completed' } });
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'ok', cost_usd: 0, child_receipts: rec.child_receipts });
    expect(rec.child_receipts).toHaveLength(4);
    // the Ollama was asked for its list twice (by /iterate before writing the parameter file, and by /agent's start), nothing else
    expect(ollama.requests).toEqual(['GET /api/tags', 'GET /api/tags']);
    expect(notes.join('\n')).toContain(`${id}  agent codex ${rec.agent!.run} completed: changed ${PARAMS} · width 140 → 180`);
    expect(text(await ws.iterate(''))).toContain('qwen (Qwen Code), or codex (Codex with a local model: codex exec --oss), on a local endpoint only');
  }, 120000);
});
