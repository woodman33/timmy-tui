/**
 * Round R4 (helper H52): OpenHands as a Timmy code agent, `/agent openhands --local <task>`, in a container with a local
 * model only, through /agent's own contract (a job, .timmy/agents/<run>/, a sealed receipt, the endpoint rule, the change
 * judge, /stop, recovery).
 *
 * Real files, real child processes, real job lifecycles and real signals; the FAKE pieces, each labelled:
 * - tests/fixtures/fake-docker.mjs, a TEST DOUBLE of the docker client (it starts no container, runs no OpenHands and
 *   calls no model): it keeps a FAKE daemon as files (its images and containers), checks the `docker run` command line
 *   Timmy's route must give, plays a SCRIPTED agent that edits the copy mounted at /work and prints the worker's JSON
 *   Lines, and honours `stop` and `kill` by name. It is put on PATH as `docker` (a link in a temporary folder);
 * - a FAKE Ollama: an HTTP server on 127.0.0.1 answering GET /api/tags with a model list, and nothing else.
 * No test runs Docker, OpenHands, a model or the real worker (workers/openhands/timmy_openhands.py is compiled only:
 * `python3 -m py_compile`). What a real run on the operator's Mac must check is in the report of round R4, H52.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { capabilities, type ProbeDeps } from '../src/capabilities/index.js';
import { capabilityLines } from '../src/capabilities/render.js';
import { agentBin, agentExercisedIndex, AGENTS_DIR, judgeAgentRun, listAgentRuns, newProgress, parseAgentLine, planAgent, progressLine, type AgentRunRecord } from '../src/code-agents/index.js';
import {
  bindMount, containerOllama, hostUser, judgeOpenHands, OPENHANDS_BUILD, OPENHANDS_BUILD_SHORT, OPENHANDS_IMAGE, OPENHANDS_NO_DOCKER, OPENHANDS_NO_PAID,
  OPENHANDS_NOT_ITERATE, OPENHANDS_NOTE, OPENHANDS_ONLY_LOCAL, openHandsCapabilityRow, openHandsDockerArgs, openHandsProgressLine, openHandsRouteWords, openHandsSaid,
  PLAIN_SHOWN, watchOpenHands, workRel, type ContainerStop, type OpenHandsDocker,
} from '../src/code-agents/openhands.js';
import { dockerCall, dockerSetup } from '../src/code-agents/openhands-run.js';
import { JobManager } from '../src/jobs/index.js';
import { folderProject, projectId } from '../src/project/index.js';
import { realOnPath } from '../src/repl/center.js';
import { parseIterateLine } from '../src/repl/iterate.js';
import { CLIENT_EXIT_MS, limitHead, OpenHandsRuns, STOP_ANSWER_MS, stoppedHow, type OpenHandsRunState } from '../src/repl/openhands.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { actStopReason } from '../src/utils/stop-words.js';
import { routeWords } from '../src/room/index.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FAKE_DOCKER = resolve('tests/fixtures/fake-docker.mjs');
const WORKER = resolve('workers/openhands/timmy_openhands.py');
const IMAGE_ID = `sha256:${'ab'.repeat(32)}`;

const dirs: string[] = [];
const spaces: Workspace[] = [];
const servers: Server[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(25); }
}
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 60_000);

/** A FAKE Ollama on 127.0.0.1: GET /api/tags lists `models`; anything else is 404. */
async function fakeOllama(models: string[]): Promise<{ url: string; host: string; port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: models.map((name) => ({ name })) })); return; }
    res.writeHead(404); res.end('not here (a FAKE Ollama)');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, host: `127.0.0.1:${port}`, port, requests };
}

interface Call { argv: string[]; keys: Record<string, string | null> }
/** The FAKE docker, on PATH as `docker`, with its FAKE daemon's state in its own folder (DOCKER_CONFIG). `signalDelayMs`:
 *  how late its FAKE daemon delivers a signal to a container (OrbStack on the loaded Mac took 5 to 7 s: ledger row 159). */
