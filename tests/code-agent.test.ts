// Round R3 (helper H13): /agent, a code agent as a durable, cancellable job with an inspectable result.
// The runs here use tests/fixtures/fake-code-agent.mjs, a FAKE agent (a test double that calls no model);
// the command lines are checked against the real --help texts captured from the operator's machine
// (tests/fixtures/agent-help). The one test that runs the real Qwen Code is skipped unless
// TIMMY_TEST_QWEN_BIN names an installed qwen; it talks only to a fake OpenAI-compatible server on 127.0.0.1.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilities, type ProbeDeps } from '../src/capabilities/index.js';
import {
  agentExercisedIndex, AGENTS_DIR, endpointClass, listAgentRuns, newProgress, parseAgentLine, planAgent, progressLine, taskWords, type AgentRunRecord, scrubPaths,
} from '../src/code-agents/index.js';
import { COMMANDS, runSlash, type ReplContext } from '../src/repl/commands.js';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FAKE_AGENT = resolve('tests/fixtures/fake-code-agent.mjs');
const HELP = (name: string): string => readFileSync(resolve('tests/fixtures/agent-help', name), 'utf8');

const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = temp('agent-proj-');
  put(root, 'src/a.txt', 'first line\n');
  put(root, 'old.txt', 'to be deleted\n');
  put(root, 'node_modules/x/index.js', 'skipped\n');
  return root;
}

