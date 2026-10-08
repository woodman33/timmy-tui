# C-15: the frozen qualification record

Accepted by the operator on 2026-10-07 at 08:57 PT as the recorded bounded qualification: 61
executed checks passed, five deferred, two not run. It is not launch approval; every change after
it gets new checkpoints and new acceptance. These files are kept exactly as the run wrote them.

| File | What it is |
| --- | --- |
| `freeze.json` | The freeze, taken at 08:00:20 PT before the run: base commit, Node and tmux versions, the SHA-256 of the tree manifest, the runner (`scripts/ui/qualify.ts`), its fixture, the contrast gate and the lockfile, the receipt store's preimage size and hash, and all 68 checks with the deferred and not-run reasons |
| `results.json` | The run, 08:00:20 to 08:08:21 PT: every check's status and evidence, and every exit code seen |
| `controls.txt` | The 12 negative controls, each failing on input known to be wrong (DOCTRINE §12) |

The tree manifest itself (SHA-256 of each of the 2,097 files) is kept with the private evidence,
not here: one of the repository's file names reads like an email address to the privacy gate, and
the gate is not overridden. `freeze.json` holds the manifest's own hash. Compared against that
manifest at 09:03 PT, the commit that carries this folder differs from the frozen tree only in
`docs/ui-cockpit/CHECKPOINTS.md`, `docs/ui-cockpit/COMMAND-CENTER-PLAN.md` and this folder.

The raw evidence (PTY bytes, screens, the 36 captures) stays private, outside the repository: it
can show local paths. The report is the operator's doc "C-15 Qualification Report".