function fakeDocker(o: { image?: 'ready' | 'missing' | 'other'; down?: boolean; signalDelayMs?: number } = {}) {
  const state = temp('oh-docker-');
  const bin = temp('oh-bin-');
  symlinkSync(FAKE_DOCKER, join(bin, 'docker'));
  if (o.down) writeFileSync(join(state, 'daemon-down'), '');
  if (o.signalDelayMs) writeFileSync(join(state, 'signal-delay-ms'), String(o.signalDelayMs));
  const image = o.image ?? 'ready';
  if (image !== 'missing') writeFileSync(join(state, 'images.json'), JSON.stringify({ [OPENHANDS_IMAGE]: { id: IMAGE_ID, labels: image === 'ready' ? { 'timmy.openhands.sdk': '1.21.0' } : { other: 'x' } } }));
  const calls = (): Call[] => { try { return readFileSync(join(state, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } };
  const containerFile = (name: string): string => join(state, 'containers', `${name}.json`);
  const report = (name: string): { argv: string[]; labels: Record<string, string>; mounts: Array<Record<string, unknown>>; env: Record<string, string | null>; user: string | null; stdin: { open: boolean; bytes: number; v: number | null; task: string; token_length: number } } => JSON.parse(readFileSync(join(state, 'runs', `${name}.json`), 'utf8'));
  /** R4 (H62): every SIGTERM or SIGINT a FAKE docker client received (it forwards them to its container, as docker's does). */
  const clientSignals = (): Array<{ name: string; signal: string }> => { try { return readFileSync(join(state, 'client-signals.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { name: string; signal: string }); } catch { return []; } };
  return { state, bin, calls, containerFile, report, clientSignals };
}
type Dock = ReturnType<typeof fakeDocker>;

const ohEnv = (dock: Dock, url: string, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${dock.bin}${delimiter}${process.env.PATH ?? ''}`, DOCKER_CONFIG: dock.state, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_AGENT_BASE_URL: url, ...extra,
});

function project(): string {
  const root = temp('oh-proj-');
  put(root, 'src/a.txt', 'first line\n');
  put(root, 'old.txt', 'to be deleted\n');
  put(root, 'node_modules/x/index.js', 'never copied\n');
  put(root, '.git/config', '[core]\n');
  put(root, 'dist/out.js', 'never copied\n');
  return root;
}

function make(root: string, env: Record<string, string>, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env,
    // the REPL's own PATH lookup (src/repl/center.ts realOnPath), over this test's PATH: the FAKE docker is found first
    onPath: (cmd) => realOnPath(cmd, env),
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('oh-jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, ts: new Date(Date.now() + i).toISOString(), hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

const jobIdOf = (out: string): string => { const m = out.match(/\b(j[0-9a-f]{6})\b/); if (!m) throw new Error(`no job id in: ${out}`); return m[1]; };
const resultOf = (root: string): AgentRunRecord => listAgentRuns(root)[0];
const runAgent = async (ws: Workspace, line: string) => { const out = text(await ws.agent(line)); return { out, job: await ws.jobs.done(jobIdOf(out)) }; };
const exercised = (sealed: ReceiptInput[]): string[] => [...agentExercisedIndex(sealed.map((s) => ({ ...s, ts: '2026-10-10T05:00:00Z' })) as unknown as Array<Record<string, unknown>>).keys()];
/** The docker commands the FAKE docker was given, by their first words. */
const commands = (dock: Dock): string[] => dock.calls().map((c) => (c.argv[0] === 'image' ? `image ${c.argv[1]}` : c.argv[0]));

// ── the plan ─────────────────────────────────────────────────────────────────────

describe('the plan: the SDK in Timmy\'s container, on a copy of the project, with this machine\'s Ollama', () => {
  it('the exact docker command line: limits, labels, the copy and the worker mounted, no key but the local placeholder; the task on stdin', () => {
    const root = temp('oh-plan-');
    const r = planAgent('openhands', 'add a test', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b' }, paid: false, local: true, run: 'a00000001', bin: 'docker', root });
    if (!r.ok) throw new Error(r.error);
    const dir = join(root, AGENTS_DIR, 'a00000001');
    const user = hostUser();
    expect(r.plan.args).toEqual([
      'run', '--rm', '-i', '--pull', 'never', '--name', 'timmy-oh-a00000001',
      '--label', 'timmy.run=a00000001', '--label', `timmy.project=${projectId(root)}`,
      '--cpus', '2', '--memory', '4g', '--memory-swap', '4g', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      ...(user ? ['--user', user] : []),
      '--tmpfs', '/tmp/timmy-home:rw,nosuid,nodev,size=512m,mode=1777', '--add-host', 'host.docker.internal:host-gateway',
      '--mount', `type=bind,source=${join(dir, 'work')},target=/work`, '--mount', `type=bind,source=${join(dir, 'worker')},target=/timmy,readonly`,
      '--workdir', '/work',
      '-e', 'HOME=/tmp/timmy-home', '-e', 'USER=timmy', '-e', 'LLM_BASE_URL=http://host.docker.internal:11434', '-e', 'LLM_MODEL=ollama/qwen3:4b', '-e', 'LLM_API_KEY=ollama',
      '-e', 'TIMMY_OPENHANDS_MAX_ITERATIONS=40', '-e', 'LITELLM_LOCAL_MODEL_COST_MAP=True', '-e', 'OPENHANDS_SUPPRESS_BANNER=1', '-e', 'PYTHONUNBUFFERED=1', '-e', 'PYTHONDONTWRITEBYTECODE=1',
      'timmy-openhands:1.21.0', 'python', '/timmy/timmy_openhands.py',
    ]);
    expect(r.plan).toMatchObject({ agent: 'openhands', command: 'docker', model: 'qwen3:4b', endpoint: 'local', where: '127.0.0.1:11434', charge: 'local endpoint, no charge', costBasis: 'local endpoint', note: OPENHANDS_NOTE, wallTime: '15m', timeoutMs: 15 * 60_000 + 30_000 });
    // R4 (H62): the job's own limit, the backstop, a minute above OpenHands' own (where its container is stopped first)
    expect(r.plan.jobTimeoutMs).toBe(15 * 60_000 + 30_000 + 60_000);
    // no -e without a value (docker would take the client's own), no host network, no socket, nothing privileged
    const joined = r.plan.args.join(' ');
    expect(joined).not.toMatch(/--privileged|--network|docker\.sock|--cap-add|-v |--volume|--env-file/);
    for (let i = 0; i < r.plan.args.length; i++) if (r.plan.args[i] === '-e') expect(r.plan.args[i + 1]).toContain('=');
    // the task is never on the command line: it goes on the worker's stdin, with the run's token
    expect(joined).not.toContain('add a test');
    const stdin = JSON.parse(r.plan.stdinText!) as { v: number; task: string; token: string };
    expect(stdin).toEqual({ v: 1, task: 'add a test', token: r.plan.container!.token });
    expect(stdin.token).toMatch(/^[0-9a-f]{32}$/);
    // Timmy's keys are blank in the docker client's own environment
    expect(r.plan.env).toEqual({ OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '', TIMMY_AGENT_API_KEY: '', LLM_API_KEY: '' });
    expect(OPENHANDS_NOTE).toContain('the container can reach the network');
    expect(OPENHANDS_NOTE).toContain('only that copy is mounted');
    expect(OPENHANDS_NOTE).toContain('the model is this machine\'s Ollama');
  });

  it('free only on this machine with a model whose tag does not end in cloud; --paid and a bare /agent openhands are refused with the reason', () => {
    const plan = (env: Record<string, string>, o: { paid?: boolean; local?: boolean } = {}) => planAgent('openhands', 'x', { env: { TIMMY_AGENT_MODEL: 'qwen3:4b', ...env }, paid: o.paid ?? false, ...(o.local === false ? {} : { local: true }), run: 'a00000002', bin: 'docker', root: '/proj' });
    for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://[::1]:11434/v1']) expect(plan({ TIMMY_AGENT_BASE_URL: url }).ok, url).toBe(true);
    for (const model of ['gpt-oss:120b-cloud', 'glm-5.3:cloud']) expect(plan({ TIMMY_AGENT_MODEL: model })).toMatchObject({ ok: false, refused: 'paid', error: expect.stringContaining('is a cloud model') });
    expect(plan({ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' })).toMatchObject({ ok: false, refused: 'paid', error: expect.stringContaining('models.example.com is not this machine') });
    const creds = plan({ TIMMY_AGENT_BASE_URL: 'http://user:pw@127.0.0.1:11434/v1' });
    expect(creds).toMatchObject({ ok: false, refused: 'setup' });
    expect(JSON.stringify(creds)).not.toContain('pw@');
    expect(planAgent('openhands', 'x', { env: {}, paid: false, local: true, run: 'a00000003', bin: 'docker', root: '/proj' })).toMatchObject({ ok: false, refused: 'setup', error: expect.stringContaining('Set TIMMY_AGENT_MODEL') });
    expect(plan({ TIMMY_AGENT_MODEL: 'qwen3 4b; rm -rf' })).toMatchObject({ ok: false, refused: 'setup' });
    expect(plan({ TIMMY_OPENHANDS_MAX_ITERATIONS: '0' })).toMatchObject({ ok: false, refused: 'setup', error: expect.stringContaining('TIMMY_OPENHANDS_MAX_ITERATIONS') });
    expect(plan({ TIMMY_OPENHANDS_MAX_ITERATIONS: '12' }).ok && (plan({ TIMMY_OPENHANDS_MAX_ITERATIONS: '12' }) as { plan: { args: string[] } }).plan.args).toContain('TIMMY_OPENHANDS_MAX_ITERATIONS=12');
    // --paid is refused for OpenHands in this round, whatever else the line says
    expect(plan({}, { paid: true })).toEqual({ ok: false, refused: 'usage', error: OPENHANDS_NO_PAID });
    expect(OPENHANDS_NO_PAID).toContain('A paid route would send the task and the copy of the project to a remote model, and none has been checked');
    expect(plan({}, { paid: true, local: false })).toEqual({ ok: false, refused: 'usage', error: OPENHANDS_NO_PAID });
    expect(plan({}, { local: false })).toEqual({ ok: false, refused: 'usage', error: OPENHANDS_ONLY_LOCAL });
    expect(parseAgentLine('openhands --local fix the bug')).toEqual({ name: 'openhands', word: 'openhands', paid: false, local: true, task: 'fix the bug' });
    expect(parseAgentLine('openhands --paid fix it')).toEqual({ name: 'openhands', word: 'openhands', paid: true, task: 'fix it' });
  });

  it('a mount source with a comma or a quote is quoted as docker\'s --mount reads it (CSV); this machine\'s Ollama as the container sees it', () => {
    expect(bindMount('/a/b', '/work')).toBe('type=bind,source=/a/b,target=/work');
    expect(bindMount('/a,b/c "d"', '/timmy', true)).toBe('type=bind,"source=/a,b/c ""d""",target=/timmy,readonly');
    expect(containerOllama('http://127.0.0.1:11434/v1')).toBe('http://host.docker.internal:11434');
    expect(containerOllama('http://localhost:8080/ollama/v1/')).toBe('http://host.docker.internal:8080/ollama');
    expect(containerOllama('ftp://127.0.0.1/x')).toBeUndefined();
    const root = temp('oh-plan-');
    const odd = join(root, 'my, "odd" project');
    mkdirSync(odd);
    const r = planAgent('openhands', 'x', { env: { TIMMY_AGENT_MODEL: 'm' }, paid: false, local: true, run: 'a00000004', bin: 'docker', root: odd });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.args).toContain(`type=bind,"source=${join(odd, AGENTS_DIR, 'a00000004', 'work').replace(/"/g, '""')}",target=/work`);
  });

  it('/iterate does not take OpenHands in this round, and says why', () => {
    expect(parseIterateLine('tray widen it --agent openhands')).toEqual({ ok: false, error: OPENHANDS_NOT_ITERATE });
    expect(OPENHANDS_NOT_ITERATE).toContain('its changes reach the project only through Timmy\'s write-back at its end');
  });
});

// ── its lines ────────────────────────────────────────────────────────────────────

describe('its lines: only a JSON line with the run\'s token is read; hostile lines are counted, named once and never believed', () => {
  const TOKEN = 'c'.repeat(32);
  const line = (o: Record<string, unknown>): string => JSON.stringify({ v: 1, token: TOKEN, ...o });
  const fresh = () => { const s = newProgress(); watchOpenHands(s, TOKEN); return s; };

  it('started, actions (file edits noted from /work paths), observations, messages, errors, events and the result', () => {
    const s = fresh();
    const shown = [
      line({ type: 'started', sdk: '1.21.0', model: 'ollama/qwen3:4b', tools: ['terminal', 'file_editor'], max_iterations: 40 }),
      line({ type: 'action', n: 1, tool: 'terminal', command: 'cat /proj/src/a.txt' }),
      line({ type: 'observation', n: 1, tool: 'terminal', error: false, exit_code: 0, excerpt: 'first' }),
      line({ type: 'action', n: 2, tool: 'file_editor', command: 'str_replace', path: '/work/src/a.txt' }),
      line({ type: 'action', n: 3, tool: 'file_editor', command: 'view', path: '/work/src/b.txt' }),
      line({ type: 'action', n: 4, tool: 'file_editor', command: 'create', path: 'notes/x.md' }),
      line({ type: 'observation', n: 4, tool: 'file_editor', error: true, excerpt: 'Invalid `path` parameter' }),
      line({ type: 'observation', n: 5, tool: 'terminal', error: false, exit_code: 2 }),
      line({ type: 'message', source: 'agent', excerpt: 'I edited /proj/src/a.txt.' }),
      line({ type: 'error', tool: 'file_editor', excerpt: 'a tool call was not valid' }),
      line({ type: 'event', kind: 'CondensationEvent' }),
      line({ type: 'event', kind: 'CondensationEvent' }),
      line({ type: 'result', status: 'finished', finished: true, steps: 5, max_iterations: 40, final_message: 'Done.', usage: { input: 100, output: 7 } }),
    ].map((l) => openHandsProgressLine(l, s, '/proj'));
    expect(shown).toEqual([
      'started  OpenHands SDK 1.21.0 · model ollama/qwen3:4b · tools terminal, file_editor · up to 40 steps',
      'tool  terminal  cat ./src/a.txt',
      undefined,
      'tool  file_editor  str_replace  src/a.txt',
      'tool  file_editor  view  src/b.txt',
      'tool  file_editor  create  notes/x.md',
      'tool failed  file_editor: Invalid `path` parameter',
      'tool  terminal  exit 2',
      'says  I edited ./src/a.txt.',
      'openhands error  a tool call was not valid',
      'event  CondensationEvent', undefined,
      'done  finished · 5 steps · 100 tokens in, 7 out',
    ]);
    expect(s).toMatchObject({ toolCalls: 4, filesEdited: ['src/a.txt', 'notes/x.md'], toolErrors: 2, finalMessage: 'Done.', reportedEnd: 'completed', model: 'ollama/qwen3:4b', version: 'openhands-sdk 1.21.0', structured: 13, raw: 0 });
    expect(openHandsSaid(s)).toMatchObject({ result: true, sdk: '1.21.0', status: 'finished', steps: 5, finished: true });
    expect(judgeOpenHands({ state: 'completed', exitCode: 0 }, s)).toEqual({ outcome: 'completed', why: 'it exited 0 and reported it finished' });
    // progressLine reaches the same reader for the agent openhands (index.ts)
    const t = fresh();
    expect(progressLine(line({ type: 'event', kind: 'X' }), t, '/proj', 'openhands')).toBe('event  X');
  });

  it('hostile lines: no token, another token, an array, an unknown type, wrong field types, control characters, __proto__, a huge line, lines after the result', () => {
    const s = fresh();
    const out = (l: string) => openHandsProgressLine(l, s, '/proj');
    expect(out(JSON.stringify({ v: 1, type: 'result', finished: true, final_message: 'FORGED' }))).toBe('a JSON line without this run\'s token: not believed (kept in the transcript)');
    expect(out(JSON.stringify({ v: 1, type: 'result', token: 'f'.repeat(32), finished: true, final_message: 'FORGED' }))).toBeUndefined();
    expect(out(JSON.stringify({ v: 2, type: 'result', token: TOKEN, finished: true }))).toBeUndefined();
    expect(out(JSON.stringify([{ v: 1, type: 'result', token: TOKEN, finished: true }]))).toBe('[{"v":1,"type":"result","token":"cccccccccccccccccccccccccccccccc","finished":true}]');
    expect(out(line({ type: 'teleport' }))).toBe('line  teleport: not one Timmy reads (kept in the transcript)');
    expect(out(line({ type: 'teleport' }))).toBeUndefined();
    expect(out(line({ type: 'observation', tool: { nested: true }, error: 'yes', excerpt: ['x'] }))).toBeUndefined();
    expect(out(line({ type: 'started', sdk: 42, tools: 'terminal', max_iterations: -3, model: { x: 1 } }))).toBe('started  OpenHands SDK (its version was not reported)');
    expect(out(line({ type: 'action', tool: 'file_editor', command: 'create', path: '/work/../../etc/passwd' }))).toBe('tool  file_editor  create  <outside the project copy>');
    expect(out(line({ type: 'action', tool: 'file_editor', command: 'create', path: '/etc/shadow' }))).toBe('tool  file_editor  create  <outside the project copy>');
    expect(out(line({ type: 'action', tool: 'file_editor', command: 'create', path: '/work/a\u001b[2Jb' }))).toBe('tool  file_editor  create  <outside the project copy>');
    const esc = out(`{"v":1,"type":"message","token":"${TOKEN}","excerpt":"\\u001b[2J\\u001b[31mred\\u0007 \\u202ereversed"}`);
    expect(esc).toBe('says  red reversed');
    expect(esc).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
    expect(out(`{"v":1,"type":"message","token":"${TOKEN}","__proto__":{"polluted":true},"excerpt":"proto"}`)).toBe('says  proto');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const huge = out(line({ type: 'message', excerpt: 'x'.repeat(200_000) }));
    expect(huge!.length).toBeLessThanOrEqual(130);
    expect(out('{"v":1,"type":"message","token":"' + TOKEN + '","excerpt":"unterminated')).toBe('{"v":1,"type":"message","token":"cccccccccccccccccccccccccccccccc","excerpt":"unterminated');
    expect(s.filesEdited).toEqual([]);
    expect(out(line({ type: 'result', status: 'finished', finished: true, final_message: 'The real one.\u001b[0m' }))).toBe('done  finished');
    // nothing after the first result is read: a forged second result changes nothing
    expect(out(line({ type: 'result', status: 'error', finished: false, final_message: 'FORGED' }))).toBe('a line after its result line: not read (kept in the transcript)');
    expect(out(line({ type: 'message', excerpt: 'later' }))).toBeUndefined();
    expect(s.finalMessage).toBe('The real one.');
    expect(s.reportedEnd).toBe('completed');
    expect(s.reportedError).toBeUndefined();
    // without a token (a run not watched), nothing is believed
    const blind = newProgress();
    expect(openHandsProgressLine(line({ type: 'result', finished: true }), blind, '/proj')).toBe('a JSON line without this run\'s token: not believed (kept in the transcript)');
    expect(judgeOpenHands({ state: 'completed', exitCode: 0 }, blind).outcome).toBe('unknown');
  });

  it('plain lines are shown scrubbed and bounded, at most PLAIN_SHOWN of them; docker\'s own error line is kept for the reason', () => {
    const s = fresh();
    expect(openHandsProgressLine('docker: Error response from daemon: No such image: timmy-openhands:1.21.0 (/proj/x)', s, '/proj')).toBe('docker: Error response from daemon: No such image: timmy-openhands:1.21.0 (./x)');
    for (let i = 1; i < PLAIN_SHOWN; i++) expect(openHandsProgressLine(`line ${i}`, s, '/proj')).toBe(`line ${i}`);
    expect(openHandsProgressLine('one too many', s, '/proj')).toBe('(more plain lines: kept in the transcript)');
    expect(openHandsProgressLine('and another', s, '/proj')).toBeUndefined();
    expect(s.raw).toBe(PLAIN_SHOWN + 2);
    expect(openHandsSaid(s).dockerError).toBe('docker: Error response from daemon: No such image: timmy-openhands:1.21.0 (./x)');
    expect(judgeOpenHands({ state: 'failed', exitCode: 125 }, s)).toEqual({ outcome: 'failed', why: 'docker could not start its container (exit 125): docker: Error response from daemon: No such image: timmy-openhands:1.21.0 (./x)' });
  });

  it('how a run ended: cancelled, timed out, not finished, no result line, nothing readable', () => {
    const s = fresh();
    expect(judgeOpenHands({ state: 'cancelled' }, s).outcome).toBe('cancelled');
    expect(judgeOpenHands({ state: 'failed', error: 'timed out' }, s).outcome).toBe('timed out');
    expect(judgeOpenHands({ state: 'completed', exitCode: 0 }, s)).toMatchObject({ outcome: 'unknown', why: expect.stringContaining('no line with its token') });
    openHandsProgressLine(line({ type: 'started', sdk: '1.21.0' }), s, '/proj');
    expect(judgeOpenHands({ state: 'completed', exitCode: 0 }, s)).toMatchObject({ outcome: 'unknown', why: expect.stringContaining('never gave its result line') });
    openHandsProgressLine(line({ type: 'result', status: 'limit', finished: false, max_iterations: 40 }), s, '/proj');
    expect(judgeOpenHands({ state: 'failed', exitCode: 3 }, s)).toEqual({ outcome: 'failed', why: 'it did not finish: its step limit (40) was reached (exit 3)' });
    expect(judgeAgentRun({ state: 'completed', exitCode: 0 }, s, 'openhands')).toEqual({ outcome: 'failed', why: 'it exited 0 but it did not finish: its step limit (40) was reached' });
    // R4 (H62): a stopped run says the worker's own last line (read with its token) beside how it was stopped, or that it gave none
    expect(judgeOpenHands({ state: 'cancelled' }, fresh())).toEqual({ outcome: 'cancelled', why: 'stopped with /stop (or the REPL ended) before it finished; the worker gave no last line of its own (what it printed is kept in transcript.log)' });
    const stopped = fresh();
    expect(openHandsProgressLine(line({ type: 'result', status: 'stopped', finished: false, steps: 3, max_iterations: 40, signal: 'SIGTERM', usage: { input: 1200, output: 34 } }), stopped, '/proj')).toBe('done  not finished: it was stopped (SIGTERM) · 3 steps · 1,200 tokens in, 34 out');
    expect(openHandsSaid(stopped)).toMatchObject({ result: true, status: 'stopped', steps: 3, signal: 'SIGTERM' });
    expect(judgeOpenHands({ state: 'cancelled', exitCode: 143 }, stopped, 'by timmy act (SIGTERM received)')).toEqual({ outcome: 'cancelled', why: 'stopped by timmy act (SIGTERM received) before it finished; the worker\'s own last line: stopped at step 3 (SIGTERM), 1,200 tokens in, 34 out' });
    expect(judgeOpenHands({ state: 'failed', error: 'timed out' }, stopped)).toEqual({ outcome: 'timed out', why: 'Timmy\'s time limit ended it (its wall time and a grace period); the worker\'s own last line: stopped at step 3 (SIGTERM), 1,200 tokens in, 34 out' });
    // a signal name is read only as one (SIGTERM, SIGINT), never as other text
    const odd = fresh();
    openHandsProgressLine(line({ type: 'result', status: 'stopped', finished: false, signal: 'SIGTERM; rm -rf /' }), odd, '/proj');
    expect(openHandsSaid(odd).signal).toBeUndefined();
    expect(workRel('/work')).toBeUndefined();
    expect(workRel('./a/./b')).toBe('a/b');
    expect(workRel('~/x')).toBeUndefined();
  });
});

// ── needs setup ──────────────────────────────────────────────────────────────────

describe('needs setup: without docker, its daemon, the image or the model, nothing is started and nothing is written (FAKE docker)', () => {
  it('each refusal says the exact step; Timmy never builds or pulls the image', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const cases: Array<[Dock | 'none', RegExp]> = [
      ['none', /^ {2}docker is not on PATH: OpenHands runs in a container \(a Docker engine such as OrbStack, Docker Desktop or Rancher Desktop provides docker\)\. Nothing was started\.$/],
      [fakeDocker({ down: true }), /Needs setup: the Docker daemon did not answer \(Cannot connect to the Docker daemon at unix:\/\/\/var\/run\/docker\.sock\. Is the docker daemon running\?\): start your Docker engine \(OrbStack, Docker Desktop or Rancher Desktop\), then \/agent openhands --local again\. Nothing was started\./],
      [fakeDocker({ image: 'missing' }), new RegExp(`Needs setup: the image timmy-openhands:1\\.21\\.0 is not built\\. Build it once, in .+: ${OPENHANDS_BUILD.replace(/[.]/g, '\\.')} \\(Timmy never builds or pulls it by itself\\)\\. Nothing was started\\.`)],
      [fakeDocker({ image: 'other' }), /Needs setup: the image timmy-openhands:1\.21\.0 here was not built from workers\/openhands\/Dockerfile \(its timmy\.openhands\.sdk label is <no value>\)\. Build it again/],
    ];
    for (const [dock, want] of cases) {
      const root = project();
      const env = dock === 'none' ? { PATH: temp('oh-nobin-'), TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_AGENT_BASE_URL: ollama.url } : ohEnv(dock, ollama.url);
      const { ws, sealed } = make(root, env);
      const out = text(await ws.agent('openhands --local fix it'));
      expect(out).toMatch(want);
      expect(ws.jobs.list()).toEqual([]);
      expect(sealed).toEqual([]);
      expect(existsSync(join(root, AGENTS_DIR))).toBe(false);
      if (dock !== 'none') {
        expect(commands(dock).filter((c) => !['info', 'image inspect'].includes(c))).toEqual([]);
        expect(dock.calls().some((c) => /build|pull/.test(c.argv.join(' ')))).toBe(false);
      }
    }
    expect(OPENHANDS_NO_DOCKER).toContain('docker is not on PATH');
    // a model the local Ollama does not list: refused after the docker checks, before anything is written
    const dock = fakeDocker();
    const root = project();
    const { ws } = make(root, ohEnv(dock, ollama.url, { TIMMY_AGENT_MODEL: 'llama3.2:3b' }));
    expect(text(await ws.agent('openhands --local fix it'))).toContain(`The Ollama at ${ollama.host} does not list llama3.2:3b`);
    expect(existsSync(join(root, AGENTS_DIR))).toBe(false);
    // the flag rules, before docker is asked anything
    const plain = fakeDocker();
    const p = make(project(), ohEnv(plain, ollama.url));
    expect(text(await p.ws.agent('openhands fix it'))).toContain(OPENHANDS_ONLY_LOCAL);
    expect(text(await p.ws.agent('openhands --local --paid fix it'))).toContain(OPENHANDS_NO_PAID);
    expect(plain.calls()).toEqual([]);
  }, 60_000);

  it('/agent\'s list names OpenHands\' local route and what it needs', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const { ws } = make(project(), ohEnv(dock, ollama.url));
    const list = text(await ws.agent(''));
    expect(list).toMatch(/openhands\s+OpenHands\s+on PATH/);
    expect(list).toContain('--local only: model qwen3:4b on this machine\'s Ollama');
    expect(list).toContain('in a container (timmy-openhands:1.21.0), no charge; the image is checked when it runs');
    const bare = make(project(), { PATH: dock.bin });
    expect(text(await bare.ws.agent(''))).toContain('--local only: needs TIMMY_AGENT_MODEL (a model from ollama list); runs in a container');
  });
});

