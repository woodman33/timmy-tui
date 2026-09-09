#!/usr/bin/env node
// OpenHands SDK sandbox lane (shelf-w6d3 step 1): repo + task → container → sandbox.run receipt.
//
//   timmy sandbox run --repo <dir|git url> --task "<text>" [--image ghcr.io/openhands/agent-server:latest-python]
//                     [--base-image nikolaik/python-nodejs:python3.12-nodejs22] [--model openrouter/google/gemini-3.7-flash]
//                     [--platform linux/arm64] [--wall 900] [--label name] [--collect out/** ] [--no-seal]
//   timmy sandbox seed timmy-suite | sun-10k | cards-200 | sim        the four seeds the order names
//   timmy sandbox doctor                                              docker + image + sdk preflight, no run
//
// Real sandbox or nothing: the lane refuses (exit 3, sandbox.refuse receipt) when
// Docker is down or the image cannot be pulled. The repo is SNAPSHOTTED into a
// scratch workspace (tar, sha256) and mounted at /workspace; the agent never
// touches the live checkout. Every run writes events.jsonl + result.json beside
// the workspace and seals ONE sandbox.run with the snapshot sha, the task sha,
// the image, the model, event and tool-call counts, files changed, cost.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = join(ROOT, 'lanes', 'sandbox');
const RUNS = join(HERE, 'runs');
const PY = process.env.OPENHANDS_PY ?? '/Users/williammeldman/.local/share/uv/tools/openhands/bin/python';
const SCRATCH = process.env.SANDBOX_SCRATCH ?? join(process.env.HOME ?? '/tmp', '.timmy-sandbox');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-seal', '--keep'].includes(args[i - 1])));
const cmd = positional[0] ?? 'doctor';
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Docker on this Mac is OrbStack. The user's ~/.docker/config.json names the
// Docker Desktop credential helper, which is not installed, so any pull fails
// with "docker-credential-desktop not found". The lane therefore talks to the
// OrbStack socket directly with a scratch, helper-free Docker config; nothing
// under ~/.docker is touched.
function dockerEnv() {
  const env = { ...process.env };
  if (!env.DOCKER_CONFIG) {
    const cfg = join(SCRATCH, 'docker-config');
    mkdirSync(cfg, { recursive: true });
    if (!existsSync(join(cfg, 'config.json'))) writeFileSync(join(cfg, 'config.json'), '{}\n');
    env.DOCKER_CONFIG = cfg;
  }
  if (env.DOCKER_HOST) return env;
  // Docker Desktop and OrbStack each leave a socket behind; only the running one answers.
  const home = process.env.HOME ?? '';
  const candidates = [process.env.SANDBOX_DOCKER_HOST, `unix://${join(home, '.docker', 'run', 'docker.sock')}`, `unix://${join(home, '.orbstack', 'run', 'docker.sock')}`, 'unix:///var/run/docker.sock'].filter(Boolean);
  for (const sock of candidates) {
    const path = sock.replace(/^unix:\/\//, '');
    if (!existsSync(path)) continue;
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 8000, env: { ...env, DOCKER_HOST: sock } });
    if (r.status === 0 && r.stdout.trim()) { env.DOCKER_HOST = sock; break; }
  }
  return env;
}
const DOCKER_ENV = dockerEnv();

function readEnvKey(name) {
  if (process.env[name]) return process.env[name];
  const p = join(ROOT, '.env');
  if (existsSync(p)) for (const l of readFileSync(p, 'utf8').split('\n')) if (l.startsWith(`${name}=`)) return l.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  return '';
}

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  const lines = readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).hash;
}

// ------------------------------------------------------------------ preflight