function make(root: string, env: Record<string, string>, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env,
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => `Open ${url} in your browser.`,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('agent-jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, ts: new Date(Date.now() + i).toISOString(), hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

const LOCAL_QWEN = { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b' };
const jobIdOf = (out: string): string => { const m = out.match(/\b(j[0-9a-f]{6})\b/); if (!m) throw new Error(`no job id in: ${out}`); return m[1]; };
const resultOf = (root: string): AgentRunRecord => listAgentRuns(root)[0];

/** Every option a command line uses is one its own --help text lists. */
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

describe('the command lines, from the agents\' own help texts', () => {
  it('Qwen Code on a local endpoint: one-shot, --bare, openai auth, the model, auto-edit, stream-json, a wall time, no chat recording', () => {
    const r = planAgent('qwen', 'add a test', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b' }, paid: false, run: 'a00000001', bin: 'qwen' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.args).toEqual([
      '--bare', '--auth-type', 'openai', '--openai-base-url', 'http://127.0.0.1:11434/v1', '-m', 'qwen3:4b',
      '--approval-mode', 'auto-edit', '-o', 'stream-json', '--max-wall-time', '15m', '--chat-recording=false', 'add a test',
    ]);
    // the key travels in the child's environment, never on the command line (round R3)
    expect(r.plan.env).toEqual({ OPENAI_API_KEY: 'ollama', OPENROUTER_API_KEY: '', TIMMY_AGENT_API_KEY: '' });
    expect(r.plan).toMatchObject({ endpoint: 'local', where: '127.0.0.1:11434', costBasis: 'local endpoint', timeoutMs: 15 * 60_000 + 30_000 });
    expect(flagsIn(r.plan.args, HELP('qwen-help.txt'))).toEqual([]);
    // the choices used are the help text's choices
    expect(HELP('qwen-help.txt')).toMatch(/--approval-mode[\s\S]*auto-edit \(Automatically approve file edits\)/);
    expect(HELP('qwen-help.txt')).toMatch(/--auth-type[^\n]*"openai"/);
  });
  it('a real key for a remote endpoint is in the child\'s environment only: not in its arguments, not in the saved job', () => {
    const secret = 'sk-test-not-a-real-key-0001';
    const r = planAgent('qwen', 'add a test', { env: { TIMMY_AGENT_MODEL: 'some-model', TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1', TIMMY_AGENT_API_KEY: secret, TIMMY_AGENT_HOME: '/tmp/agent-home' }, paid: true, run: 'a00000009', bin: 'qwen' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.args.join(' ')).not.toContain(secret);
    expect(r.plan.args).not.toContain('--openai-api-key');
    expect(r.plan.env).toEqual({ HOME: '/tmp/agent-home', OPENAI_API_KEY: secret, OPENROUTER_API_KEY: '', TIMMY_AGENT_API_KEY: '' });
  });
  it('the review of ee70b9e: a -cloud tag is cloud; --paid counts only right after the name; folders scrub at a boundary', () => {
    expect(endpointClass('http://127.0.0.1:11434/v1', 'gpt-oss:120b-cloud').local).toBe(false);
    expect(endpointClass('http://127.0.0.1:11434/v1', 'glm-5.3:cloud').local).toBe(false);
    expect(endpointClass('http://127.0.0.1:11434/v1', 'qwen3.8:27b-mlx').local).toBe(true);
    expect(parseAgentLine('claude explain what the --paid flag of our CLI does')).toMatchObject({ paid: false, task: 'explain what the --paid flag of our CLI does' });
    expect(parseAgentLine('claude --paid fix the typo')).toMatchObject({ paid: true, task: 'fix the typo' });
    expect(scrubPaths('/a/proj/x, /a/proj2/y and /a/proj', '/a/proj')).toBe('./x, /a/proj2/y and .');
  });
  it('the account agents: headless, structured output, edits kept to the project, no bypass flag; each flag is in its help text', () => {
    const claude = planAgent('claude', 'fix it', { env: {}, paid: true, run: 'a00000002', bin: 'claude' });
    const codex = planAgent('codex', 'fix it', { env: {}, paid: true, run: 'a00000003', bin: 'codex' });
    const opencode = planAgent('opencode', 'fix it', { env: {}, paid: true, run: 'a00000004', bin: 'opencode' });
    if (!claude.ok || !codex.ok || !opencode.ok) throw new Error('a paid plan was refused with --paid');
    expect(claude.plan.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--no-session-persistence']));
    expect(codex.plan.args.slice(0, 3)).toEqual(['exec', '--json', '--sandbox']);
    expect(codex.plan.args).toEqual(expect.arrayContaining(['workspace-write', '--ephemeral', '-o', `${AGENTS_DIR}/a00000003/codex-last-message.txt`]));
    expect(opencode.plan.args).toEqual(expect.arrayContaining(['run', '--format', 'json']));
    const all = [...claude.plan.args, ...codex.plan.args, ...opencode.plan.args].join(' ');
    expect(all).not.toMatch(/dangerously|bypassPermissions|danger-full-access|--auto\b|--yolo/);
    expect(flagsIn(claude.plan.args, HELP('claude-help.txt'))).toEqual([]);
    expect(flagsIn(codex.plan.args, HELP('codex-exec-help.txt'))).toEqual([]);
    expect(flagsIn(opencode.plan.args, HELP('opencode-run-help.txt'))).toEqual([]);
    for (const p of [claude.plan, codex.plan, opencode.plan]) expect(p).toMatchObject({ endpoint: 'remote', costBasis: expect.not.stringMatching(/local/) });
  });
  it('a task that begins with "-" is never read as an option', () => {
    const r = planAgent('qwen', '--yolo do it', { env: { TIMMY_AGENT_MODEL: 'm' }, paid: false, run: 'a00000005', bin: 'qwen' });
    expect(r.ok && r.plan.args.at(-1)).toBe('Task: --yolo do it');
  });
  it('/agent is in the work group with a short description', () => {
    const c = COMMANDS.find((x) => x.name === 'agent');
    expect(c?.group).toBe('work');
    expect(c!.description.length).toBeLessThanOrEqual(45);
    expect(parseAgentLine('claude --paid fix the bug')).toEqual({ name: 'claude', word: 'claude', paid: true, task: 'fix the bug' });
  });
});

describe('local, no charge: only a loopback endpoint and a model that is not :cloud', () => {
  it('classifies endpoints and models', () => {
    expect(endpointClass('http://127.0.0.1:11434/v1', 'qwen3:4b')).toMatchObject({ local: true, where: '127.0.0.1:11434' });
    expect(endpointClass('http://localhost:11434/v1', 'qwen3:4b').local).toBe(true);
    expect(endpointClass('http://[::1]:11434/v1', 'qwen3:4b').local).toBe(true);
    // a tag ending in -cloud is an Ollama cloud model too (the review of ee70b9e; the earlier rule caught only :cloud)
    expect(endpointClass('http://127.0.0.1:11434/v1', 'gpt-oss:120b-cloud').local).toBe(false);
    expect(endpointClass('http://127.0.0.1:11434/v1', 'gpt-oss:120b:cloud')).toMatchObject({ local: false, why: expect.stringContaining(':cloud') });
    expect(endpointClass('https://api.example.com/v1', 'qwen3:4b')).toMatchObject({ local: false, where: 'api.example.com' });
    expect(endpointClass('not a url', 'm').local).toBe(false);
  });
  it('a missing TIMMY_AGENT_MODEL says exactly what to set, and starts nothing', async () => {
    const root = project();
    const { ws } = make(root, { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT });
    const out = text(await ws.agent('qwen add a test'));
    expect(out).toContain('Set TIMMY_AGENT_MODEL');
    expect(out).toContain('Nothing was started');
    expect(ws.jobs.list()).toEqual([]);
    expect(existsSync(join(root, AGENTS_DIR))).toBe(false);
  });
  it('a :cloud model, or an endpoint off this machine, is paid: refused without --paid', async () => {
    const root = project();
    const cloud = make(root, { ...LOCAL_QWEN, TIMMY_AGENT_MODEL: 'qwen3-coder:480b:cloud' });
    const a = text(await cloud.ws.agent('qwen add a test'));
    expect(a).toMatch(/may cost money/);
    expect(a).toContain('/agent qwen --paid');
    const remote = make(root, { ...LOCAL_QWEN, TIMMY_AGENT_BASE_URL: 'https://api.example.com/v1' });
    const b = text(await remote.ws.agent('qwen add a test'));
    expect(b).toMatch(/api\.example\.com is not this machine/);
    expect(cloud.ws.jobs.list()).toEqual([]);
    expect(remote.ws.jobs.list()).toEqual([]);
    // with --paid, a remote endpoint still needs its own key: nothing is sent with the local placeholder
    const c = text(await remote.ws.agent('qwen --paid add a test'));
    expect(c).toContain('Set TIMMY_AGENT_API_KEY');
    expect(remote.ws.jobs.list()).toEqual([]);
  });
  it('Claude Code, Codex and OpenCode are refused without --paid, saying they use the account and cost money', async () => {
    const root = project();
    const { ws } = make(root, { TIMMY_AGENT_CLAUDE_BIN: FAKE_AGENT, TIMMY_AGENT_CODEX_BIN: FAKE_AGENT, TIMMY_AGENT_OPENCODE_BIN: FAKE_AGENT });
    for (const n of ['claude', 'codex', 'opencode']) {
      const out = text(await ws.agent(`${n} fix the bug`));
      expect(out).toMatch(/runs on your own account and costs money\. Nothing was started\./);
      expect(out).toContain(`/agent ${n} --paid <task>`);
    }
    expect(ws.jobs.list()).toEqual([]);
  });
  it('/agent reaches the workspace through the command registry, as the REPL dispatches it', async () => {
    const root = project();
    const { ws } = make(root, { ...LOCAL_QWEN, TIMMY_AGENT_CLAUDE_BIN: FAKE_AGENT });
    const printed: string[] = [];
    const ctx = { print: (s: { text: string }[]) => printed.push(s.map((x) => x.text).join('')), glyphs: glyphSet(true), workspace: ws } as unknown as ReplContext;
    expect(await runSlash('/agent', ctx)).toBe('handled');
    expect(printed.join('\n')).toContain('Code agents');
    expect(await runSlash('/agent claude fix it', ctx)).toBe('handled');
    expect(printed.join('\n')).toContain('runs on your own account and costs money');
    expect(ws.jobs.list()).toEqual([]);
  });
  it('/agent alone lists each agent: found or not, how it would run, its model and endpoint', async () => {
    const root = project();
    const { ws } = make(root, { ...LOCAL_QWEN });
    const out = text(await ws.agent(''));
    expect(out).toMatch(/qwen\s+Qwen Code\s+set by TIMMY_AGENT_QWEN_BIN/);
    expect(out).toContain('local endpoint, no charge');
    expect(out).toContain('model qwen3:4b at 127.0.0.1:11434');
    expect(out).toMatch(/claude\s+Claude Code\s+not on PATH/);
    expect(out).toContain('your own account: costs money (--paid)');
  });
});

describe('a run (the FAKE agent): a job, its progress, its result and its receipt', () => {
  it('edits, adds and deletes files: the snapshot finds all three, the stream names the edits, the final message is kept', async () => {
    const root = project();
    const { ws, sealed, notes } = make(root, LOCAL_QWEN);
    const task = 'EDIT the files please, then explain every change you made, file by file, in detail';
    const started = text(await ws.agent(`qwen ${task}`));
    const id = jobIdOf(started);
    // the label: the agent, the run id (the operation ID) and the first words of the task
    expect(started).toMatch(/agent qwen a[0-9a-f]{8}: EDIT the files please, then explain every…/);
    expect(started).toContain('local endpoint, no charge');
    expect(started).toContain('0.0.0-fake');
    const job = await ws.jobs.done(id);
    expect(job.state).toBe('completed');
    const r = resultOf(root);
    expect(r).toMatchObject({ agent: 'qwen', outcome: 'completed', model: 'qwen3:4b', endpoint: 'local', cost_usd: 0, cost_basis: 'local endpoint', job: id, exit_code: 0 });
    expect(r.files!.added.map((f) => f.path)).toEqual(['new/added.txt']);
    expect(r.files!.changed.map((f) => f.path)).toEqual(['src/a.txt']);
    expect(r.files!.deleted.map((f) => f.path)).toEqual(['old.txt']);
    expect(r.progress).toMatchObject({ tool_calls: 3, files_edited: ['src/a.txt', 'new/added.txt'] });
    expect(r.final_message).toMatchObject({ file: 'final-message.md', truncated: false });
    const dir = join(root, AGENTS_DIR, r.run);
    expect(readFileSync(join(dir, 'final-message.md'), 'utf8')).toBe('All done: FINAL (a FAKE agent).');
    expect(readFileSync(join(dir, 'transcript.log'), 'utf8')).toContain('"type":"result"');
    const progress = readFileSync(join(dir, 'progress.log'), 'utf8');
    expect(progress).toContain('started  model qwen3:4b');
    expect(progress).toContain('tool  edit  src/a.txt');
    expect(progress).toContain('tool  write_file  new/added.txt');
    expect(progress).toContain('tool  run_shell_command  ls');
    expect(progress).toContain('tool failed: not approved');
    expect(progress).toContain('done  success · 2 turns · 1 tool call denied (run_shell_command)');
    expect(r.why).toBe('it exited 0 and reported success; 1 of its tool calls was denied (run_shell_command)');
    expect(r.progress).toMatchObject({ tool_errors: 1, denied: ['run_shell_command'] });
    // one receipt, kind agent, through the job's seal
    const rec = sealed.filter((s) => s.kind === 'agent');
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      status: 'ok', cost_usd: 0, model_requested: 'qwen3:4b',
      agent: { name: 'qwen', run: r.run, outcome: 'completed', endpoint: 'local', added: 1, changed: 1, deleted: ['old.txt'], tool_calls: 3, cost_basis: 'local endpoint' },
      job: { id, state: 'completed', exit_code: 0 },
    });
    expect(rec[0].files!.map((f) => f.path).sort()).toEqual(['new/added.txt', 'src/a.txt']);
    expect(rec[0].outputs!.map((o) => o.path)).toEqual(expect.arrayContaining([`${AGENTS_DIR}/${r.run}/result.json`, `${AGENTS_DIR}/${r.run}/final-message.md`, `${AGENTS_DIR}/${r.run}/transcript.log`]));
    expect(String(rec[0].prompt_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // the task itself is sealed as its hash; only the label's first words are in the receipt
    expect(JSON.stringify(rec[0])).not.toContain(task);
    expect(r.task).toBe(task);
    // what the operator sees: the notice, /jobs, /results and /agent last, with no absolute path
    await tick();
    expect(notes.join('\n')).toMatch(new RegExp(`${id} completed  agent qwen ${r.run}: 1 added, 1 changed, 1 deleted · cost \\$0\\.0000 \\(local endpoint\\)`));
    const jobs = text(ws.jobsView(id));
    expect(jobs).toContain('3 tool calls · edited src/a.txt, new/added.txt');
    expect(jobs).toContain('tool  edit  src/a.txt');
    expect(jobs).not.toContain('"type"');
    const results = text(ws.results(''));
    expect(results).toContain('Agents');
    expect(results).toMatch(new RegExp(`${r.run}\\s+qwen\\s+completed · 1 added, 1 changed, 1 deleted · receipt id`));
    expect(results).toContain('new/added.txt added · src/a.txt changed · old.txt deleted');
    expect(results).toContain('a code agent (/agent)');
    const last = text(await ws.agent('last'));
    expect(last).toContain(`Agent run  ${r.run}  qwen 0.0.0-fake (a FAKE code agent, not a real one) · completed`);
    expect(last).toContain('Said       All done: FINAL');
    expect(last).toContain('cost $0.0000 (local endpoint)');
    // (the /results header names the project's folder, as it always has: only its Agents part is the agent's)
    const agentsPart = results.slice(results.indexOf('  Agents'));
    for (const shown of [started, jobs, agentsPart, last, notes.join('\n'), JSON.stringify(rec[0]), readFileSync(join(dir, 'result.json'), 'utf8')]) {
      expect(shown).not.toContain(root);
      expect(shown).not.toContain(tmpdir());
    }
  });
  it('a final message longer than 8,000 characters is kept bounded, with a truncation note', async () => {
    const root = project();
    const { ws } = make(root, LOCAL_QWEN);
    await ws.jobs.done(jobIdOf(text(await ws.agent('qwen LONG answer'))));
    const r = resultOf(root);
    expect(r.final_message).toMatchObject({ chars: 9000, truncated: true });
    const kept = readFileSync(join(root, AGENTS_DIR, r.run, 'final-message.md'), 'utf8');
    expect(kept.startsWith('L'.repeat(8000))).toBe(true);
    expect(kept).toContain('[truncated: the agent\'s final message had 9000 characters');
  });
  it('a stream that reports an error is failed even at exit 0; plain text output is shown as it came', async () => {
    const root = project();
    const { ws, sealed } = make(root, LOCAL_QWEN);
    await ws.jobs.done(jobIdOf(text(await ws.agent('qwen FAILJSON'))));
    expect(resultOf(root)).toMatchObject({ outcome: 'failed', why: 'it exited 0 but reported error_during_execution' });
    expect(sealed.at(-1)).toMatchObject({ kind: 'agent', status: 'failed' });
    const id = jobIdOf(text(await ws.agent('qwen TEXT only')));
    await ws.jobs.done(id);
    expect(text(ws.jobsView(id))).toContain('Working on it (plain text, a FAKE agent).');
    // plain text only: an exit status is not a report, so the outcome is unknown (the review of ee70b9e)
    expect(resultOf(root)).toMatchObject({ outcome: 'unknown', progress: { raw_lines: 2, structured_lines: 0 } });
  });
  it('/stop cancels it: its process group is gone, the outcome is cancelled and the receipt says so', async () => {
    const root = project();
    const { ws, sealed } = make(root, LOCAL_QWEN);
    const id = jobIdOf(text(await ws.agent('qwen SLEEP a while')));
    let pid: number | undefined;
    for (let i = 0; i < 100 && !(pid = ws.jobs.get(id)?.pid); i++) await tick(20);
    expect(pid).toBeGreaterThan(0);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(() => process.kill(pid!, 0)).toThrow();
    const r = resultOf(root);
    expect(r).toMatchObject({ outcome: 'cancelled', cost_usd: 0 });
    const rec = sealed.find((s) => s.kind === 'agent')!;
    expect(rec).toMatchObject({ status: 'cancelled', agent: { outcome: 'cancelled' }, job: { state: 'cancelled' } });
    expect(agentExercisedIndex(sealed.map((s) => ({ ...s, ts: '2026-10-09T00:00:00Z' })) as unknown as Array<Record<string, unknown>>).size).toBe(0);
  });
  it('a run that outlives its time ends timed out: by Timmy\'s limit, or by the agent\'s own budget (exit 55)', async () => {
    const root = project();
    const { ws, sealed } = make(root, { ...LOCAL_QWEN, TIMMY_AGENT_WALL_TIME: '1s', TIMMY_AGENT_GRACE_MS: '300' });
    const t0 = Date.now();
    const a = await ws.jobs.done(jobIdOf(text(await ws.agent('qwen SLEEP forever'))));
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(a).toMatchObject({ state: 'failed', error: 'timed out' });
    expect(resultOf(root)).toMatchObject({ outcome: 'timed out' });
    expect(sealed.at(-1)).toMatchObject({ kind: 'agent', status: 'failed', agent: { outcome: 'timed out' } });
    const own = make(root, { ...LOCAL_QWEN, TIMMY_AGENT_WALL_TIME: '1s', TIMMY_AGENT_GRACE_MS: '20000' });
    const b = await own.ws.jobs.done(jobIdOf(text(await own.ws.agent('qwen SLEEP BUDGET'))));
    expect(b).toMatchObject({ state: 'failed', exitCode: 55 });
    expect(resultOf(root)).toMatchObject({ outcome: 'timed out', why: 'its own wall-time budget ended it (exit 55)' });
  });
  it('a paid agent\'s cost is what it reported, or unknown (never 0)', async () => {
    const root = project();
    const { ws, sealed } = make(root, { TIMMY_AGENT_CLAUDE_BIN: FAKE_AGENT, TIMMY_AGENT_CODEX_BIN: FAKE_AGENT });
    const started = text(await ws.agent('claude --paid COST check'));
    expect(started).toMatch(/your Claude Code account: costs money \(--paid\): it uses your account and may cost money/);
    await ws.jobs.done(jobIdOf(started));
    expect(resultOf(root)).toMatchObject({ agent: 'claude', outcome: 'completed', cost_usd: 0.0123, cost_basis: 'reported by the agent' });
    expect(sealed.at(-1)).toMatchObject({ cost_usd: 0.0123 });
    await ws.jobs.done(jobIdOf(text(await ws.agent('codex --paid TEXT only'))));
    expect(resultOf(root)).toMatchObject({ agent: 'codex', cost_usd: null, cost_basis: 'unknown: the agent reported no cost' });
    expect(sealed.at(-1)).toMatchObject({ cost_measured: false });
    expect(sealed.at(-1)).not.toHaveProperty('cost_usd');
  });
  it('TIMMY_AGENT_HOME gives the agent its own HOME, and the operator is told so', async () => {
    const root = project();
    const home = temp('agent-sandbox-home-');
    const { ws } = make(root, { ...LOCAL_QWEN, TIMMY_AGENT_HOME: home });
    const started = text(await ws.agent('qwen HOME TEXT'));
    expect(started).toContain('its own HOME (TIMMY_AGENT_HOME)');
    expect(started).not.toContain(home);
    await ws.jobs.done(jobIdOf(started));
    expect(readFileSync(join(root, AGENTS_DIR, resultOf(root).run, 'transcript.log'), 'utf8')).toContain(`home=${home}`);
  });
  it('a task with an absolute path is shown without it, and so is the final message /agent last quotes', async () => {
    const root = project();
    expect(taskWords(`fix ${root}/src/a.txt and /etc/hosts`, root)).toBe('fix ./src/a.txt and <path>');
    const { ws } = make(root, LOCAL_QWEN);
    await ws.jobs.done(jobIdOf(text(await ws.agent('qwen say something'))));
    writeFileSync(join(root, AGENTS_DIR, resultOf(root).run, 'final-message.md'), `Created ${root}/hello.txt`);
    const last = text(await ws.agent('last'));
    expect(last).toContain('Said       Created ./hello.txt');
    expect(last).not.toContain(root);
  });
});

describe('progress lines from each agent\'s structured output', () => {
  it('reads Codex JSONL and OpenCode JSON events', () => {
    const root = '/proj';
    const codex = newProgress();
    const shownC = [
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } },
      { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/proj/src/x.ts', kind: 'update' }] } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Fixed.' } },
    ].map((e) => progressLine(JSON.stringify(e), codex, root));
    expect(shownC).toEqual(['command  npm test  exit 0', 'files  src/x.ts', 'says  Fixed.']);
    expect(codex).toMatchObject({ toolCalls: 2, filesEdited: ['src/x.ts'], finalMessage: 'Fixed.' });
    const oc = newProgress();
    progressLine(JSON.stringify({ type: 'tool_use', part: { tool: 'edit', state: { input: { filePath: '/proj/a.md' } } } }), oc, root);
    progressLine(JSON.stringify({ type: 'step_finish', part: { cost: 0.01 } }), oc, root);
    progressLine(JSON.stringify({ type: 'step_finish', part: { cost: 0.02 } }), oc, root);
    expect(oc).toMatchObject({ toolCalls: 1, filesEdited: ['a.md'] });
    expect(oc.reportedCostUsd).toBeCloseTo(0.03);
  });
});

describe('/tools: an agent row is exercised only by a sealed, completed run of that agent', () => {
  const base: ProbeDeps = {
    env: {}, onPath: () => true, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
    lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
  };
  const receipt = (name: string, outcome: string, status: string, ts: string) => ({ kind: 'agent', status, ts, agent: { name, outcome }, job: { state: outcome === 'completed' ? 'completed' : 'failed' } });
  it('a completed qwen run marks Qwen Code only; failed, cancelled and submitted runs mark nothing', async () => {
    const chain = [
      receipt('qwen', 'completed', 'ok', '2026-10-09T10:00:00Z'),
      receipt('claude', 'failed', 'failed', '2026-10-09T10:01:00Z'),
      receipt('codex', 'cancelled', 'cancelled', '2026-10-09T10:02:00Z'),
      receipt('opencode', 'timed out', 'failed', '2026-10-09T10:03:00Z'),
      { kind: 'task', status: 'ok', ts: '2026-10-09T10:04:00Z', job: { label: 'agent claude' } },
    ];
    const rows = Object.fromEntries((await capabilities({ ...base, agentRuns: () => agentExercisedIndex(chain) })).map((r) => [r.id, r]));
    expect(rows['qwen-code']).toMatchObject({ exercisedBy: 'agent:qwen', exercised: '2026-10-09T10:00:00Z' });
    for (const id of ['claude-code', 'codex', 'opencode']) expect(rows[id].exercised).toBeUndefined();
    const none = Object.fromEntries((await capabilities(base)).map((r) => [r.id, r]));
    expect(none['qwen-code'].exercised).toBeUndefined();
  });
});

// ── the real Qwen Code (skipped unless TIMMY_TEST_QWEN_BIN names one) against a FAKE OpenAI-compatible server ──

const REAL_QWEN = process.env.TIMMY_TEST_QWEN_BIN;
const realQwen = REAL_QWEN && existsSync(REAL_QWEN) ? it : it.skip;

/**
 * A FAKE OpenAI-compatible chat endpoint on 127.0.0.1: first an `edit` tool call that creates the file (an empty
 * old_string; qwen 0.25.0 in --bare mode offers read_file, edit, notebook_edit and run_shell_command, not
 * write_file: observed), then a closing message.
 */
function fakeOpenAi(target: string): Promise<{ server: Server; url: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(body || '{}') as Record<string, unknown>; } catch { /* not JSON */ }
      requests.push({ url: req.url, auth: req.headers.authorization ?? null, ...json });
      if (!req.url?.includes('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
      const messages = Array.isArray(json.messages) ? json.messages as Array<{ role?: string }> : [];
      const done = messages.some((m) => m.role === 'tool');
      const id = `chatcmpl-fake-${requests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const delta = done
        ? { role: 'assistant', content: 'Wrote hello.txt (a FAKE server answer).' }
        : { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'edit', arguments: JSON.stringify({ file_path: target, old_string: '', new_string: 'hello from a fake model\n' }) } }] };
      const finish = done ? 'stop' : 'tool_calls';
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (json.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: json.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: json.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        const message = done ? { role: 'assistant', content: delta.content } : { role: 'assistant', content: null, tool_calls: (delta as { tool_calls: unknown[] }).tool_calls };
        res.end(JSON.stringify({ id, object: 'chat.completion', created, model: json.model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    r({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`, requests });
  }));
}