// ── a run ────────────────────────────────────────────────────────────────────────

describe('a run (FAKE docker, FAKE Ollama): the copy, the container, the write-back, the result and the receipt', () => {
  it('completed: its changes are written back, the originals kept in before/, the copy removed; one sealed receipt', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const keyNames = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'TIMMY_AGENT_API_KEY', 'LLM_API_KEY'] as const;
    // Built at run time, so no key-shaped literal sits in the source (the privacy gate); not a real key.
    const fake = ['sk', 'test', 'not', 'a', 'key', '0052'].join('-');
    const saved = Object.fromEntries(keyNames.map((k) => [k, process.env[k]]));
    for (const k of keyNames) process.env[k] = fake;
    try {
      const { ws, sealed, notes } = make(root, ohEnv(dock, ollama.url));
      const task = 'ADD DELETE: append a line to src/a.txt, add a new file and delete old.txt, then explain each change in detail';
      const { out, job } = await runAgent(ws, `openhands --local ${task}`);
      // the label: the agent, its run id and the first words of the task (the task itself is sealed only as its hash)
      expect(out).toMatch(/agent openhands a[0-9a-f]{8}: ADD DELETE: append a line to src\/a\.txt, add a…/);
      expect(out).toContain(`OpenHands timmy-openhands:1.21.0 (image abababababab, labelled openhands-sdk 1.21.0; docker 29.4.0-fake) · model qwen3:4b at ${ollama.host} · local endpoint, no charge`);
      expect(out).toContain(`Note       ${OPENHANDS_NOTE}`);
      expect(job).toMatchObject({ state: 'completed', exitCode: 0 });
      const r = resultOf(root);
      const run = r.run;
      const dir = join(root, AGENTS_DIR, run);
      expect(r).toMatchObject({
        agent: 'openhands', outcome: 'completed', endpoint: 'local', where: ollama.host, model: 'qwen3:4b', cost_usd: 0, cost_basis: 'local endpoint',
        agent_version: 'timmy-openhands:1.21.0 (image abababababab, labelled openhands-sdk 1.21.0; docker 29.4.0-fake)',
      });
      expect(r.why).toBe('it exited 0 and reported it finished; its changes were written into the project: 1 added, 1 changed, 1 deleted; the files it replaced or deleted are kept in ' + `${AGENTS_DIR}/${run}/before/`);
      // the project: the agent's changes, written back
      expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('first line\none more line (a FAKE OpenHands)\n');
      expect(readFileSync(join(root, 'src/new.txt'), 'utf8')).toBe('a new file (a FAKE OpenHands)\n');
      expect(existsSync(join(root, 'old.txt'))).toBe(false);
      // the judge: as for the other agents, from the project's own before/after comparison
      expect(r.files!.added.map((f) => f.path)).toEqual(['src/new.txt']);
      expect(r.files!.changed.map((f) => f.path)).toEqual(['src/a.txt']);
      expect(r.files!.deleted.map((f) => f.path)).toEqual(['old.txt']);
      // what it replaced or deleted, kept first
      expect(readFileSync(join(dir, 'before/src/a.txt'), 'utf8')).toBe('first line\n');
      expect(readFileSync(join(dir, 'before/old.txt'), 'utf8')).toBe('to be deleted\n');
      // the copy is gone once everything in it was written back; the worker that ran is kept, read-only
      expect(existsSync(join(dir, 'work'))).toBe(false);
      expect(readFileSync(join(dir, 'worker/timmy_openhands.py'))).toEqual(readFileSync(WORKER));
      expect(lstatSync(join(dir, 'worker/timmy_openhands.py')).mode & 0o222).toBe(0);
      expect(r.openhands).toMatchObject({
        image: OPENHANDS_IMAGE, image_id: IMAGE_ID,
        container: { name: `timmy-oh-${run}`, labels: { 'timmy.run': run, 'timmy.project': projectId(root) } },
        worker: { path: `${AGENTS_DIR}/${run}/worker/timmy_openhands.py`, sha256: sha(readFileSync(WORKER)) },
        limits: { cpus: '2', memory: '4g', pids: 512, max_iterations: 40 },
        copy: { path: `${AGENTS_DIR}/${run}/work`, files: 2, kept: false },
        reported: { sdk: '1.21.0', status: 'finished', steps: 4, tools: ['terminal', 'file_editor'] },
        writeback: { state: 'written', not_written: [] },
      });
      expect(r.openhands!.writeback!.written).toEqual([
        { path: 'old.txt', how: 'deleted', previous_sha256: sha('to be deleted\n'), kept: `${AGENTS_DIR}/${run}/before/old.txt` },
        { path: 'src/a.txt', how: 'changed', sha256: sha('first line\none more line (a FAKE OpenHands)\n'), previous_sha256: sha('first line\n'), kept: `${AGENTS_DIR}/${run}/before/src/a.txt` },
        { path: 'src/new.txt', how: 'added', sha256: sha('a new file (a FAKE OpenHands)\n') },
      ]);
      // what the FAKE docker was given: the planned command line (it refuses any other), the task on stdin with its token
      const report = dock.report(`timmy-oh-${run}`);
      const user = hostUser();
      expect(report.argv).toEqual(openHandsDockerArgs({
        name: `timmy-oh-${run}`, labels: { 'timmy.run': run, 'timmy.project': projectId(root) }, work: join(dir, 'work'), worker: join(dir, 'worker'),
        llmBase: `http://host.docker.internal:${ollama.port}`, llmModel: 'ollama/qwen3:4b', maxIterations: 40, ...(user ? { user } : {}),
      }));
      expect(report.stdin).toEqual({ open: false, bytes: expect.any(Number), v: 1, task, token_length: 32 });
      expect(report.env).toMatchObject({ LLM_API_KEY: 'ollama', LLM_MODEL: 'ollama/qwen3:4b', LLM_BASE_URL: `http://host.docker.internal:${ollama.port}`, HOME: '/tmp/timmy-home' });
      // the copy it was given: the project's files, never .git, node_modules, .timmy or dist
      expect(report.mounts.map((m) => m.target)).toEqual(['/work', '/timmy']);
      // every docker command ran with Timmy's keys blank in the client's environment; none built or pulled anything
      expect(commands(dock)).toEqual(['info', 'image inspect', 'run']);
      for (const c of dock.calls()) expect(c.keys).toEqual(Object.fromEntries(keyNames.map((k) => [k, ''])));
      // the FAKE Ollama was asked for its list once, before the run, and for nothing else
      expect(ollama.requests).toEqual(['GET /api/tags']);
      // progress, final message, transcript
      expect(readFileSync(join(dir, 'progress.log'), 'utf8').trim().split('\n')).toEqual([
        'started  OpenHands SDK 1.21.0 · model ollama/qwen3:4b · tools terminal, file_editor · up to 40 steps',
        'tool  terminal  cat /work/src/a.txt',
        'tool  file_editor  str_replace  src/a.txt',
        'tool  file_editor  create  src/new.txt',
        'tool  terminal  rm old.txt',
        'says  I changed src/a.txt (a FAKE OpenHands).',
        'done  finished · 4 steps · 1,200 tokens in, 34 out',
      ]);
      expect(r.progress).toMatchObject({ tool_calls: 4, files_edited: ['src/a.txt', 'src/new.txt'], tool_errors: 0, structured_lines: 9, raw_lines: 0 });
      expect(readFileSync(join(dir, 'final-message.md'), 'utf8')).toBe('Done: FINAL (a FAKE OpenHands).');
      expect(readFileSync(join(dir, 'transcript.log'), 'utf8')).toContain('"type":"result"');
      expect(JSON.parse(readFileSync(join(dir, 'container.json'), 'utf8'))).toMatchObject({ name: `timmy-oh-${run}`, image_id: IMAGE_ID, job: job.id, stops: [] });
      // one receipt, kind agent: local, cost 0, its container and write-back
      const rec = sealed.filter((s) => s.kind === 'agent');
      expect(rec).toHaveLength(1);
      expect(rec[0]).toMatchObject({
        status: 'ok', cost_usd: 0, model_requested: 'qwen3:4b',
        agent: { name: 'openhands', run, outcome: 'completed', endpoint: 'local', added: 1, changed: 1, deleted: ['old.txt'], tool_calls: 4, cost_basis: 'local endpoint' },
        job: { id: job.id, state: 'completed', exit_code: 0 },
        openhands: {
          image: OPENHANDS_IMAGE, image_id: IMAGE_ID, container: `timmy-oh-${run}`, labels: { 'timmy.run': run, 'timmy.project': projectId(root) },
          worker_sha256: sha(readFileSync(WORKER)), sdk_reported: '1.21.0', copy: { files: 2, kept: false }, writeback: { state: 'written', written: 3, not_written: 0 },
        },
      });
      expect(rec[0].files!.map((f) => f.path).sort()).toEqual(['src/a.txt', 'src/new.txt']);
      expect(JSON.stringify(rec[0])).not.toContain(task);
      // its run marks its own route exercised, never another's
      expect(exercised(sealed)).toEqual(['openhands']);
      // what the operator sees: the notice, /agent last, the Control Room
      await until(() => notes.some((n) => n.includes(`${job.id} completed`)));
      expect(notes.join('\n')).toContain(`${job.id} completed  agent openhands ${run}: 1 added, 1 changed, 1 deleted · written into the project (1 added, 1 changed, 1 deleted) · cost $0.0000 (local endpoint)`);
      const last = text(await ws.agent('last'));
      expect(last).toContain(`Container  timmy-oh-${run} · timmy-openhands:1.21.0 · it reported openhands-sdk 1.21.0 · a copy of 2 files (removed once written back) · written into the project (1 added, 1 changed, 1 deleted)`);
      expect(last).toContain('Said       Done: FINAL (a FAKE OpenHands).');
      const room = text(await ws.room(run));
      expect(room).toContain('local endpoint, no charge; in a container (timmy-openhands:1.21.0): only a copy of the project is mounted, the network is reachable, the model is this machine\'s Ollama');
      for (const shown of [out, last, notes.join('\n'), room, JSON.stringify(rec[0]), readFileSync(join(dir, 'result.json'), 'utf8')]) {
        expect(shown).not.toContain(root);
        expect(shown).not.toContain(tmpdir());
        expect(shown).not.toContain(fake);
      }
    } finally {
      for (const k of keyNames) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }, 60_000);

  it('a stale refusal: the project changed while it ran, so nothing is written; its changes stay in its copy', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const { ws, sealed } = make(root, ohEnv(dock, ollama.url));
    const { job } = await runAgent(ws, 'openhands --local TOUCHPROJECT ADD append a line');
    expect(job.state).toBe('completed');
    const r = resultOf(root);
    const dir = join(root, AGENTS_DIR, r.run);
    expect(r.outcome).toBe('failed');
    expect(r.why).toBe(`it finished in its container, but its changes were not written into the project: the project changed while it ran (src/a.txt changed); its changes are kept in ${AGENTS_DIR}/${r.run}/work/`);
    // the project holds the operator's edit only; nothing of the agent's
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('first line\nan edit by the operator meanwhile\n');
    expect(existsSync(join(root, 'src/new.txt'))).toBe(false);
    expect(existsSync(join(root, 'old.txt'))).toBe(true);
    // the agent's work, kept in its copy
    expect(readFileSync(join(dir, 'work/src/a.txt'), 'utf8')).toBe('first line\none more line (a FAKE OpenHands)\n');
    expect(readFileSync(join(dir, 'work/src/new.txt'), 'utf8')).toBe('a new file (a FAKE OpenHands)\n');
    expect(existsSync(join(dir, 'before'))).toBe(false);
    expect(r.openhands).toMatchObject({ copy: { kept: true }, writeback: { state: 'refused', written: [], changed_meanwhile: ['src/a.txt'] } });
    expect(r.openhands!.copy_changes!.added.map((x) => x.path)).toEqual(['src/new.txt']);
    expect(r.openhands!.copy_changes!.changed.map((x) => x.path)).toEqual(['src/a.txt']);
    // the operator's own edit is not called the agent's
    expect(r.files).toMatchObject({ added: [], changed: [], deleted: [] });
    expect(sealed.find((s) => s.kind === 'agent')).toMatchObject({ status: 'failed', agent: { outcome: 'failed', added: 0, changed: 0 }, openhands: { writeback: { state: 'refused', written: 0 } } });
    expect(exercised(sealed)).toEqual([]);
  }, 60_000);

  it('a link and .git written in its copy never come back; the rest does, and the result names what was not written', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const { ws } = make(root, ohEnv(dock, ollama.url));
    await runAgent(ws, 'openhands --local LINK GITDIR NESTED please');
    const r = resultOf(root);
    expect(r.outcome).toBe('completed');
    expect(r.why).toContain('; 2 changes were not (result.json names them)');
    expect(readFileSync(join(root, 'deep/er/file.txt'), 'utf8')).toBe('deep (a FAKE OpenHands)\n');
    expect(existsSync(join(root, 'link.txt'))).toBe(false);
    expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe('[core]\n');
    expect(r.openhands!.writeback!.not_written).toEqual([
      { path: 'link.txt', why: 'a link: links are never written back from the container' },
      { path: '.git/', why: 'not compared: .git, node_modules, .timmy and dist are never written back' },
    ]);
    expect(r.openhands!.copy.kept).toBe(true);
    expect(r.files!.added.map((x) => x.path)).toEqual(['deep/er/file.txt']);
  }, 60_000);

  it('a run that does not complete writes nothing: not finished, no result line, silent, and docker unable to start it', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const { ws, sealed } = make(root, ohEnv(dock, ollama.url));
    const cases: Array<[string, Partial<AgentRunRecord>, RegExp]> = [
      ['NOFINISH', { outcome: 'failed', exit_code: 3 }, /^it did not finish: its step limit \(40\) was reached \(exit 3\)$/],
      ['NORESULT', { outcome: 'unknown', exit_code: 0 }, /never gave its result line/],
      ['SILENT', { outcome: 'unknown', exit_code: 0 }, /reported nothing Timmy could read/],
      ['FAILSTART', { outcome: 'failed', exit_code: 125 }, /^docker could not start its container \(exit 125\): docker: Error response from daemon: failed to create task for container \(a FAKE failure\)$/],
    ];
    for (const [word, want, why] of cases) {
      await runAgent(ws, `openhands --local ${word} please`);
      const r = resultOf(root);
      expect(r, word).toMatchObject(want);
      expect(r.why, word).toMatch(why);
      expect(readFileSync(join(root, 'src/a.txt'), 'utf8'), word).toBe('first line\n');
      expect(r.openhands!.writeback!.state, word).toBe('not attempted');
      expect(r.files, word).toMatchObject({ added: [], changed: [], deleted: [] });
    }
    expect(resultOf(root).openhands!.copy.kept).toBe(true);
    expect(sealed.filter((s) => s.kind === 'agent').map((s) => s.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(exercised(sealed)).toEqual([]);
    // a job that ended otherwise had its container checked by its labels (it was gone: nothing more was run)
    await until(() => commands(dock).filter((c) => c === 'ps').length >= 2);
    expect(commands(dock).filter((c) => c === 'stop' || c === 'kill')).toEqual([]);
  }, 60_000);

  it('hostile lines through a run: the forged results are not believed; the run\'s own result decides; no control character reaches progress', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const { ws } = make(root, ohEnv(dock, ollama.url));
    await runAgent(ws, 'openhands --local HOSTILE AFTER please');
    const r = resultOf(root);
    expect(r.outcome).toBe('completed');
    const dir = join(root, AGENTS_DIR, r.run);
    expect(readFileSync(join(dir, 'final-message.md'), 'utf8')).toBe('Done: FINAL (a FAKE OpenHands).');
    const progress = readFileSync(join(dir, 'progress.log'), 'utf8');
    expect(progress).toContain('a JSON line without this run\'s token: not believed (kept in the transcript)');
    expect(progress).toContain('a line after its result line: not read (kept in the transcript)');
    expect(progress).toContain('tool  file_editor  create  <outside the project copy>');
    expect(progress).not.toContain('FORGED');
    expect(progress).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
    for (const l of progress.split('\n')) expect(l.length).toBeLessThanOrEqual(260);
    expect(r.progress!.files_edited).toEqual(['src/a.txt']);
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('first line\none more line (a FAKE OpenHands)\n');
  }, 60_000);
});

