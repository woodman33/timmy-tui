# C-17 package audit: what the candidate tarball ships, and every finding in it

**Not zero findings.** The privacy scan keeps **105 findings** and sets aside **2 under the approved exemption**; gitleaks finds **1**; the strings pass over the binary files finds **0**. Every one has a disposition below, and **0 are unexplained**.

## Identity

| | |
|---|---|
| Tarball | `timmy-tui-2.0.0-rc.2.tgz`, 3288164 bytes, 1070 files |
| SHA-256 | `212704590691bf6cbb65aec0489a3327b99a0640351a0ab730a5cb4008d0a43a` |
| Source commit | `bd7ec9b5d058fd90181e84e9a8f0a5f30747d4a8` |
| Built | a clean clone at the commit: npm ci --include=dev, the build, the canvas check, npm pack --ignore-scripts, the release check. The Linux build (Node v24.21.0, npm 11.19.0) and the Mac build (Node v24.14.1, npm 11.11.0, macOS 26.6.2 arm64) of this commit are byte-identical. |
| Machine-readable | `package-audit.json` beside this file (no match text); the scanner's masked matches and their context are kept privately, outside the repository |

## Coverage

Every file of the tarball is read. Text files go to the privacy scanner (`lanes/privacy/scan.mjs`, its patterns at SHA-256 `34170a70eb38895e…`); the only path it skips is the throwaway repository folder the audit creates (`^\.git/`). Binary files (PNG images and WOFF2 fonts here) are read again through their printable strings. gitleaks 8.24.3 reads every file.

| Category | Files | Text, scanned | Binary, strings pass |
|---|---:|---:|---:|
| entrypoints | 1 | 1 | 0 |
| compiled code | 767 | 767 | 0 |
| canvas assets | 258 | 223 | 35 |
| license notices | 5 | 5 | 0 |
| other shipped files | 39 | 38 | 1 |

## The privacy scan: 105 kept

By severity: critical 5, high 24, medium 12, review 64.

By category: license notices 16, canvas assets 41, compiled code 48.

| Pattern | Kept |
|---|---:|
| `media.personal` | 62 |
| `pii.email` | 21 |
| `net.other_hosts` | 4 |
| `secret.env_assignment` | 2 |
| `net.hostname_spark` | 2 |
| `secret.openrouter_key` | 1 |
| `secret.dev_vars_content` | 1 |
| `secret.tailscale_key` | 1 |
| `pii.phone` | 1 |
| `pii.home_path` | 1 |
| `identity.fixture` | 1 |
| `net.tailnet_ip` | 1 |
| `net.tailnet_ip6` | 1 |
| `net.tailnet_name` | 1 |
| `net.lan_ip` | 1 |
| `net.mac` | 1 |
| `net.mac_nvidia_oui` | 1 |
| `brand.discovery_land` | 1 |
| `net.worker_subdomain` | 1 |

### Dispositions

A group shares one reason only where that reason holds for every member; each finding's own row is in `package-audit.json`.

| Disposition | Rule | Findings | Reason |
|---|---|---:|---|
| explained: upstream contact | `upstream-license-copy` | 1 | tldraw's license text (tldraw 5.5.2), the copy the canvas build places beside its bundle; byte-identical to the approved text, but the exemption covers only the approved path, so this copy stays a finding |
| explained: upstream contact | `upstream-contact` | 19 | a contact or copyright holder of the upstream package named in that finding's row (package, version and license), in its license text or compiled from its source |
| false positive | `font-family` | 44 | the word "family" naming a font family (CSS, a font face, a design token or an error message about font families), not a person |
| false positive | `tld-table` | 1 | the top-level domain .family in a compressed table of domain names that the canvas bundle's link detection carries |
| false positive | `model-family` | 3 | the model family field of the provider registry, not a person |
| false positive | `workflow-family` | 2 | a workflow family (a Rerun application ID) in a code comment, not a person |
| false positive | `surface-family` | 8 | a harness surface's family field, not a person |
| false positive | `placeholder-host` | 1 | a placeholder URL shown in an empty input (your-worker.workers.dev), not a deployment |
| by design | `privacy-fixture` | 18 | the privacy gate's must-fail fixture: made-up values planted so `timmy privacy fixture` can prove the gate trips. It ships on purpose (an operator decision on record, as in 2.0.0-rc.1) |
| by design; operator decision | `pattern-definitions` | 8 | the privacy gate's own pattern definitions, matching their own rules. They include the patterns for the operator's private host names, which therefore ship in the package (as in 2.0.0-rc.1): an operator decision on record |

Upstream packages behind the 20 address findings: @tldraw/editor 5.5.2 (SEE LICENSE IN LICENSE.md), @tldraw/utils 5.5.2 (MIT), idb 7.1.1 (ISC), orderedmap 2.1.1 (MIT), prosemirror-commands 1.7.2 (MIT), prosemirror-dropcursor 1.8.4 (MIT), prosemirror-gapcursor 1.4.1 (MIT), prosemirror-history 1.5.1 (MIT), prosemirror-keymap 1.2.3 (MIT), prosemirror-model 1.25.12 (MIT), prosemirror-schema-list 1.5.1 (MIT), prosemirror-state 1.4.4 (MIT), prosemirror-transform 1.12.2 (MIT), prosemirror-view 1.42.6 (MIT), react-remove-scroll-bar 2.3.8 (MIT), rope-sequence 1.3.4 (MIT), tldraw 5.5.2 (the tldraw license), w3c-keyname 2.2.8 (MIT). The must-fail fixture's made-up address is counted with the fixture.

## The approved exemption: 2 set aside

| Path | SHA-256 | Rule |
|---|---|---|
| `companion/studio-canvas/LICENSE-tldraw.md` | `9578fcddc20e404b6a29f44b6fea81d8b331698c0e7e9be34132d6f4394fa533` | `pii.email` only |
| `companion/studio-canvas/licenses/react-remove-scroll-bar.LICENSE` | `a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84` | `pii.email` only |

The exemption is exactly as configured in `lanes/privacy/patterns.json`: these two paths, these bytes, this one rule. The byte-identical copy of tldraw's license that the canvas build places at `companion/studio-canvas/dist/LICENSE-tldraw.md` is not exempt, so it stays a finding (rule `upstream-license-copy` above).

## gitleaks: 1

- `dist/lanes/privacy/fixtures/must-fail.txt` line 2, `generic-api-key`: by design (the privacy gate's must-fail fixture: a made-up secret-shaped value, planted on purpose).

## Strings pass over the binary files: 0 findings in 36 files

## Controls

Each on a fresh copy of the unpacked package; a negative control must be caught, a positive one must pass.

- an approved license text with one byte added keeps its pii.email finding (negative): caught as it should be.
- the approved text at another path keeps its finding (negative): caught as it should be.
- an address planted in the compiled code is found (negative): caught as it should be.
- a token planted in the compiled code is found by gitleaks (negative): caught as it should be.
- an address planted in a binary file is found by the strings pass (negative): caught as it should be.
- the package as packed exempts exactly the two approved texts, by path, SHA-256 and rule (positive): passes as it should.

## Operator decisions this audit carries

- The privacy gate's must-fail fixture ships in the package (18 privacy findings and the 1 gitleaks finding, all made-up values), so `timmy privacy fixture` can prove the gate trips. As in 2.0.0-rc.1.
- `dist/lanes/privacy/patterns.json` ships the gate's pattern definitions, including the patterns for the operator's private host names (8 self-matches). As in 2.0.0-rc.1.
- Commercial tldraw distribution coverage remains a publication gate; this audit records licenses, it does not establish an entitlement.
