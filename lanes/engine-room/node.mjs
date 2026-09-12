#!/usr/bin/env node
// Engine room (Part 2): bring a DGX Spark into the fleet over Tailscale SSH and
// serve a model from it. Every step is a receipt; nothing here needs a password
// (Tailscale SSH), and every remote command is printed before it runs.
//
//   timmy node probe <id>                        what is on the node (read-only)
//   timmy node join <id> [--no-seal]             env-lock + fleet entry + node.join receipt
//   timmy node ollama <id>                       install or update Ollama (sudo path, else user-space tarball)
//   timmy node pick [--mem-gb 128] [--ctx 262144] the quant that fits, with the math
//   timmy node pull <id> [--model hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q8_K_XL]    start the pull (detached, logged)
//   timmy node pull-status <id>                  progress of a running pull
//   timmy node serve <id>                        ollama serve on the tailnet (0.0.0.0:11434), detached
//   timmy node register <id> [--model tag]       provider entries for the fleet, the judge tier, the harnesses, the commander
//   timmy node prove <id> [--model tag]          one sealed chat.turn through the node
//   timmy node status <id>                       models loaded, serve state
//
// Nodes come from fleet/nodes.json (tailnet name, ip, ssh command).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = join(ROOT, 'lanes', 'engine-room');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-seal', '--json'].includes(args[i - 1])));
const cmd = positional[0] ?? 'status';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const NODES = JSON.parse(readFileSync(join(ROOT, 'fleet', 'nodes.json'), 'utf8'));
const node = (id) => { const n = NODES.nodes.find((x) => x.id === id || x.tailnet_name === id); if (!n) throw new Error(`unknown node ${id}; fleet/nodes.json has ${NODES.nodes.map((x) => x.id).join(', ')}`); return n; };
const DEFAULT_MODEL = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q8_K_XL';

/** Run one remote command over Tailscale SSH (BatchMode: never prompts). */
function ssh(n, script, { timeout = 120000, quiet = false } = {}) {
  const host = n.tailnet_ip ?? n.tailnet_name;
  const target = n.ssh_user ? `${n.ssh_user}@${host}` : host; // Tailscale SSH policy names the remote user; the Mac login name is not it
  if (!quiet) console.error(`$ ssh ${target} ${script.slice(0, 160).replace(/\n/g, ' ')}${script.length > 160 ? '…' : ''}`);
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', target, script], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), timed_out: r.error?.code === 'ETIMEDOUT' };
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

const PROBE = `set +e
echo "hostname=$(hostname)"
echo "user=$(id -un)"
echo "arch=$(uname -m)"
echo "kernel=$(uname -r)"
echo "os=$(. /etc/os-release && echo "$PRETTY_NAME")"
echo "tailnet_ip=$(tailscale ip -4 2>/dev/null | head -1)"
echo "mem_total_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')"
echo "mem_avail_kb=$(grep MemAvailable /proc/meminfo | awk '{print $2}')"
echo "disk_root=$(df -h / | tail -1 | awk '{print $2" total "$4" free"}')"
echo "gpu=$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null)"
echo "nvidia_smi_path=$(command -v nvidia-smi)"
echo "nvidia_smi_sha256=$(sha256sum $(command -v nvidia-smi) 2>/dev/null | cut -c1-64)"
echo "nvidia_smi_out_sha256=$(nvidia-smi 2>/dev/null | sha256sum | cut -c1-64)"
echo "cuda=$(nvcc --version 2>/dev/null | grep release | sed 's/.*release //')"
echo "ollama_path=$(command -v ollama)"
echo "ollama_version=$(ollama --version 2>/dev/null | head -1)"
echo "ollama_sha256=$(sha256sum $(command -v ollama) 2>/dev/null | cut -c1-64)"
echo "ollama_serving=$(curl -s --max-time 3 http://127.0.0.1:11434/api/version 2>/dev/null)"
echo "docker=$(command -v docker)"
echo "sudo=$(sudo -n true 2>/dev/null && echo nopass || echo password)"
echo "uptime=$(uptime -p 2>/dev/null)"`;

function parseKv(text) { const o = {}; for (const l of text.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); } return o; }

function probe(n) {
  const r = ssh(n, PROBE, { timeout: 90000 });
  if (!r.ok && !r.out) return { ok: false, node: n.id, error: r.err.split('\n').slice(-2).join(' | ') || `ssh exit ${r.status}`, timed_out: r.timed_out };
  return { ok: true, node: n.id, ...parseKv(r.out) };
}