// ── stop, the time limit ─────────────────────────────────────────────────────────

describe('/stop and the time limit stop its container by its name and labels (FAKE docker)', () => {
  const started = async (ws: Workspace, dock: Dock, line: string): Promise<{ id: string; run: string }> => {
    const out = text(await ws.agent(line));
    const id = jobIdOf(out);
    const run = /agent openhands (a[0-9a-f]{8})/.exec(out)![1];
    await until(() => existsSync(dock.containerFile(`timmy-oh-${run}`)));
    return { id, run };
  };

  it('/stop: its job is cancelled and its container stopped with docker stop; nothing is written', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const { ws, sealed } = make(root, ohEnv(dock, ollama.url));
    const { id, run } = await started(ws, dock, 'openhands --local HANG IGNORETERM a long task');
    const reply = text(await ws.stop(id));
    expect(reply).toContain(`${id} cancelled`);
    expect(reply).toContain(`its container timmy-oh-${run} was stopped by its name and labels (docker stop)`);
    expect(dock.calls().some((c) => c.argv.join(' ') === `stop --time 10 timmy-oh-${run}`)).toBe(true);
    expect(dock.calls().some((c) => c.argv[0] === 'ps' && c.argv.includes(`label=timmy.run=${run}`) && c.argv.includes(`label=timmy.project=${projectId(root)}`))).toBe(true);
    expect(existsSync(dock.containerFile(`timmy-oh-${run}`))).toBe(false);
    const r = resultOf(root);
    expect(r).toMatchObject({ outcome: 'cancelled', openhands: { writeback: { state: 'not attempted' } } });
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('first line\n');
    expect(sealed.find((s) => s.kind === 'agent')).toMatchObject({ status: 'cancelled', job: { state: 'cancelled' } });
    const kept = JSON.parse(readFileSync(join(root, AGENTS_DIR, run, 'container.json'), 'utf8')) as { stops: Array<Record<string, unknown>> };
    expect(kept.stops).toEqual([expect.objectContaining({ why: 'stop', result: 'stopped', name: `timmy-oh-${run}`, steps: [{ command: `docker stop --time 10 timmy-oh-${run}`, exit: 0 }] })]);
  }, 60_000);

  it('a stop ends its container before its docker client, so the worker\'s own last line arrives even when docker delivers its signal late (row 159)', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    // The FAKE daemon delivers each signal to the container 3 s late: more than the job's own 2 s between SIGTERM and SIGKILL.
    const dock = fakeDocker({ signalDelayMs: 3000 });
    const root = project();
    const { ws, sealed } = make(root, ohEnv(dock, ollama.url));
    const { id, run } = await started(ws, dock, 'openhands --local HANG a long task');
    const reply = text(await ws.stop(id));
    expect(reply).toContain(`${id} cancelled`);
    expect(reply).toContain(`its container timmy-oh-${run} was stopped by its name and labels (docker stop)`);
    const dir = join(root, AGENTS_DIR, run);
    // the worker's own last line reached Timmy through its docker client: kept in the transcript, read into the progress
    expect(readFileSync(join(dir, 'transcript.log'), 'utf8')).toContain('"status":"stopped"');
    expect(readFileSync(join(dir, 'progress.log'), 'utf8')).toContain('done  not finished: it was stopped (SIGTERM) · 1 step · 900 tokens in, 30 out');
    // the order: its container first (docker stop), then its docker client ended by itself: no signal ever reached the client
    expect(dock.clientSignals()).toEqual([]);
    expect(ws.jobs.get(id)).toMatchObject({ state: 'cancelled', exitCode: 143, signal: null, cleanup: 'complete', stopOrder: { first: 'answered', group: 'ended by itself' } });
    // the run's result: who stopped it, how its container and then its client ended, and the worker's own words
    const name = `timmy-oh-${run}`;
    const r = resultOf(root);
    expect(r.why).toBe(`stopped with /stop before it finished: first docker stop ended its container ${name} (docker stop --time 10 ${name} exited 0), then its docker client ended by itself (exit 143); the worker's own last line: stopped at step 1 (SIGTERM), 900 tokens in, 30 out`);
    expect(r).toMatchObject({ outcome: 'cancelled', exit_code: 143, openhands: { reported: { status: 'stopped', steps: 1 }, client: { container_stop: 'answered', ended: 'by itself' }, writeback: { state: 'not attempted' } } });
    expect(r.openhands!.stop).toMatchObject({ why: 'stop', by: 'with /stop', result: 'stopped', steps: [{ command: `docker stop --time 10 ${name}`, exit: 0 }] });
    expect(r.openhands!.limit).toBeUndefined();
    expect(sealed.find((s) => s.kind === 'agent')).toMatchObject({
      status: 'cancelled', agent: { outcome: 'cancelled' },
      openhands: { stop: { why: 'stop', by: 'with /stop', result: 'stopped', steps: [{ command: `docker stop --time 10 ${name}`, exit: 0 }], client: 'by itself' } },
    });
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('first line\n');
  }, 60_000);

  it('end to end: Timmy\'s real worker (python3 on a FAKE SDK) in the FAKE container, stopped by /stop through docker stop: its own last line is in the result', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker({ signalDelayMs: 2500 });
    const root = project();
    const { ws, sealed } = make(root, ohEnv(dock, ollama.url));
    const { id, run } = await started(ws, dock, 'openhands --local PYWORKER HANG a long task');
    const dir = join(root, AGENTS_DIR, run);
    const progress = (): string => { try { return readFileSync(join(dir, 'progress.log'), 'utf8'); } catch { return ''; } };
    await until(() => progress().includes('tool  terminal  cat a.txt'));
    const reply = text(await ws.stop(id));
    expect(reply).toContain(`${id} cancelled`);
    const name = `timmy-oh-${run}`;
    expect(dock.clientSignals()).toEqual([]);
    expect(progress()).toContain('done  not finished: it was stopped (SIGTERM) · 2 steps · 900 tokens in, 30 out');
    const r = resultOf(root);
    expect(r.why).toBe(`stopped with /stop before it finished: first docker stop ended its container ${name} (docker stop --time 10 ${name} exited 0), then its docker client ended by itself (exit 143); the worker's own last line: stopped at step 2 (SIGTERM), 900 tokens in, 30 out`);
    // the real worker said what it is: no SDK version here (the FAKE SDK is no installed package), its status and steps
    expect(r.openhands!.reported).toMatchObject({ sdk: null, status: 'stopped', steps: 2 });
    expect(sealed.find((s) => s.kind === 'agent')).toMatchObject({ status: 'cancelled', openhands: { stop: { result: 'stopped', client: 'by itself' } } });
    expect(existsSync(dock.containerFile(name))).toBe(false);
  }, 60_000);

  it('Timmy\'s time limit takes the same order: OpenHands\' own limit stops the container first, before the job\'s own (the backstop); the worker\'s words arrive', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker({ signalDelayMs: 3000 });
    const root = project();
    const { ws, notes } = make(root, ohEnv(dock, ollama.url, { TIMMY_AGENT_WALL_TIME: '1s', TIMMY_AGENT_GRACE_MS: '0' }));
    const { out, job } = await runAgent(ws, 'openhands --local HANG forever');
    const run = /agent openhands (a[0-9a-f]{8})/.exec(out)![1];
    const name = `timmy-oh-${run}`;
    expect(job).toMatchObject({ state: 'failed', error: 'timed out', exitCode: 143, stopOrder: { first: 'answered', group: 'ended by itself' } });
    expect(dock.clientSignals()).toEqual([]);
    const r = resultOf(root);
    expect(r.why).toBe(`Timmy's time limit passed (1s: its wall time and a grace period): first docker stop ended its container ${name} (docker stop --time 10 ${name} exited 0), then its docker client ended by itself (exit 143); the worker's own last line: stopped at step 1 (SIGTERM), 900 tokens in, 30 out`);
    expect(r).toMatchObject({ outcome: 'timed out', openhands: { limit: { by: 'openhands', ms: 1000 }, stop: { why: 'time limit', result: 'stopped' }, client: { ended: 'by itself' } } });
    expect(r.openhands!.stop!.by).toBeUndefined();
    await until(() => notes.some((n) => n.includes('at Timmy\'s time limit')));
    expect(notes.join('\n')).toContain(`agent openhands ${run}  its container ${name} was stopped by its name and labels at Timmy's time limit (docker stop)`);
  }, 60_000);

  it('how Timmy stopped a run, in words: its container (each docker command with its exit), then what its docker client needed', () => {
    const name = 'timmy-oh-a1a1a1a1a';
    const s = (result: ContainerStop['result'], steps: ContainerStop['steps'] = [], detail?: string): ContainerStop => ({ why: 'stop', at: '', name, result, steps, ...(detail ? { detail } : {}) });
    const stop = (exit: number | null) => ({ command: `docker stop --time 10 ${name}`, exit });
    const kill = (exit: number | null) => ({ command: `docker kill ${name}`, exit });
    const byItself = { first: 'answered' as const, group: 'ended by itself' as const };
    expect(stoppedHow(s('stopped', [stop(0)]), { exitCode: 143, stopOrder: byItself })).toBe(`first docker stop ended its container ${name} (docker stop --time 10 ${name} exited 0), then its docker client ended by itself (exit 143)`);
    expect(stoppedHow(s('killed', [stop(1), kill(0)]), { exitCode: 137, stopOrder: byItself })).toBe(`first docker stop did not end its container ${name}, and docker kill did (docker stop --time 10 ${name} exited 1, then docker kill ${name} exited 0), then its docker client ended by itself (exit 137)`);
    expect(stoppedHow(s('ended', [stop(null), kill(1)]), { exitCode: 143, stopOrder: byItself })).toBe(`first its container ${name} ended while Timmy stopped it, not by docker kill (docker stop --time 10 ${name} gave no answer, then docker kill ${name} exited 1), then its docker client ended by itself (exit 143)`);
    expect(stoppedHow(s('gone'), { exitCode: 0, stopOrder: byItself })).toBe(`first its container ${name} had already ended, then its docker client ended by itself (exit 0)`);
    expect(stoppedHow(s('unchecked', [], 'docker ps: no answer'), { exitCode: 143, stopOrder: { first: 'answered', group: 'SIGTERM' } })).toBe(`first its container ${name} could not be checked (docker ps: no answer), then its docker client did not end by itself within 15s, so Timmy ended it (SIGTERM; exit 143)`);
    expect(stoppedHow(s('asked'), { signal: 'SIGKILL', stopOrder: { first: 'no answer', group: 'SIGKILL' } })).toBe(`first the stop of its container ${name} was asked (no answer within 1m 40s), then its docker client did not end by itself within 15s, so Timmy ended it (SIGTERM, then SIGKILL; signal SIGKILL)`);
    expect(stoppedHow(undefined, { exitCode: 0 })).toBe('its docker client had already ended (exit 0) before Timmy stopped its container; its container is checked by its name and labels after its job\'s end');
    expect(stoppedHow(s('stopped', [stop(0)]), { exitCode: 143 })).toBe(`first docker stop ended its container ${name} (docker stop --time 10 ${name} exited 0), then its docker client had ended (exit 143)`);
  });

  it('the job\'s own limit, the backstop, takes the same first part (its container first) and the record says the backstop came first', async () => {
    const dock = fakeDocker();
    const root = project();
    const run = 'a0c0c0c0c';
    const name = `timmy-oh-${run}`;
    const labels = { 'timmy.run': run, 'timmy.project': projectId(root) };
    const dir = join(root, AGENTS_DIR, run);
    mkdirSync(dir, { recursive: true });
    // A FAKE container as the FAKE daemon keeps it; its worker, a real process that ends on SIGTERM.
    const worker = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(143));setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((r) => worker.once('spawn', () => r()));
    onTestFinished(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); });
    mkdirSync(dirname(dock.containerFile(name)), { recursive: true });
    writeFileSync(dock.containerFile(name), JSON.stringify({ id: sha(name), name, labels, state: 'running', pid: worker.pid, behaviour: [] }));
    const runs = new OpenHandsRuns({ glyphs: glyphSet(true), notify: () => {} });
    const st: OpenHandsRunState = {
      container: { name, image: OPENHANDS_IMAGE, labels, dir, work: join(dir, 'work'), worker: join(dir, 'worker'), token: 'f'.repeat(32), maxIterations: 40, llmBase: 'http://host.docker.internal:11434', llmModel: 'ollama/qwen3:4b' },
      run, root, bin: join(dock.bin, 'docker'), env: { DOCKER_CONFIG: dock.state }, copied: new Map(), stops: [], limits: { openhands: 1000, job: 61_000 },
      record: { image: OPENHANDS_IMAGE, container: { name, labels }, worker: { path: 'w', sha256: 'x' }, limits: { cpus: '2', memory: '4g', pids: 512, max_iterations: 40 }, copy: { path: 'c', files: 0, bytes: 0 } },
    };
    const first = runs.stopFirst(st);
    expect(first).toMatchObject({ answerMs: STOP_ANSWER_MS, exitMs: CLIENT_EXIT_MS });
    const stopped = await first.run({ state: 'failed', error: 'timed out' }) as Record<string, unknown>;
    expect(stopped).toMatchObject({ why: 'time limit', result: 'stopped', steps: [{ command: `docker stop --time 10 ${name}`, exit: 0 }] });
    expect(st.limit?.by).toBe('job');
    expect(limitHead(st)).toBe('the job\'s own time limit, the backstop (1m 1s), ended it: OpenHands\' own stop at its time limit (1s) had not come');
    await until(() => worker.exitCode !== null || worker.signalCode !== null);
    // a later ask (a /stop meanwhile) gets the first one's answer: one docker stop, its why and words kept
    expect(await runs.stopFirst(st).run({ state: 'cancelled' })).toBe(stopped);
    expect(dock.calls().filter((c) => c.argv[0] === 'stop')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'container.json'), 'utf8')).stops).toEqual([expect.objectContaining({ why: 'time limit', result: 'stopped' })]);
    // OpenHands' own limit, said the other way
    expect(limitHead({ limit: { by: 'openhands', at: '' }, limits: { openhands: 930_000, job: 990_000 } })).toBe('Timmy\'s time limit passed (15m 30s: its wall time and a grace period)');
  }, 60_000);

  it('/stop of a container docker stop cannot end: docker kill ends it', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const { ws } = make(project(), ohEnv(dock, ollama.url));
    const { id, run } = await started(ws, dock, 'openhands --local HANG IGNORETERM STOPFAILS a long task');
    const reply = text(await ws.stop(id));
    expect(reply).toContain(`its container timmy-oh-${run} did not stop with docker stop: docker kill ended it`);
    const names = dock.calls().map((c) => c.argv.join(' '));
    expect(names.indexOf(`stop --time 10 timmy-oh-${run}`)).toBeLessThan(names.indexOf(`kill timmy-oh-${run}`));
    expect(existsSync(dock.containerFile(`timmy-oh-${run}`))).toBe(false);
  }, 60_000);

  it('a container that ended on the stop\'s own signal is never said to be ended by docker kill (ledger row 159)', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const { ws } = make(root, ohEnv(dock, ollama.url));
    const { id, run } = await started(ws, dock, 'openhands --local HANG IGNORETERM STOPERR a long task');
    const reply = text(await ws.stop(id));
    expect(reply).not.toContain('docker kill ended it');
    expect(reply).toContain(`its container timmy-oh-${run} ended while Timmy stopped it, not by docker kill (docker stop exited 1; docker kill exited 1)`);
    const kept = JSON.parse(readFileSync(join(root, AGENTS_DIR, run, 'container.json'), 'utf8')) as { stops: Array<Record<string, unknown>> };
    expect(kept.stops.at(-1)).toMatchObject({ result: 'ended', steps: [{ command: `docker stop --time 10 timmy-oh-${run}`, exit: 1 }, { command: `docker kill timmy-oh-${run}`, exit: 1 }] });
    expect(existsSync(dock.containerFile(`timmy-oh-${run}`))).toBe(false);
  }, 60_000);

  it('a docker command Timmy\'s own timeout ended has no exit code: no answer, even when the program exits 143 on SIGTERM (row 159)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oh-timeout-'));
    const slow = join(dir, 'docker');
    writeFileSync(slow, '#!/bin/sh\ntrap \'exit 143\' TERM\nsleep 30 & wait\n', { mode: 0o755 });
    const r = await dockerCall(slow, ['stop', 'x'], {}, 300);
    expect(r.code).toBeNull();
    expect(r.error).toMatch(/^no answer within 0 s \(Timmy ended the docker command\)$/);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it('docker is run by the name the PATH gives it: a multi-call program behind a link (OrbStack\'s) runs (row 159)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oh-multicall-'));
    // FAKE: a multi-call program that, like OrbStack's docker-tools, refuses to run under any name but its links'.
    writeFileSync(join(dir, 'docker-tools'), '#!/bin/sh\ncase "$(basename "$0")" in docker) echo "FAKE docker answered"; exit 0;; *) echo "unsupported argv0 \\"$(basename "$0")\\"" >&2; exit 127;; esac\n', { mode: 0o755 });
    symlinkSync(join(dir, 'docker-tools'), join(dir, 'docker'));
    const env = { PATH: dir };
    const resolved = realOnPath('docker', env)!;
    expect(spawnSync(resolved, ['info'], { encoding: 'utf8' })).toMatchObject({ status: 127 });
    const bin = agentBin('openhands', env, (c) => realOnPath(c, env));
    expect(bin).toBe(join(dir, 'docker'));
    expect(spawnSync(bin!, ['info'], { encoding: 'utf8' })).toMatchObject({ status: 0, stdout: 'FAKE docker answered\n' });
    // Other agents keep onPath's own answer.
    expect(agentBin('qwen', { PATH: dir }, () => '/where/onPath/said')).toBe('/where/onPath/said');
    rmSync(dir, { recursive: true, force: true });
  });

  it('Timmy\'s time limit: the job ends timed out, and its container is stopped by its name (a notice says so)', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const { ws, notes, sealed } = make(root, ohEnv(dock, ollama.url, { TIMMY_AGENT_WALL_TIME: '1s', TIMMY_AGENT_GRACE_MS: '0' }));
    const t0 = Date.now();
    const { out, job } = await runAgent(ws, 'openhands --local HANG IGNORETERM forever');
    const run = /agent openhands (a[0-9a-f]{8})/.exec(out)![1];
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(job).toMatchObject({ state: 'failed', error: 'timed out' });
    expect(resultOf(root)).toMatchObject({ outcome: 'timed out', openhands: { writeback: { state: 'not attempted' } } });
    expect(sealed.find((s) => s.kind === 'agent')).toMatchObject({ status: 'failed', agent: { outcome: 'timed out' } });
    await until(() => notes.some((n) => n.includes('at Timmy\'s time limit')));
    expect(notes.join('\n')).toContain(`agent openhands ${run}  its container timmy-oh-${run} was stopped by its name and labels at Timmy's time limit (docker stop)`);
    expect(dock.calls().some((c) => c.argv.join(' ') === `stop --time 10 timmy-oh-${run}`)).toBe(true);
    expect(existsSync(dock.containerFile(`timmy-oh-${run}`))).toBe(false);
    const kept = JSON.parse(readFileSync(join(root, AGENTS_DIR, run, 'container.json'), 'utf8')) as { stops: Array<Record<string, unknown>> };
    expect(kept.stops).toEqual([expect.objectContaining({ why: 'time limit', result: 'stopped' })]);
  }, 60_000);

  it('the REPL\'s end stops a running container by its name too', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    const dock = fakeDocker();
    const root = project();
    const { ws } = make(root, ohEnv(dock, ollama.url));
    const { run } = await started(ws, dock, 'openhands --local HANG IGNORETERM a long task');
    await ws.close();
    expect(dock.calls().some((c) => c.argv.join(' ') === `stop --time 10 timmy-oh-${run}`)).toBe(true);
    expect(existsSync(dock.containerFile(`timmy-oh-${run}`))).toBe(false);
    expect(resultOf(root)).toMatchObject({ outcome: 'cancelled' });
  }, 60_000);

  it('the REPL\'s end and timmy act\'s stop take the same order (container first, the worker\'s words kept), each with its own words', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    for (const how of ['the REPL\'s end', 'timmy act\'s stop'] as const) {
      const dock = fakeDocker({ signalDelayMs: 2500 });
      const root = project();
      const { ws } = make(root, ohEnv(dock, ollama.url));
      const { id, run } = await started(ws, dock, 'openhands --local HANG a long task');
      if (how === 'the REPL\'s end') await ws.close();
      else await ws.stop('all', { by: actStopReason('SIGINT received') }); // what `timmy act` does on a SIGINT (src/ops/act.ts)
      const name = `timmy-oh-${run}`;
      const by = how === 'the REPL\'s end' ? 'as the REPL ended' : 'by timmy act (SIGINT received)';
      expect(dock.clientSignals(), how).toEqual([]);
      expect(ws.jobs.get(id), how).toMatchObject({ state: 'cancelled', exitCode: 143, stopOrder: { first: 'answered', group: 'ended by itself' } });
      const r = resultOf(root);
      expect(r.why, how).toBe(`stopped ${by} before it finished: first docker stop ended its container ${name} (docker stop --time 10 ${name} exited 0), then its docker client ended by itself (exit 143); the worker's own last line: stopped at step 1 (SIGTERM), 900 tokens in, 30 out`);
      expect(r.openhands!.stop, how).toMatchObject({ why: how === 'the REPL\'s end' ? 'the REPL ended' : 'stop', by, result: 'stopped' });
      const kept = JSON.parse(readFileSync(join(root, AGENTS_DIR, run, 'container.json'), 'utf8')) as { stops: Array<Record<string, unknown>> };
      expect(kept.stops, how).toEqual([expect.objectContaining({ by, result: 'stopped', steps: [{ command: `docker stop --time 10 ${name}`, exit: 0 }] })]);
    }
  }, 60_000);
});

