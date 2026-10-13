/**
 * R4 (H69; ledger row 162, r20): OpenHands' local model calls its tools natively, and a text answer read as a tool call is
 * said. Timmy's worker (workers/openhands/timmy_openhands.py), run for real under this machine's python3 on a FAKE OpenHands
 * SDK and a FAKE litellm (tests/fixtures/fake-openhands-sdk.py: TEST DOUBLES that call no model, run no tool and contact
 * nothing; the FAKE litellm records every call it is given, in order). What is checked:
 * - the route Timmy gives, ollama_chat/<model> (LiteLLM's route to Ollama's /api/chat): for this machine's Ollama the worker
 *   registers the model with LiteLLM as supporting function calling BEFORE it makes the LLM, asks LiteLLM's own parameter
 *   mapping how it would pass a tool (nothing is sent), and says the route and that decision in its started line;
 * - nothing is registered for another route or address; LiteLLM refusing the entry, lacking its mapping or missing is said,
 *   and the run goes on; the SDK's own setting (tools in its prompt) is said beside LiteLLM's decision;
 * - an answer whose text reads as a tool call (r20's {"command": ...}) gives one text_call line, which Timmy shows bounded.
 * The FAKE litellm's Ollama chat route decides as LiteLLM's documentation describes its Ollama provider (JSON mode for a
 * model it does not know supports function calling). Which LiteLLM the image holds and what it decides is the Mac run's.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newProgress } from '../src/code-agents/index.js';
import { openHandsProgressLine, openHandsSaid, toolCallWords, watchOpenHands, zeroStepsWhy } from '../src/code-agents/openhands.js';

const WORKER = join(__dirname, '..', 'workers', 'openhands', 'timmy_openhands.py');
const FAKE_SDK = join(__dirname, 'fixtures', 'fake-openhands-sdk.py');
const TOKEN = 'cd'.repeat(16);
const LOOPBACK = 'http://host.docker.internal:11434';
const REGISTERED = ['ollama_chat/qwen3:4b', 'ollama/qwen3:4b'];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Line = Record<string, unknown>;
interface Ran { status: number | null; out: string; err: string; lines: Line[]; calls: Line[] }

/** The worker on the FAKE SDK and FAKE litellm, its request on stdin, as its container runs it; and what the FAKE litellm was given. */
function runWorker(task: string, env: Record<string, string> = {}): Ran {
  const dir = mkdtempSync(join(tmpdir(), 'oh-route-'));
  dirs.push(dir);
  const log = join(dir, 'litellm.jsonl');
  const r = spawnSync('python3', ['-B', FAKE_SDK, WORKER], {
    input: `${JSON.stringify({ v: 1, task, token: TOKEN })}\n`, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH ?? '', LLM_MODEL: 'ollama_chat/qwen3:4b', LLM_BASE_URL: LOOPBACK, LLM_API_KEY: 'ollama', TIMMY_OPENHANDS_MAX_ITERATIONS: '40', PYTHONDONTWRITEBYTECODE: '1', FAKE_LITELLM_LOG: log, ...env },
  });
  let calls: Line[] = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line); } catch { calls = []; }
  return { status: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line), calls };
}
const started = (r: Ran): Line => r.lines.find((l) => l.type === 'started')!;
/** Timmy's reading of a run's lines: what each shows, its progress and what its lines said. */
function read(out: string) {
  const progress = newProgress();
  watchOpenHands(progress, TOKEN);
  const shown = out.trim().split('\n').map((l) => openHandsProgressLine(l, progress, '/proj')).filter((l): l is string => l !== undefined);
  return { progress, shown, said: openHandsSaid(progress) };
}
/** The worker's own functions, imported (its module code only: main() is not run), given JSON on stdin; its answer on its protocol channel. */
function workerSays(call: string, input: unknown): unknown {
  const py = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("timmy_openhands", sys.argv[1])',
    'w = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(w)',
    'given = json.loads(sys.stdin.read())',
    `w._proto.write(json.dumps([${call} for x in given]) + "\\n")`,
    'w._proto.flush()',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-B', '-c', py, WORKER], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe('the route: ollama_chat/<model>, registered with LiteLLM before the LLM is made, and LiteLLM\'s decision in the started line (python3, a FAKE SDK and a FAKE litellm)', () => {
  it('this machine\'s Ollama on the ollama_chat route: registered as supporting function calling, then LiteLLM\'s mapping asked, then the LLM made; tool calls native', () => {
    const r = runWorker('a short task');
    expect(r.status, r.err).toBe(0);
    expect(r.calls.map((c) => c.call)).toEqual(['register_model', 'OllamaChatConfig.map_openai_params', 'openhands.sdk.LLM']);
    expect(r.calls[0]).toEqual({ call: 'register_model', model_cost: { 'ollama_chat/qwen3:4b': { supports_function_calling: true }, 'ollama/qwen3:4b': { supports_function_calling: true } } });
    expect(r.calls[1]).toEqual({ call: 'OllamaChatConfig.map_openai_params', model: 'qwen3:4b', params: ['tools'], drop_params: false });
    // the LLM is made on the route Timmy gave, after the registration; the probe left LiteLLM's add_function_to_prompt as it was
    expect(r.calls[2]).toEqual({ call: 'openhands.sdk.LLM', model: 'ollama_chat/qwen3:4b', base_url: LOOPBACK, options: ['stream', 'timeout', 'usage_id'], add_function_to_prompt: false });
    const s = started(r);
    expect(s).toMatchObject({ route: 'ollama_chat', endpoint: '/api/chat', registered: REGISTERED, tool_calls: 'native', tool_calls_by: 'mapping' });
    for (const k of ['not_registered', 'tool_calls_error', 'litellm', 'sdk_tools']) expect(s, k).not.toHaveProperty(k);
    const { shown, said } = read(r.out);
    expect(shown[0]).toBe('started  OpenHands SDK (its version was not reported) · model ollama_chat/qwen3:4b · tools terminal, file_editor · up to 40 steps · route ollama_chat (Ollama\'s /api/chat) · tool calls native, as LiteLLM decides · registered with LiteLLM as supporting function calling · LiteLLM\'s version not reported');
    expect(said).toMatchObject({ route: 'ollama_chat', toolCalls: 'native', registered: REGISTERED, litellm: null });
    // its model called a tool: no text_call line
    expect(r.lines.map((l) => l.type)).toEqual(['started', 'action', 'observation', 'result']);
  });

  it('an address that is not this machine\'s Ollama: nothing is registered; LiteLLM\'s mapping then decides JSON mode, and that is said; the probe leaves LiteLLM as it was', () => {
    const r = runWorker('a short task', { LLM_BASE_URL: 'http://models.example.com:11434' });
    expect(r.status, r.err).toBe(0);
    expect(r.calls.map((c) => c.call)).toEqual(['OllamaChatConfig.map_openai_params', 'openhands.sdk.LLM']);
    expect(r.calls[1]).toMatchObject({ add_function_to_prompt: false });
    expect(started(r)).toMatchObject({ route: 'ollama_chat', registered: [], not_registered: 'not this machine\'s Ollama', tool_calls: 'json', tool_calls_by: 'mapping' });
    expect(read(r.out).shown[0]).toContain(' · route ollama_chat (Ollama\'s /api/chat) · tool calls in JSON mode, not native, as LiteLLM decides · not registered (not this machine\'s Ollama) · ');
  });

  it('r20\'s route, ollama/<model> (Ollama\'s /api/generate): never registered; LiteLLM\'s own check of the model answers', () => {
    const r = runWorker('a short task', { LLM_MODEL: 'ollama/qwen3:4b' });
    expect(r.status, r.err).toBe(0);
    expect(r.calls.map((c) => c.call)).toEqual(['supports_function_calling', 'openhands.sdk.LLM']);
    expect(r.calls[0]).toEqual({ call: 'supports_function_calling', model: 'ollama/qwen3:4b' });
    expect(started(r)).toMatchObject({ route: 'ollama', endpoint: '/api/generate', registered: [], not_registered: 'only the ollama_chat route is registered', tool_calls: 'json', tool_calls_by: 'supports_function_calling' });
    expect(read(r.out).shown[0]).toContain(' · route ollama (Ollama\'s /api/generate) · tool calls in JSON mode, not native, as LiteLLM says of the model · not registered (only the ollama_chat route is registered) · ');
  });

  it('LiteLLM refusing the entry, lacking its mapping, passing the tools natively by itself, or missing: each said in the started line; the run goes on and finishes', () => {
    const cases: Array<[string, Line, string]> = [
      ['refuse-register', { registered: [], not_registered: 'register_model refused it: ValueError: a FAKE refusal of register_model', tool_calls: 'json', tool_calls_by: 'mapping' },
        ' · tool calls in JSON mode, not native, as LiteLLM decides · not registered (register_model refused it: ValueError: a FAKE refusal of register_model) · '],
      ['no-mapping', { registered: REGISTERED, tool_calls: 'native', tool_calls_by: 'supports_function_calling' },
        ' · tool calls native, as LiteLLM says of the model · registered with LiteLLM as supporting function calling · '],
      ['native', { registered: REGISTERED, tool_calls: 'native', tool_calls_by: 'mapping' },
        ' · tool calls native, as LiteLLM decides · registered with LiteLLM as supporting function calling · '],
      ['absent', { registered: [], not_registered: 'LiteLLM could not be imported', tool_calls: 'unknown', tool_calls_error: expect.stringMatching(/^LiteLLM could not be imported: (ModuleNotFoundError|ImportError): /) },
        ' · tool calls: whether native is not known (LiteLLM could not be imported: '],
    ];
    for (const [mode, want, words] of cases) {
      const r = runWorker('a short task', { FAKE_LITELLM: mode });
      expect(r.status, `${mode}: ${r.err}`).toBe(0);
      expect(started(r), mode).toMatchObject({ route: 'ollama_chat', ...want });
      expect(read(r.out).shown[0], mode).toContain(words);
      expect(r.lines.at(-1), mode).toMatchObject({ type: 'result', status: 'finished', finished: true, steps: 1 });
    }
  });

  it('the SDK\'s own setting: an LLM that describes the tools in its prompt is said so, LiteLLM\'s decision kept beside it in the record', () => {
    const r = runWorker('a short task', { FAKE_SDK_NATIVE_TOOL_CALLING: '0' });
    expect(r.status, r.err).toBe(0);
    expect(started(r)).toMatchObject({ sdk_tools: 'prompt', tool_calls: 'native', tool_calls_by: 'mapping' });
    const { shown, said } = read(r.out);
    expect(shown[0]).toContain(' · tool calls in the prompt, not native (the SDK\'s setting) · registered with LiteLLM as supporting function calling · ');
    expect(said).toMatchObject({ sdkTools: 'prompt', toolCalls: 'native' });
    expect(started(runWorker('a short task', { FAKE_SDK_NATIVE_TOOL_CALLING: '1' }))).toMatchObject({ sdk_tools: 'native', tool_calls: 'native' });
    expect(toolCallWords({ toolCalls: 'native', sdkTools: 'native' })).toBe('tool calls native');
  });

  it('the worker\'s own reading of a route: the route, the model\'s own name, and whether the address is this machine\'s Ollama', () => {
    expect(workerSays('w.route_of(*x)', [
      ['ollama_chat/qwen3:4b', 'http://host.docker.internal:11434'], ['ollama_chat/hf.co/org/repo:Q4_K_M', 'http://127.0.0.1:11434'],
      ['ollama_chat/m', 'http://[::1]:11434'], ['ollama_chat/m', 'http://localhost:8080/ollama'], ['ollama_chat/m', 'http://models.example.com:11434'],
      ['ollama/m', 'http://host.docker.internal:11434'], ['openai/gpt', 'http://127.0.0.1:1'], ['m', ''], ['ollama_chat/m', 'http://[bad'],
    ])).toEqual([
      ['ollama_chat', 'qwen3:4b', true], ['ollama_chat', 'hf.co/org/repo:Q4_K_M', true],
      ['ollama_chat', 'm', true], ['ollama_chat', 'm', true], ['ollama_chat', 'm', false],
      ['ollama', 'm', true], ['other', 'openai/gpt', true], ['other', 'm', false], ['ollama_chat', 'm', false],
    ]);
  });
});

