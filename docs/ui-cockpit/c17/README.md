# C-17: the release candidate's acceptance record

The final acceptance of the v2 release candidate, `timmy-tui` `2.0.0-rc.2`, frozen and run once (AGENTS.md §5) for the operator's 20:14 order and its 22:23 and 22:30 continuations. It is not launch approval: merge, publish, tags and deploys wait for the operator. C-15 and C-16 stay as they were, in `../c15/` and `../c16/`; the development rehearsals that came before the freeze are in `../c17-development/` and are not part of this record.

Frozen at 00:19:32 PT on 2026-10-08 at `8944e0f`, with 2,236 files, Node 24.21.0 and tmux 3.4. `8944e0f` differs from the candidate's code, `bd7ec9b`, only under `docs/ui-cockpit/`. Run once, 00:19:36 to 00:31:08 PT, with the machine to itself and no repair or rerun. The 35 negative controls failed as they should and the 9 positive controls passed. Of the 71 checks, **67 passed, 0 failed, 4 were deferred and 0 were not run**:

- **Deferred**, each for the reason its freeze gives: CLI-18 (no step reports a known total), TUI-01 and TUI-03 (displays that were not built) and COPY-02 (the monitor's older copy).
- **REPLAY-02** read the frozen run of `bd7ec9b` on a GitHub-hosted runner (`replay-02/`, run 37741148748): 65 passed, 0 failed, 4 deferred, and the two checks that never run there not run.
- **LIVE-01** read the record of real model turns on the operator's Mac, through the installed package (`live-01/`).

Exit codes seen: 0, 78, 130 and 143 only. The shared receipt store and the tree's manifest, compared last, were both unchanged. The run's three files are kept exactly as it wrote them, and `controls.txt` is byte for byte the frozen replay's. The commit that carries them differs from the frozen tree only under `docs/ui-cockpit/`.

The candidate: source `bd7ec9b5d058fd90181e84e9a8f0a5f30747d4a8`; package `timmy-tui-2.0.0-rc.2.tgz`, 1,070 files, SHA-256 `212704590691bf6cbb65aec0489a3327b99a0640351a0ab730a5cb4008d0a43a`. The Linux build, the Mac's build and the runner's are byte-identical (`builds.json`), and INSTALL-01 packed the same tarball from a clean clone of the frozen tree.

| File | What it is |
| --- | --- |
| `freeze.json` | The freeze, taken before the run: the commit, Node and tmux versions, the SHA-256 of the tree manifest, the runner (`scripts/ui/qualify.ts`), its fixture, the contrast gate and the lockfile, the receipt store's preimage size and hash, the monitor's home, and all 71 checks with the deferred reasons |
| `results.json` | The run: every check's status and evidence, and every exit code seen |
| `controls.txt` | The 35 negative controls, each failing on input known to be wrong (DOCTRINE §12), and 9 positive controls, so a gate that refused everything would show |
| `REQUEST` | The request that started the frozen REPLAY-02: the commit and `mode frozen` |
| `replay-02/` | REPLAY-02's evidence, the workflow's artifact kept unchanged, with `IDENTITY.json` (the run, the workflow revision, the replayed commit, the runner image, the toolchain) and `SHA256SUMS` |
| `live-01/` | LIVE-01 on the operator's Mac at `bd7ec9b`, through the installed tarball: the record (`live-01.json`), the screens, the receipts' fields |
| `builds.json` | The tarball built on Linux, on the Mac and on the runner, with each toolchain and each SHA-256 |
| `package-audit.md`, `package-audit.json` | The package audit bound to the tarball's SHA-256 and the source commit: every file read, 105 findings kept and each disposed of, 2 set aside by the approved exemption, the controls |
| `SHA256SUMS` | The SHA-256 of every other file in this folder: `sha256sum -c SHA256SUMS` from here |

What C-17 checks beyond C-16:

- INSTALL-01: the frozen tree packed as the release job packs it, validated, installed by npm into an empty prefix and used as an installed user meets it: `-v`, the next steps `timmy init` and the doctor name, the doctor's documented exit (78, no model key), bare `timmy` at an empty first-run prompt, a SIGTERM mid-turn, and the canvas page.
- REPLAY-02 may run on a GitHub-hosted runner under the cockpit exception in AGENTS.md §10, and its record must prove where it ran: the runner, its image, the run and the replayed commit. It ran this time; at C-16 it was blocked.
- BIN-01 also opens the installed command at an empty first-run prompt, where `/exit` exits 0.
- CLI-29 runs instead of being deferred: `-v`, `--version`, `version` and `repl -v` print the version line and nothing else.

Known after the run. LIVE-01 recorded two defects, and the operator's 00:28 order names them as release issues: the environment's model key was written into the settings file of the fresh home it ran in (behavior older than this branch), and the turn after a cancel also finished the cancelled request. This record stays as it is. The fixes go to a new candidate under its own freeze, C-18, in `../c18/`.

The tree manifest itself (the SHA-256 of each file) is kept with the private evidence, not here; `freeze.json` holds the manifest's own hash. The raw evidence (PTY bytes, screens, the 36 captures, the install's logs, the packed tarball) stays private, outside the repository, because it can show local paths. Its archive and SHA-256 are in the ledger, row 102.