// ── recovery ─────────────────────────────────────────────────────────────────────

describe('recovery: an orphaned container is found only by its labels plus its run\'s record (FAKE docker)', () => {
  /** A pid that has just exited (its process is gone). */
  const exitedPid = (): Promise<number> => new Promise((r) => { const c = spawn(process.execPath, ['-e', '']); c.once('exit', () => r(c.pid!)); });
  const runRecord = (root: string, run: string, job: string, name: string, labels: Record<string, string>): void => put(root, `${AGENTS_DIR}/${run}/run.json`, JSON.stringify({
    agent_run: 1, run, agent: 'openhands', agent_version: null, model: 'qwen3:4b', endpoint: 'local', where: '127.0.0.1:11434', task: 'x', job, started_at: new Date(Date.now() - 120_000).toISOString(), state: 'submitted',
    openhands: { image: OPENHANDS_IMAGE, container: { name, labels }, worker: { path: 'w', sha256: 'x' }, limits: { cpus: '2', memory: '4g', pids: 512, max_iterations: 40 }, copy: { path: 'c', files: 1, bytes: 1 } },
  }));
  const jobRecord = (jobsDir: string, id: string, root: string, pid: number): void => {
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify({ id, kind: 'task', label: 'agent openhands', project: 'p', root, command: 'docker', args: ['run'], state: 'running', pid, startedAt: new Date(Date.now() - 120_000).toISOString(), steps: [], lines: 0, owner: { pid, startedAt: new Date(Date.now() - 300_000).toISOString() } }));
    writeFileSync(join(jobsDir, `${id}.log`), '');
  };
  const container = (dock: Dock, name: string, labels: Record<string, string>, pid: number): void => {
    mkdirSync(dirname(dock.containerFile(name)), { recursive: true });
    writeFileSync(dock.containerFile(name), JSON.stringify({ id: sha(name), name, labels, state: 'running', pid, behaviour: [] }));
  };

  it('a labelled orphan whose run\'s job was left by an ended REPL is stopped and sealed; an unlabelled container of the same kind of name is never touched', async () => {
    const dock = fakeDocker();
    const root = project();
    const pid = projectId(root);
    const jobsDir = join(temp('oh-jobs-'), 'jobs');
    const dead = await exitedPid();
    const run = 'a0b1c2d3e';
    const name = `timmy-oh-${run}`;
    const labels = { 'timmy.run': run, 'timmy.project': pid };
    runRecord(root, run, 'j0a0b0c', name, labels);
    jobRecord(jobsDir, 'j0a0b0c', root, dead);
    container(dock, name, labels, dead);
    // a container with the name a run record names, but no Timmy labels: docker lists it by no label of Timmy's
    const other = 'a9a9a9a9a';
    runRecord(root, other, 'j0d0d0d', `timmy-oh-${other}`, { 'timmy.run': other, 'timmy.project': pid });
    jobRecord(jobsDir, 'j0d0d0d', root, dead);
    container(dock, `timmy-oh-${other}`, {}, dead);
    // a container labelled for this project whose run has no record here: never stopped by its labels alone
    container(dock, 'timmy-oh-a7a7a7a7a', { 'timmy.run': 'a7a7a7a7a', 'timmy.project': pid }, dead);
    const { ws, sealed } = make(root, ohEnv(dock, 'http://127.0.0.1:11434/v1'), { jobsDir, recoverAtStart: false });
    const out = text(await ws.recover(''));
    expect(out).toContain('1 OpenHands container left running by a REPL that ended was stopped');
    expect(out).toContain(`OpenHands run ${run}: its job j0a0b0c was left running and its process is gone; its container ${name} was stopped by its name and labels by recovery (docker stop); its job record now says cancelled; nothing was written into the project; receipt id1`);
    expect(out).toContain(`a container labelled for this project's run a7a7a7a7a (timmy-oh-a7a7a7a7a) runs, but no OpenHands run record a7a7a7a7a is here: it was not stopped (never by its labels alone): docker stop timmy-oh-a7a7a7a7a stops it`);
    const stops = dock.calls().filter((c) => c.argv[0] === 'stop' || c.argv[0] === 'kill').map((c) => c.argv.join(' '));
    expect(stops).toEqual([`stop --time 10 ${name}`]);
    // the unlabelled one and the one with no record still "run": never touched
    expect(JSON.parse(readFileSync(dock.containerFile(`timmy-oh-${other}`), 'utf8'))).toMatchObject({ state: 'running', labels: {} });
    expect(existsSync(dock.containerFile('timmy-oh-a7a7a7a7a'))).toBe(true);
    expect(existsSync(dock.containerFile(name))).toBe(false);
    // listed only by labels: the project's id and a run label, never a name
    const ps = dock.calls().filter((c) => c.argv[0] === 'ps').map((c) => c.argv.filter((a) => a.startsWith('label=') || a.startsWith('name=')));
    expect(ps[0]).toEqual([`label=timmy.project=${pid}`, 'label=timmy.run']);
    expect(ps.flat().some((a) => a.startsWith('name='))).toBe(false);
    // its receipt, its container.json and its job's own record
    expect(sealed).toEqual([expect.objectContaining({ kind: 'recover', subject: `recover · agent · openhands · ${run} · container stopped`, status: 'ok', project_id: pid })]);
    expect((sealed[0].sources as Array<Record<string, unknown>>)[0]).toMatchObject({ operation: run, agent: 'openhands', action: 'container stopped', container: name, job: 'j0a0b0c' });
    expect(JSON.parse(readFileSync(join(root, AGENTS_DIR, run, 'container.json'), 'utf8')).stops).toEqual([expect.objectContaining({ why: 'recovery', result: 'stopped' })]);
    expect(ws.jobs.get('j0a0b0c')).toMatchObject({ state: 'cancelled', error: expect.stringContaining(`recovery stopped its container ${name}`) });
    // R4 (H59): the run's own record ended as interrupted (no result: its copy's changes never came back), its bytes on the receipt.
    const runBytes = readFileSync(join(root, AGENTS_DIR, run, 'run.json'));
    expect(JSON.parse(runBytes.toString('utf8'))).toMatchObject({
      state: 'interrupted', job: 'j0a0b0c', why: `its REPL ended while it ran; recovery stopped its container ${name} (docker stop); no result was written, and nothing was written into the project`,
      recovered: { by: 'recovery', process: 'container stopped by recovery', container: name, result: 'not written', job: { id: 'j0a0b0c', state: 'cancelled' } },
    });
    expect(existsSync(join(root, AGENTS_DIR, run, 'result.json'))).toBe(false);
    expect(sealed[0].outputs).toEqual([{ path: `${AGENTS_DIR}/${run}/run.json`, sha256: createHash('sha256').update(runBytes).digest('hex'), bytes: runBytes.length }]);
    expect(out).toContain(`its record ${AGENTS_DIR}/${run}/run.json now says interrupted (no result was written)`);
    // the run whose container was not stopped keeps its record as it was
    expect(JSON.parse(readFileSync(join(root, AGENTS_DIR, other, 'run.json'), 'utf8')).state).toBe('submitted');
    // a second pass finds nothing more to stop
    const again = text(await ws.recover(''));
    expect(again).not.toContain('was stopped');
    expect(dock.calls().filter((c) => c.argv[0] === 'stop').length).toBe(1);
  }, 60_000);

  it('a run whose job is not in this Timmy\'s jobs folder is left as it is, with how to stop it; a project with no OpenHands run asks docker nothing', async () => {
    const dock = fakeDocker();
    const root = project();
    const pid = projectId(root);
    const run = 'a1b2c3d4e';
    const name = `timmy-oh-${run}`;
    const labels = { 'timmy.run': run, 'timmy.project': pid };
    runRecord(root, run, 'j0e0e0e', name, labels);
    container(dock, name, labels, await exitedPid());
    const { ws } = make(root, ohEnv(dock, 'http://127.0.0.1:11434/v1'), { recoverAtStart: false });
    const out = text(await ws.recover(''));
    expect(out).toContain(`OpenHands run ${run}: its container ${name} still runs; its job j0e0e0e is not in this Timmy's jobs folder, so whether a session follows it cannot be told: it was not stopped; docker stop ${name} stops it`);
    expect(dock.calls().filter((c) => c.argv[0] === 'stop' || c.argv[0] === 'kill')).toEqual([]);
    const empty = fakeDocker();
    const plain = make(project(), ohEnv(empty, 'http://127.0.0.1:11434/v1'), { recoverAtStart: false });
    await plain.ws.recover('');
    expect(empty.calls()).toEqual([]);
  }, 60_000);

  it('a stale job whose container is already gone is ended: its job cancelled with words, its run interrupted, one receipt each; nothing claimed about its result (H59\'s note)', async () => {
    const dock = fakeDocker();
    const root = project();
    const pid = projectId(root);
    const jobsDir = join(temp('oh-jobs-'), 'jobs');
    const dead = await exitedPid();
    // one whose container docker no longer lists (removed, --rm), one docker lists as exited
    const runs = [{ run: 'a1d1d1d1d', job: 'j1d1d1d' }, { run: 'a2e2e2e2e', job: 'j2e2e2e' }];
    for (const x of runs) { runRecord(root, x.run, x.job, `timmy-oh-${x.run}`, { 'timmy.run': x.run, 'timmy.project': pid }); jobRecord(jobsDir, x.job, root, dead); }
    container(dock, `timmy-oh-${runs[1].run}`, { 'timmy.run': runs[1].run, 'timmy.project': pid }, dead);
    const file = dock.containerFile(`timmy-oh-${runs[1].run}`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), state: 'exited' }));
    // an earlier recovery ended this one's job record, but not its run's record
    const earlier = { run: 'a3f3f3f3f', job: 'j3f3f3f' };
    runRecord(root, earlier.run, earlier.job, `timmy-oh-${earlier.run}`, { 'timmy.run': earlier.run, 'timmy.project': pid });
    writeFileSync(join(jobsDir, `${earlier.job}.json`), JSON.stringify({ id: earlier.job, kind: 'task', label: 'agent openhands', project: 'p', root, command: 'docker', args: ['run'], state: 'cancelled', pid: dead, startedAt: new Date(Date.now() - 120_000).toISOString(), endedAt: new Date(Date.now() - 60_000).toISOString(), exitCode: null, signal: null, error: 'its REPL ended; its container was already gone', steps: [], lines: 0 }));
    writeFileSync(join(jobsDir, `${earlier.job}.log`), '');
    // docker not on PATH: whether the containers are gone cannot be told, so nothing is ended
    const blind = make(root, { PATH: temp('oh-nobin-'), TIMMY_AGENT_MODEL: 'qwen3:4b' }, { jobsDir, recoverAtStart: false });
    const said = text(await blind.ws.recover(''));
    expect(said).toContain(`OpenHands run ${runs[0].run} has no result, and docker is not on PATH, so whether its container timmy-oh-${runs[0].run} still runs cannot be checked`);
    expect(blind.sealed).toEqual([]);
    expect(blind.ws.jobs.get(runs[0].job)).toMatchObject({ state: 'running', stale: true });
    await blind.ws.close();

    const { ws, sealed } = make(root, ohEnv(dock, 'http://127.0.0.1:11434/v1'), { jobsDir, recoverAtStart: false });
    const out = text(await ws.recover(''));
    expect(out).toContain('3 agent runs left by a REPL that ended were recorded as interrupted');
    for (const x of runs) {
      const name = `timmy-oh-${x.run}`;
      expect(out).toContain(`OpenHands run ${x.run} (job ${x.job}): its REPL ended, and its job's process and its container ${name} were already gone; its job record now says cancelled: its REPL ended; its container was already gone; its record ${AGENTS_DIR}/${x.run}/run.json now says interrupted (no result was written); nothing was written into the project; receipt id`);
      expect(ws.jobs.get(x.job)).toMatchObject({ state: 'cancelled', error: 'its REPL ended; its container was already gone', exitCode: null, signal: null });
      const bytes = readFileSync(join(root, AGENTS_DIR, x.run, 'run.json'));
      expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
        state: 'interrupted', job: x.job,
        why: `its REPL ended while it ran; its docker client and its container ${name} were already gone when recovery looked (when they ended is not recorded); no result was written, and nothing was written into the project`,
        recovered: { by: 'recovery', process: 'gone', container: name, result: 'not written', job: { id: x.job, state: 'cancelled', error: 'its REPL ended; its container was already gone' } },
      });
      const r = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      for (const k of ['outcome', 'files', 'final_message', 'cost_usd', 'exit_code']) expect(r, k).not.toHaveProperty(k);
      expect(existsSync(join(root, AGENTS_DIR, x.run, 'result.json'))).toBe(false);
      const receipt = sealed.find((s) => s.subject === `recover · agent · openhands · ${x.run} · interrupted`)!;
      expect(receipt).toMatchObject({ kind: 'recover', status: 'ok', project_id: pid, outputs: [{ path: `${AGENTS_DIR}/${x.run}/run.json`, sha256: sha(bytes), bytes: bytes.length }] });
      expect((receipt.sources as Array<Record<string, unknown>>)[0]).toMatchObject({ operation: x.run, agent: 'openhands', job: x.job, container: name, action: 'found its job\'s process and its container gone' });
      expect(JSON.stringify(receipt)).not.toMatch(/"outcome"|"cost_usd"/);
    }
    expect(out).toContain(`OpenHands run ${earlier.run} (job ${earlier.job}): an earlier recovery ended its job (its record says cancelled: its REPL ended; its container was already gone) but not its own record, and its container timmy-oh-${earlier.run} runs no more; its record ${AGENTS_DIR}/${earlier.run}/run.json now says interrupted`);
    expect(JSON.parse(readFileSync(join(root, AGENTS_DIR, earlier.run, 'run.json'), 'utf8'))).toMatchObject({ state: 'interrupted', recovered: { process: 'ended before' } });
    expect(sealed.map((s) => s.subject).sort()).toEqual([...runs, earlier].map((x) => `recover · agent · openhands · ${x.run} · interrupted`).sort());
    // nothing was stopped (there was nothing to stop)
    expect(dock.calls().filter((c) => c.argv[0] === 'stop' || c.argv[0] === 'kill')).toEqual([]);
    // a second pass: nothing more, said with everything it looked for
    expect(text(await ws.recover(''))).toBe(`  Recovery   nothing to pick up in ${basename(root)}: no recipe job, flow, native run, workflow run, code agent run or OpenHands container was left by a REPL that ended`);
    expect(sealed).toHaveLength(3);
    // a stale job whose container's name is taken by a container without Timmy's labels: never judged by a name, left as it is
    const decoy = { run: 'a4a4a4a4a', job: 'j4a4a4a' };
    runRecord(root, decoy.run, decoy.job, `timmy-oh-${decoy.run}`, { 'timmy.run': decoy.run, 'timmy.project': pid });
    jobRecord(jobsDir, decoy.job, root, dead);
    container(dock, `timmy-oh-${decoy.run}`, {}, dead);
    expect(text(await ws.recover(''))).toContain(`OpenHands run ${decoy.run}: no container with its labels runs, but a container named timmy-oh-${decoy.run} without them is there (not Timmy's; never judged by its name alone): its records were left as they are`);
    expect(JSON.parse(readFileSync(join(root, AGENTS_DIR, decoy.run, 'run.json'), 'utf8')).state).toBe('submitted');
    expect(ws.jobs.get(decoy.job)).toMatchObject({ state: 'running', stale: true });
    expect(sealed).toHaveLength(3);
    // docker was asked by labels, and for its whole list; never by a name
    expect(dock.calls().filter((c) => c.argv[0] === 'ps').flatMap((c) => c.argv).some((a) => a.startsWith('name='))).toBe(false);
  }, 60_000);
});

