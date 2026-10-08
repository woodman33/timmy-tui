# C-19: the corrected candidate's acceptance record

The acceptance of the corrected release candidate, `timmy-tui` `2.0.0-rc.2` at `8319f8f`, frozen and run once (AGENTS.md §5) for the operator's 00:28 order. It is not launch approval: merge, publish, tags and deploys wait for the operator.

C-19 is a new prospective freeze of the same candidate code as C-18. C-18's one acceptance run was ended by a restart of the workspace it ran in, not by a check: 56 of 71 checks were recorded (53 passed, 0 failed, 3 deferred), and 15 never ran. That record stays as it was left, marked incomplete, in `../c18/`. C-19 was declared in the ledger (row 109) before it was taken, to run once with its result standing whatever it was. C-17 stays as it was, in `../c17/`.

Frozen at 11:47:51 PT on 2026-10-08 (`freeze.json`'s `frozenAt`; the freeze command began at 11:47:49) at `078cc31`, with 2,289 files, Node 24.21.0 and tmux 3.4. `078cc31` differs from the candidate's code, `8319f8f`, only under `docs/ui-cockpit/`. Run once, 11:47:52 to 12:03:15 PT (`results.json`), with the machine to itself, no prompt, no repair and no rerun. The 37 negative controls failed as they should and the 9 positive controls passed; `controls.txt` is byte for byte the frozen replay's. Of the 71 checks, **67 passed, 0 failed, 4 were deferred and 0 were not run**:

- **Deferred**, each for the reason its freeze gives: CLI-18 (no step reports a known total), TUI-01 and TUI-03 (displays that were not built) and COPY-02 (the monitor's older copy).
- **REPLAY-02** read C-18's frozen run of `8319f8f` on a GitHub-hosted runner (`../c18/replay-02/`, run 37751016296): 65 passed, 0 failed, 4 deferred, and the two checks that never run there not run.
- **LIVE-01** read the record of real model turns on the operator's Mac through the installed tarball (`../c18/live-01/`). The turn after a cancel did not finish the cancelled request, and an explicit request to continue finished it from what had finished, without redoing the finished call.
- **INSTALL-01** packed `timmy-tui-2.0.0-rc.2.tgz` from a clean clone of the frozen tree: 1,070 files, SHA-256 `eae8efb1e75ea002d0ab19a8278099489e330fa7ec621327b3ae62befa5c0eb5`, the candidate's tarball.
- **SUITE-01**: 73 files and 533 tests passed (1 file and 2 tests skipped), the two new suites among them; **SUITE-02**: tsc 0, tsgo 0, the privacy gate 0 gated; **CANVAS-01**: 7 passed in a real Chromium.

Exit codes seen: 0, 78, 130 and 143 only. The shared receipt store (10,358 bytes) and the tree's manifest (`db5d72f9…`), compared last, were both unchanged. The run's three files are kept exactly as it wrote them. The commit that carries them differs from the frozen tree only under `docs/ui-cockpit/`.

The candidate: source `8319f8fce293df1b706bcb802c739f77093fe92a`; package `timmy-tui-2.0.0-rc.2.tgz`, 1,070 files, 3,291,643 bytes, SHA-256 `eae8efb1e75ea002d0ab19a8278099489e330fa7ec621327b3ae62befa5c0eb5`. The Linux build, the Mac's build, the runner's build and INSTALL-01's pack are byte-identical (`../c18/builds.json`). The package audit bound to this tarball is `../c18/package-audit.md`. The version stays `2.0.0-rc.2`, so the SHA-256 is what tells this tarball from C-17's (`21270459…`); neither is published.

| File | What it is |
| --- | --- |
| `freeze.json` | The freeze, taken before the run: the commit, Node and tmux versions, the SHA-256 of the tree manifest, the runner (`scripts/ui/qualify.ts`), its fixture, the contrast gate and the lockfile, the receipt store's preimage size and hash, the monitor's home, and all 71 checks with the deferred reasons |
| `results.json` | The run: every check's status and evidence, and every exit code seen |
| `controls.txt` | The 37 negative controls, each failing on input known to be wrong (DOCTRINE §12), and 9 positive controls, so a gate that refused everything would show |
| `SHA256SUMS` | The SHA-256 of every other file in this folder: `sha256sum -c SHA256SUMS` from here |

The external evidence C-19 read is in `../c18/` (`REQUEST`, `replay-02/`, `live-01/`, `builds.json`, `package-audit.*`), each bound to `8319f8f`.

The raw evidence stays private, outside the repository, because it can show local paths: the tree manifest itself, the 36 captures, 79 raw PTY files with their screens, the install's logs, the doctor's and init's text, the packed tarball and a SHA-256 list of the 27,267 installed files. It is archived on the operator's Mac as `~/timmy/evidence/c19/c19-acceptance-078cc31-private.tar.gz` (4,600,444 bytes, SHA-256 `4a8841cabc7b31ee8b423918ef0fd4306bbd49f07fbdca9643e407f734550f57`). The clones and the install prefix, rebuilt from the commit and the tarball, and the throwaway identity seeds are left out.
