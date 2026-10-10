#!/usr/bin/env node
// fake-docker.mjs: a FAKE docker client, a TEST DOUBLE for tests/openhands-agent.test.ts. It is NOT docker: it starts no
// container, runs no image and no OpenHands, calls no model and contacts nothing. It keeps its "daemon" as files in the
// folder DOCKER_CONFIG names (a real docker client setting, which Timmy passes through to the client it runs; here it
// is a temporary folder of the test's own):
//   argv.jsonl            every invocation: its arguments, and the keys its environment held (blank or not)
//   daemon-down           present: every command that needs the daemon fails as docker's does when it is not running
//   images.json           {"<image>": {"id": "sha256:…", "labels": {…}}}: the images this "daemon" has
//   containers/<name>.json  a "container": its id, name, labels, state and the pid of the `run` process playing it
//   runs/<name>.json      what a `run` was given: its arguments, mounts, -e settings and stdin, for the tests to check
//
// `run` plays the docker client and the container's worker in one process: it checks its command line against what
// Timmy's OpenHands route must give (and refuses anything else with exit 125, as docker refuses a bad run), registers
// its container, reads the worker's stdin ({"v":1,"task","token"}), then plays a SCRIPTED agent chosen by words in
// the task, editing the files of the copy mounted at /work (the host folder its --mount names) and printing the
// worker's JSON Lines with the run's token:
//   (default)     appends a line to src/a.txt                    ADD      also writes src/new.txt
//   DELETE        also deletes old.txt                           LINK     also makes link.txt, a link to /etc/hosts
//   GITDIR        also writes .git/config in the copy            NESTED   also writes deep/er/file.txt
//   TOUCHPROJECT  also changes the PROJECT's own src/a.txt, as an operator editing meanwhile would (stale)
//   NOFINISH      its result says not finished (its step limit); exits 3
//   NORESULT      prints its lines but no result line; exits 0     SILENT   prints nothing; exits 0
//   FAILSTART     says docker could not start the container; exits 125
//   HOSTILE       prints hostile lines first (no token, another token, a forged result, control characters, a huge
//                 line, an array, unknown types), then its own lines and result
//   AFTER         prints a forged second result after its own
//   HANG          starts, then waits until it is stopped; SIGTERM: a "stopped" result, exit 143
//   IGNORETERM    with HANG: SIGTERM does nothing (a worker that does not stop); `docker stop` then kills it
//   STOPFAILS     `docker stop` fails for its container (and leaves it running); `docker kill` ends it
//   UNKILLABLE    `docker stop` and `docker kill` both fail for its container
//   STOPERR       `docker stop` ends the worker (SIGTERM) but exits 1 before docker lists it as gone, as a stop Timmy's own
//                 time limit cut short did on the Mac (ledger row 159); `docker kill` then finds it not running, exits 1
// A `run` process killed outright (SIGKILL) leaves its container file "running": an orphan, as a real container
// outlives a killed docker client. `stop` and `kill` act on a container by its name (or id), as docker's do.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const state = process.env.DOCKER_CONFIG;
if (!state) { process.stderr.write('FAKE docker: DOCKER_CONFIG names no state folder\n'); process.exit(99); }
mkdirSync(join(state, 'containers'), { recursive: true });
mkdirSync(join(state, 'runs'), { recursive: true });
const KEYS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'TIMMY_AGENT_API_KEY', 'LLM_API_KEY'];
appendFileSync(join(state, 'argv.jsonl'), `${JSON.stringify({ argv, keys: Object.fromEntries(KEYS.map((k) => [k, process.env[k] ?? null])) })}\n`);

// The one-shot commands answer with synchronous writes (a few short lines), so process.exit() right after loses nothing;
// `run` streams through process.stdout and exits only once that has drained (process.exit() alone cuts a pipe short).
const say = (t) => { writeSync(1, `${t}\n`); };
const fail = (t, code = 1) => { writeSync(2, `${t}\n`); process.exit(code); };
const exit = (code) => { process.stdout.write('', () => process.stderr.write('', () => process.exit(code))); };
const down = () => existsSync(join(state, 'daemon-down'));
const DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const containerFile = (name) => join(state, 'containers', `${name}.json`);
const containers = () => readdirSync(join(state, 'containers')).filter((n) => n.endsWith('.json')).map((n) => readJson(join(state, 'containers', n), null)).filter(Boolean);
const find = (ref) => containers().find((c) => c.name === ref || c.id === ref);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gone(pid, ms = 5000) { const end = Date.now() + ms; while (alive(pid) && Date.now() < end) await sleep(25); return !alive(pid); }
const remove = (name) => { try { unlinkSync(containerFile(name)); } catch { /* gone */ } };