describe('an answer whose text reads as a tool call (r20): one text_call line, which Timmy shows bounded', () => {
  it('r20\'s answer, {"command": "find /work ..."}, twice: one line saying so; the run said it finished after 0 steps; the judge\'s words', () => {
    const r = runWorker('TEXTCALL TEXTTWICE add an index page');
    expect(r.status, r.err).toBe(0);
    expect(r.lines.map((l) => l.type)).toEqual(['started', 'message', 'text_call', 'message', 'result']);
    expect(r.lines[2]).toEqual({ v: 1, type: 'text_call', token: TOKEN, n: 0, keys: ['command'] });
    expect(r.lines.at(-1)).toMatchObject({ status: 'finished', finished: true, steps: 0, usage: { input: 11104, output: 200 } });
    const { shown, said, progress } = read(r.out);
    expect(shown.filter((l) => l.startsWith('model answered in text'))).toEqual(['model answered in text, not with a tool call: its text reads as a tool call\'s arguments (command)']);
    expect(shown.at(-1)).toBe('done  finished · 0 steps · 11,104 tokens in, 200 out');
    expect(said).toMatchObject({ steps: 0, finished: true, textCall: { keys: ['command'] } });
    expect(zeroStepsWhy(progress)).toBe('it said it finished after 0 steps and changed nothing: whether it did the task is not known; the model\'s last answer was text, not a tool call (it reads as a tool call\'s arguments: command)');
  });

  it('what reads as a tool call given as text, and what does not (the worker\'s own reading)', () => {
    const texts = [
      '{"command": "find /work -name \\"index.html\\""}',
      '  ```json\n{"command": "ls", "is_input": false}\n```  ',
      '{"name": "terminal", "arguments": {"command": "ls"}}',
      '{"tool": "file_editor", "parameters": "{\\"path\\": \\"/work/a\\"}"}',
      'I will run ls in /work.',
      'Here it is: {"command": "ls"}',
      '[{"command": "ls"}]',
      '{"answer": 42}',
      '{"command": ',
      `{"command": "${'x'.repeat(200_001)}"}`,
    ];
    expect(workerSays('w.call_in_text(x)', texts)).toEqual([
      { keys: ['command'] },
      { keys: ['command', 'is_input'] },
      { name: 'terminal', keys: ['command'] },
      { name: 'file_editor', keys: [] },
      null, null, null, null, null, null,
    ]);
  });
});

