#!/usr/bin/env node
// fake-code-agent.mjs: a FAKE code agent, a TEST DOUBLE for tests/code-agent.test.ts. It is NOT Qwen Code,
// Claude Code, Codex or OpenCode, calls no model and sends nothing anywhere. It prints events shaped like the
// stream-json lines Claude Code documents for `-p --output-format stream-json` (system/init, assistant,
// user, result), which is the shape this repo's parser reads for Qwen Code too; the real Qwen Code 0.25.0
// stream is checked separately (tests/code-agent.test.ts, the real-qwen test, skipped when it is absent).
//
// What it does is chosen by words in its task (its last argument):
//   EDIT      changes src/a.txt, adds new/added.txt (both reported as tool calls) and deletes old.txt
//             without reporting it (only the before/after snapshot can see that)
//   SLEEP     reports its start, then waits 30 s (for /stop and time limits)
//   BUDGET    with SLEEP: exits 55 once its --max-wall-time passes, as qwen documents
//   FAILJSON  exits 0 but its result event says is_error
//   TEXT      prints plain text, no JSON
//   LONG      its final message is 9,000 characters
//   COST      its result event reports total_cost_usd 0.0123
//   EXIT3     exits 3 after its start
//   HOME      prints the HOME it was given, as plain text
// For /iterate (round R4), on the recipe's parameter file recipes/tray.params.json:
//   PARAM:<name>=<value>  (one or more) sets those parameters in the file, keeping its schema and recipe fields
//   PARAMSBAD             writes the file with a width the recipe refuses (5 mm)
//   OTHERFILE             also writes notes/other.txt, a file /iterate does not allow it to change
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('0.0.0-fake (a FAKE code agent, not a real one)'); process.exit(0); }
const task = argv.at(-1) ?? '';
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const model = flag('-m') ?? flag('--model') ?? 'fake-model';
const emit = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const cwd = process.cwd();

if (task.includes('HOME')) console.log(`home=${process.env.HOME ?? ''}`);
if (task.includes('TEXT')) {
  console.log('Working on it (plain text, a FAKE agent).');
  console.log('Done.');
  process.exit(0);
}

emit({ type: 'system', subtype: 'init', cwd, session_id: 'fake-session', model, tools: ['write_file', 'edit', 'read_file'], qwen_code_version: '0.0.0-fake' });

if (task.includes('EXIT3')) process.exit(3);

if (task.includes('SLEEP')) {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Thinking for a long time (a FAKE).' }] } });
  if (task.includes('BUDGET')) {
    const wall = flag('--max-wall-time') ?? '1s';
    const n = Number.parseFloat(wall);
    const ms = wall.endsWith('m') ? n * 60_000 : wall.endsWith('h') ? n * 3_600_000 : n * 1000;
    setTimeout(() => { console.error('wall-clock budget exceeded (a FAKE)'); process.exit(55); }, ms);
  }
  setTimeout(() => process.exit(0), 30_000);
} else {
  if (task.includes('EDIT')) {
    const a = join(cwd, 'src', 'a.txt');
    writeFileSync(a, `${readFileSync(a, 'utf8')}one more line\n`);
    mkdirSync(join(cwd, 'new'), { recursive: true });
    writeFileSync(join(cwd, 'new', 'added.txt'), 'added by a FAKE agent\n');
    rmSync(join(cwd, 'old.txt'));
    emit({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'I will edit two files.' },
      { type: 'tool_use', id: 't1', name: 'edit', input: { file_path: a, old_string: 'x', new_string: 'y' } },
      { type: 'tool_use', id: 't2', name: 'write_file', input: { file_path: join(cwd, 'new', 'added.txt'), content: 'added' } },
      { type: 'tool_use', id: 't3', name: 'run_shell_command', input: { command: 'ls' } },
    ] } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'not approved' }] } });
  }
  const params = [...task.matchAll(/PARAM:([A-Za-z]+)=(-?[0-9.]+)/g)];
  if (params.length || task.includes('PARAMSBAD')) {
    const file = join(cwd, 'recipes', 'tray.params.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    for (const [, name, value] of params) json.parameters[name] = Number(value);
    if (task.includes('PARAMSBAD')) json.parameters.width = 5;
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'edit', input: { file_path: file, old_string: 'x', new_string: 'y' } }] } });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }] } });
  }
  if (task.includes('OTHERFILE')) {
    mkdirSync(join(cwd, 'notes'), { recursive: true });
    writeFileSync(join(cwd, 'notes', 'other.txt'), 'written by a FAKE agent where it was told not to write\n');
  }
  const fail = task.includes('FAILJSON');
  const message = task.includes('LONG') ? 'L'.repeat(9000) : 'All done: FINAL (a FAKE agent).';
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: message }] } });
  emit({
    type: 'result', subtype: fail ? 'error_during_execution' : 'success', is_error: fail, num_turns: 2, duration_ms: 12,
    result: message, ...(task.includes('COST') ? { total_cost_usd: 0.0123 } : {}),
    // as qwen 0.25.0 was seen to report a refused tool call (its run still says success)
    permission_denials: task.includes('EDIT') ? [{ tool_name: 'run_shell_command', tool_use_id: 't3', tool_input: { command: 'ls' } }] : [],
  });
  process.exit(0);
}