const cmd = argv[0];
if (cmd === '--version') { say('Docker version 0.0.0-fake, build fake (a FAKE docker, not the real one)'); process.exit(0); }
if (cmd !== 'run' && down()) fail(DOWN);

if (cmd === 'info') { say('29.4.0-fake'); process.exit(0); }

if (cmd === 'image' && argv[1] === 'inspect') {
  const image = argv.at(-1);
  const img = readJson(join(state, 'images.json'), {})[image];
  if (!img) fail(`Error response from daemon: No such image: ${image}`);
  say(`${img.id}|${img.labels?.['timmy.openhands.sdk'] ?? '<no value>'}`);
  process.exit(0);
}

if (cmd === 'ps') {
  const filters = [];
  for (let i = 1; i < argv.length; i++) if (argv[i] === '--filter') filters.push(argv[++i]);
  const format = argv[argv.indexOf('--format') + 1] ?? '';
  if (format !== '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "timmy.run"}}\t{{.Label "timmy.project"}}') fail(`FAKE docker: a ps --format it does not play: ${format}`, 98);
  const match = (c) => filters.every((f) => {
    const m = /^label=([^=]+)(?:=(.*))?$/.exec(f);
    if (!m) return false;
    return m[2] === undefined ? c.labels?.[m[1]] !== undefined : c.labels?.[m[1]] === m[2];
  });
  for (const c of containers().filter(match)) say([c.id, c.name, c.state, c.labels?.['timmy.run'] ?? '', c.labels?.['timmy.project'] ?? ''].join('\t'));
  process.exit(0);
}

if (cmd === 'stop' || cmd === 'kill') {
  const ref = argv.at(-1);
  const c = find(ref);
  if (!c) fail(`Error response from daemon: No such container: ${ref}`);
  const words = c.behaviour ?? [];
  if (words.includes('UNKILLABLE') || (cmd === 'stop' && words.includes('STOPFAILS'))) fail(`Error response from daemon: cannot ${cmd} container: ${ref}: a FAKE refusal`);
  if (words.includes('STOPERR')) {
    if (cmd === 'stop') {
      if (c.state === 'running' && alive(c.pid)) { process.kill(c.pid, 'SIGTERM'); await gone(c.pid); }
      fail(`FAKE docker: the stop of ${ref} gave no answer in time`); // the container file stays: listed until kill looks
    }
    if (!alive(c.pid)) { remove(c.name); fail(`Error response from daemon: cannot kill container: ${ref}: container is not running`); }
  }
  if (c.state === 'running' && alive(c.pid)) {
    // docker stop: SIGTERM, then SIGKILL after its grace (played at once for a worker that ignores SIGTERM); docker kill: SIGKILL
    process.kill(c.pid, cmd === 'kill' || words.includes('IGNORETERM') ? 'SIGKILL' : 'SIGTERM');
    if (!(await gone(c.pid))) { process.kill(c.pid, 'SIGKILL'); await gone(c.pid); }
  }
  remove(c.name); // --rm: an ended container is removed
  say(ref);
  process.exit(0);
}

if (cmd !== 'run') fail(`FAKE docker: a command it does not play: ${cmd}`, 98);

