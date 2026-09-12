# Acceptance script — integration/train-20260909 (preview-h9s3)

10 minutes at Will's terminal width (160 cols; every line below ≤160). Preflight once:

```
cd ~/Desktop/Code-Projects/timmy-tui && git checkout integration/train-20260909 && node scripts/build-cli.mjs
export TIMMY_COMMANDER_WS="$(node -e "import('./lanes/privacy/overlay.mjs').then(m=>process.stdout.write(m.readPrivateJson('config.json').data.commander_ws))")"
# token needs no export: edgeToken() reads the overlay edge_token first; export TIMMY_EDGE_TOKEN=… only to override
node boot.cjs
```

1. BOOT → HOME (0 keystrokes to the journey). See: header `TIMMY 1 HOME …` + 7 journey rows with proof hashes; first paint <1s.
   Defect: blank >1s; `assembling…` stuck >5s; any journey row without a hash/fact. (Budget: 0 keys here; ↓×6 max to walk rows.)
2. `[S]` status (1 key). See: overlay mission board + `PRIVACY GATE … state ARMED · patterns ba347abf4425`. Defect: overlay won't open; state MISSING.
3. RUN (1 key: `2`). See: sealed runs list incl. today's demo/run receipts. Defect: empty pane despite seals.
4. CHAT commander turn (4 keys + typing: `5`, Enter, type, Enter). See: flash `chat → commander …`, then `answer · commander …` row +
   `chat.turn · commander` seal; COMMAND later shows ws●. Defect: ws○ / `local sovereign` flash (WS export missing); no answer in 60s.
5. COMMAND SWARM launch (≈15 keys: `6`, `w`, `]`×11 → tournament-4, `U`×1 → $0.50, `l`). See: preset row `tournament-4`, members 4× openrouter
   (gemini-3.7-flash/grok-4.6), budget `$0.50`; flash `swarm tournament-4 launched · governor armed · panes materialized`; `sw:*` tmux panes appear.
   Defect: launch flash says failed; no panes; spend exceeds $0.50 without a governor KILLED row. Spends up to $0.50 of your OpenRouter credit — your call.
6. CHAIN cross-link (5 keys: `3`, `/`, type `swarm.run`, Esc, `o`). See: filtered run row; after `o`: header `⊗ swarm_… · [o] unlink · N` with member+airgap
   rows; DETAIL shows typed lines (`run …`, `member … ph …`, `⊘ airgap … egress …`). Defect: no typed lines; `o` no-ops; any `…` in a cell.
7. LIBRARY (1 key: `4`). See: MODELS rows with `node-… FIT/NOFIT/edge` tail; right rail `◇ SKILLS` tree (proj folders + skills).
   Defect: tail or SKILLS card missing.
8. Demo playback (0 keys in TUI: exit, then `asciinema play .timmy/demo/demo.cast`). See: 6-frame placeholder session
   (node-a/proj-a/closed-3 — no real hosts/names). Defect: any real hostname/path/name in playback.

Total ≈ 28 keystrokes + typing; ≈10 min including the swarm run. Known non-defects: `font-family` privacy-review hits (false positives),
the creator-attribution stamps (deliberate), and the untracked `mcp-protocol-fallback.test.ts` WIP (Claude Code owns it).
