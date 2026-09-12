#!/usr/bin/env node
// Swarm fit — "Ollama parallel slots = swarm sessions". How many concurrent
// sessions (OLLAMA_NUM_PARALLEL=N, each holding num_ctx tokens of KV) fit beside
// one loaded model in a node's unified memory. spark2 is pure math from pinned
// facts; mac reads the model live with `ollama show` and derives the KV geometry
// from the tensor list when the show output carries one.
//
//   node lanes/swarm/fit.mjs [--node mac|spark2] [--model <ollama tag>] [--ctx 8192] [--sizes 1,2,3,4,5,6,8] [--json]
//
// Formula, per swarm size N:
//   kv_per_slot  = kv_bytes_per_token × num_ctx
//   kv_total     = N × kv_per_slot            (OLLAMA_NUM_PARALLEL=N makes Ollama allocate N × num_ctx tokens of KV for the loaded model)
//   state_total  = N × linear_state_per_slot  (the linear-attention layers hold a small fixed recurrent state per sequence)
//   total        = weights + mmproj + overhead + kv_total + state_total
//   headroom     = mem − os_reserve − total ; fits = headroom > 0
//   max_n        = floor((mem − os_reserve − weights − mmproj − overhead) / (kv_per_slot + linear_state_per_slot))
//
// Units: every *_gb value is GiB (1024³ B). Both nodes carry 137,438,953,472 B = 128 GiB
// of unified memory, so GiB is the unit the headroom is really measured in; decimal-GB
// equivalents (what `ollama list` and the Hub print) are spelled out in the assumptions.
import { spawnSync } from 'node:child_process';
import { totalmem } from 'node:os';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);

const GIB = 1024 ** 3;
const gb = (bytes) => +(bytes / GIB).toFixed(2);
const dec = (bytes) => (bytes / 1e9).toFixed(2);

// Qwen3.8-27B text config (unsloth GGUF; lanes/engine-room/node.mjs pick()): 64 blocks =
// 16 full-attention layers (4 KV heads × 256 head_dim) + 48 linear-attention layers.
const GGUF_GEOMETRY = { full_attention_layers: 16, kv_heads: 4, head_dim: 256, linear_layers: 48, kv_dtype: 'f16', source: 'assumed: unsloth/Qwen3.8-27B-GGUF text config' };
const kvBytesPerToken = (g) => g.full_attention_layers * 2 * g.kv_heads * g.head_dim * 2; // layers × (K,V) × kv_heads × head_dim × 2 B (f16)
const LINEAR_STATE_PER_SLOT = 0.5 * GIB; // fixed recurrent state of the 48 linear-attention layers, one per sequence (slot)
const OVERHEAD = 3 * GIB; // runtime compute/scratch buffers for one loaded model (same allowance as engine-room pick())

// unsloth/Qwen3.8-27B-GGUF file sizes (bytes, measured on the Hub 2026-09-07) — spark2 pulls one of these
const GGUF_QUANTS = { 'UD-Q4_K_XL': 17559178144, 'UD-Q5_K_XL': 20876938144, 'UD-Q6_K_XL': 25299061664, 'Q8_0': 29047086048, 'UD-Q8_K_XL': 31457991680, 'BF16': 49986159616 + 4671576000 };
const GGUF_MMPROJ = 931146432; // vision projector Ollama pulls beside the GGUF weights
const MAC_MLX_BYTES_PINNED = 18174721847; // qwen3.8:27b-mlx per /api/tags on 2026-09-08 (fallback when no local server answers)

