# Privacy audit — woodman33/timmy-tui (ORDER privacy-d5n9)

Generated 2026-09-09. Two scanners over every open-order working tree and the
full git history of every branch: **gitleaks 8.30** (secrets) and the **Timmy
pattern set** (`lanes/privacy/patterns.json`: emails, phones, home paths, login
names, tailnet/LAN/MAC addresses, hostnames, policy text, card serials, brand
material). Match values are masked in this report; nothing here repeats a secret.

## Headline

- **No real secret is committed — in any tree or anywhere in history.** Every
  critical hit is a placeholder (`.env.example` = `sk-or-v1-your-key-here`), a
  test fixture (`tests/hermes.test.ts` = `sk-or-v1-abcdef…`; a history
  `test-openrouter-key-not-valid`), or vendored public documentation (Cloudflare
  and Svix example keys, one example `PRIVATE KEY` block in
  `cloudflare-wrangler-docs.md`). gitleaks independently found 14 history leaks —
  all the same doc-examples/fixtures. The real `.env`, `.dev.vars`, and
  `.timmy/keys/ed25519.pem` exist **only on disk** and are gitignored; they were
  never committed.
- **The real exposure is site + personal identity in committed files:** the DGX
  Spark network registry, home paths and the login name baked into harness/wire
  transcripts, the Mac hostname, the Cloudflare account subdomain, real custody
  serials + venue names, and the author email inherent to every commit.

## Counts

| where | files scanned | critical | high | medium | review |
|---|---|---|---|---|---|
| main working tree (branch order/warroom-v2-c4m8) | 3,492 | 16 (all benign) | 39,802 | 214 | 7,168 |
| history (242 commits, 2,604 distinct text blobs) | 467 files touched | 30 (all benign) | 5,821 | 508 | 706 |

High/review counts are inflated by the **same few facts repeated**: the home
path `/Users/<user>`, the login name, and `wmeldman33.workers.dev` recur
thousands of times across docs, transcripts and source. The distinct picture is
below.

## The real findings, by actionability

### A. Site network identity in committed files — the priority

| file(s) | carries | note |
|---|---|---|
| `fleet/nodes.json` | Spark tailnet IPs, LAN IPs, MACs, hostnames | **committed on order/swarm-b3k7 (PR #38)** — the highest-value leak; moved to the private overlay + template by this order |
| `lanes/abilities/results/*.json`, `lanes/abilities/transcripts/*.jsonl` | the Mac hostname, home paths, login name | harness probe output baked in verbatim |
| `lanes/wire/results.json`, `lanes/wire/bridges.json`, `lanes/wire/transcripts/*.jsonl` | home paths, login name (344 hits in results.json alone) | MCP wire captures |
| `companion/boards/observer.board.json` | card serials (`VC-serials…`) + "a venue name", "a location" | **real custody / customer-venue data** |
| `lanes/swarm/runs/*.json`, `orders.log`, `lanes/cf/pane.mjs`, `lanes/commander/cli.mjs`, ~40 `src/**` and `tests/**` | `wmeldman33.workers.dev` | the Cloudflare account subdomain (a live URL, but it embeds the account handle) |
| `lanes/engine-room/node.mjs`, `lanes/swarm/swarm.mjs`, `lanes/swarm/airgap.mjs` | Spark tailnet/LAN IPs as fallback literals | replace with placeholders + the overlay |
| promo `.cast` files (`studio/timmy-promo*/making-of-*.cast`) | home paths, login name in the recorded terminal | re-record or scrub |

### B. Personal identity

- **Home path** `/Users/<user>` and **login name** — pervasive in
  transcripts, docs, shell contrib, receipts. 332 tracked files.
- **the founder name** — docs and marketing copy (~27 per tree).
- **Author email** `wmeldman33@…(gmail)` — on all 278 commits. Inherent to the
  history; only a full rewrite (mailmap) changes it. See §4.
- **NTAG UIDs** in `vault-custody/test/*` and `demo.astro` — 7-byte `04…` values;
  these read as synthetic test vectors, flagged low.

### C. History-only (no longer in any tree)

2,077 findings live only in past commits — chiefly `.timmy/receipts/runs.jsonl`
(committed early, carrying the Mac hostname + worker subdomain, before `.timmy/`
was gitignored), `src/companion/client/index.html`, and `scratch_test_cf.ts`.
These do not affect a new push but remain in history until a rewrite (§4).

## §4 — history rewrite (proposed, NOT executed — Will's call)

To remove the personal/site data from past commits (email, home paths, login
name, the receipts blob, the Spark registry):

```
git filter-repo \
  --path .timmy/receipts/runs.jsonl --path .timmy/receipts/index.json \
  --path fleet/nodes.json --path scratch_test_cf.ts --invert-paths \
  --mailmap ../mailmap.txt \
  --replace-text ../replacements.txt
```

- `mailmap.txt`: `Timmy <timmy@localhost> <wmeldman33@…(gmail)>` rewrites the
  author identity on all 278 commits.
- `replacements.txt`: `regex:/Users/<user>==>/Users/<user>`, the login
  name, `wmeldman33.workers.dev==>timmy-edge.workers.dev`, the tailnet/LAN/MAC
  literals → placeholders.

**Impact:** it rewrites every commit hash, so all five open PRs (#33, #34, #36,
#37, #38) must be re-pushed from rebased branches, and any local clone must
re-clone. This is disruptive and irreversible; it is proposed only. The gate
below prevents *new* leaks regardless of whether the rewrite happens.

## The gate (§3)

Three layers, all built by this order; any match at medium or above blocks:

1. **pre-commit** — `.githooks/pre-commit` (enable once: `git config
   core.hooksPath .githooks`); scans the staged diff.
2. **CI** — `.github/workflows/privacy.yml`; scans the tree and the PR's commits,
   plus gitleaks; the §12 negative control runs first.
3. **seal tool** — `timmy seal` refuses a receipt whose subject/meta carries a
   secret, personal data, or an address (`--allow-privacy` overrides and is
   recorded on the receipt).

**§12 negative control:** `lanes/privacy/fixtures/must-fail.txt` MUST trip the
gate. `timmy privacy fixture` runs it first in CI; a clean pass there fails the
job, because a gate that cannot fail its own fixture is not a gate.

## Key rotation

No real key was found in git, so **no rotation is required for anything in the
repo**. The keys that exist on disk (`.env`, `workers/ai-proxy/.dev.vars`,
`.timmy/keys/ed25519.pem`) were never pushed; rotate them only if they were
exposed by some other channel.
