# C-17: development rehearsals of REPLAY-02 (development evidence only)

These six runs rehearsed REPLAY-02 on a GitHub-hosted runner before C-17 was frozen. They are
**development evidence, never C-17's**. A rehearsal replays a development commit and cannot become C-17
evidence by being relabeled. The first ran the frozen sequence on a development commit; the other five
ran in development mode (`mode development` in the request), where every check runs and the record says
`dev`. Failed runs are kept as their runs kept them.

Each folder holds the run's artifact, unpacked and unchanged: `results.json`, `freeze.json`,
`controls.txt`, `replay.json`, `replay.log`, `setup.log`, and from the third run on, the run's own logs
under `q/evidence/`. `SHA256SUMS` lists every file's hash.

| # | Run, attempt | Workflow revision (request commit) | Replayed commit | Mode | Runner image | Toolchain | Artifact: name, id, digest | Terminal result | Ledger |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 37726398467, 1 | `eb9c5e5` | `a9235a8bdf0ad99eef2b00f97d5943bdbcd0f776` | frozen sequence on a development commit (before the mode existed) | ubuntu24 20260927.320.1 | Node v24.21.0, tmux 3.7c (Homebrew), Chromium started | `replay-02-37726398467-1`, 11528106951, `sha256:d28a8491929f7a41574996ebfe427da51c0d6f2a83517ecc86e546ededad9a14` | exit 1, stopped at CLI-35: 34 passed, 1 failed (CLI-35), 4 deferred, 32 not run | 93 |
| 2 | 37729375560, 1 | `ab8517a` | `70acf49f736efc561bfa15749d9443c4d058e063` | development | ubuntu24 20261004.327.1 | same | `replay-02-37729375560-1`, 11529417891, `sha256:dc3e37f84e9bbaa5a8578be8528629fb8e345bd526224c2f3b46cfb17b12d485` | exit 1: 64 passed, 1 failed (SUITE-01, the test not named in this record), 4 deferred, 2 not run | 95 |
| 3 | 37730418421, 1 | `84d5929` | `86c7d33d78f5f7abdeb323d42110b0b4a365e7b9` | development | ubuntu24 20261004.327.1 | same | `replay-02-37730418421-1`, 11529464834, `sha256:37b9f504f09b87b29d1e6eb97351e966267e69d8f843b9cbfa8b4210c80d23e8` | exit 1: 64 passed, 1 failed (SUITE-01: `tests/studio-composition.test.ts`, the font antialiasing of the runner), 4 deferred, 2 not run | 96 |
| 4 | 37731909816, 1 | `5b57d56` | `874a4d397d2dc0941e78dc93aa0f6954e4c5fefc` | development | ubuntu24 20260927.320.1 | same | `replay-02-37731909816-1`, 11530566513, `sha256:83c2d979a4df45a338d4ffcdf6b31c2e8e4c376f48b7542fd9bea53c065eae21` | exit 0: 65 passed, 0 failed, 4 deferred, 2 not run | 97 |
| 5 | 37737840468, 1 | `09ad45c` | `d2ef0a51b08a7e3dd0dfa527835b9e35cffe0fb2` | development | ubuntu24 20260927.320.1 | same | `replay-02-37737840468-1`, 11532728245, `sha256:251a9f889149ea149b2098cbb21a2284302501028e9a690927682679ffb9761f` | exit 0: 65 passed, 0 failed, 4 deferred, 2 not run (the doctor's fix; before the review's) | 99 |
| 6 | 37739446456, 1 | `7b38f16` | `bd7ec9b5d058fd90181e84e9a8f0a5f30747d4a8` | development | ubuntu24 20260927.320.1 | same | `replay-02-37739446456-1`, 11533717083, `sha256:e781cc7ddda740f5b1b9910801e9825bafc422a5e0ea37298029a403e4d9e2fe` | exit 0: 65 passed, 0 failed, 4 deferred, 2 not run; SUITE-01 with the continuation's suites, 71 files; INSTALL-01 packed `21270459…` | 100 |

In every run, the 4 deferred checks are CLI-18, TUI-01, TUI-03 and COPY-02. The checks not run there
are REPLAY-02 and LIVE-01, which never run on the runner. Run 1 also left unrun every check after the
check where it stopped. The Toolchain cell for runs 2 to 6 says "same": Node v24.21.0, tmux 3.7c from
Homebrew, and Chromium started.
