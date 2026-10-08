# C-18: development rehearsals of REPLAY-02 (development evidence only)

These runs rehearsed REPLAY-02 on a GitHub-hosted runner before C-18 was frozen. They are **development
evidence, never C-18's**: a rehearsal replays a development commit in development mode (`mode development`
in the request), where every check runs and the record says `dev`, and it cannot become C-18 evidence by
being relabeled. C-17's rehearsals stay in `../c17-development/`.

Each folder holds the run's artifact, unpacked and unchanged: `results.json`, `freeze.json`,
`controls.txt`, `replay.json`, `replay.log`, `setup.log` and the run's own logs under `q/evidence/`.
`SHA256SUMS` lists every file's hash.

| # | Run, attempt | Workflow revision (request commit) | Replayed commit | Mode | Runner image | Toolchain | Artifact: name, id, digest | Terminal result | Ledger |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 37749297160, 1 | `2daad38` | `8319f8fce293df1b706bcb802c739f77093fe92a` | development | ubuntu24 20260927.320.1 | Node v24.21.0, tmux 3.7c (Homebrew), Chromium started | `replay-02-37749297160-1`, 11538315195, `sha256:8aabc9f58966a1cb6ffadb3477ac63e0cc3b6b47201550605486ccbc423a185f` | exit 0: 65 passed, 0 failed, 4 deferred, 2 not run; 37 negative and 9 positive controls behaved; SUITE-01 73 files and 533 tests passed; INSTALL-01 packed `eae8efb1…` | 106 |

The 4 deferred checks are CLI-18, TUI-01, TUI-03 and COPY-02. The checks not run there are REPLAY-02 and
LIVE-01, which never run on the runner.
