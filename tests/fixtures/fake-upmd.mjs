#!/usr/bin/env node
// fake-upmd.mjs: a TEST DOUBLE of upmd 0.2.7's --ci behaviour, for tests/workflows-upmd.test.ts.
// It is not upmd (github.com/rezigned/upmd, MIT). It reproduces only what was observed of the real
// tool on the operator's machine:
//   upmd --version                          prints `upmd 0.2.7`
//   upmd --ci -b <name> -d <dir> <file.md>  runs the named block after its dependencies (dependencies
//                                           first), without prompting, with <dir> as the working
//                                           directory. For each block it runs, stdout shows
//                                             ==> <name> [block <n>]
//                                             (the block's own output, its stdout and stderr merged)
//                                             <== <name> exited with code <c>
//                                           where <n> counts fenced code blocks in document order
//                                           from 1. A failing block stops the chain: its end line
//                                           shows its code, `Block <n> failed - stopping dependency
//                                           chain` goes to stderr and the exit status is 1. Success
//                                           exits 0.
// Each block's code runs with `sh -c` in <dir>. Anything else (another option, an unknown block or
// dependency, a cycle) was not observed: the double says so on stderr and exits 2 instead of
// guessing. It parses the Markdown with its own small logic and imports nothing from src/, so the
// adapter's parser is checked against an independent reading of the document.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';

// synchronous writes to the file descriptors the blocks share, so the lines interleave in order
const out = (text) => writeSync(1, text);
const err = (text) => writeSync(2, text);
const unobserved = (what) => {
  err(`fake-upmd: ${what} (not observed of upmd 0.2.7; this test double does not guess)\n`);
  process.exit(2);
};

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  out('upmd 0.2.7\n');
  process.exit(0);
}

let ci = false;
let target = null;
let dir = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--ci') ci = true;
  else if (arg === '-b') target = argv[++i];
  else if (arg === '-d') dir = argv[++i];
  else if (arg.startsWith('-')) unobserved(`option ${arg}`);
  else files.push(arg);
}
if (!ci || !target || !dir || files.length !== 1) unobserved('only `--ci -b <name> -d <dir> <file.md>` and `--version` are reproduced');

// Blocks: fenced code blocks (``` or ~~~, indented at most 3 spaces), numbered from 1 in order.
const blocks = [];
const lines = readFileSync(files[0], 'utf8').split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
  if (!open || (open[1][0] === '`' && open[2].includes('`'))) continue;
  const body = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]);
    if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) break;
    body.push(lines[j]);
  }
  const attrs = {};
  const list = /\[(.*)\]/.exec(open[2]);
  for (const pair of (list ? list[1] : '').matchAll(/(\w+)\s*:\s*("[^"]*"|'[^']*'|[^,]*)/g)) {
    attrs[pair[1]] = pair[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  blocks.push({ n: blocks.length + 1, name: attrs.name || null, deps: (attrs.deps || '').match(/[\w.-]+/g) || [], code: body.join('\n') });
  i = j;
}

// The run order: dependencies first, each block once.
const byName = new Map();
for (const block of blocks) if (block.name && !byName.has(block.name)) byName.set(block.name, block);
const order = [];
const seen = new Map(); // name → 'visiting' | 'done'
const visit = (name) => {
  if (seen.get(name) === 'done') return;
  if (seen.get(name) === 'visiting') unobserved(`a dependency cycle through ${name}`);
  const block = byName.get(name);
  if (!block) unobserved(`no block named ${name}`);
  seen.set(name, 'visiting');
  for (const dep of block.deps) visit(dep);
  seen.set(name, 'done');
  order.push(block);
};
visit(target);

for (const block of order) {
  out(`==> ${block.name} [block ${block.n}]\n`);
  // the block's stdout and stderr both go to this process's stdout: merged, in order
  const run = spawnSync('sh', ['-c', block.code], { cwd: dir, stdio: ['ignore', 1, 1] });
  const code = run.status ?? 1; // a signal or a spawn error was not observed; reported as a failure
  out(`<== ${block.name} exited with code ${code}\n`);
  if (code !== 0) {
    err(`Block ${block.n} failed - stopping dependency chain\n`);
    process.exit(1);
  }
}
process.exit(0);
