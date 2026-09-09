// timmy demo (chain-views-e6p2) — a scripted, replayable war-room session on
// PLACEHOLDER data only (privacy-d5n9): fixture receipt chain in a mkdtemp
// store, frozen clock, fixed key script. Same input → same frames → same
// cast sha. Outputs: demo.cast (asciinema v2) + demo.gif (agg) + demo.mp4
// (ffmpeg), then seals demo.cast into the active store.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// frozen clock: every ago()/stamp()/new Date() in the TUI and the receipt
// chain reads the wall clock — pinning the constructor AND now() makes the
// render (and therefore the cast) byte-deterministic.
const NOW = 1767225600000; // 2026-01-01T00:00:00.000Z
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [number]));
  }
  static now(): number { return NOW; }
}
(globalThis as unknown as { Date: typeof Date }).Date = FrozenDate as unknown as typeof Date;

const WIDTH = 120;
const HEIGHT = 32;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : join(process.cwd(), '.timmy', 'demo');
  mkdirSync(outDir, { recursive: true });

  // 1. fixture store: a valid hash chain of placeholder receipts.
  //    Determinism: frozen clock (above), seeded PRNG for receipt ids, a
  //    fixed zero-seed ed25519 identity pre-placed at the store's key path,
  //    and a fixed env_lock on every seeded receipt.
  const store = mkdtempSync(join(tmpdir(), 'timmy-demo-'));
  process.env.TIMMY_STORE = join(store, 'receipts');
  process.env.TIMMY_DEMO = '1';
  let prngState = 0x2f6e2b1 >>> 0;
  (Math as unknown as { random: () => number }).random = () => {
    prngState = (prngState + 0x6d2b79f5) >>> 0;
    let t = prngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const DEMO_LOCK = { os: { platform: 'demo', build: '0', version: '0' }, arch: 'demo', tools: {} };
  const { appendReceipt } = await import('../utils/receipts.js');
  const seed = (subject: string, sources: Record<string, unknown>, status = 'ok') =>
    appendReceipt('runs', { kind: 'seal', subject, policy: 'auto', status, env_lock: DEMO_LOCK, sources: [sources] } as never);
  // the war-room readers (presets/runs/nodes/sbx/abilities/projects) must see
  // PLACEHOLDER artifacts, not the operator's live lanes: seed a fixture tree
  // under the store and point TIMMY_REPO_ROOT at it (deterministic + private)
  const w = (rel: string, body: string) => {
    const p = join(store, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  };
  w('lanes/swarm/presets/closed-3.cue', `package swarm\n\nswarm: {\n\tid: "closed-3"\n\tpreset: "closed-3"\n\ttopology: "closed"\n\tmembers: [\n\t\t{id: "slot-1", kind: "model", model: "placeholder/qwen", provider: "ollama", node: "mac", sandbox: "closed"},\n\t\t{id: "slot-2", kind: "model", model: "placeholder/qwen", provider: "ollama", node: "mac", sandbox: "closed"},\n\t\t{id: "slot-3", kind: "harness", harness: "harn-a", node: "mac", sandbox: "closed"},\n\t]\n\tsize: 3\n\tbudget: {usd: 0.05, max_calls: 9}\n\tjudge: {tier: "local", model: "placeholder/qwen"}\n\tnetwork: {policy: "closed"}\n}\n`);
  w('lanes/swarm/runs/swarm_demo0001_aaaa.json', JSON.stringify({ where: 'local', room: 'war-room', spec: { v: 1, id: 'closed-3', preset: 'closed-3', topology: 'closed', size: 3, members: [{ id: 'slot-1', kind: 'model', sandbox: 'closed' }, { id: 'slot-2', kind: 'model', sandbox: 'closed' }, { id: 'slot-3', kind: 'harness', harness: 'harn-a', sandbox: 'closed' }], budget: { usd: 0.05, max_calls: 9 }, judge: { tier: 'local', model: 'placeholder/qwen' }, network: { policy: 'closed' } }, task: 'placeholder task', result: { ok: true, run_id: 'swarm_demo0001_aaaa', usd: 0.0312, ms: 4200, calls: [{ member: 'slot-1', tokens_reasoning: 214 }, { member: 'slot-2', tokens_reasoning: 198 }] }, receipt: 'demo' }));
  w('lanes/sandbox/runs/sb_demo0001_aaaa.json', JSON.stringify({ id: 'sb_demo0001_aaaa', label: 'seed:demo', image: 'placeholder/img:1', model: 'placeholder/one', platform: 'linux/arm64', files: 2, driver_exit: 0, result: { ok: true } }));
  w('lanes/abilities/results/harn-a.json', JSON.stringify({ harness: 'harn-a', abilities: { one_shot: { value: true }, mcp: { value: true } }, isolation: 'private home', mcp_setup_files: [{ path: '/placeholder/mcp.json' }] }));
  w('projects/proj-a/profile.cue', `package profile\n\nprofile: {\n\tname: "proj-a"\n\towner: "placeholder"\n\tbudget: max_spend_usd: 2\n\tharnesses: allowed: ["harn-a"]\n}\n`);
  w('projects/proj-a/drop/input.txt', 'placeholder input');
  w('projects/proj-a/plans/plan-a.md', '# placeholder plan');
  w('fleet/nodes.json', JSON.stringify({ v: 1, note: 'demo fixture', nodes: [{ id: 'node-a', tailnet_name: 'node-a', tailnet_ip: '0.0.0.0', kind: 'fixture', ssh: 'ssh node-a', status: 'joined', role: ['ollama'] }] }));
  process.env.TIMMY_REPO_ROOT = store;
  process.env.TIMMY_PROJECTS_ROOT = join(store, 'projects');
  seed('doctor.cli · demo fixture', { checks: '4/4' });
  seed('lane.start · demo-lane', { lane: 'demo-lane' });
  seed('swarm.run', { run_id: 'swarm_demo0001_aaaa', swarm_id: 'closed-3', preset: 'closed-3', topology: 'closed', size: '3', where: 'local', room: 'war-room', ok: 'true', usd: '0.0312', ms: '4200', judge_tier: 'local', policy: 'closed', task_sha256: sha('placeholder task') });
  seed('swarm.member', { run_id: 'swarm_demo0001_aaaa', swarm_id: 'closed-3', member: 'slot-1', kind: 'model', phase: 'work', model: 'placeholder/qwen', node: 'mac', provider: 'ollama', usd: '0.0', ms: '1200', ok: 'true' });
  seed('swarm.member', { run_id: 'swarm_demo0001_aaaa', swarm_id: 'closed-3', member: 'slot-2', kind: 'harness', phase: 'work', harness: 'harn-a', node: 'mac', usd: '0.0', ms: '1400', ok: 'true' });
  seed('swarm.airgap', { run_id: 'swarm_demo0001_aaaa', swarm_id: 'closed-3', swarm_run: `sha256_${sha('demo-run').slice(0, 56)}`, policy: '{"policy":"closed","egress_allow":[]}', policy_sha256: `sha256_${sha('demo-policy').slice(0, 56)}`, egress: '0', egress_tools: '', hands: 'sbx-lockdown', wire_tool_calls: '0' });
  seed('chat.turn · commander', { text: 'placeholder ping', model: 'placeholder/auto' });

  // 2. scripted session
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  const { ShellV2 } = await import('../tui/components/ShellV2.js');
  const view = render(React.createElement(ShellV2, { width: WIDTH }));
  const frames: { t: number; text: string }[] = [];
  let t = 0;
  const grab = (hold: number) => { frames.push({ t, text: view.lastFrame() ?? '' }); t += hold; };
  const press = async (key: string, ms = 140) => { view.stdin.write(key); await sleep(ms); };
  const settle = async (pred: (f: string) => boolean, ms = 6000) => {
    // performance.now is NOT the frozen Date.now — timeouts stay real
    const t0 = performance.now();
    for (;;) {
      if (pred(view.lastFrame() ?? '') || performance.now() - t0 > ms) return;
      await sleep(60);
    }
  };
  await settle(f => f.includes('YOUR JOURNEY'));
  grab(1.0);                                   // boot → HOME settled
  await press('2'); await settle(f => f.includes('RUNS')); grab(1.0);   // RUN
  await press('6'); await settle(f => f.includes('COMMANDER'));
  await press('w'); await settle(f => f.includes('SWARM')); grab(1.2);   // SWARM view (closed-3 preset first)
  await press('l'); await sleep(200); grab(1.0);                        // launch beat (demo-guarded)
  await press('3'); await settle(f => f.includes('RECEIPTS'));
  await press('/'); await press('swarm.airgap', 160); await press('\x1b'); await settle(f => f.includes('swarm.airgap'));
  grab(1.2);                               // CHAIN → airgap receipt + typed view
  await press('o'); await sleep(200); grab(1.4);                        // [o] cross-link the run
  view.unmount();

  // 3. asciinema v2 cast (deterministic timestamps + frozen content)
  const castPath = join(outDir, 'demo.cast');
  const lines: string[] = [JSON.stringify({ version: 2, width: WIDTH, height: HEIGHT, timestamp: Math.floor(NOW / 1000), env: { SHELL: '/bin/bash', TERM: 'xterm-256color' } })];
  for (const f of frames) lines.push(JSON.stringify([Number(f.t.toFixed(3)), 'o', `\x1b[2J\x1b[H${f.text}`]));
  writeFileSync(castPath, lines.join('\n') + '\n');

  // 4. gif + mp4 through the operator's toolchain (agg, ffmpeg)
  const gifPath = join(outDir, 'demo.gif');
  const mp4Path = join(outDir, 'demo.mp4');
  const agg = spawnSync('agg', [castPath, gifPath], { encoding: 'utf8', timeout: 120000 });
  let mp4: { ok: boolean; note?: string } = { ok: false, note: 'agg missing' };
  if (agg.status === 0 && existsSync(gifPath)) {
    const ff = spawnSync('ffmpeg', ['-y', '-i', gifPath, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', 'faststart', '-pix_fmt', 'yuv420p', mp4Path], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
    mp4 = ff.status === 0 && existsSync(mp4Path) ? { ok: true } : { ok: false, note: (ff.stderr ?? '').slice(-200) };
  }

  // 5. seal the cast (real store of the invoking session)
  const castBuf = readFileSync(castPath);
  if (args.includes('--no-seal')) {
    console.log(JSON.stringify({ ok: true, cast: castPath, gif: existsSync(gifPath) ? gifPath : null, mp4: mp4.ok ? mp4Path : null, mp4_note: mp4.note ?? null, frames: frames.length, cast_sha256: sha(castBuf).slice(0, 16), sealed: null }, null, 1));
    return;
  }
  delete process.env.TIMMY_STORE;
  const rec = appendReceipt('runs', {
    kind: 'seal', subject: 'demo.cast', policy: 'human-gated', status: 'ok',
    sources: [{ frames: frames.length, width: WIDTH, height: HEIGHT, cast_sha256: sha(castBuf), mp4: mp4.ok ? sha(readFileSync(mp4Path)) : 'none', deterministic: 'frozen-clock + fixture-store + placeholder-data' }],
  } as never);
  console.log(JSON.stringify({ ok: true, cast: castPath, gif: existsSync(gifPath) ? gifPath : null, mp4: mp4.ok ? mp4Path : null, mp4_note: mp4.note ?? null, frames: frames.length, cast_sha256: sha(castBuf).slice(0, 16), sealed: String(rec.hash).slice(0, 16) }, null, 1));
}

main().catch(e => { console.error(`demo failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