describe('the real Qwen Code against a FAKE local OpenAI-compatible server', () => {
  realQwen('runs headless as a job: the endpoint is asked, the file is written, the stream is read, the result is sealed', async () => {
    const root = project();
    const home = temp('agent-home-');
    const fake = await fakeOpenAi(join(root, 'hello.txt'));
    try {
      // the real qwen runs with a throwaway HOME (TIMMY_AGENT_HOME), so no one's ~/.qwen is read or written
      const { ws, sealed } = make(root, { TIMMY_AGENT_QWEN_BIN: REAL_QWEN!, TIMMY_AGENT_MODEL: 'fake-model', TIMMY_AGENT_BASE_URL: fake.url, TIMMY_AGENT_WALL_TIME: '60s', TIMMY_AGENT_HOME: home });
      const out = text(await ws.agent('qwen create hello.txt saying hello'));
      const job = await ws.jobs.done(jobIdOf(out));
      const r = resultOf(root);
      // eslint-disable-next-line no-console
      console.log('real qwen:', JSON.stringify({ state: job.state, exit: job.exitCode, outcome: r.outcome, why: r.why, files: r.files, progress: r.progress, requests: fake.requests.length }));
      if (process.env.TIMMY_TEST_QWEN_DEBUG) console.log(readFileSync(join(root, AGENTS_DIR, r.run, 'transcript.log'), 'utf8'));
      expect(fake.requests.length).toBeGreaterThan(0);
      expect(r.agent_version).toMatch(/0\.25\.0/);
      expect(r.endpoint).toBe('local');
      expect(sealed.find((s) => s.kind === 'agent')).toBeTruthy();
      expect(r.outcome).toBe('completed');
      expect(r.files!.added.map((f) => f.path)).toEqual(['hello.txt']);
      expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello from a fake model\n');
      expect(r.progress).toMatchObject({ tool_calls: 1, files_edited: ['hello.txt'], denied: [] });
      expect(readFileSync(join(root, AGENTS_DIR, r.run, 'final-message.md'), 'utf8')).toBe('Wrote hello.txt (a FAKE server answer).');
      expect(r).toMatchObject({ cost_usd: 0, cost_basis: 'local endpoint', model: 'fake-model' });
      // what the endpoint was asked: the model named on the command line
      expect(fake.requests.some((q) => q.model === 'fake-model')).toBe(true);
      // the key reached the endpoint from the child's environment (OPENAI_API_KEY), not from a command-line flag
      expect(fake.requests.filter((q) => String(q.url).includes('/chat/completions')).every((q) => q.auth === 'Bearer ollama')).toBe(true);
      expect(existsSync(join(home, '.qwen'))).toBe(true);
    } finally {
      fake.server.close();
    }
  }, 120_000);
});
