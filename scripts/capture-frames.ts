// ui-cockpit-k7m3 C5 — screen captures through a real PTY (tmux), the same
// way the FILM-PLAN-v2 / ck1 shots were taken, but reproducible:
//   npx tsx scripts/capture-frames.ts --out .timmy/captures --name ck5-hands-80 \
//     --width 80 --height 24 --keys 6,h,Right,Right,Enter [--wait 7000] [--env K=V]…
// Keys are tmux send-keys names (Enter, Escape, Right, Down, C-k …) or single
// characters; "text:<literal>" types a literal string. The capture is the
// full pane (capture-pane -p), written verbatim; its sha256 is printed so a
// manifest can cite it. Nothing is written outside --out.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n: string, d?: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flags = (n: string): string[] => argv.map((a, i) => (a === n ? argv[i + 1] : null)).filter((x): x is string => !!x);
const out = flag('--out', '.timmy/captures')!;
const name = flag('--name');
const width = Number(flag('--width', '120'));
const height = Number(flag('--height', '40'));
const wait = Number(flag('--wait', '30000')); // upper bound: the script polls until the shell has assembled
const keys = (flag('--keys', '') ?? '').split(',').map(k => k.trim()).filter(Boolean);
const env = flags('--env');
if (!name) { console.error('usage: capture-frames.ts --name <stem> [--out dir] [--width n] [--height n] [--keys k,k,…] [--wait ms] [--env K=V]…'); process.exit(2); }

const S = `cap-${name}`;
const tmux = (a: string): string => execSync(`tmux ${a}`, { encoding: 'utf8' });
const sleep = (ms: number): void => { execSync(`sleep ${ms / 1000}`); };
try { tmux(`kill-session -t ${S}`); } catch { /* fresh */ }
// TIMMY_SHELL=v2 keeps the legacy nine-view shell (TIMMY_SHELL=v1) out of the
// capture even when the tmux server inherited it; --env overrides win
const envStr = ['TIMMY_TELEMETRY_URL=off', 'TIMMY_SHELL=v2', ...env].map(e => `${e.split('=')[0]}=${JSON.stringify(e.slice(e.indexOf('=') + 1))}`).join(' ');
tmux(`new-session -d -s ${S} -x ${width} -y ${height} ${JSON.stringify(`cd ${process.cwd()} && env ${envStr} npx tsx timmy.ts; sleep 30`)}`);
// boot is a cold tsx start plus lane probes: poll for the assembled header
// (tab digits, no "assembling") instead of trusting a fixed delay
const t0 = Date.now();
for (;;) {
  sleep(500);
  const f = tmux(`capture-pane -p -t ${S}`);
  if (/TIMMY\s+1 /.test(f) && !/assembling/.test(f)) break;
  if (Date.now() - t0 > wait) { console.error(`capture-frames: shell did not assemble within ${wait} ms`); break; }
}
sleep(1200);
for (const k of keys) {
  if (k.startsWith('text:')) tmux(`send-keys -t ${S} -l ${JSON.stringify(k.slice(5))}`);
  else tmux(`send-keys -t ${S} ${k}`);
  sleep(600);
}
sleep(800);
const frame = tmux(`capture-pane -p -t ${S}`);
try { tmux(`send-keys -t ${S} q`); sleep(500); tmux(`kill-session -t ${S}`); } catch { /* gone */ }
mkdirSync(out, { recursive: true });
const file = join(out, name);
writeFileSync(file, frame);
const sha = createHash('sha256').update(frame).digest('hex');
const lines = frame.split('\n');
const widest = Math.max(...lines.map(l => [...l].length));
console.log(JSON.stringify({ file, width, height, keys, lines: lines.length, widest, sha256: sha }));
