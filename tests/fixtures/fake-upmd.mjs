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
//
// Round R4 (H58): the pty mode, when its stdout is a terminal (Timmy runs upmd through
// workers/upmd/pty_run.py). What upmd 0.2.7 wrote on a terminal (a probe run under python3's pty on
// the operator's Mac, kept byte for byte in tests/fixtures/upmd-0.2.7-pty-third.bin), reproduced here
// by its shape, with the blocks running for real so their delays are real:
//   ESC[?25l (the cursor hidden) first and ESC[?25h last;
//   as a block starts: ` [<n>/<count>] <Lang>` (<count>: every fenced block of the document; <Lang>:
//     its language with a capital), with ` [<needs>]` after it for a block with needs, then its code
//     (each line indented by two spaces), a blank line, an empty styled line, its output as it runs
//     (indented by two spaces) and a drawn cursor (an inverse space);
//   each new line of output: ESC[<k>A CR ESC[J and the whole drawing again (its header repeated);
//   as it ends: a failing block's `Block <n> failed - stopping dependency chain` on stderr first,
//     then ESC[<k>A CR ESC[J, `==> <name> [block <n>]`, its whole output again and `✔ exited with
//     code 0` or `✘ exited with code <c>` (indented by two spaces), then a blank line; a failing
//     block ends the run there with exit 1.
// Lines end with \n, which the terminal writes as CR LF (upmd, in raw mode, writes CR LF itself).
// Like upmd (r18 saw each block's bash in a session of its own), each block runs in a session of its
// own; unlike upmd, its output comes through pipes, not a terminal of its own, so it gets no hangup
// when this process ends. The pipe mode (stdout not a terminal) is unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';
import { isatty } from 'node:tty';

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
  blocks.push({ n: blocks.length + 1, name: attrs.name || null, deps: (attrs.deps || '').match(/[\w.-]+/g) || [], code: body.join('\n'), lang: /^[^\s[]*/.exec(open[2].trim())[0] });
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

if (isatty(1)) await runOnTerminal();

/** The pty mode (see the header): each block drawn as it starts, its output as it comes, its end. */
async function runOnTerminal() {
  const E = '\x1b';
  const quiet = `${E}[38;2;130;130;146m`;
  const lang = (l) => (l ? l[0].toUpperCase() + l.slice(1) : 'Text');
  out(`${E}[?25l\n`);
  for (const block of order) {
    const header = `${E}[48;2;60;60;76m${quiet} [${E}[38;2;203;166;247m${block.n}${E}[0m${E}[48;2;60;60;76m${quiet}/${blocks.length}]${quiet} ${lang(block.lang)}`
      + `${block.deps.length ? ` ${E}[38;2;147;153;178m [${block.deps.join(', ')}]` : ''}${E}[0m`;
    const code = block.code.split('\n').map((l) => `  ${E}[38;2;205;214;244m${l}${E}[0m`);
    const output = [];
    const shown = (l) => `  ${E}[39m${E}[49m${l}${E}[0m`;
    let drawn = 0;
    const draw = () => {
      const frame = [header, ...code, '', `${E}[38;2;147;153;178m${E}[0m`, ...output.map(shown), `  ${E}[39m${E}[49m${E}[7m ${E}[0m`];
      out(`${drawn ? `${E}[${drawn}A\r${E}[J\n` : ''}${frame.join('\n')}\n`);
      drawn = frame.length + 1;
    };
    draw();
    const child = spawn('sh', ['-c', block.code], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const reader = () => {
      let rest = '';
      return {
        data: (chunk) => {
          const lines = (rest + chunk.toString('utf8')).split('\n');
          rest = lines.pop();
          if (lines.length) { output.push(...lines); draw(); }
        },
        end: () => { if (rest) output.push(rest); rest = ''; },
      };
    };
    const o = reader();
    const e = reader();
    child.stdout.on('data', o.data);
    child.stderr.on('data', e.data);
    // a signal or a spawn error was not observed; reported as a failure
    const code0 = await new Promise((resolve) => { child.on('error', () => resolve(1)); child.on('close', (status) => resolve(status ?? 1)); });
    o.end();
    e.end();
    if (code0 !== 0) err(`Block ${block.n} failed - stopping dependency chain\n`);
    out(`${E}[${drawn}A\r${E}[J\n${E}[38;2;203;166;247m==> ${block.name} [block ${block.n}]${E}[0m\n`);
    for (const l of output) out(`${shown(l)}\n`);
    out(`  ${code0 === 0 ? `${E}[38;2;166;227;161m✔` : `${E}[38;2;243;139;168m✘`} exited with code ${code0}${E}[0m\n`);
    if (code0 !== 0) {
      out(`${E}[?25h`);
      process.exit(1);
    }
    out('\n');
  }
  out(`${E}[?25h`);
  process.exit(0);
}

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