describe('Timmy\'s reading of the route and text_call lines: bounded, scrubbed, never filled in', () => {
  const line = (o: Line): string => JSON.stringify({ v: 1, token: TOKEN, ...o });

  it('an unknown tool_calls value reads unknown; fields of the wrong type are dropped; long and control text is bounded; a second text_call is not shown', () => {
    const p = newProgress();
    watchOpenHands(p, TOKEN);
    const shown = openHandsProgressLine(line({
      type: 'started', sdk: '1.21.0', model: 'ollama_chat/m', route: 'ollama_chat\u001b[2J', endpoint: '/api/chat', tool_calls: 'definitely', registered: 'not a list',
      not_registered: `${'y'.repeat(500)} /proj/inside`, litellm: 42, sdk_tools: 'maybe', tool_calls_error: 'it failed in /proj/inside\u0007',
    }), p, '/proj')!;
    expect(shown).toBe(`started  OpenHands SDK 1.21.0 · model ollama_chat/m · route ollama_chat (Ollama's /api/chat) · tool calls: whether native is not known (it failed in ./inside) · not registered (${'y'.repeat(99)}…) · LiteLLM's version not reported`);
    expect(shown).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(openHandsSaid(p)).toMatchObject({ route: 'ollama_chat', toolCalls: 'unknown', registered: [], litellm: null });
    expect(openHandsSaid(p).sdkTools).toBeUndefined();
    const call = openHandsProgressLine(line({ type: 'text_call', n: 0, keys: ['command', 42, '\u001b[31mpath', 'k'.repeat(100), '/proj/x'], name: 7 }), p, '/proj');
    expect(call).toBe(`model answered in text, not with a tool call: its text reads as a tool call's arguments (command, path, ${'k'.repeat(29)}…, ./x)`);
    expect(openHandsProgressLine(line({ type: 'text_call', n: 0, keys: ['path'] }), p, '/proj')).toBeUndefined();
    expect(openHandsSaid(p).textCall).toEqual({ keys: ['command', 'path', `${'k'.repeat(29)}…`, './x'] });
    // an older worker's started line, without a route: nothing about a route is shown or filled in
    const old = newProgress();
    watchOpenHands(old, TOKEN);
    expect(openHandsProgressLine(line({ type: 'started', sdk: '1.21.0', model: 'ollama/m' }), old, '/proj')).toBe('started  OpenHands SDK 1.21.0 · model ollama/m');
    expect(openHandsSaid(old)).not.toHaveProperty('route');
    expect(openHandsSaid(old)).not.toHaveProperty('toolCalls');
  });

  it('the judge\'s words for 0 steps: a call of a named tool; an answer with no text', () => {
    const named = newProgress();
    watchOpenHands(named, TOKEN);
    for (const l of [
      line({ type: 'message', source: 'agent', excerpt: '{"name": "terminal", "arguments": {"command": "ls"}}' }),
      line({ type: 'text_call', n: 0, keys: ['command'], name: 'terminal' }),
      line({ type: 'result', status: 'finished', finished: true, steps: 0 }),
    ]) openHandsProgressLine(l, named, '/proj');
    expect(zeroStepsWhy(named)).toBe('it said it finished after 0 steps and changed nothing: whether it did the task is not known; the model\'s last answer was text, not a tool call (it reads as a call of terminal with command)');
    const silent = newProgress();
    watchOpenHands(silent, TOKEN);
    openHandsProgressLine(line({ type: 'result', status: 'finished', finished: true, steps: 0 }), silent, '/proj');
    expect(zeroStepsWhy(silent)).toBe('it said it finished after 0 steps and changed nothing: whether it did the task is not known; the model\'s last answer held no tool call');
  });
});