// ── run: the command line Timmy's OpenHands route must give ──
const FLAGS = new Set(['--name', '--label', '--cpus', '--memory', '--memory-swap', '--pids-limit', '--cap-drop', '--security-opt', '--user', '--tmpfs', '--add-host', '--mount', '--workdir', '-e', '--pull']);
const BOOLS = new Set(['--rm', '-i']);
const given = {}; const multi = { '--label': [], '--mount': [], '-e': [] }; const bools = new Set();
const problems = [];
let i = 1;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (BOOLS.has(a)) { bools.add(a); continue; }
  if (FLAGS.has(a)) { const v = argv[++i]; if (a in multi) multi[a].push(v); else given[a] = v; continue; }
  if (a.startsWith('-')) { problems.push(`a flag it does not expect: ${a}`); continue; }
  break;
}
const image = argv[i];
const command = argv.slice(i + 1);
const envs = Object.fromEntries(multi['-e'].map((kv) => { const at = kv.indexOf('='); return at < 0 ? [kv, null] : [kv.slice(0, at), kv.slice(at + 1)]; }));
const labels = Object.fromEntries(multi['--label'].map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
/** docker's --mount: a CSV list (a quoted field may hold commas; "" is a quote). */
function mountOf(spec) {
  const fields = []; let cur = ''; let q = false;
  for (let k = 0; k < spec.length; k++) {
    const ch = spec[k];
    if (q) { if (ch === '"' && spec[k + 1] === '"') { cur += '"'; k++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { fields.push(cur); cur = ''; } else cur += ch;
  }
  fields.push(cur);
  const m = { readonly: false };
  for (const f of fields) { const at = f.indexOf('='); if (at < 0) { if (f === 'readonly') m.readonly = true; else m[f] = true; } else m[f.slice(0, at)] = f.slice(at + 1); }
  return m;
}
const mounts = multi['--mount'].map(mountOf);
const run = labels['timmy.run'];
if (!bools.has('--rm')) problems.push('no --rm');
if (!bools.has('-i')) problems.push('no -i');
if (given['--pull'] !== 'never') problems.push(`--pull is ${given['--pull']}, not never`);
if (!/^a[0-9a-f]{8}$/.test(run ?? '')) problems.push('no --label timmy.run=<run>');
if (given['--name'] !== `timmy-oh-${run}`) problems.push(`the name is ${given['--name']}, not timmy-oh-${run}`);
if (!/^[0-9a-f]{16}$/.test(labels['timmy.project'] ?? '')) problems.push('no --label timmy.project=<project id>');
if (Object.keys(labels).sort().join(',') !== 'timmy.project,timmy.run') problems.push(`labels it does not expect: ${Object.keys(labels).join(', ')}`);
if (given['--cpus'] !== '2' || given['--memory'] !== '4g' || given['--pids-limit'] !== '512') problems.push('the limits are not --cpus 2 --memory 4g --pids-limit 512');
if (given['--cap-drop'] !== 'ALL') problems.push('no --cap-drop ALL');
if (given['--security-opt'] !== 'no-new-privileges') problems.push('no --security-opt no-new-privileges');
if (!/^\/tmp\/timmy-home:rw,nosuid,nodev,size=\d+m,mode=1777$/.test(given['--tmpfs'] ?? '')) problems.push('HOME is not on a tmpfs at /tmp/timmy-home');
if (given['--add-host'] !== 'host.docker.internal:host-gateway') problems.push('no --add-host host.docker.internal:host-gateway');
if (given['--workdir'] !== '/work') problems.push('the workdir is not /work');
if (envs.HOME !== '/tmp/timmy-home') problems.push('HOME is not /tmp/timmy-home');
if (envs.LLM_API_KEY !== 'ollama') problems.push(`LLM_API_KEY is not the local placeholder`);
if (!/^ollama\/[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(envs.LLM_MODEL ?? '')) problems.push(`LLM_MODEL is ${envs.LLM_MODEL}, not ollama/<model>`);
if (!/^https?:\/\/host\.docker\.internal(:\d+)?$/.test(envs.LLM_BASE_URL ?? '')) problems.push(`LLM_BASE_URL is ${envs.LLM_BASE_URL}, not this machine's Ollama as the container sees it`);
for (const [k, v] of Object.entries(envs)) {
  if (v === null) problems.push(`-e ${k} with no value (docker would take the client's own)`);
  else if (/KEY|TOKEN|SECRET/i.test(k) && !(k === 'LLM_API_KEY' && v === 'ollama')) problems.push(`a key in the container's environment: ${k}`);
  else if (/\bsk-[A-Za-z0-9-]{8,}/.test(v)) problems.push(`a key-shaped value in ${k}`);
}
const work = mounts.find((m) => m.target === '/work');
const worker = mounts.find((m) => m.target === '/timmy');
if (mounts.length !== 2 || !work || !worker) problems.push('the mounts are not exactly the copy at /work and the worker at /timmy');
if (work && (work.type !== 'bind' || work.readonly || !String(work.source).endsWith(`/.timmy/agents/${run}/work`))) problems.push('the copy is not the run\'s work folder, bound read-write at /work');
if (worker && (worker.type !== 'bind' || !worker.readonly || !String(worker.source).endsWith(`/.timmy/agents/${run}/worker`))) problems.push('the worker is not the run\'s worker folder, bound read-only at /timmy');
if (worker && !existsSync(join(worker.source ?? '', 'timmy_openhands.py'))) problems.push('the worker folder holds no timmy_openhands.py');
if (image !== 'timmy-openhands:1.21.0') problems.push(`the image is ${image}`);
if (command.join(' ') !== 'python /timmy/timmy_openhands.py') problems.push(`the command is ${command.join(' ')}`);
if (problems.length) fail(`docker: FAKE refusal: ${problems.join('; ')}`, 125);
if (down()) fail(`docker: ${DOWN}`, 125);
if (!readJson(join(state, 'images.json'), {})[image]) fail(`docker: Error response from daemon: No such image: ${image} (and --pull never)`, 125);
if (find(given['--name'])) fail(`docker: Error response from daemon: Conflict. The container name "/${given['--name']}" is already in use`, 125);

// ── its stdin: the worker's request ──
const stdin = await new Promise((done) => {
  let body = '';
  const timer = setTimeout(() => done({ open: true, body }), 5000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { body += c; });
  process.stdin.once('end', () => { clearTimeout(timer); done({ open: false, body }); });
  process.stdin.resume();
});
let request = {};
try { request = JSON.parse(stdin.body); } catch { request = {}; }
const task = typeof request.task === 'string' ? request.task : '';
const token = typeof request.token === 'string' ? request.token : '';
const words = new Set(task.split(/\W+/).filter((w) => /^[A-Z]{3,}$/.test(w)));
writeFileSync(join(state, 'runs', `${given['--name']}.json`), `${JSON.stringify({ argv, labels, mounts, env: envs, user: given['--user'] ?? null, stdin: { open: stdin.open, bytes: Buffer.byteLength(stdin.body), v: request.v ?? null, task, token_length: token.length } }, null, 2)}\n`);
if (stdin.open) fail('timmy_openhands: its stdin stayed open (a FAKE refusal: the real worker reads it to its end)', 2);

// ── its container, as this "daemon" keeps it ──
const name = given['--name'];
writeFileSync(containerFile(name), `${JSON.stringify({ id: randomBytes(32).toString('hex'), name, labels, state: 'running', pid: process.pid, behaviour: [...words] })}\n`);
const end = (code) => { remove(name); exit(code); };
const emit = (type, fields = {}) => process.stdout.write(`${JSON.stringify({ v: 1, type, token, ...fields })}\n`);

/** The scripted agent: each path ends with end(), which exits once its output has drained. */
function play() {
  if (words.has('FAILSTART')) { process.stderr.write('docker: Error response from daemon: failed to create task for container (a FAKE failure)\n'); return end(125); }
  if (words.has('SILENT')) return end(0);

  const root = work.source;
  const project = dirname(dirname(dirname(dirname(root)))); // <project>/.timmy/agents/<run>/work
  const inCopy = (rel) => join(root, ...rel.split('/'));
  const put = (rel, body) => { mkdirSync(dirname(inCopy(rel)), { recursive: true }); writeFileSync(inCopy(rel), body); };

  const stream = (t) => process.stdout.write(`${t}\n`);
  if (words.has('HOSTILE')) {
    stream(JSON.stringify({ v: 1, type: 'result', token: 'f'.repeat(32), finished: true, status: 'finished', final_message: 'FORGED: another token' }));
    stream(JSON.stringify({ v: 1, type: 'result', finished: true, status: 'finished', final_message: 'FORGED: no token' }));
    stream(JSON.stringify([{ v: 1, type: 'result', token }]));
    stream(`{"v":1,"type":"message","token":"${token}","excerpt":"\\u001b[2J\\u001b[31mred\\u0007 \\u202ereversed text"}`);
    stream(JSON.stringify({ v: 1, type: 'action', token, tool: 'file_editor', command: 'create', path: '/work/../../etc/passwd' }));
    stream(JSON.stringify({ v: 1, type: 'action', token, tool: 'file_editor', command: 'create', path: '/etc/shadow' }));
    stream(JSON.stringify({ v: 1, type: 'teleport', token }));
    stream(JSON.stringify({ v: 1, type: 'observation', token, tool: { nested: true }, error: 'yes', excerpt: ['not', 'a string'] }));
    stream(JSON.stringify({ v: 1, type: 'started', token, sdk: 42, tools: 'terminal', max_iterations: -3, model: { x: 1 } }));
    stream(`{"v":1,"type":"message","token":"${token}","__proto__":{"polluted":true},"excerpt":"proto"}`);
    stream(`{"v":1,"type":"message","token":"${token}","excerpt":"${'x'.repeat(200_000)}"}`);
    stream('{"v":1,"type":"message","token":"' + token + '","excerpt":"unterminated');
  }

  emit('started', { sdk: '1.21.0', tools_package: '1.21.0', python: '3.12.0', model: envs.LLM_MODEL, tools: ['terminal', 'file_editor'], tool_names: ['TerminalTool', 'FileEditorTool'], max_iterations: Number(envs.TIMMY_OPENHANDS_MAX_ITERATIONS), bounded: true, llm_options: ['stream', 'timeout', 'usage_id'], live_events: true });
  emit('action', { n: 1, tool: 'terminal', name: 'TerminalTool', kind: 'TerminalAction', command: 'cat /work/src/a.txt' });
  emit('observation', { n: 1, tool: 'terminal', kind: 'TerminalObservation', error: false, exit_code: 0, excerpt: 'first line' });

  if (words.has('HANG')) {
    if (words.has('IGNORETERM')) process.on('SIGTERM', () => { process.stderr.write('timmy_openhands: SIGTERM ignored (a FAKE worker that does not stop)\n'); });
    else process.on('SIGTERM', () => { emit('result', { status: 'stopped', finished: false, steps: 1, max_iterations: 40 }); end(143); });
    setInterval(() => {}, 1000);
  } else {
    appendFileSync(inCopy('src/a.txt'), 'one more line (a FAKE OpenHands)\n');
    emit('action', { n: 2, tool: 'file_editor', name: 'FileEditorTool', kind: 'FileEditorAction', command: 'str_replace', path: '/work/src/a.txt' });
    emit('observation', { n: 2, tool: 'file_editor', kind: 'FileEditorObservation', error: false, excerpt: 'The file /work/src/a.txt has been edited.' });
    let n = 2;
    if (words.has('ADD')) { put('src/new.txt', 'a new file (a FAKE OpenHands)\n'); emit('action', { n: ++n, tool: 'file_editor', command: 'create', path: '/work/src/new.txt' }); }
    if (words.has('DELETE')) { rmSync(inCopy('old.txt'), { force: true }); emit('action', { n: ++n, tool: 'terminal', command: 'rm old.txt' }); }
    if (words.has('LINK')) { symlinkSync('/etc/hosts', inCopy('link.txt')); emit('action', { n: ++n, tool: 'terminal', command: 'ln -s /etc/hosts link.txt' }); }
    if (words.has('GITDIR')) { put('.git/config', '[core]\n'); emit('action', { n: ++n, tool: 'terminal', command: 'git init' }); }
    if (words.has('NESTED')) { put('deep/er/file.txt', 'deep (a FAKE OpenHands)\n'); emit('action', { n: ++n, tool: 'file_editor', command: 'create', path: 'deep/er/file.txt' }); }
    // Not the agent: the operator editing the project itself while the run goes (the real container cannot reach it).
    if (words.has('TOUCHPROJECT')) appendFileSync(join(project, 'src', 'a.txt'), 'an edit by the operator meanwhile\n');
    emit('message', { source: 'agent', excerpt: 'I changed src/a.txt (a FAKE OpenHands).' });
    if (words.has('NORESULT')) return end(0);
    if (words.has('NOFINISH')) { emit('result', { status: 'limit', finished: false, steps: n, max_iterations: 40, final_message: 'Ran out of steps (a FAKE OpenHands).', usage: { input: 900, output: 30 } }); return end(3); }
    emit('result', { status: 'finished', finished: true, steps: n, max_iterations: 40, final_message: 'Done: FINAL (a FAKE OpenHands).', final_chars: 31, usage: { input: 1200, output: 34 } });
    if (words.has('AFTER')) emit('result', { status: 'finished', finished: true, final_message: 'FORGED: a second result' });
    return end(0);
  }
}
play();