function envLock(n, p) {
  const lock = { v: 1, node: n.id, tailnet_name: n.tailnet_name, captured_at: new Date().toISOString(), hostname: p.hostname, os: p.os, kernel: p.kernel, arch: p.arch, gpu: p.gpu, cuda: p.cuda || null, mem_total_gb: Math.round(Number(p.mem_total_kb) / 1048576), tools: { 'nvidia-smi': { path: p.nvidia_smi_path, sha256: p.nvidia_smi_sha256 || null }, ollama: p.ollama_path ? { path: p.ollama_path, sha256: p.ollama_sha256 || null, version: p.ollama_version || null } : null } };
  mkdirSync(join(HERE, 'nodes'), { recursive: true });
  const text = JSON.stringify(lock, null, 1);
  writeFileSync(join(HERE, 'nodes', `${n.id}.env-lock.json`), text);
  return { lock, sha256: sha(text), path: `lanes/engine-room/nodes/${n.id}.env-lock.json` };
}

function fleetEntry(n, p, modelTag) {
  const fleetPath = join(ROOT, 'fleet', 'fleet.json');
  const fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
  const id = `${n.id}-ollama`;
  const url = `http://${n.tailnet_ip}:11434/api/tags`;
  const entry = { id, rank: (fleet.find((f) => f.id === id)?.rank) ?? fleet.length + 1, forms: ['api'], detect: { url }, lane: `lanes/engine-room/node.mjs (timmy node …): Ollama on ${n.tailnet_name} over the tailnet; model ${modelTag}; OpenAI-compatible at http://${n.tailnet_ip}:11434/v1`, node: { id: n.id, tailnet_name: n.tailnet_name, tailnet_ip: n.tailnet_ip, gpu: p.gpu, mem_total_gb: Math.round(Number(p.mem_total_kb) / 1048576) }, note: `DGX Spark ${n.tailnet_name} · engine room · reachable on the tailnet only` };
  const i = fleet.findIndex((f) => f.id === id);
  if (i >= 0) fleet[i] = { ...fleet[i], ...entry, rank: fleet[i].rank }; else fleet.push(entry);
  // the judge tier looks at this node first
  const judges = fleet.find((f) => f.id === 'local-judges');
  if (judges) { judges.detect = { url }; judges.note = `${judges.note ?? ''} · detect points at ${n.tailnet_name} (engine room) since 2026-09-07`.replace(/^ · /, ''); }
  writeFileSync(fleetPath, JSON.stringify(fleet, null, 2) + '\n');
  return entry;
}

function setStatus(id, status, extra = {}) {
  const n = NODES.nodes.find((x) => x.id === id);
  Object.assign(n, { status, ...extra });
  writeFileSync(join(ROOT, 'fleet', 'nodes.json'), JSON.stringify(NODES, null, 1) + '\n');
}

// ------------------------------------------------------------------ fit math

export function pick({ memGb = 128, ctx = 262144, reserveGb = 8 } = {}) {
  // unsloth/Qwen3.8-27B-GGUF file sizes (bytes, measured on the Hub 2026-09-07) and the text config
  const quants = { 'UD-Q4_K_XL': 17559178144, 'UD-Q5_K_XL': 20876938144, 'UD-Q6_K_XL': 25299061664, 'Q8_0': 29047086048, 'UD-Q8_K_XL': 31457991680, 'BF16': 49986159616 + 4671576000 };
  const mmproj = 931146432; // vision projector Ollama pulls beside the weights
  const cfg = { layers: 64, full_attention_layers: 16, kv_heads: 4, head_dim: 256, linear_layers: 48, linear_value_heads: 48, linear_key_head_dim: 128, linear_value_head_dim: 128, max_ctx: 262144 };
  const kvPerTokenF16 = cfg.full_attention_layers * 2 * cfg.kv_heads * cfg.head_dim * 2; // bytes: 16 layers × K,V × 4 heads × 256 dims × 2 B
  const linearState = cfg.linear_layers * cfg.linear_value_heads * cfg.linear_key_head_dim * cfg.linear_value_head_dim * 4; // fp32 recurrent state, fixed per sequence
  const gb = (b) => b / 1073741824;
  const rows = Object.entries(quants).map(([q, bytes]) => {
    const kv = kvPerTokenF16 * ctx;
    const compute = 3 * 1073741824;
    const total = bytes + mmproj + kv + linearState + compute;
    return { quant: q, weights_gb: +gb(bytes).toFixed(2), kv_cache_gb: +gb(kv).toFixed(2), linear_state_gb: +gb(linearState).toFixed(2), mmproj_gb: +gb(mmproj).toFixed(2), compute_gb: 3, total_gb: +gb(total).toFixed(2), headroom_gb: +(memGb - reserveGb - gb(total)).toFixed(2), fits: memGb - reserveGb - gb(total) > 0 };
  });
  const choice = rows.filter((r) => r.fits && r.quant !== 'BF16').sort((a, b) => b.weights_gb - a.weights_gb)[0];
  return { model: 'unsloth/Qwen3.8-27B-GGUF', arch: cfg, kv_per_token_bytes_f16: kvPerTokenF16, ctx, mem_gb: memGb, os_reserve_gb: reserveGb, rows, choice: choice?.quant, ollama_tag: `hf.co/unsloth/Qwen3.8-27B-GGUF:${choice?.quant}`, why: `${choice?.quant} is the highest-quality dynamic quant that leaves ${choice?.headroom_gb} GB free after a full ${ctx}-token f16 KV cache; BF16 also fits (${rows.find((r) => r.quant === 'BF16')?.headroom_gb} GB free) but decodes ~1.7× slower on the Spark's 273 GB/s memory bus for no measurable judge-quality gain.` };
}

