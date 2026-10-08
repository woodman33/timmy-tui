# Private evidence: where it is kept, and how to check it

The public records in this folder (`c17/`, `c18/`, `c19/`) hold summaries, the runs' own files and their hashes. The raw evidence behind them stays private, outside this public repository, because it can show local paths, host names and throwaway sandbox keys. This index is the durable link between the two: each archive is named by its location on the operator's Mac, its size and its SHA-256, so it can be found and verified without being published.

Location: `~/timmy/evidence/` on the operator's Mac. Folders are 0700, files 0600. Verify everything at once:

```sh
cd ~/timmy/evidence && shasum -a 256 -c SHA256SUMS
```

| Archive (under `~/timmy/evidence/`) | Bytes | SHA-256 | What it holds | Backs |
| --- | ---: | --- | --- | --- |
| `earlier/live01-c16-era-private.tar.gz` | 144,404 | `2a24fc346cad60f9f9f3822099ae109b0e27f54bbe7e26665b6a35e7bc1cf8bb` | LIVE-01 runs from the C-16 era: their screens, normalized screens and sandbox homes | `c16/live-01/` |
| `c17/c17-acceptance-8944e0f-private.tar.gz` | 4,614,354 | `1b59f708960b876da01d0dc72c6bc4617b48a1d37db0c64b4546ca8ba5d50988` | C-17's acceptance run: the full tree manifest, 36 captures, 197 PTY files, the install's logs, the doctor's and init's text, the packed tarball, a SHA-256 list of the 27,267 installed files | `c17/` (ledger row 102) |
| `c17/c17-build-audit-bd7ec9b-private.tar.gz` | 3,324,133 | `d69a7545d133b42e2c75291f77a94c7fab48b4473ccb288131b29bf0aade353d` | C-17's Linux build, the package audit's outputs (its masked matches and their context) and the audit tools | `c17/builds.json`, `c17/package-audit.*` |
| `c17/c17-mac-bd7ec9b-private.tar.gz` | 3,325,660 | `236d6642b6a33d9a3115ce89e159c1311ad06839f3b04dea09c4f31ca095a695` | C-17's Mac build, install, LIVE-01 run (raw panes, sandbox homes, receipts) and its scripts | `c17/live-01/`, `c17/builds.json` |
| `c18/c18-acceptance-5b82857-private.tar.gz` | 171,243 | `2fa536eb43ab609fc3ee6223bfae2f0af8881881f59e4f166f4620a511b5473e` | C-18's acceptance run as far as it got (it was ended when the workspace was reclaimed): the full tree manifest, the receipt store's preimage, the captures and PTY files it had written, its logs | `c18/` (rows 108) |
| `c18/c18-build-audit-8319f8f-private.tar.gz` | 3,434,013 | `3c236fbed7a33eb80126c635541f0df3bd176ec47af7c0ecf96e7624d3f0bd86` | C-18's Linux build and package audit, the downloaded GitHub artifacts, and the local development run that ran out of disk | `c18/builds.json`, `c18/package-audit.*`, `c18-development/` |
| `c18/c18-mac-8319f8f-private.tar.gz` | 4,421,055 | `d8c6bdda6f22f610a49cd514fed62329cb9711cf691eebecefcfb63f9fc6804c` | C-18's Mac build and its controls, the installed checks, LIVE-01 (raw panes, sandbox homes, receipts, saved session), the spend readings, a SHA-256 list of the 27,376 installed files | `c18/live-01/`, `c18/builds.json` |
| `c18/timmy-tui-2.0.0-rc.2.tgz` | 3,291,643 | `eae8efb1e75ea002d0ab19a8278099489e330fa7ec621327b3ae62befa5c0eb5` | The candidate tarball itself (the Mac's build; byte-identical to the Linux, runner and INSTALL-01 builds) | `c18/builds.json`, `c19/` |
| `c18/review-captures/` (37 files, its own `SHA256SUMS`, hash `be989431…`) | — | see its `SHA256SUMS` | Real screenshots of the installed candidate on the operator's Mac (REPL, monitor, canvas), their ANSI text, the scripts that took them, and the review sheet (`timmy-rc2-review-captures.pdf`) | ledger row 110 |
| `c19/c19-acceptance-078cc31-private.tar.gz` | 4,600,444 | `4a8841cabc7b31ee8b423918ef0fd4306bbd49f07fbdca9643e407f734550f57` | C-19's acceptance run: the full tree manifest, 36 captures, 79 raw PTY files and their screens, the install's logs, the doctor's and init's text, the packed tarball, a SHA-256 list of the 27,267 installed files | `c19/` (row 109) |

Left out of the acceptance archives, as at C-17: the clones and the install prefixes, which rebuild from the commit and the tarball, and the throwaway identity seeds. The copies first made in the session's scratch workspace are not durable; the Mac's copies are the retained ones, and each was compared by SHA-256 after the copy.
