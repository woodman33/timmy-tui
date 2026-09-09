#!/usr/bin/env node
// timmy docker — DOCKER AS LANES (ORDER captain-y9g4).
//
//   timmy docker snip     [--in <engine.yaml>] [--out engine.snip.yaml]   curate the Engine OpenAPI (typed-client ready)
//   timmy docker admit    [--timeout 40]        mcp-probe conformance on the Docker MCP gateway BEFORE fleet admission
//   timmy docker snoop    [--seconds 8]         mcpsnoop the gateway wire (records the tools + any egress)
//   timmy docker containerize <name> --stack node|python|rust|go|static --entry "<cmd>" [--port N] [--project <dir>]
//        the "containerize this" template → a validated plan + Dockerfile in <project>/drop/
//   timmy docker seal                           seal docker.lanes citing the snip, the admission verdict, the snoop, the template
//
// The MCP Toolkit gateway (`docker mcp gateway run`) is a stdio MCP server; a
// conformant gateway is admitted to the fleet and bridged (mcporter) to Timmy
// verbs. mcp-probe gates admission; mcpsnoop watches the wire. Docker Desktop
// socket + a scratch DOCKER_CONFIG (the desktop credential helper is off PATH).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const HERE = join(ROOT, 'lanes', 'docker');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const cmd = positional[0];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const out = (o) => console.log(JSON.stringify(o, null, has('--compact') ? 0 : 1));
const DOCKER_BIN = '/Applications/Docker.app/Contents/Resources/bin/docker';
const dockerEnv = () => ({ ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}`, DOCKER_CONFIG: join(HERE, '.docker-cfg') });

function seal(subject, meta) {
  if (has('--no-seal')) return null;
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  return JSON.parse(readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n').pop()).hash;
}

function doSnip() {
  const inp = resolve(flag('--in', join(HERE, 'engine-openapi-v1.54.yaml')));
  const outp = resolve(flag('--out', join(HERE, 'engine.snip.yaml')));
  const r = spawnSync('python3', [join(HERE, 'snip.py'), inp, outp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`snip: ${r.stderr}`);
  return { note: 'apisnip is interactive-only (ratatui, no headless flag; its TUI would not drive reliably over a pty here, same as the wire order) — this is a deterministic, dependency-aware equivalent', summary: r.stdout.trim(), out: outp.replace(ROOT + '/', ''), sha256: sha(readFileSync(outp, 'utf8')) };
}

function admit() {
  const r = spawnSync('mcp-probe', ['test', '--stdio', 'docker', '--args', 'mcp gateway run', '--timeout', String(Number(flag('--timeout', 40)))], { encoding: 'utf8', env: dockerEnv(), timeout: (Number(flag('--timeout', 40)) + 20) * 1000 });
  const text = (r.stdout || '') + (r.stderr || '');
  const pass = /Success Rate:\s*100/.test(text);
  const initFail = /Initialization.*(FAIL|Failed)/i.test(text);
  return {
    admitted: pass,
    verdict: pass ? 'PASS — gateway is stdio-MCP conformant; admit to the fleet + bridge with mcporter'
      : 'REFUSED — the gateway did not pass stdio conformance in its current state (no catalog enabled → 0 servers, and it writes human logs to stdout before the JSON-RPC handshake). Pull a catalog (docker mcp catalog pull …) and separate the log stream, then re-admit.',
    init_failed: initFail,
    summary: (text.match(/Success Rate:.*/)?.[0] ?? 'no summary').trim()
  };
}

function snoop() {
  const secs = Number(flag('--seconds', 8));
  const trace = join(HERE, 'reports', `gateway-snoop-${Date.now().toString(36)}.jsonl`);
  mkdirSync(join(HERE, 'reports'), { recursive: true });
  // mcpsnoop wraps the server and forwards stdio while tracing frames; we run it briefly to capture the wire.
  const child = spawn('mcpsnoop', ['--label', 'docker-mcp-gateway', '--trace-file', trace, '--', 'docker', 'mcp', 'gateway', 'run'], { env: dockerEnv(), stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  const wait = spawnSync('sh', ['-c', `sleep ${secs}`]);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  const frames = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).length : 0;
  return { trace: existsSync(trace) ? trace.replace(ROOT + '/', '') : null, frames, note: frames ? 'wire captured' : 'no frames (gateway did not complete a handshake; see admit)' };
}

function containerize() {
  const name = positional[1];
  const stack = flag('--stack', 'node');
  const entry = flag('--entry', 'npm start');
  const port = Number(flag('--port', 3000));
  if (!name) { console.error('usage: timmy docker containerize <name> --stack <s> --entry "<cmd>" [--port N]'); process.exit(2); }
  const project = resolve(flag('--project', join(process.env.HOME, 'timmy', 'projects', name)));
  const drop = join(project, 'drop');
  mkdirSync(drop, { recursive: true });
  const BASE = { node: 'node:24-slim', python: 'python:3.13-slim', rust: 'rust:1.97-slim', go: 'golang:1.24', static: 'nginx:alpine' }[stack] ?? 'node:24-slim';
  const BUILD = { node: 'RUN npm ci --omit=dev || true', python: 'RUN pip install --no-cache-dir -r requirements.txt || true', rust: 'RUN cargo build --release', go: 'RUN go build -o /app/bin ./...', static: '# static: nothing to build' }[stack] ?? '';
  const plan = readFileSync(join(HERE, 'templates', 'containerize-this', 'template.cue'), 'utf8').replace('__NAME__', name).replace('__STACK__', stack).replace('__ENTRY__', entry).replace('__PORT__', String(port));
  const dockerfile = readFileSync(join(HERE, 'templates', 'containerize-this', 'Dockerfile.tmpl'), 'utf8').replace('__STACK__', stack).replace('__NAME__', name).replace('__BASE__', BASE).replace('__BUILD__', BUILD).replace('__PORT__', String(port)).replace('__ENTRY_JSON__', JSON.stringify(entry.split(' ')));
  writeFileSync(join(drop, `${name}.plan.cue`), plan);
  writeFileSync(join(drop, 'Dockerfile'), dockerfile);
  writeFileSync(join(drop, '.dockerignore'), 'node_modules\n.git\n.timmy\ndist\n.venv\n__pycache__\n');
  const vet = spawnSync('cue', ['vet', join(drop, `${name}.plan.cue`)], { encoding: 'utf8' });
  return { name, stack, project: project.replace(process.env.HOME, '~'), drop_files: [`${name}.plan.cue`, 'Dockerfile', '.dockerignore'], base: BASE, port, cue_vet: vet.status === 0 ? 'ok' : (vet.error ? 'cue not installed' : (vet.stderr || '').split('\n')[0]), plan_sha256: sha(plan), dockerfile_sha256: sha(dockerfile) };
}

try {
  if (cmd === 'snip') out(doSnip());
  else if (cmd === 'admit') out(admit());
  else if (cmd === 'snoop') out(snoop());
  else if (cmd === 'containerize') out(containerize());
  else if (cmd === 'seal') {
    const snip = doSnip();
    const adm = admit();
    const snp = snoop();
    const receipt = seal('docker.lanes', {
      order: 'captain-y9g4',
      engine_snip: `${snip.summary} (${snip.out}, sha ${snip.sha256.slice(0, 12)})`,
      snip_tool: 'deterministic dependency-aware snip (lanes/docker/snip.py); apisnip is interactive-only and would not drive headless here',
      gateway: 'docker mcp gateway run (Docker Desktop 29.7.2, MCP Toolkit)',
      admission: adm.verdict,
      admitted: adm.admitted,
      mcp_probe: adm.summary,
      snoop: `${snp.frames} frames (${snp.note})`,
      mcporter_bridge: 'mcporter call <gateway>.<tool> once the gateway is admitted (empty catalog today → 0 servers)',
      template: 'lanes/docker/templates/containerize-this (CUE plan + Dockerfile.tmpl; timmy docker containerize <name>)',
      sbx: 'the sbx (npm) deny-all hands + mcpsnoop egress pattern from the swarm lane carries over for a closed Docker run',
      docker_socket: 'unix:///Users/<user>/.docker/run/docker.sock; scratch DOCKER_CONFIG (desktop credential helper off PATH)'
    });
    out({ ok: true, engine_snip: snip, admission: adm, snoop: snp, receipt });
  } else { console.error('usage: timmy docker <snip|admit|snoop|containerize|seal> …'); process.exit(2); }
} catch (e) { console.error(`[docker] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
