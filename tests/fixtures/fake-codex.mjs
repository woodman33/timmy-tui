#!/usr/bin/env node
// fake-codex.mjs: a FAKE Codex, a TEST DOUBLE for tests/codex-local.test.ts. It is NOT codex-cli: it calls no
// model, contacts nothing and sends nothing anywhere. It checks the command line Timmy's local Codex route gives
// it (codex exec --oss --local-provider ollama -m <model> --json --skip-git-repo-check -s workspace-write
// -c <the three sandbox_workspace_write overrides> -C <project> --ignore-user-config --ignore-rules ...), refuses a
// bypass flag or any other -c override, then prints JSONL events shaped as Timmy's parser reads them
// (thread.started, turn.started, item.*, turn.completed, turn.failed, error).
// Round R4 (H37): a real run with codex-cli 0.153.2 printed thread.started, turn.started, item.started, item.completed
// (item types reasoning, agent_message, command_execution, error) and turn.completed; the other names this fake prints
// (turn.failed, item.updated, error, file_change, todo_list, ...) are still the ones Timmy ASSUMES (codex-local.ts).
// Every field beyond an event's type is as codex-rs is known to write it, not recorded from that run.
//
// What it was given (its arguments, its -c overrides, its working folder, and the environment variables Timmy sets
// or blanks) is written to fake-codex-report.json beside its -o file (the run's folder, .timmy/agents/<run>/).
//
// Its stdin: the recorded `codex exec --help` (codex-cli 0.153.2) says "If stdin is piped and a prompt is also
// provided, stdin is appended as a `<stdin>` block", so a real Codex reads a piped stdin to its end. This fake reads it
// too, and where the real one would wait on a pipe nobody ends, the fake gives up after 2 s and refuses the run instead.
//
// What it does is chosen by words in its task (its last argument):
//   (default)              appends a line to src/a.txt: a command item, a file_change item, a message, turn.completed
//   PARAM:<name>=<value>   (one or more) sets those parameters in recipes/tray.params.json instead (for /iterate)
//   OTHERFILE              also writes notes/other.txt
//   FAILTURN               its turn fails (turn.failed with a message); exits 1
//   FAILEXIT0              its turn fails, but it exits 0
//   TRANSIENT              an error event (a reconnect notice) first, then the turn completes
//   NOEND                  a message, but no turn.completed; exits 0
//   SILENT                 prints nothing; exits 0
//   ALIEN                  prints only JSON lines of types Timmy does not read; exits 0
//   SLEEP                  starts, then waits 30 s (for /stop)
//   OBSERVED               (R4, H37) the sequence a real codex-cli 0.153.2 run printed: the plain line "Reading
//                          additional input from stdin..." on stderr, then thread.started, turn.started, an
//                          item.completed of type error (its model metadata warning, the model named `<model>` as in
//                          the order that reported it), reasoning, five command_execution items (one shown writing a
//                          patch under /tmp, one applying it: printed only, NOT run; this fake writes nothing outside
//                          the project and appends the line to src/a.txt itself), an agent_message and turn.completed
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('codex-cli 0.0.0-fake (a FAKE Codex, not the real one)'); process.exit(0); }
const cwd = process.cwd();
const value = (...flags) => { for (const f of flags) { const i = argv.indexOf(f); if (i >= 0) return argv[i + 1]; } return undefined; };
const task = argv.at(-1) ?? '';
const emit = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);

// ── what it was given ──
const stdin = await new Promise((done) => {
  if (process.stdin.isTTY) { done({ tty: true, open: false, bytes: 0 }); return; }
  let bytes = 0;
  const timer = setTimeout(() => done({ open: true, bytes }), 2000);
  process.stdin.on('data', (chunk) => { bytes += chunk.length; });
  process.stdin.once('end', () => { clearTimeout(timer); done({ open: false, bytes }); });
  process.stdin.once('error', () => { clearTimeout(timer); done({ open: false, bytes }); });
  process.stdin.resume();
});
const last = value('-o', '--output-last-message');
const lastFile = last ? resolve(cwd, last) : undefined;
const reportDir = lastFile ? dirname(lastFile) : join(cwd, '.timmy');
const ENV_SEEN = ['HOME', 'CODEX_HOME', 'CODEX_OSS_BASE_URL', 'CODEX_OSS_PORT', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY', 'TIMMY_AGENT_API_KEY'];
// R4 (H37): every -c / --config override, in order (the flag may be given more than once)
const config = argv.flatMap((a, i) => ((a === '-c' || a === '--config') && i + 1 < argv.length ? [argv[i + 1]] : a.startsWith('--config=') ? [a.slice('--config='.length)] : []));
try {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'fake-codex-report.json'), `${JSON.stringify({ argv, config, cwd, stdin, env: Object.fromEntries(ENV_SEEN.map((k) => [k, process.env[k] ?? null])) }, null, 2)}\n`);
} catch { /* the tests then find no report */ }

