# swarm · Ollama parallel slots = swarm sessions

Two Node 22 ESM files, no dependencies, no secrets, no receipts (the caller seals).

| file | what it does |
|---|---|
| `fit.mjs` | Fit math: for each swarm size N, how much memory one loaded model + N KV slots take on a node, the headroom, whether it fits, and the max N that fits. Pure math for `spark2` (pinned GGUF facts); `mac` reads the model live with `ollama show` and derives the KV geometry from the tensor list. |
| `slots.mjs` | Starts a **second** Ollama server (own port, pid, log; `OLLAMA_NUM_PARALLEL=N`) without touching the primary on `:11434`, then **proves** the slots with N concurrent `/api/chat` calls. `mac` runs locally; `spark2` runs the same verbs over Tailscale SSH and exits 3 (never hangs) when the node is unreachable. |

## Formula (per swarm size N)

```
kv_per_slot  = kv_bytes_per_token × num_ctx
kv_total     = N × kv_per_slot            # OLLAMA_NUM_PARALLEL=N makes Ollama allocate N × num_ctx tokens of KV
state_total  = N × 0.5 GiB                # fixed recurrent state of the 48 linear-attention layers, one per slot
total        = weights + mmproj + overhead(3 GiB) + kv_total + state_total
headroom     = mem − os_reserve − total ;  fits = headroom > 0
max_n        = floor((mem − os_reserve − weights − mmproj − overhead) / (kv_per_slot + 0.5 GiB))
```

`kv_bytes_per_token` for Qwen3.8-27B = 16 full-attention layers × 2 (K,V) × 4 KV heads × 256 head_dim × 2 B (f16) = **65,536 B/token**
(0.5 GiB per slot at `num_ctx 8192`, 2 GiB at 32768). On the mac this geometry is read from
`ollama show qwen3.8:27b-mlx --verbose` (16 `self_attn.k_proj [1024 5120]` layers, `k_norm [256]`, 48 `linear_attn` layers);
when a show output carries no geometry the GGUF figures are assumed and the `assumptions` say so.

Node facts: `spark2` = 128 GiB, 8 GiB OS reserve, `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q8_K_XL` (31,457,991,680 B = 31.46 GB decimal = 29.30 GiB) + 0.87 GiB mmproj.
`mac` = 128 GiB (`os.totalmem()`), 16 GiB OS reserve, `qwen3.8:27b-mlx` (nvfp4, 18,174,721,847 B = 18.17 GB decimal = 16.93 GiB).
All `*_gb` outputs are **GiB**; every assumption is printed under the table and in the JSON `assumptions` array.

## Run

```sh
node lanes/swarm/fit.mjs --node mac    --ctx 8192              # table + formula + assumptions
node lanes/swarm/fit.mjs --node spark2 --ctx 32768 --json      # same as JSON
node lanes/swarm/fit.mjs --node mac --sizes 1,5,10,20 --model qwen3.8:27b-mlx

node lanes/swarm/slots.mjs start  --node mac --parallel 5 --port 11435 --ctx 8192   # detached second server, warms the model
node lanes/swarm/slots.mjs prove  --node mac --parallel 5 --port 11435 --json       # N concurrent chats → overlap_ratio, slots_proven
node lanes/swarm/slots.mjs status --node mac --port 11435                           # version + /api/ps + pid + parallel from the log
node lanes/swarm/slots.mjs stop   --node mac --port 11435                           # kills only the pid in lanes/swarm/.cache/ollama-11435.pid

node lanes/swarm/slots.mjs start|prove|status|stop --node spark2 --parallel 5 --port 11435   # over Tailscale SSH; exit 3 if unreachable
```

`start` on the mac spawns `OLLAMA_HOST=127.0.0.1:<port> OLLAMA_NUM_PARALLEL=<N> OLLAMA_KEEP_ALIVE=30m OLLAMA_MODELS=~/.ollama/models OLLAMA_NOPRUNE=1 ollama serve`
detached, logs to `lanes/swarm/.cache/ollama-<port>.log`, writes `lanes/swarm/.cache/ollama-<port>.pid`, waits ≤ 30 s for `/api/version`,
then preloads the model at `num_ctx` (`--no-warm` skips). Port 11434 is refused. On spark2 the server binds `0.0.0.0:<port>` (tailnet-only reach) so `prove` can hit it from here;
its log/pid live in `~/.timmy/swarm/` on the node.

`prove` first times a solo call (`--solo-runs 2`, the first absorbs the runner's first-forward page-in), then fires N concurrent
`POST /api/chat` (`stream:false`, `think:false`, `options.num_ctx`) with prompts `Reply with the single word SLOT-<i>`, 300 s AbortController
per call, and reports `{parallel_requested, completed, total_ms, sum_ms, overlap_ratio, overlap_proven, solo_ms, speedup_vs_solo, stagger_ratio,
concurrent, slots_proven, throughput_gain, verdict, per_call[], ps}`.

* `overlap_ratio = sum_ms / total_ms > 1.5` with N ≥ 2 is `overlap_proven` — the order's criterion. On its own it is **fooled by a queue**:
  N calls served one after another also sum to > 1.5× the wall (call k waits for calls 1..k−1).
* `work_overlap = Σ(prompt_eval_duration + eval_duration) / total_ms` — the runner's own compute time per request (Ollama reports it; queue
  wait is not in it). ≈ 1 means the runner computed one request at a time; > 1.5 means requests were computed together.
  `slots_proven = overlap_proven && work_overlap > 1.5`. This is immune to a noisy solo baseline and to queue wait.
* `solo_ms` (best of `--solo-runs 2`), `speedup_vs_solo = N × solo_ms / total_ms` (throughput truth, `throughput_gain` > 1.5) and
  `stagger_ratio = (max wall − min wall) / ((N−1) × solo_ms)` (≈ 0 finished together, ≈ 1 one solo apart) are supporting evidence.

## What the mac run showed (Ollama 0.33.1, 2026-09-08)

* `qwen3.8:27b-mlx` runs on Ollama's **mlx runner**, which **ignores `OLLAMA_NUM_PARALLEL`**: across three 5-way runs the runner's compute
  time summed to ≈ the wall every time (`work_overlap` 0.97–0.98: e.g. Σ 4,752 ms of compute in a 4,899 ms wall, SLOT-1 spent 3.7 s of its
  4.9 s waiting) and finishes came one call apart — even though the server log shows `OLLAMA_NUM_PARALLEL:5`. The order's overlap
  metric alone read 2.6–4.4× ("proven") on all three runs: the queue artifact above. (`ollama ps` prints `context_length 8192`, the
  per-slot `num_ctx`, for both runners on 0.33.1, so it says nothing about slot count.)
* Control on the same server: `granite4.2:latest` (GGUF, **llama.cpp runner**) — the 5 calls were computed together (`work_overlap` 2.1–3.7,
  all finished within 40–84 ms of each other), so `OLLAMA_NUM_PARALLEL=5` does create real slots on this server for GGUF models; but with
  no throughput gain (`speedup 0.8×`, an 8.8B Q4 batching poorly on Metal). The mlx-backed swarm model does not get slots at all.
  For a real N-session swarm on the mac today: a GGUF build of the model on the llama.cpp runner, or N separate `ollama serve` processes
  on N ports (N × weights in memory — see the `fit.mjs` headroom), or spark2 (GGUF + llama.cpp on CUDA, where batching does pay).
