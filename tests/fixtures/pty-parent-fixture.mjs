#!/usr/bin/env node
// pty-parent-fixture.mjs: a labelled TEST FIXTURE for tests/workflow-parent-death.test.ts (round R4, H67); nobody runs it as
// Timmy. It is the parent a pty wrapper has in a REPL, reduced to what matters here: it starts one command as src/jobs
// starts a job (the leader of its own process group, stdin, stdout and stderr pipes it holds), copies what the command
// writes to a file as it comes, prints `READY {"pid": <the command's pid>}` once the command has started, and then waits
// to be killed from outside (the test sends SIGKILL, as r20 did to a REPL on the Mac). It never stops the command itself.
//
//   node tests/fixtures/pty-parent-fixture.mjs <config.json>
//   config: { "command": "<program>", "args": ["<arg>", ...], "log": "<file the command's output is copied to>" }
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const child = spawn(cfg.command, cfg.args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
const keep = (stream) => (chunk) => appendFileSync(cfg.log, `${stream}: ${chunk.toString('utf8')}`);
child.stdout.on('data', keep('out'));
child.stderr.on('data', keep('err'));
child.once('spawn', () => process.stdout.write(`READY ${JSON.stringify({ pid: child.pid, parent: process.pid })}\n`));
child.once('error', (e) => { process.stdout.write(`FAILED ${e.message}\n`); process.exit(1); });
child.once('exit', (code, signal) => appendFileSync(cfg.log, `exit: ${code ?? signal}\n`));
// Killed from outside: this process never ends by itself.
setInterval(() => {}, 1 << 30);