// ── /tools ───────────────────────────────────────────────────────────────────────

describe('/tools: OpenHands\' own row; exercised only by a sealed, completed run of its own', () => {
  const base: ProbeDeps = {
    env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
    lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
  };
  const ready = { onPath: () => true, env: { TIMMY_AGENT_MODEL: 'qwen3:4b' } };
  const row = async (d: Partial<ProbeDeps>) => (await capabilities({ ...base, ...d })).find((r) => r.id === 'openhands')!;
  const probe = (docker: OpenHandsDocker, worker = true) => async () => ({ docker, worker, root: '~/timmy-tui' });

  it('needs setup with the exact step, installed only when docker, its daemon, the image and a local model are there', async () => {
    expect(await row({})).toMatchObject({ rung: 'needs setup', detail: 'docker is not on PATH; implemented; not run', setup: 'install a Docker engine (OrbStack, Docker or Rancher Desktop)', exercisedBy: 'agent:openhands' });
    expect(await row({ ...ready, openhands: probe({ state: 'no daemon' }) })).toMatchObject({ rung: 'needs setup', setup: 'start your Docker engine (OrbStack, Docker or Rancher Desktop)' });
    expect(await row({ ...ready, openhands: probe({ state: 'no image' }) })).toMatchObject({ rung: 'needs setup', detail: 'image timmy-openhands:1.21.0 not built: run the step in ~/timmy-tui; implemented; not run', setup: OPENHANDS_BUILD_SHORT });
    expect(await row({ ...ready, openhands: probe({ state: 'other image', detail: 'x' }) })).toMatchObject({ rung: 'needs setup', setup: OPENHANDS_BUILD_SHORT });
    expect(await row({ ...ready, openhands: probe({ state: 'ready', server: '29.4.0', imageId: IMAGE_ID }, false) })).toMatchObject({ rung: 'needs setup', detail: expect.stringContaining('workers/openhands/timmy_openhands.py is not in this Timmy') });
    expect(await row({ onPath: () => true, openhands: probe({ state: 'ready', server: '29.4.0', imageId: IMAGE_ID }) })).toMatchObject({ rung: 'needs setup', setup: 'set TIMMY_AGENT_MODEL to a model from ollama list' });
    expect(await row({ onPath: () => true, env: { TIMMY_AGENT_MODEL: 'glm-5.3:cloud' }, openhands: probe({ state: 'ready', server: '29.4.0', imageId: IMAGE_ID }) })).toMatchObject({ rung: 'needs setup', detail: expect.stringMatching(/^not local: glm-5\.3:cloud is a cloud model/) });
    expect(await row({ ...ready, openhands: probe({ state: 'ready', server: '29.4.0', imageId: IMAGE_ID }) })).toMatchObject({ rung: 'installed', detail: 'implemented; not run: /agent openhands --local <task>, in a container (timmy-openhands:1.21.0), free on this machine\'s Ollama (qwen3:4b)' });
    expect(await row(ready)).toMatchObject({ rung: 'installed', detail: 'docker on PATH; its daemon and image were not checked here; implemented; not run' });
    // exercised only by a sealed, completed run of its own: a Codex local run or a failed OpenHands run never marks it
    const receipt = (name: string, endpoint: string, outcome: string, status: string, ts: string) => ({ kind: 'agent', status, ts, agent: { name, outcome, endpoint }, job: { state: outcome === 'completed' ? 'completed' : 'failed' } });
    const others = agentExercisedIndex([receipt('codex', 'local', 'completed', 'ok', '2026-10-10T05:00:00Z'), receipt('openhands', 'local', 'failed', 'failed', '2026-10-10T05:01:00Z')]);
    expect((await row({ ...ready, agentRuns: () => others, openhands: probe({ state: 'ready', server: '29.4.0', imageId: IMAGE_ID }) })).exercised).toBeUndefined();
    const own = agentExercisedIndex([receipt('openhands', 'local', 'completed', 'ok', '2026-10-10T05:02:00Z')]);
    expect(await row({ ...ready, agentRuns: () => own, openhands: probe({ state: 'ready', server: '29.4.0', imageId: IMAGE_ID }) })).toMatchObject({ exercised: '2026-10-10T05:02:00Z', detail: '/agent openhands --local <task>: a job in a container (timmy-openhands:1.21.0); free on this machine\'s Ollama (qwen3:4b)' });
    // every setup step prints whole at 80 columns
    for (const docker of [{ state: 'no daemon' }, { state: 'no image' }, { state: 'other image' }, { state: 'docker failed' }] as OpenHandsDocker[]) {
      const rows = await capabilities({ ...base, ...ready, openhands: probe(docker) });
      for (const r of rows) if (r.setup) expect(r.setup.length, r.id).toBeLessThanOrEqual(69);
      for (const l of capabilityLines(rows, glyphSet(true), 80).map((x) => x.map((s) => s.text).join(''))) expect(l.length).toBeLessThanOrEqual(80);
    }
    expect(openHandsCapabilityRow({ env: {}, onPath: () => true, docker: { state: 'docker failed', detail: 'boom' }, worker: true })).toMatchObject({ detail: 'docker did not answer as expected (boom); implemented; not run', setup: 'docker info shows what is wrong' });
  });

  it('its docker checks against the FAKE docker: the daemon, the image, its label; read-only', async () => {
    const env = (d: Dock) => ({ DOCKER_CONFIG: d.state });
    expect(await dockerSetup(FAKE_DOCKER, env(fakeDocker()))).toEqual({ state: 'ready', server: '29.4.0-fake', imageId: IMAGE_ID });
    expect(await dockerSetup(FAKE_DOCKER, env(fakeDocker({ image: 'missing' })))).toEqual({ state: 'no image' });
    expect(await dockerSetup(FAKE_DOCKER, env(fakeDocker({ image: 'other' })))).toEqual({ state: 'other image', detail: 'its timmy.openhands.sdk label is <no value>' });
    const down = fakeDocker({ down: true });
    expect(await dockerSetup(FAKE_DOCKER, env(down))).toMatchObject({ state: 'no daemon', detail: expect.stringContaining('Cannot connect to the Docker daemon') });
    expect(commands(down)).toEqual(['info']);
  });
});