export function doctor(image) {
  const d = spawnSync('docker', ['info', '--format', '{{.ServerVersion}} {{.Architecture}}'], { encoding: 'utf8', timeout: 20000, env: DOCKER_ENV });
  const docker = d.status === 0 ? d.stdout.trim() : null;
  const img = image ? spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Architecture}} {{.Size}}'], { encoding: 'utf8', timeout: 20000, env: DOCKER_ENV }) : null;
  const py = spawnSync(PY, ['-c', 'import openhands.sdk, openhands.workspace, importlib.metadata as m; print(m.version("openhands-sdk"), m.version("openhands-workspace"))'], { encoding: 'utf8', timeout: 60000 });
  return {
    docker: docker ? { ok: true, version: docker.split(' ')[0], arch: docker.split(' ')[1] } : { ok: false, error: (d.stderr ?? d.error?.message ?? 'docker not reachable').split('\n')[0] },
    image: image ? (img.status === 0 ? { ok: true, name: image, arch: img.stdout.trim().split(' ')[0], bytes: Number(img.stdout.trim().split(' ')[1]) } : { ok: false, name: image, error: 'not pulled' }) : null,
    sdk: py.status === 0 ? { ok: true, python: PY, versions: py.stdout.trim() } : { ok: false, python: PY, error: (py.stderr ?? '').split('\n').slice(-1)[0] },
    key: !!readEnvKey('OPENROUTER_API_KEY')
  };
}

// ------------------------------------------------------------------ snapshot

const SKIP = new Set(['node_modules', '.git', '.claude', 'dist', 'renders', '.timmy-sandbox']);