// ------------------------------------------------------------------ commands

const out = (o) => console.log(JSON.stringify(o, null, 1));

try {
  switch (cmd) {
    case 'pick': out(pick({ memGb: Number(flag('--mem-gb', 128)), ctx: Number(flag('--ctx', 262144)) })); break;
    case 'probe': out(probe(node(positional[1]))); break;
    case 'join': {
      const n = node(positional[1]);
      const p = probe(n);
      if (!p.ok) { out(p); process.exit(1); }
      const lock = envLock(n, p);
      const entry = fleetEntry(n, p, flag('--model', DEFAULT_MODEL));
      let receipt = null;
      if (!has('--no-seal')) {
        receipt = seal('node.join', { node: n.id, hostname: p.hostname, tailnet_name: n.tailnet_name, tailnet_ip: p.tailnet_ip || n.tailnet_ip, lan_ip: n.lan_ip ?? 'n/a', mac: n.mac ?? 'n/a', os: p.os, kernel: p.kernel, arch: p.arch, gpu: p.gpu, cuda: p.cuda || 'n/a', mem_total_gb: Math.round(Number(p.mem_total_kb) / 1048576), nvidia_smi_sha256: p.nvidia_smi_sha256 || 'n/a', nvidia_smi_output_sha256: p.nvidia_smi_out_sha256 || 'n/a', ollama: p.ollama_version || 'absent', envlock: lock.path, envlock_sha256: lock.sha256, fleet_entry: entry.id, transport: 'tailscale-ssh', order: 'engine-room-part-2' });
        setStatus(n.id, 'joined', { joined_at: new Date().toISOString(), node_join: receipt });
      }
      out({ ok: true, node: n.id, hostname: p.hostname, tailnet_ip: p.tailnet_ip, gpu: p.gpu, envlock: lock.path, envlock_sha256: lock.sha256, fleet_entry: entry.id, receipt });
      break;
    }
    case 'ollama': {
      const n = node(positional[1]);
      const p = probe(n);
      if (!p.ok) { out(p); process.exit(1); }
      let r;
      if (p.sudo === 'nopass') {
        r = ssh(n, 'curl -fsSL https://ollama.com/install.sh | sh 2>&1 | tail -5; ollama --version', { timeout: 900000 });
      } else {
        // no password ever typed by this lane: user-space install from the official tarball
        r = ssh(n, 'set -e; mkdir -p $HOME/ollama; cd $HOME/ollama; curl -fsSL -o ollama-linux-arm64.tgz https://ollama.com/download/ollama-linux-arm64.tgz; tar -xzf ollama-linux-arm64.tgz; rm ollama-linux-arm64.tgz; mkdir -p $HOME/.local/bin; ln -sf $HOME/ollama/bin/ollama $HOME/.local/bin/ollama; grep -q "ollama/bin" $HOME/.profile 2>/dev/null || echo "export PATH=$HOME/ollama/bin:$HOME/.local/bin:$PATH" >> $HOME/.profile; $HOME/ollama/bin/ollama --version', { timeout: 900000 });
      }
      out({ ok: r.ok, node: n.id, path: p.sudo === 'nopass' ? 'installer (sudo)' : 'user-space tarball ~/ollama', output: r.out.split('\n').slice(-6), error: r.ok ? null : r.err.split('\n').slice(-3).join(' | ') });
      process.exit(r.ok ? 0 : 1);
    }
    case 'serve': {
      const n = node(positional[1]);
      const r = ssh(n, 'set -e; export PATH=$HOME/ollama/bin:$HOME/.local/bin:$PATH; if curl -s --max-time 3 http://127.0.0.1:11434/api/version >/dev/null; then echo already-serving; else mkdir -p $HOME/.timmy; OLLAMA_HOST=0.0.0.0:11434 OLLAMA_KEEP_ALIVE=30m nohup ollama serve > $HOME/.timmy/ollama-serve.log 2>&1 & sleep 4; fi; curl -s --max-time 5 http://127.0.0.1:11434/api/version; echo; ss -ltnp 2>/dev/null | grep 11434 || netstat -ltn 2>/dev/null | grep 11434', { timeout: 60000 });
      const remote = spawnSync('curl', ['-s', '--max-time', '8', `http://${n.tailnet_ip}:11434/api/version`], { encoding: 'utf8' });
      out({ ok: r.ok, node: n.id, local: r.out.split('\n').slice(-3), reachable_from_here: remote.status === 0 && !!remote.stdout, version_from_here: remote.stdout || null, error: r.ok ? null : r.err.split('\n').slice(-2).join(' | ') });
      process.exit(r.ok && remote.status === 0 ? 0 : 1);
    }
    case 'pull': {
      const n = node(positional[1]);
      const model = flag('--model', DEFAULT_MODEL);
      const r = ssh(n, `set -e; export PATH=$HOME/ollama/bin:$HOME/.local/bin:$PATH; mkdir -p $HOME/.timmy; nohup ollama pull ${model} > $HOME/.timmy/ollama-pull.log 2>&1 & echo started pid $!; sleep 6; tail -c 300 $HOME/.timmy/ollama-pull.log`, { timeout: 60000 });
      out({ ok: r.ok, node: n.id, model, started: r.out.split('\n').slice(0, 1), log: '~/.timmy/ollama-pull.log', tail: r.out.split('\n').slice(-3), error: r.ok ? null : r.err.split('\n').slice(-2).join(' | ') });
      process.exit(r.ok ? 0 : 1);
    }
    case 'pull-status': {
      const n = node(positional[1]);
      const r = ssh(n, 'export PATH=$HOME/ollama/bin:$HOME/.local/bin:$PATH; pgrep -f "ollama pull" >/dev/null && echo running || echo not-running; tail -c 400 $HOME/.timmy/ollama-pull.log 2>/dev/null | tr "\\r" "\\n" | tail -3; ollama list 2>/dev/null', { timeout: 60000, quiet: true });
      out({ node: n.id, ok: r.ok, lines: r.out.split('\n').filter(Boolean).slice(-8) });
      break;
    }
    case 'status': {
      const n = node(positional[1] ?? 'spark2');
      const r = ssh(n, 'export PATH=$HOME/ollama/bin:$HOME/.local/bin:$PATH; curl -s --max-time 3 http://127.0.0.1:11434/api/version; echo; ollama list 2>/dev/null; ollama ps 2>/dev/null; nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null', { timeout: 60000, quiet: true });
      out({ node: n.id, ok: r.ok, lines: r.out.split('\n').filter(Boolean) });
      break;
    }
    case 'register': {
      const n = node(positional[1]);
      const model = flag('--model', DEFAULT_MODEL);
      const base = `http://${n.tailnet_ip}:11434`;
      const providers = existsSync(join(ROOT, 'fleet', 'providers.json')) ? JSON.parse(readFileSync(join(ROOT, 'fleet', 'providers.json'), 'utf8')) : { v: 1, providers: [] };
      const entry = {
        id: `${n.id}-ollama`, node: n.id, kind: 'ollama', base_url: base, openai_compatible: `${base}/v1`, model, tag_for_ollama: model,
        reach: 'tailnet-only (<tailnet-ip>/10); the edge commander cannot reach it without a tunnel',
        roles: {
          judge_tier: { how: 'fleet local-judges detect → this node; timmy_fusion_plan lists local judges first', env: { OLLAMA_HOST: base, TIMMY_ALLOW_LOCAL_OLLAMA: '1' } },
          harnesses: { openai_compatible_base_url: `${base}/v1`, api_key: 'ollama', notes: 'pi: models.json provider ollama baseUrl; opencode: provider ollama baseURL; hermes/openhands: OPENAI_BASE_URL + OPENAI_API_KEY=ollama; jcode: provider profile' },
          commander: { status: 'registered, not reachable from Cloudflare', how: 'lanes/commander/cli.mjs think --mind spark2 runs the turn locally against this base_url and posts it as a holder turn; a tunnel (cloudflared / tailscale funnel) is what would let the DO call it directly' }
        },
        registered_at: new Date().toISOString()
      };
      const i = providers.providers.findIndex((p) => p.id === entry.id);
      if (i >= 0) providers.providers[i] = entry; else providers.providers.push(entry);
      writeFileSync(join(ROOT, 'fleet', 'providers.json'), JSON.stringify(providers, null, 1) + '\n');
      // per-harness snippets, ready to paste (no user config is touched)
      mkdirSync(join(HERE, 'profiles'), { recursive: true });
      const profiles = {
        'pi.models.json': { providers: { [`${n.id}-ollama`]: { baseUrl: `${base}/v1`, api: 'openai-completions', apiKey: 'ollama', models: [{ id: model, name: `${n.id} ${model}`, contextWindow: 262144, maxTokens: 8192 }] } } },
        'opencode.json': { $schema: 'https://opencode.ai/config.json', provider: { [`${n.id}-ollama`]: { npm: '@ai-sdk/openai-compatible', name: `${n.id} ollama`, options: { baseURL: `${base}/v1` }, models: { [model]: { name: model } } } } },
        'env.sh': `# hermes / openhands / any OpenAI-compatible harness\nexport OPENAI_BASE_URL=${base}/v1\nexport OPENAI_API_KEY=ollama\nexport LLM_MODEL=openai/${model}\n# timmy judge tier\nexport OLLAMA_HOST=${base}\nexport TIMMY_ALLOW_LOCAL_OLLAMA=1\n`,
        'jcode.provider.json': { providers: [{ id: `${n.id}-ollama`, type: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: 'ollama', models: [model] }] }
      };
      for (const [name, body] of Object.entries(profiles)) writeFileSync(join(HERE, 'profiles', `${n.id}.${name}`), typeof body === 'string' ? body : JSON.stringify(body, null, 1) + '\n');
      const receipt = has('--no-seal') ? null : seal('provider.register', { provider: entry.id, node: n.id, base_url: base, model, roles: 'judge-tier,harnesses,commander(local-turn)', profiles: Object.keys(profiles).map((k) => `lanes/engine-room/profiles/${n.id}.${k}`).join(','), fleet: 'fleet/providers.json + fleet/fleet.json local-judges detect', reach: 'tailnet-only', order: 'engine-room-part-2' });
      out({ ok: true, provider: entry.id, base_url: base, model, profiles: Object.keys(profiles), receipt });
      break;
    }
    case 'prove': {
      const n = node(positional[1]);
      const model = flag('--model', DEFAULT_MODEL);
      const prompt = flag('--prompt', 'You are the engine-room judge on a DGX Spark. In one sentence, say what a hash-chained receipt log gives a fleet of agents, then answer with exactly PONG on a new line.');
      const started = Date.now();
      const r = spawnSync('curl', ['-s', '--max-time', '600', `http://${n.tailnet_ip}:11434/api/chat`, '-H', 'content-type: application/json', '-d', JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }], options: { num_ctx: 8192, temperature: 0.2 } })], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      let j = null; try { j = JSON.parse(r.stdout); } catch { /* not json */ }
      const answer = j?.message?.content ?? '';
      const okAnswer = !!answer && !j?.error;
      const evalTps = j?.eval_count && j?.eval_duration ? +(j.eval_count / (j.eval_duration / 1e9)).toFixed(2) : null;
      const receipt = has('--no-seal') ? null : seal('chat.turn', { provider: `${n.id}-ollama`, node: n.id, host: `${n.tailnet_ip}:11434`, model, ok: okAnswer ? 'true' : 'false', prompt_sha256: sha(prompt), answer_sha256: sha(answer), answer_preview: answer.replace(/\s+/g, ' ').slice(0, 240), prompt_tokens: j?.prompt_eval_count ?? 'n/a', eval_tokens: j?.eval_count ?? 'n/a', eval_tok_per_s: evalTps ?? 'n/a', total_ms: j?.total_duration ? Math.round(j.total_duration / 1e6) : Date.now() - started, load_ms: j?.load_duration ? Math.round(j.load_duration / 1e6) : 'n/a', error: j?.error ?? (r.status !== 0 ? `curl exit ${r.status}` : null), transport: 'tailnet http', order: 'engine-room-part-2' });
      out({ ok: okAnswer, node: n.id, model, answer, prompt_tokens: j?.prompt_eval_count, eval_tokens: j?.eval_count, eval_tok_per_s: evalTps, total_ms: j?.total_duration ? Math.round(j.total_duration / 1e6) : null, error: j?.error ?? null, receipt });
      process.exit(okAnswer ? 0 : 1);
    }
    default: console.error('usage: timmy node probe|join|ollama|pick|pull|pull-status|serve|register|prove|status <id>'); process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
