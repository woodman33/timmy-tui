# C-16: the final acceptance record

The final acceptance of a new revision, frozen and run once (AGENTS.md §5), as the fourth order asks: "Preserve C-15 as the historical baseline. Freeze a new revision for final acceptance and report evidence for that revision." C-15 stays as it was, in `../c15/`. It is not launch approval: merge, publish, tags and deploys wait for the operator.

Frozen at 16:25:13 PT on 2026-10-07 at `11d8e62`, with 2,132 files, Node 22.22.0 and tmux 3.4. Run once, 16:25:21 to 16:34:18 PT, with the machine to itself and no repair or rerun. The 20 negative controls failed as they should and the 3 positive controls passed. Of the 70 checks, **64 passed, 0 failed, 5 were deferred and 1 was not run**:

- **Deferred**, each for C-15's reason: CLI-18 (no step reports a known total), CLI-29 (`-v`, the operator's decision), TUI-01 and TUI-03 (displays that were not built), and COPY-02 (the monitor's older copy).
- **Not run:** REPLAY-02, blocked as recorded in `replay-02/BLOCKED.json`.

Exit codes seen: 0, 78, 130 and 143 only. The shared receipt store and the tree's manifest, compared last, were both unchanged. These files are kept exactly as the run wrote them. The commit that carries them differs from the frozen tree only under `docs/ui-cockpit/`.

| File | What it is |
| --- | --- |
| `freeze.json` | The freeze, taken before the run: the commit, Node and tmux versions, the SHA-256 of the tree manifest, the runner (`scripts/ui/qualify.ts`), its fixture, the contrast gate and the lockfile, the receipt store's preimage size and hash, and all 70 checks with the deferred reasons |
| `results.json` | The run: every check's status and evidence, and every exit code seen |
| `controls.txt` | The 20 negative controls, each failing on input known to be wrong (DOCTRINE §12), and 3 positive controls, so a gate that refused everything would show |
| `live-01/` | LIVE-01 on the operator's Mac at `79529e5`: the record (`live-01.json`), the screens, the receipts' fields |
| `replay-02/BLOCKED.json` | REPLAY-02's recorded blocker: no isolated sandbox could be created from this session |

What C-16 checks beyond C-15:

- BIN-01: the installed command's bin in a real PTY. Bare `timmy` opens the REPL, and a SIGTERM to `timmy` reaches the REPL it started.
- CANVAS-01: Timmy Canvas in a real Chromium at desktop, tablet and phone sizes, with none of its checks skipped.
- LIVE-01: the record of a real model run on the operator's Mac, bound to the commit it ran at. The frozen tree may differ from that commit only under `docs/ui-cockpit/`.
- REPLAY-02: the same frozen run repeated in an isolated Vercel sandbox, bound the same way, or a recorded blocker. A blocker reports the check as not run, never as a pass.
- SUITE-01 also takes every studio suite, the bin's suites and the runtime package test.
- PROC-01 names the branch's files from where it left `origin/main`. At C-15 it named the uncommitted files, and on a clean commit it would have checked none.
- REPLAY-01 also works on a clean commit.

The tree manifest itself (the SHA-256 of each file) is kept with the private evidence, not here, as at C-15. `freeze.json` holds the manifest's own hash. The raw evidence (PTY bytes, screens, the 36 captures) stays private, outside the repository: it can show local paths.