// ── the Control Room and the job's stdin ─────────────────────────────────────────

describe('the Control Room\'s route words, and a job\'s stdinText (JobSpec, round R4 H52)', () => {
  it('OpenHands says what its container isolates and what it does not; the other routes\' words are unchanged', () => {
    expect(openHandsRouteWords({ endpoint: 'local', openhands: { image: OPENHANDS_IMAGE } })).toBe('local endpoint, no charge; in a container (timmy-openhands:1.21.0): only a copy of the project is mounted, the network is reachable, the model is this machine\'s Ollama');
    expect(routeWords({ endpoint: 'local', where: '127.0.0.1:11434' })).toBe('local endpoint, no charge');
  });

  it('a real child reads the text and then the end of its input', async () => {
    const jobs = new JobManager({ dir: join(temp('oh-stdin-jobs-'), 'jobs') });
    const root = temp('oh-stdin-root-');
    const reader = 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{console.log("GOT "+JSON.stringify(b));process.exit(0)});setTimeout(()=>{console.log("OPEN");process.exit(0)},2000)';
    const done = await jobs.done(jobs.start({ kind: 'task', label: 'stdin text', project: 'p', root, command: process.execPath, args: ['-e', reader], stdinText: '{"v":1,"task":"x"}\n' }).id);
    expect(done.state).toBe('completed');
    expect(jobs.tail(done.id)).toEqual(['GOT "{\\"v\\":1,\\"task\\":\\"x\\"}\\n"']);
    await jobs.stopAll();
  });
});

describe('the worker ships beside the code, with no fixture-specific prompt', () => {
  it('workers/openhands holds the worker and the Dockerfile; the Dockerfile pins 1.21.0, builds no browser, copies no worker', () => {
    expect(readdirSync(resolve('workers/openhands')).sort()).toEqual(['Dockerfile', 'timmy_openhands.py']);
    const dockerfile = readFileSync(resolve('workers/openhands/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('FROM python:3.12-slim');
    expect(dockerfile).toContain('openhands-sdk==1.21.0 openhands-tools==1.21.0');
    expect(dockerfile).toContain('LABEL timmy.openhands.sdk="1.21.0"');
    expect(dockerfile).toContain(OPENHANDS_BUILD);
    const instructions = dockerfile.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(instructions).not.toMatch(/chromium|playwright|^COPY/im);
    const worker = readFileSync(WORKER, 'utf8');
    expect(worker).not.toMatch(/add\.js|a - b|npm test/);
    expect(worker).toContain('"stream", False');
    expect(worker).toContain('NeverConfirm');
  });
});