// ── the command line it must have been given ──
const problems = [];
if (argv[0] !== 'exec') problems.push(`its first argument is ${argv[0]}, not exec`);
if (!argv.includes('--oss')) problems.push('no --oss');
if (value('--local-provider') !== 'ollama') problems.push(`--local-provider is ${value('--local-provider')}, not ollama`);
const model = value('-m', '--model');
if (!model) problems.push('no -m <model>');
if (!argv.includes('--json')) problems.push('no --json');
if (!argv.includes('--skip-git-repo-check')) problems.push('no --skip-git-repo-check');
if (value('-s', '--sandbox') !== 'workspace-write') problems.push(`the sandbox is ${value('-s', '--sandbox')}, not workspace-write`);
const cd = value('-C', '--cd');
let cdOk = false;
try { cdOk = Boolean(cd) && realpathSync(resolve(cwd, cd)) === realpathSync(cwd); } catch { cdOk = false; }
if (!cdOk) problems.push(`-C ${cd} is not the folder it runs in`);
for (const bad of ['--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--yolo', 'danger-full-access', '--add-dir']) if (argv.includes(bad)) problems.push(`it was given ${bad}`);
// R4 (H37): the sandbox overrides Timmy's route passes, exactly these and nothing else (the keys are ASSUMED from Codex's
// config documentation; this fake checks only that they are given, not what a real Codex does with them)
const OVERRIDES = ['sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.network_access=false'];
for (const want of OVERRIDES) if (!config.includes(want)) problems.push(`no -c ${want}`);
for (const got of config) if (!OVERRIDES.includes(got)) problems.push(`an override it does not expect: -c ${got}`);
for (const flag of ['--ignore-user-config', '--ignore-rules']) if (!argv.includes(flag)) problems.push(`no ${flag}`);
if (stdin.open) problems.push('its stdin stayed open: a real codex exec reads a piped stdin to its end, so it would wait');
if (problems.length) {
  const message = `FAKE codex refused its command line: ${problems.join('; ')}`;
  emit({ type: 'error', message });
  emit({ type: 'turn.failed', error: { message } });
  process.exit(2);
}

if (task.includes('SILENT')) process.exit(0);
if (task.includes('ALIEN')) {
  emit({ type: 'session.configured', model });
  emit({ type: 'response.delta', text: 'not an event Timmy reads' });
  emit({ type: 'session.configured', model });
  process.exit(0);
}

if (task.includes('OBSERVED')) process.stderr.write('Reading additional input from stdin...\n');
emit({ type: 'thread.started', thread_id: 'fake-thread-0001' });
emit({ type: 'turn.started' });
if (task.includes('TRANSIENT')) emit({ type: 'error', message: 'Reconnecting... 1/5 (a FAKE stream error)' });

const finish = (message, id = 'item_9') => {
  emit({ type: 'item.completed', item: { id, type: 'agent_message', text: message } });
  if (lastFile) writeFileSync(lastFile, message);
};

if (task.includes('OBSERVED')) {
  // the sequence codex-cli 0.153.2 printed on the operator's Mac (types as observed; other fields as codex-rs writes them)
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `<model>` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'Reading the file before changing it (a FAKE).' } });
  const a = join(cwd, 'src', 'a.txt');
  // printed, NOT run: this fake never writes /tmp; it makes the change the patch stands for itself, in the project
  const commands = [
    "bash -lc 'cat src/a.txt'",
    "bash -lc 'ls'",
    "bash -lc \"cat > /tmp/patch.txt << 'EOF'\n*** Begin Patch\n*** Update File: src/a.txt\n+one more line (a FAKE codex)\n*** End Patch\nEOF\"",
    "bash -lc 'apply_patch < /tmp/patch.txt'",
    "bash -lc 'cat src/a.txt'",
  ];
  commands.forEach((command, i) => {
    const id = `item_${i + 2}`;
    emit({ type: 'item.started', item: { id, type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' } });
    if (i === 3) appendFileSync(a, 'one more line (a FAKE codex)\n');
    emit({ type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: i === 0 || i === 4 ? readFileSync(a, 'utf8') : '', exit_code: 0, status: 'completed' } });
  });
  finish('Done: FINAL (a FAKE codex, the observed sequence).', 'item_7');
  emit({ type: 'turn.completed', usage: { input_tokens: 2400, cached_input_tokens: 0, output_tokens: 120 } });
  process.exit(0);
} else if (task.includes('SLEEP')) {
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking for a long time (a FAKE)' } });
  setTimeout(() => process.exit(0), 30_000);
} else if (task.includes('FAILTURN') || task.includes('FAILEXIT0')) {
  emit({ type: 'turn.failed', error: { message: 'model qwen3:4b ran out of context (a FAKE failure)' } });
  process.exit(task.includes('FAILEXIT0') ? 0 : 1);
} else {
  const params = [...task.matchAll(/PARAM:([A-Za-z]+)=(-?[0-9.]+)/g)];
  emit({ type: 'item.started', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'read the file', completed: false }, { text: 'edit it', completed: false }] } });
  if (params.length) {
    const file = join(cwd, 'recipes', 'tray.params.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    for (const [, name, v] of params) json.parameters[name] = Number(v);
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    emit({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: file, kind: 'update' }], status: 'completed' } });
  } else {
    const a = join(cwd, 'src', 'a.txt');
    emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'cat src/a.txt', aggregated_output: '', status: 'in_progress' } });
    emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat src/a.txt', aggregated_output: readFileSync(a, 'utf8'), exit_code: 0, status: 'completed' } });
    appendFileSync(a, 'one more line (a FAKE codex)\n');
    emit({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: a, kind: 'update' }], status: 'completed' } });
  }
  if (task.includes('OTHERFILE')) {
    mkdirSync(join(cwd, 'notes'), { recursive: true });
    writeFileSync(join(cwd, 'notes', 'other.txt'), 'written by a FAKE codex where it was told not to write\n');
  }
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'read the file', completed: true }, { text: 'edit it', completed: true }] } });
  finish('Done: FINAL (a FAKE codex).');
  if (!task.includes('NOEND')) emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 34 } });
  process.exit(0);
}
