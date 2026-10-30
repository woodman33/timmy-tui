#!/usr/bin/env node
// A FAKE `timmy act` for tests/control-runs.test.ts: what act prints (its progress on stderr, its end's JSON on stdout) and
// what an /agent run writes in its project (.timmy/agents/<run>/result.json, the final message, the operation record).
// FAKE_ACT_MODE: ok (the agent changes a.txt, exit 0) · wait (waits for SIGTERM, then ends stopped, exit 3) · die (exits 1
// without printing its end). `act /recover` answers, exit 0.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const work = argv[argv.indexOf('--project') + 1];
const line = argv[1];
const mode = process.env.FAKE_ACT_MODE ?? 'ok';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const end = (o) => { process.stdout.write(`${JSON.stringify({ schema: 'timmy.act/1', joined: false, parent: null, request: line, project: 'work', records: [], lines: [], ...o })}\n`); };

if (line === '/recover') {
  process.stderr.write('  recover: 1 run left by a session that ended: settled as interrupted\n');
  end({ operation: 'o9e9e9e9e', outcome: 'answered', exit_code: 0, why: 'answered', runs: [], receipts: [], lines: ['recovered 1 run: interrupted'] });
  process.exit(0);
}

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(TIMMY_AGENT_|OPENROUTER|OPENAI|TIMMY_HOME$)/.test(k)));
writeFileSync(join(work, 'fake-act-seen.json'), JSON.stringify({ argv, env, copy: readdirSync(work) }));
mkdirSync(join(work, '.timmy', 'operations'), { recursive: true });
writeFileSync(join(work, '.timmy', 'operations', 'o1a2b3c4d.json'), '{}');
process.stderr.write('  ▶ qwen: started (job j0a0b0c)\n');

if (mode === 'die') { process.stderr.write('  ▶ qwen: editing a.txt\n'); process.exit(1); }

if (mode === 'wait') {
  process.stderr.write('  ▶ qwen: waiting\n');
  process.on('SIGTERM', () => {
    process.stderr.write('  stopping: SIGTERM received\n');
    end({ operation: 'o1a2b3c4d', outcome: 'stopped', exit_code: 3, why: 'SIGTERM received', runs: [{ kind: 'agent', id: 'a1b2c3d4e' }], receipts: [] });
    process.exit(3);
  });
  setInterval(() => {}, 1000);
} else {
  const before = readFileSync(join(work, 'a.txt'), 'utf8');
  writeFileSync(join(work, 'a.txt'), `${before}two\n`);
  const run = join(work, '.timmy', 'agents', 'a1b2c3d4e');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'final-message.txt'), 'Added a line.');
  writeFileSync(join(run, 'result.json'), JSON.stringify({
    agent_run: 1, run: 'a1b2c3d4e', agent: 'qwen', agent_version: 'qwen 0.25.1', model: process.env.TIMMY_AGENT_MODEL, endpoint: 'local', where: '127.0.0.1:11434',
    task: line, job: 'j0a0b0c', operation: 'o1a2b3c4d', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), exit_code: 0, outcome: 'completed', why: 'it said it completed',
    files: { added: [], changed: [{ path: 'a.txt', size: 8, sha256: sha('one\ntwo\n'), previous_sha256: sha('one\n') }], deleted: [], truncated: false },
    final_message: { file: '.timmy/agents/a1b2c3d4e/final-message.txt', chars: 13, truncated: false }, receipt: 'feedbeef',
  }));
  process.stderr.write('  ▶ qwen: editing a.txt\n  ✓ qwen: completed\n');
  end({ operation: 'o1a2b3c4d', outcome: 'succeeded', exit_code: 0, why: 'the agent run completed', runs: [{ kind: 'agent', id: 'a1b2c3d4e' }], receipts: [{ id: 'feedbeef', kind: 'run', status: 'ok' }] });
  process.exit(0);
}
