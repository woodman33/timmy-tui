# Cockpit lane — ORDER factory-f1d0 · C2 PANES

`timmy cockpit up` starts one tmux session, **timmy**, with one pane per non-external hand:
the pane is `cd`'d to the hand's worktree, its output is piped by `tmux pipe-pane` to
`.timmy/private/cockpit/<hand>/<date>.log` *before* the hand's CLI is launched (claude, codex,
qwen-code → `qwen` when that is the installed binary), then the CLI starts. `timmy cockpit attach`
attaches; `status` lists panes and logs; `down` kills the session and keeps the logs.

The hands registry is operator-private (`.timmy/private/cockpit/hands.json`; worktree paths are
site-specific). `hands.example.json` is the committed template with placeholders; `up` refuses to
launch a placeholder. `timmy cockpit hands --discover --write` seeds the registry from
`git worktree list` (order/* branches) and the ledger's `HANDS:` lines, marking what it cannot
assign as `unassigned:<order>` for you to name. External hands (PR bots, hosted agents) get no pane.
