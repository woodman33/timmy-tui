#!/usr/bin/env node
// R10 (H163): which processes still run in a folder: those whose command line names it or whose working folder is inside it.
//
//   node census.mjs <folder> [--json]      exit 0 when none, 1 when some (each named), 2 on a usage error
//
// R9's Mac run counted "one sh of the run folder still running 15.4 s after the run's tmux server ended" (its step E). Its
// census was `ps -axo pid=,command=`, the lines holding the run folder, all but the census's own script; it did not leave out
// the census's own parents. Run as R9's runner ran it (`sh <run folder>/…/run-steps.sh`, starting each step's node script),
// that runner is such a line for exactly as long as the census waits, and ends with the run: on Linux the same census found
// "1 (sh)" after 15.2 s, and the sh was its own parent (R10, H163). This census leaves out itself and every process it runs
// under, and names what it finds (pid, parent, program, and whether the folder is in its command line or is its working
// folder), so a process left behind can be told from the one counting.
//
// Linux reads /proc (command lines and working folders); macOS asks ps (command lines) and lsof (working folders).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The processes this census runs under: its own pid and each parent up to pid 1 (which is never counted either). */
export function ancestorsOf(pid = process.pid, parentOf = defaultParentOf()) {
  const out = new Set([pid]);
  for (let p = pid, n = 0; p > 1 && n < 256; n++) {
    const q = parentOf(p);
    if (!q || out.has(q)) break;
    out.add(q);
    p = q;
  }
  out.add(1);
  return out;
}

function procParent(pid) {
  try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); } catch { return 0; }
}
function psTable() {
  const rows = new Map();
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 }); } catch { return rows; }
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}
function defaultParentOf() {
  if (process.platform === 'linux') return procParent;
  const rows = psTable();
  return (pid) => rows.get(pid)?.ppid ?? 0;
}

const inside = (root, p) => !!p && (p === root || p.startsWith(`${root}/`));

/** Every process (not this census nor its parents) whose command line names `folder` or whose working folder is inside it. */
export function census(folder, o = {}) {
  let root = resolve(folder);
  try { root = realpathSync(root); } catch { /* as given */ }
  const roots = [...new Set([resolve(folder), root])];
  const skip = o.skip ?? ancestorsOf();
  const found = [];
  if (process.platform === 'linux') {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      if (skip.has(pid)) continue;
      let argv = [], cwd = '', stat = '';
      try { argv = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
      try { cwd = readlinkSync(`/proc/${d}/cwd`); } catch { cwd = ''; }
      try { stat = readFileSync(`/proc/${d}/stat`, 'utf8'); } catch { continue; }
      const byArgv = argv.some((a) => roots.some((r) => a.includes(r)));
      const byCwd = roots.some((r) => inside(r, cwd));
      if (!byArgv && !byCwd) continue;
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      if (state === 'Z') continue;   // ended, waiting for its parent to read its exit: not running
      found.push({ pid, ppid: procParent(pid), program: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), command: argv.join(' '), cwd, why: [byArgv && 'command line', byCwd && 'working folder'].filter(Boolean).join(' and ') });
    }
    return found;
  }
  const rows = psTable();
  const cwds = new Map();
  try {
    let pid = 0;
    for (const line of execFileSync('lsof', ['-nP', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }).split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1)); else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
    }
  } catch { /* no lsof: command lines only */ }
  for (const [pid, r] of rows) {
    if (skip.has(pid)) continue;
    const cwd = cwds.get(pid) ?? '';
    const byArgv = roots.some((x) => r.command.includes(x));
    const byCwd = roots.some((x) => inside(x, cwd));
    if (!byArgv && !byCwd) continue;
    found.push({ pid, ppid: r.ppid, program: (r.command.split(/\s+/)[0] ?? '?').split('/').pop(), command: r.command, cwd, why: [byArgv && 'command line', byCwd && 'working folder'].filter(Boolean).join(' and ') });
  }
  return found;
}

/** One line a process: pid, its parent, its program, why it is counted, its command line (cut). */
export const describe = (p) => `pid ${p.pid} (parent ${p.ppid}) ${p.program}: the folder is in its ${p.why}: ${p.command.slice(0, 160)}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith('--'));
  if (!folder) { console.error('usage: node census.mjs <folder> [--json]'); process.exit(2); }
  const found = census(folder);
  if (args.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else if (!found.length) console.log(`No process runs in ${folder} (none names it in its command line or works inside it; this census and the processes it runs under are not counted).`);
  else { console.log(`${found.length} process${found.length === 1 ? ' still runs' : 'es still run'} in ${folder}:`); for (const p of found) console.log(`  ${describe(p)}`); }
  process.exit(found.length ? 1 : 0);
}