function snapshot(repo, label) {
  const src = resolve(repo);
  if (!existsSync(src)) throw new Error(`no repo at ${src}`);
  const id = `sb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(SCRATCH, id);
  const ws = join(dir, 'workspace');
  mkdirSync(ws, { recursive: true });
  cpSync(src, ws, { recursive: true, filter: (p) => !SKIP.has(basename(p)) && !p.includes('/node_modules/') });
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  walk(ws);
  const manifest = files.sort().map((p) => `${sha(readFileSync(p))} ${relative(ws, p)}`).join('\n');
  writeFileSync(join(dir, 'snapshot.manifest'), manifest);
  return { id, dir, ws, files: files.length, snapshot_sha256: sha(manifest), source: src, label };
}

function diffSnapshot(ws, manifestPath) {
  const before = new Map(readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map((l) => { const i = l.indexOf(' '); return [l.slice(i + 1), l.slice(0, i)]; }));
  const after = new Map();
  // the agent server keeps its own bookkeeping in the workspace (.git it inits, conversations/); that is not the agent's work
  const own = (rel) => rel.startsWith('.git/') || rel.startsWith('conversations/') || rel === '.git';
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); const rel = relative(ws, p); if (own(rel)) continue; if (e.isDirectory()) walk(p); else if (e.isFile()) after.set(rel, sha(readFileSync(p))); } };
  walk(ws);
  const changed = [], added = [], removed = [];
  for (const [f, h] of after) { if (!before.has(f)) added.push(f); else if (before.get(f) !== h) changed.push(f); }
  for (const f of before.keys()) if (!after.has(f)) removed.push(f);
  return { changed, added, removed };
}

// ------------------------------------------------------------------ run

// The agent-server image must match the client SDK's version: a newer server
// emits event fields (parent_id, …) that an older SDK rejects with a pydantic
// extra_forbidden error. So the default image tag IS the installed SDK version.
export function sdkVersion() {
  const r = spawnSync(PY, ['-c', 'import importlib.metadata as m; print(m.version("openhands-sdk"))'], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
export const SDK_VERSION = sdkVersion() ?? 'latest';
export const DEFAULT_IMAGE = process.env.SANDBOX_IMAGE ?? `ghcr.io/openhands/agent-server:${SDK_VERSION}-python`;
// The python agent-server image already ships node + npm at /usr/local/bin
// (measured: Debian 13, node, npm, uv, python3), so the Node seeds run on the
// same image. DockerDevWorkspace (build from a base image) cannot be used
// here: its builder needs the OpenHands source checkout, not the pip SDK.
export const NODE_IMAGE = process.env.SANDBOX_NODE_IMAGE ?? DEFAULT_IMAGE;

export async function run({ repo, task, image, baseImage, model, platform, wall, label, collect, noSeal = false, keep = false, seedMeta = {} }) {
  const chosenImage = baseImage || image || DEFAULT_IMAGE;
  const pre = doctor(baseImage ? null : chosenImage);
  const reason = !pre.docker.ok ? `docker down: ${pre.docker.error}` : !pre.sdk.ok ? `openhands sdk unusable: ${pre.sdk.error}` : !pre.key ? 'no OPENROUTER_API_KEY' : (pre.image && !pre.image.ok) ? `image not pulled: ${chosenImage}` : null;
  if (reason) {
    const receipt = noSeal ? null : seal('sandbox.refuse', { reason, repo: String(repo), task_sha256: sha(String(task)), image: chosenImage, order: 'shelf-w6d3' });
    return { ok: false, refused: true, reason, receipt };
  }
  const snap = snapshot(repo, label);
  const out = join(snap.dir, 'out');
  mkdirSync(out, { recursive: true });
  const started = Date.now();
  const argv = [join(HERE, 'driver.py'), '--workspace', snap.ws, '--task', task, '--out', out, '--model', model, '--wall', String(wall), '--platform', platform];
  if (baseImage) argv.push('--base-image', baseImage); else argv.push('--image', chosenImage);
  const r = spawnSync(PY, argv, { encoding: 'utf8', timeout: (wall + 600) * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...DOCKER_ENV, OPENROUTER_API_KEY: readEnvKey('OPENROUTER_API_KEY'), PYTHONUNBUFFERED: '1' } });
  writeFileSync(join(out, 'driver.log'), `$ ${PY} ${argv.map((a) => (a === task ? '<task>' : a)).join(' ')}\n--- stdout\n${r.stdout ?? ''}\n--- stderr\n${r.stderr ?? ''}\n--- exit ${r.status}\n`);
  let result = {};
  try { result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')); } catch { result = { ok: false, error: `driver produced no result.json (exit ${r.status}); see driver.log` }; }
  const diff = diffSnapshot(snap.ws, join(snap.dir, 'snapshot.manifest'));
  // collect: copy requested outputs from the workspace next to the run record
  const collected = [];
  if (collect) {
    for (const rel of collect.split(',').map((s) => s.trim()).filter(Boolean)) {
      const p = join(snap.ws, rel);
      if (existsSync(p)) { const dst = join(out, 'collected', rel); mkdirSync(join(dst, '..'), { recursive: true }); cpSync(p, dst, { recursive: true }); collected.push({ path: rel, sha256: statSync(p).isFile() ? sha(readFileSync(p)) : null }); }
    }
  }
  mkdirSync(RUNS, { recursive: true });
  const record = { v: 1, id: snap.id, label, repo: snap.source, snapshot_sha256: snap.snapshot_sha256, files: snap.files, task, task_sha256: sha(task), image: chosenImage, dev_image: !!baseImage, model, platform, driver_exit: r.status, result, diff: { changed: diff.changed.length, added: diff.added.length, removed: diff.removed.length, sample: [...diff.changed, ...diff.added].slice(0, 40) }, collected, ms: Date.now() - started, ts: new Date().toISOString(), dir: snap.dir, ...seedMeta };
  const ok = !!result.ok;
  let receipt = null;
  if (!noSeal) {
    receipt = seal('sandbox.run', {
      id: snap.id, label: label ?? 'adhoc', ok: ok ? 'true' : 'false', repo: snap.source.replace(process.env.HOME ?? '', '~'), snapshot_sha256: snap.snapshot_sha256, snapshot_files: snap.files,
      task_sha256: sha(task), task_preview: task.slice(0, 160), image: chosenImage, dev_image: baseImage ? 'true' : 'false', platform, model, container: result.container ?? 'n/a',
      events: result.events ?? 0, tool_calls: result.tool_calls ?? 0, status: result.status ?? 'n/a', final_sha256: result.final ? sha(String(result.final)) : 'none', final_preview: String(result.final ?? '').slice(0, 200),
      files_changed: diff.changed.length, files_added: diff.added.length, files_removed: diff.removed.length, changed_sample: [...diff.changed, ...diff.added].slice(0, 12).join(','),
      collected: collected.map((c) => `${c.path}:${(c.sha256 ?? 'dir').slice(0, 12)}`).join(','), cost_usd: result.cost_usd ?? 'unreported', error: result.error ?? null, ms: record.ms,
      ...Object.fromEntries(Object.entries(seedMeta).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v])), order: 'shelf-w6d3'
    });
    record.receipt = receipt;
  }
  writeFileSync(join(RUNS, `${snap.id}.json`), JSON.stringify(record, null, 1));
  if (!keep && ok) { try { rmSync(snap.ws, { recursive: true, force: true }); } catch { /* leave it */ } }
  return { ok, receipt, record };
}

// ------------------------------------------------------------------ seeds

const SEEDS = {
  'timmy-suite': {
    note: 'the timmy-tui test suite in isolation: the snapshot of this checkout, npm ci, vitest run',
    repo: ROOT,
    image: NODE_IMAGE,
    task: 'You are in /workspace, a snapshot of the timmy-tui repository with no node_modules. Run `npm ci --no-audit --no-fund` (ignore warnings), then run `npx vitest run --reporter=json --outputFile=/workspace/out/vitest.json` (create /workspace/out first). Do not modify any source file. When finished, reply with exactly one line: SUITE <passed>/<total> tests, <failed files> failed files, taken from the JSON report.',
    collect: 'out/vitest.json',
    wall: 1500
  },
  'sun-10k': {
    note: '10k synthetic SUN taps through the edge verifier → a sealed confusion matrix',
    repo: ROOT,
    image: NODE_IMAGE,
    task: 'You are in /workspace, a snapshot of the timmy-tui repository with no node_modules. Run `npm ci --no-audit --no-fund` in /workspace/vault-custody (ignore warnings), then run `cd /workspace && node --import /workspace/vault-custody/node_modules/tsx/dist/loader.mjs lanes/sandbox/seeds/sun-10k.mjs --n 10000 --out /workspace/out/sun-10k.json` (if that loader path is wrong, use `npx --prefix vault-custody tsx lanes/sandbox/seeds/sun-10k.mjs --n 10000 --out /workspace/out/sun-10k.json`). Do not modify any source file. Reply with exactly one line: SUN <accuracy> accuracy over <n> taps, matrix at out/sun-10k.json.',
    collect: 'out/sun-10k.json',
    wall: 1500
  },
  'cards-200': {
    note: '200 generated card images with per-row provenance → dataset.synthetic-v0 (auto-labelled by the local observer afterwards)',
    repo: ROOT,
    image: NODE_IMAGE,
    task: 'You are in /workspace, a snapshot of the timmy-tui repository with no node_modules. Run `cd /workspace/vault-custody && npm ci --no-audit --no-fund` (ignore warnings; the sharp package must install for linux), then run `cd /workspace && node lanes/sandbox/seeds/cards-200.mjs --n 200 --out /workspace/out/cards` which renders 200 synthetic trading-card PNGs with a provenance JSONL. Do not modify any source file. Reply with exactly one line: CARDS <count> images, provenance at out/cards/provenance.jsonl.',
    collect: 'out/cards',
    wall: 1500
  },
  sim: {
    note: 'timmy sim runs Timmy itself inside the sandbox with a synthetic receipt store and bus',
    repo: ROOT,
    image: NODE_IMAGE,
    task: 'You are in /workspace, a snapshot of the timmy-tui repository with no node_modules. Run `npm ci --no-audit --no-fund` (ignore warnings). Then make the receipt store synthetic and local: `mkdir -p /workspace/.timmy/receipts && printf /workspace/.timmy/receipts > /workspace/.timmy/store-pin`. Then run `npx tsx src/cli.ts seal sandbox.bus.synthetic --meta inside=container` and `npx tsx lanes/sim/sim.mjs run --dry --board companion/boards/ship.story.json` (dry: no network) and then `npx tsx src/cli.ts verify`. Copy the receipt store to /workspace/out/synthetic-receipts.jsonl with `mkdir -p /workspace/out && cp /workspace/.timmy/receipts/runs.jsonl /workspace/out/synthetic-receipts.jsonl`. Reply with exactly one line: SIM <turns> turns sealed, verify <ok:true|false> <receipts> receipts, store at out/synthetic-receipts.jsonl.',
    collect: 'out/synthetic-receipts.jsonl,lanes/sim/runs',
    wall: 1500
  }
};

const out = (o) => console.log(JSON.stringify(o, null, 1));

/** What each seed seals AFTER the container run, from what it collected. */
function postSeed(name, r) {
  if (!r.ok || !r.record) return null;
  const dir = join(r.record.dir, 'out', 'collected');
  if (name === 'sun-10k') {
    const p = join(dir, 'out', 'sun-10k.json');
    if (!existsSync(p)) return { note: 'sun-10k.json not collected' };
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const receipt = seal('sun.confusion', { n: j.n, seed: j.seed, accuracy: j.accuracy, per_class: Object.entries(j.per_class).map(([k, v]) => `${k}:${(v.accuracy ?? 0).toFixed(4)}`).join(','), matrix: JSON.stringify(j.matrix).slice(0, 900), expected: JSON.stringify(j.expected), tag: j.tag, matrix_sha256: sha(readFileSync(p)), sandbox_run: r.receipt, ran_in: 'openhands sandbox container', ms: j.ms, order: 'shelf-w6d3' });
    return { receipt, accuracy: j.accuracy, n: j.n };
  }
  if (name === 'cards-200') {
    const cards = join(dir, 'out', 'cards');
    if (!existsSync(join(cards, 'provenance.jsonl'))) return { note: 'cards not collected' };
    const l = spawnSync('node', [join(HERE, 'seeds', 'label-cards.mjs'), '--cards', cards], { cwd: ROOT, encoding: 'utf8', env: DOCKER_ENV, stdio: ['ignore', 'pipe', 'inherit'] });
    return { label_exit: l.status, summary: (l.stdout ?? '').trim().split('\n').slice(-12).join('\n') };
  }
  if (name === 'sim') {
    const p = join(dir, 'out', 'synthetic-receipts.jsonl');
    if (!existsSync(p)) return { note: 'synthetic store not collected' };
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    let head = null; let turns = 0; let subjects = new Set();
    for (const l of lines) { try { const j = JSON.parse(l); if (j.hash) head = j.hash; if (j.subject) subjects.add(j.subject); if (j.subject === 'sim.turn') turns++; } catch { /* envelope */ } }
    const receipt = seal('sandbox.sim', { synthetic_store: 'out/synthetic-receipts.jsonl', store_sha256: sha(readFileSync(p)), records: lines.length, sim_turns: turns, subjects: [...subjects].join(','), synthetic_head: head ?? 'none', sandbox_run: r.receipt, note: 'timmy sim ran inside the OpenHands container against a container-local store-pin; the synthetic chain never touched the root store', order: 'shelf-w6d3' });
    return { receipt, records: lines.length, turns, head };
  }
  if (name === 'timmy-suite') {
    const p = join(dir, 'out', 'vitest.json');
    if (!existsSync(p)) return { note: 'vitest.json not collected' };
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { tests: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, files_failed: j.numFailedTestSuites, report_sha256: sha(readFileSync(p)) };
  }
  return null;
}

switch (cmd) {
  case 'doctor': out({ default_image: DEFAULT_IMAGE, node_image: NODE_IMAGE, ...doctor(flag('--image', DEFAULT_IMAGE)), node_image_present: doctor(NODE_IMAGE).image }); break;
  case 'image': {
    // what the sandbox image carries: measured by running it, not assumed
    const r = spawnSync('docker', ['run', '--rm', '--entrypoint', '/bin/bash', DEFAULT_IMAGE, '-lc', 'id -un; head -1 /etc/os-release; node --version; npm --version; python3 --version; uv --version'], { encoding: 'utf8', env: DOCKER_ENV, timeout: 120000 });
    out({ image: DEFAULT_IMAGE, node_image: NODE_IMAGE, probe: (r.stdout ?? '').trim().split('\n'), error: r.status === 0 ? null : (r.stderr ?? '').trim().split('\n').slice(-3).join(' ') });
    break;
  }
  case 'run': {
    const repo = flag('--repo'); const task = flag('--task');
    if (!repo || !task) { console.error('usage: timmy sandbox run --repo <dir> --task "<text>" [--image i | --base-image b] [--model m] [--wall s] [--collect a,b] [--no-seal]'); process.exit(2); }
    const r = await run({ repo, task, image: flag('--image'), baseImage: flag('--base-image'), model: flag('--model', process.env.SANDBOX_MODEL ?? 'openrouter/google/gemini-3.7-flash'), platform: flag('--platform', process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'), wall: Number(flag('--wall', 900)), label: flag('--label', 'adhoc'), collect: flag('--collect'), noSeal: has('--no-seal'), keep: has('--keep') });
    out({ ok: r.ok, refused: r.refused ?? false, reason: r.reason ?? null, receipt: r.receipt, id: r.record?.id, result: r.record?.result, diff: r.record?.diff, collected: r.record?.collected, ms: r.record?.ms });
    process.exit(r.ok ? 0 : r.refused ? 3 : 1);
  }
  case 'seed': {
    const name = positional[1];
    const s = SEEDS[name];
    if (!s) { console.error(`seed? one of ${Object.keys(SEEDS).join(', ')}`); process.exit(2); }
    const r = await run({ repo: s.repo, task: s.task, baseImage: flag('--base-image'), image: flag('--image', s.image), model: flag('--model', process.env.SANDBOX_MODEL ?? 'openrouter/google/gemini-3.7-flash'), platform: flag('--platform', process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'), wall: Number(flag('--wall', s.wall)), label: `seed:${name}`, collect: s.collect, noSeal: has('--no-seal'), keep: has('--keep'), seedMeta: { seed: name, seed_note: s.note } });
    const post = has('--no-seal') ? null : postSeed(name, r);
    out({ ok: r.ok, refused: r.refused ?? false, reason: r.reason ?? null, receipt: r.receipt, id: r.record?.id, result: r.record?.result, diff: r.record?.diff, collected: r.record?.collected, dir: r.record?.dir, ms: r.record?.ms, post });
    process.exit(r.ok ? 0 : r.refused ? 3 : 1);
  }
  case 'list': out((existsSync(RUNS) ? readdirSync(RUNS) : []).filter((f) => f.endsWith('.json')).map((f) => { const j = JSON.parse(readFileSync(join(RUNS, f), 'utf8')); return { id: j.id, label: j.label, ok: j.result?.ok, events: j.result?.events, receipt: j.receipt, ts: j.ts }; })); break;
  case 'reseal': {
    // Seal a run that was made with --no-seal, from its saved record (so seeds can run while another lane holds the chain).
    const id = positional[1];
    const p = join(RUNS, `${id}.json`);
    if (!existsSync(p)) { console.error(`no run record ${p}`); process.exit(2); }
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    if (rec.receipt) { out({ ok: true, already: rec.receipt }); break; }
    const result = rec.result ?? {}; const diff = rec.diff ?? {};
    const receipt = seal('sandbox.run', {
      id: rec.id, label: rec.label ?? 'adhoc', ok: result.ok ? 'true' : 'false', repo: String(rec.repo).replace(process.env.HOME ?? '', '~'), snapshot_sha256: rec.snapshot_sha256, snapshot_files: rec.files,
      task_sha256: rec.task_sha256, task_preview: String(rec.task).slice(0, 160), image: rec.image, dev_image: rec.dev_image ? 'true' : 'false', platform: rec.platform, model: rec.model, container: result.container ?? 'n/a',
      events: result.events ?? 0, tool_calls: result.tool_calls ?? 0, status: result.status ?? 'n/a', final_sha256: result.final ? sha(String(result.final)) : 'none', final_preview: String(result.final ?? '').slice(0, 200),
      files_changed: diff.changed ?? 0, files_added: diff.added ?? 0, files_removed: diff.removed ?? 0, changed_sample: (diff.sample ?? []).slice(0, 12).join(','),
      collected: (rec.collected ?? []).map((c) => `${c.path}:${(c.sha256 ?? 'dir').slice(0, 12)}`).join(','), cost_usd: result.cost_usd ?? 'unreported', error: result.error ?? null, ms: rec.ms, resealed_from_record: 'true',
      ...(rec.seed ? { seed: rec.seed, seed_note: rec.seed_note } : {}), order: 'shelf-w6d3'
    });
    rec.receipt = receipt;
    writeFileSync(p, JSON.stringify(rec, null, 1));
    const post = rec.seed && !has('--no-post') ? postSeed(rec.seed, { ok: !!result.ok, receipt, record: rec }) : null;
    out({ ok: !!result.ok, receipt, post });
    break;
  }
  default: console.error('usage: timmy sandbox doctor | run … | seed <timmy-suite|sun-10k|cards-200|sim> | list'); process.exit(2);
}