const NODES = {
  spark2: { id: 'spark2', label: 'DGX Spark spark2 (GB10, 128 GiB unified)', mem_bytes: 128 * GIB, mem_source: 'pinned: DGX Spark 128 GB LPDDR5x', os_reserve_bytes: 8 * GIB, default_model: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q8_K_XL' },
  mac: { id: 'mac', label: 'MacBook Pro (Apple silicon, 128 GiB unified)', mem_bytes: totalmem(), mem_source: 'live: os.totalmem()', os_reserve_bytes: 16 * GIB, default_model: 'qwen3.8:27b-mlx' }
};

// ------------------------------------------------------------------ model facts

function spark2Model(tag) {
  const quant = tag.match(/^hf\.co\/unsloth\/Qwen3\.8-27B-GGUF:(\S+)$/)?.[1];
  if (!quant || !GGUF_QUANTS[quant]) throw new Error(`spark2 fit knows hf.co/unsloth/Qwen3.8-27B-GGUF:{${Object.keys(GGUF_QUANTS).join('|')}} only (no live read over ssh here); got ${tag}`);
  const bytes = GGUF_QUANTS[quant];
  return {
    model: tag, architecture: 'qwen3_5 (GGUF)', parameters: '27.8B', quantization: quant, context_length: 262144, weights_bytes: bytes, mmproj_bytes: GGUF_MMPROJ, geometry: { ...GGUF_GEOMETRY },
    assumptions: [
      `weights: pinned ${quant} file size ${bytes.toLocaleString()} B = ${dec(bytes)} GB decimal = ${gb(bytes)} GiB (measured on the Hub 2026-09-07) + mmproj ${GGUF_MMPROJ.toLocaleString()} B = ${gb(GGUF_MMPROJ)} GiB`,
      'KV geometry: 16 full-attention layers × 2 (K,V) × 4 KV heads × 256 head_dim × 2 B (f16) = 65,536 B/token; 48 linear-attention layers hold a fixed state, treated as 0.5 GiB per slot'
    ]
  };
}

function parseSize(s) { const m = s.match(/([\d.]+)\s*(GiB|MiB|GB|MB)/i); if (!m) return null; const n = Number(m[1]); const u = m[2].toLowerCase(); return Math.round(u === 'gib' ? n * GIB : u === 'mib' ? n * 1024 ** 2 : u === 'gb' ? n * 1e9 : n * 1e6); }

function ollamaHost() {
  let h = process.env.OLLAMA_HOST || '127.0.0.1:11434';
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace('0.0.0.0', '127.0.0.1').replace(/\/$/, '');
}

/** KV geometry from `ollama show --verbose`: safetensors tensor names (mlx) or GGUF metadata keys. */
function geometryFromShow(text, arch) {
  const full = new Set(), linear = new Set(); let kvDim = null, headDim = null;
  for (const l of text.split('\n')) {
    let m = l.match(/language_model\.layers\.(\d+)\.self_attn\.k_proj\.weight\s+\S+\s+\[(\d+) (\d+)\]/);
    if (m) { full.add(+m[1]); kvDim = +m[2]; continue; }
    m = l.match(/language_model\.layers\.(\d+)\.self_attn\.k_norm\.weight\s+\S+\s+\[(\d+)\]/);
    if (m) { headDim = +m[2]; continue; }
    m = l.match(/language_model\.layers\.(\d+)\.linear_attn\./);
    if (m) linear.add(+m[1]);
  }
  if (full.size && kvDim && headDim) return { full_attention_layers: full.size, kv_heads: kvDim / headDim, head_dim: headDim, linear_layers: linear.size, kv_dtype: 'f16', source: `derived: ollama show --verbose tensor list (${full.size} self_attn layers, k_proj [${kvDim} …] / k_norm [${headDim}] → ${kvDim / headDim} KV heads × ${headDim} head_dim; ${linear.size} linear_attn layers)` };
  // GGUF metadata (e.g. qwen3_5.attention.head_count_kv / key_length / full_attention_interval / block_count)
  const meta = (k) => { const m = text.match(new RegExp(`^\\s*${arch}\\.${k.replace(/\./g, '\\.')}\\s+(\\S+)`, 'm')); return m ? Number(m[1]) : null; };
  const kvHeads = meta('attention.head_count_kv'), keyLen = meta('attention.key_length'), blocks = meta('block_count'), interval = meta('full_attention_interval');
  if (kvHeads && keyLen && blocks) { const fa = interval ? Math.floor(blocks / interval) : blocks; return { full_attention_layers: fa, kv_heads: kvHeads, head_dim: keyLen, linear_layers: blocks - fa, kv_dtype: 'f16', source: `derived: ollama show --verbose GGUF metadata (${arch}.attention.head_count_kv=${kvHeads}, key_length=${keyLen}, block_count=${blocks}, full_attention_interval=${interval ?? 'n/a'})` }; }
  return null;
}

async function macModelLive(tag) {
  const assumptions = [];
  const show = spawnSync('ollama', ['show', tag], { encoding: 'utf8', timeout: 30000 });
  if (show.status !== 0) throw new Error(`ollama show ${tag} failed: ${(show.stderr || show.error?.message || '').trim().split('\n').pop()}`);
  const line = (label) => { const m = show.stdout.match(new RegExp(`^[ \\t]*${label}[ \\t]{2,}([^\\n]+?)[ \\t]*$`, 'mi')); return m ? m[1].trim() : null; };
  const architecture = line('architecture'), parameters = line('parameters'), context_length = Number(line('context length')) || null, quantization = line('quantization'), sizeLine = line('size');

  // weights: `ollama show` prints no size line for this model → exact bytes from /api/tags → `ollama list` → pinned
  let weights_bytes = null, size_source = null;
  if (sizeLine && parseSize(sizeLine)) { weights_bytes = parseSize(sizeLine); size_source = `ollama show size line "${sizeLine}"`; }
  if (!weights_bytes) {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000);
      const r = await fetch(`${ollamaHost()}/api/tags`, { signal: ac.signal }); clearTimeout(t);
      const m = (await r.json()).models?.find((x) => x.name === tag || x.model === tag);
      if (m?.size) { weights_bytes = m.size; size_source = `GET ${ollamaHost()}/api/tags size (exact bytes)`; }
    } catch { /* no local server; fall through */ }
  }
  if (!weights_bytes) {
    const list = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 30000 });
    const row = (list.stdout || '').split('\n').find((l) => l.startsWith(tag + ' '));
    if (row && parseSize(row)) { weights_bytes = parseSize(row); size_source = `ollama list row "${row.replace(/\s+/g, ' ').trim()}" (rounded)`; }
  }
  if (!weights_bytes) { weights_bytes = MAC_MLX_BYTES_PINNED; size_source = 'pinned fallback (no server answered): 18,174,721,847 B per /api/tags on 2026-09-08'; }
  assumptions.push(`weights: ${weights_bytes.toLocaleString()} B = ${dec(weights_bytes)} GB decimal = ${gb(weights_bytes)} GiB — from ${size_source}; \`ollama show ${tag}\` itself reports architecture ${architecture ?? '?'}, parameters ${parameters ?? '?'}, context length ${context_length ?? '?'}, quantization ${quantization ?? '?'} and no size line`);

  const verbose = spawnSync('ollama', ['show', tag, '--verbose'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  let geometry = geometryFromShow(verbose.stdout || '', architecture || 'qwen3_5');
  if (geometry) assumptions.push(`KV geometry ${geometry.source}; kv_bytes_per_token = ${geometry.full_attention_layers} × 2 × ${geometry.kv_heads} × ${geometry.head_dim} × 2 B (f16) = ${kvBytesPerToken(geometry).toLocaleString()} B`);
  else { geometry = { ...GGUF_GEOMETRY }; assumptions.push(`KV geometry NOT in the show output — assumed the same as the GGUF (16 full-attention layers × 4 KV heads × 256 head_dim, f16) = ${kvBytesPerToken(geometry).toLocaleString()} B/token`); }
  assumptions.push('the linear-attention layers hold a fixed recurrent state per sequence, treated as 0.5 GiB per slot (same allowance as spark2)');
  return { model: tag, architecture, parameters, quantization, context_length, weights_bytes, mmproj_bytes: 0, geometry, assumptions };
}

// ------------------------------------------------------------------ fit math

export function fit(node, m, ctx, sizes) {
  const kvTok = kvBytesPerToken(m.geometry);
  const maxCtx = m.context_length || 262144;
  const numCtx = Math.min(ctx, maxCtx);
  const kvSlot = kvTok * numCtx;
  const perSlot = kvSlot + LINEAR_STATE_PER_SLOT;
  const budget = node.mem_bytes - node.os_reserve_bytes;
  const fixed = m.weights_bytes + m.mmproj_bytes + OVERHEAD;
  const rows = sizes.map((n) => {
    const kvTotal = n * kvSlot, stTotal = n * LINEAR_STATE_PER_SLOT, total = fixed + kvTotal + stTotal, head = budget - total;
    return { n, weights_gb: gb(m.weights_bytes), kv_per_slot_gb: gb(kvSlot), kv_total_gb: gb(kvTotal), state_total_gb: gb(stTotal), overhead_gb: gb(OVERHEAD + m.mmproj_bytes), total_gb: gb(total), headroom_gb: gb(head), fits: head > 0, ollama_kv_tokens: n * numCtx };
  });
  const max_n = Math.max(0, Math.floor((budget - fixed) / perSlot));
  const assumptions = [
    `units: every *_gb is GiB (1024³ B); memory ${node.mem_bytes.toLocaleString()} B = ${gb(node.mem_bytes)} GiB (${node.mem_source}); OS reserve ${gb(node.os_reserve_bytes)} GiB → budget ${gb(budget)} GiB`,
    ...m.assumptions,
    `KV cache dtype f16 (OLLAMA_KV_CACHE_TYPE unset); q8_0 would halve kv_per_slot`,
    `fixed runtime overhead ${gb(OVERHEAD)} GiB for compute/scratch buffers${m.mmproj_bytes ? ` + mmproj ${gb(m.mmproj_bytes)} GiB` : ''} (the overhead column)`,
    `Ollama per-slot cost: OLLAMA_NUM_PARALLEL=N multiplies num_ctx by N for the loaded model, so the KV budget is N × num_ctx tokens (note: ollama ps on 0.33.1 still prints the per-slot num_ctx, not N × num_ctx); num_ctx ${ctx}${numCtx !== ctx ? ` clamped to the model's ${maxCtx}` : ''} ≤ max context ${maxCtx}`,
    'headroom ignores other processes on the node; a swarm of N harness processes needs its own RAM on top of this'
  ];
  return {
    node: node.id, label: node.label, model: m.model, architecture: m.architecture, parameters: m.parameters, quantization: m.quantization, max_context: maxCtx, ctx: numCtx, unit: 'GiB',
    mem_gb: gb(node.mem_bytes), os_reserve_gb: gb(node.os_reserve_bytes), budget_gb: gb(budget), weights_gb: gb(m.weights_bytes), weights_bytes: m.weights_bytes, mmproj_gb: gb(m.mmproj_bytes), overhead_gb: gb(OVERHEAD),
    geometry: m.geometry, kv_bytes_per_token: kvTok, kv_per_slot_gb: gb(kvSlot), linear_state_per_slot_gb: gb(LINEAR_STATE_PER_SLOT), per_slot_gb: gb(perSlot),
    rows, max_n, fits_requested: rows.every((r) => r.fits),
    formula: [
      `kv_per_slot  = kv_bytes_per_token × num_ctx = ${kvTok.toLocaleString()} × ${numCtx} = ${gb(kvSlot)} GiB`,
      `kv_total     = N × kv_per_slot`,
      `state_total  = N × ${gb(LINEAR_STATE_PER_SLOT)} GiB (linear-attention state per slot)`,
      `total        = weights ${gb(m.weights_bytes)} + mmproj ${gb(m.mmproj_bytes)} + overhead ${gb(OVERHEAD)} + kv_total + state_total`,
      `headroom     = mem ${gb(node.mem_bytes)} − os_reserve ${gb(node.os_reserve_bytes)} − total ; fits = headroom > 0`,
      `max_n        = floor((${gb(budget)} − ${gb(fixed)}) / ${gb(perSlot)}) = ${max_n}`
    ],
    assumptions
  };
}

function printTable(r) {
  console.log(`swarm fit · ${r.node} · ${r.model} (${r.quantization ?? '?'}, ${r.parameters ?? '?'}) · num_ctx ${r.ctx} · mem ${r.mem_gb.toFixed(2)} GiB − OS reserve ${r.os_reserve_gb.toFixed(2)} GiB = budget ${r.budget_gb.toFixed(2)} GiB`);
  const cols = [['N', 3], ['weights', 8], ['kv/slot', 8], ['kv_total', 9], ['lin_state', 10], ['overhead', 9], ['total', 8], ['headroom', 9], ['fits', 5]];
  console.log(cols.map(([h, w]) => h.padStart(w)).join('  '));
  for (const row of r.rows) {
    const cells = [row.n, row.weights_gb.toFixed(2), row.kv_per_slot_gb.toFixed(2), row.kv_total_gb.toFixed(2), row.state_total_gb.toFixed(2), row.overhead_gb.toFixed(2), row.total_gb.toFixed(2), row.headroom_gb.toFixed(2), row.fits ? 'yes' : 'NO'];
    console.log(cells.map((v, i) => String(v).padStart(cols[i][1])).join('  '));
  }
  console.log(`max N that fits at num_ctx ${r.ctx}: ${r.max_n}   (all *_gb in GiB; Ollama allocates KV for N × ${r.ctx} tokens when OLLAMA_NUM_PARALLEL=N)`);
  console.log('formula:'); for (const f of r.formula) console.log(`  ${f}`);
  console.log('assumptions:'); for (const a of r.assumptions) console.log(`  - ${a}`);
}

// ------------------------------------------------------------------ main

try {
  const nodeId = flag('--node', 'mac');
  const node = NODES[nodeId];
  if (!node) { console.error(`usage: node lanes/swarm/fit.mjs [--node mac|spark2] [--model <tag>] [--ctx 8192] [--sizes 1,2,3,4,5,6,8] [--json]`); process.exit(2); }
  const model = flag('--model', node.default_model);
  const ctx = Number(flag('--ctx', 8192));
  const sizes = String(flag('--sizes', '1,2,3,4,5,6,8')).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!Number.isInteger(ctx) || ctx <= 0 || !sizes.length) throw new Error('--ctx must be a positive integer and --sizes a comma list of positive integers');
  const m = nodeId === 'spark2' ? spark2Model(model) : await macModelLive(model);
  const r = fit(node, m, ctx, sizes);
  if (has('--json')) console.log(JSON.stringify(r, null, 1)); else printTable(r);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
