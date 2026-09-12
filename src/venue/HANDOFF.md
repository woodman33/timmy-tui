# HANDOFF — current Timmy repo → the marketplace

> v0.1, 2026-08-22. The master passover document. Read order for the
> implementing agent: **THREATS.md → ADVICE.md → this file**. THREATS.md
> holds the 24 threats and 6 rulings (acceptance criteria, not suggestions).
> ADVICE.md holds sequencing strategy. This file holds the physical model,
> the complete build path, and everything the first two passes left implicit.
> DEMO-2026-08-22.md is the launch-night runbook and the source of the
> listing schema draft.

---

## 1. The physical model — what crosses the wire (CANON)

The venue sells **execution, not files**. Be precise about what that means
at the byte level, because every design decision descends from it.

**The workflow is files** — blueprint YAML, fragment JSON, raw prompt text,
tool wiring, param defaults, glue scripts. Whoever holds those files runs the
job forever for free and can resell it. In the venue model **those files never
leave the seller's disk.**

What physically crosses the wire is a remote procedure call, not a download:

- **Buyer → seller:** a JSON-RPC `tools/call` message (tool name + arguments
  that validate against the published params schema), relayed through the
  venue switchboard, through the tier filter.
- **Seller → buyer:** exactly three kinds of payload —
  1. **Result bytes.** The finished artifact (image/video/dataset). The
     output, never the machinery.
  2. **Receipts** — signed JSON evidence. The existing schema in
     `src/utils/receipts.ts` already does the trick that matters: it carries
     `prompt_hash`, `response_hash`, `plan_hash`, cost, timestamps, model
     ids, ed25519 signature — **hashes, not content**. A hash proves "a
     specific prompt ran, here is its fingerprint" without revealing a word
     of it. The buyer verifies the run happened, when, at what cost,
     producing exactly these output bytes — and learns nothing about how.
  3. **Sanitized logs** — `status` + `error_class` taxonomy only ("step 3
     failed: schema"). Never stack traces or verbose output; raw logs leak
     prompts and paths (T-12). Raw errors stay on the seller's chain for
     disputes.

**What the buyer sees up front is the interface, not the implementation:**
the params schema — `{"name":"color_palette","type":"COMBO","options":[…]}`.
Names, types, ranges of the knobs (the Houdini slider panel). Hidden: which
prompt each knob interpolates into, which nodes it feeds, how it was tuned
(the node graph).

**After a settled trade the buyer's disk contains:** the result file,
receipt JSONs (hashes + signatures), the params schema, the countersigned
escrow transitions. **Never:** a blueprint, a fragment, a prompt.

Mental model: calling OpenAI's API. You send inputs, get completions and a
usage log, never see weights or serving code — yet you trust the output and
can audit the bill. The venue turns every seller's workflow into a private
API like that, with the receipt chain as a cryptographically signed usage
log.

Sharpening for reviewers who ask "so, JSON not code?": the buyer gets JSON,
but only JSON that is **evidence** (hashes, signatures) or **interface**
(param names/types). Any JSON describing workflow internals — the blueprint
is JSON/YAML too — is exactly what must never cross the wire.

---

## 2. Where the repo is today (verified inventory)

| Primitive | File | State |
|---|---|---|
| Escrow state machine | `src/utils/escrow-engine.ts` | Working; CUE-vetted transitions; **single-party** (writes `.timmy/escrow/` under cwd — T-03) |
| Receipt chain | `src/utils/receipts.ts` | Working; hash-chained, ed25519-signed, env-locked, release epochs; **one chain per machine** |
| Identity | `src/utils/signing.ts` | Working; per-instance ed25519; **self-issued, no registration** (T-01) |
| Work attestation | `src/utils/agent-pass.ts` | Working Merkle pass; **verifies against the prover's own chain** (T-08) |
| cmcp bridge | `src/mcp/cmcp-bridge.ts` | Working `createClientExecServer/Client` over stdio; no bindPuppet, no auth |
| MCP server | `src/mcp/server.ts` | ~675 lines incl. `timmy_mission_compile`; exposes far more than any listing should (T-10) |
| Companion server | `src/companion/server.ts` | express+ws, **no auth, self-loads API key from .env** — never faces the internet (T-17) |
| Cloudflare worker | `src/companion/cloudflare-worker.ts` | Deployed surface; `Env` already stubs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price ids, Clerk keys; Durable Objects available |
| Redaction | `src/utils/redact.ts` | Exists; not yet on the cross-domain path |
| Local template catalog | `src/utils/templates.ts` | The copyable-artifact model — tonight's $3 demo product; the venue's predecessor, not its future |
| TUI evidence views | `src/tui/components/EscrowReceiptsView.tsx`, `src/utils/eventbus.ts` | Render escrow + chains; model for venue panels |

**Not built yet:** switchboard, tier filter, venue-custody escrow, session
tokens, listing registry, countersigning, judge runner, package export.

---

## 3. Build path — M1 → M5, with acceptance criteria

Launch shape per ADVICE.md §1: **single-sided** — the owner is the only
seller in v1. This removes T-01/T-06/T-08/T-21 from the launch gate.

### M0 (prelude, demo-driven): `timmy package export`
Bundle blueprint + params schema + receipt excerpt + result hashes into a
signed tarball matching the manifest in DEMO-2026-08-22.md §"package
manifest". This is the copyable-product line ($3 demo) AND the listing
schema draft. Small, ships independently.
- ✅ Export round-trips: a foreign harness can load and run the package.
- ✅ Manifest validates against a CUE schema (`schemas/package.cue`, new).

### M1 — Switchboard + venue-custody escrow
- Relocate escrow writes behind the venue domain: worker Durable Object is
  the **only writer** (rulings 1; T-03/T-05). The engine's transition logic
  moves largely intact; DO gives single-writer serialization for free.
- Session tokens: venue-signed capabilities `{escrow_id, party, expiry,
  nonce}`, minted at `locked`, single-use per connection, dead at terminal
  state (T-17/T-18).
- Binding lifecycle = escrow lifecycle: the cmcp binding is created at
  `locked`, torn down at `settled`/`slashed`/cancel. The venue's cut is
  topological — no binding without a locked escrow.
- Countersigned transitions delivered to both parties' chains (T-04).
- ✅ Adversarial test per threat: T-03 (party rewrites local snapshot →
  ignored), T-05 (parallel draws never exceed ceiling), T-18 (replayed
  session token rejected).

### M2 — Tier filter (LAUNCH BLOCKER, ruling 2)
A venue-side proxy on the `tools/call` path:
- Default-deny per-escrow **tool allowlist** (method scoping is not tool
  scoping — T-10).
- Argument validation against the listing's params schema (CUE) (T-13).
- Preview degradation stage: watermark / downsample / truncate / hash-only
  for preview tiers; full-fidelity bytes only via the settlement delivery
  path (T-11).
- Error reduction to `error_class` + receipt hash (T-12), via
  `src/utils/redact.ts` finally placed on the cross-domain path.
- Per-call draw metering against the ceiling; binding dies at
  drawn = ceiling (T-14).
- ✅ Adversarial tests: unlisted tool call → denied + receipted; oversized
  args → denied; preview response bytes ≠ full artifact bytes.

### M3 — Listings + discovery (minimal)
- Listing = signed JSON record: package manifest fields + tier table
  (which tools per tier, prices, judge spec, TTLs, delivery deadline).
- Registry = a signed index the worker serves. No search, no ratings
  (ADVICE.md §3) — settled-count + receipt links IS reputation.
- Buyer UX ruling: **each listing is exposed as an MCP endpoint** the buyer
  agent simply adds. Buying = the venue minting a session token that makes
  that endpoint answer. No SDK to install; every MCP-speaking harness is
  already a customer.
- ✅ A foreign harness can list, inspect params schema, and call a preview
  tool with zero Timmy-specific code.

### M4 — Judge runner (deterministic class only, ruling 3)
- Venue-executed checks: CUE/schema vet, hash match, dimensions/duration,
  test-suite pass. Judge scores the artifact by the same hash appearing in
  the AgentPass leaves AND the delivery receipt (T-07).
- Chain anchoring: at `locked` the venue records the seller's chain head;
  pass leaves must descend from it (T-08). One settlement per merkle_root
  ever (T-09).
- Lock TTL auto-cancel (T-20), delivery deadline (T-21).
- ✅ Fake-money end-to-end trade (ADVICE.md §4.3): lock → filtered calls →
  judge → settle → countersigned receipts on all three chains, owner as
  both parties, before ANY Stripe code.

### M5 — Money + identity
- Stripe Connect, venue as platform: auth at `locked`, capture at
  `settled`, cancel at `slashed`; webhook is the only event flipping the
  paid bit (T-15). Application-fee flow so the venue never holds funds
  (T-24 — legal read is a blocker before the first real dollar).
- Identity = Connect onboarding countersigned by the venue (T-01);
  key rotation + revocation list (T-02).
- Dispute bonds (T-22) and the human dispute window arrive here, not
  earlier.
- ✅ Venue publishes its chain head on a schedule via the release-epoch
  mechanism in `receipts.ts` (T-23).

---

## 4. Gaps closed on this pass (previously implicit)

1. **Buyer distribution = MCP endpoints** (M3 above). This was unstated and
   it is the growth mechanic: zero-integration purchase for any MCP client.
2. **Draw metering** was in no milestone; it is now M2 (T-14 needs it).
3. **Package/listing versioning:** a listing update is a new signed manifest
   whose receipt links the prior version — upgrade history is itself a
   receipt chain. Buyers pin a version; sellers can't silently swap the
   workflow behind a paid listing.
4. **Refund path:** cancel refunds ceiling − drawn (already in the engine);
   M1 must expose it through the switchboard as a buyer-callable action
   before TTL expiry.
5. **Test strategy:** every T-nn gets a named adversarial test; the demo
   run's receipts become fixtures. CI gate: the threat table in THREATS.md
   §5 maps to a test file listing — a threat without a test is an open item.
6. **Metrics from day one:** GMV, take, previews-per-purchase (T-11
   economics check), time-to-reproduce (the headline stat), settle rate,
   dispute rate. Log as receipts on the venue chain; they're then auditable
   marketing numbers, not analytics-db claims.
7. **Two product lines, explicitly:** the $3 copyable **package** (demo,
   `templates.ts` lineage, volume/marketing play) and the **venue
   execution** (the moat). Same manifest schema, different delivery. Never
   blur them in copy; the package line is the funnel into the venue line.

---

## 5. Growth ideas (owner strategy — build later, none block M1–M5)

### G-1: The bounty board (reverse marketplace)
Buyers post escrowed job specs with a deterministic judge attached ("$40:
1080×1080 render passing this CUE spec, judged by hash/dims"). Seller agents
race; first pass settles; venue takes the cut on every bounty. Why it's
strong: it turns *demand* into public content — every bounty is a watchable
challenge ("can any agent do this for $40?"), a leaderboard, and an X post
that writes itself. Speedrun culture for agents. It also solves cold-start
supply: bounties recruit sellers with money instead of marketing. All
existing machinery reverses cleanly: escrow arms on post, judge spec is the
listing, first valid AgentPass wins the settle.

### G-2: Royalty composition ("npm with money in the wires")
Let packages call other packages: a listing's workflow may invoke a paid
sub-workflow as one of its steps, and the receipt chain already records the
call tree (`child_receipts`) — so settlement can auto-split royalties to
upstream authors on every downstream execution. Authors then earn compounding
income when *others* build on them, which makes every serious author a
promoter of the platform. This is the network effect the copyable model can
never have, and the evidence layer (who called what, receipted and signed)
is precisely the hard part that already exists.

### G-3: Proof-of-run physical collectibles
Every settled run can be minted as a physical artifact — the laser rig from
the demo becomes a product line: coaster/plaque engraved with the output art
plus a QR resolving to the signed receipt chain (the certificate of
authenticity is *cryptographic*, not a hologram sticker). Sell limited
physical editions of popular workflow outputs; venue takes a mint fee.
Synergies are unusually good: it reuses the owner's existing laser/finishing
capacity and packaging discipline (KraftForgeLabs), every unit shipped is a
desk-top billboard with a scannable provenance story, and eBay is already a
sales channel he operates. "The first agent marketplace whose receipts you
can hold."

Bonus (cheap, do alongside launches): **live param-tweak streams** — run a
listing live, let chat vote/pay to move the sliders, mint G-3 collectibles
of the winning frame. Content engine for X; zero new infra beyond M2.

---

## 6. File map for the implementing agent

| File | Role |
|---|---|
| `src/venue/THREATS.md` | 24 threats, 6 rulings — acceptance criteria |
| `src/venue/ADVICE.md` | Sequencing + strategy (single-sided launch, judge discipline, fake-money rule) |
| `src/venue/DEMO-2026-08-22.md` | Launch-night runbook + package manifest draft (= listing schema seed) |
| `src/venue/HANDOFF.md` | This file — physical model, inventory, M0–M5 path, gaps, growth |

Rules of engagement: rulings in THREATS.md §6 are non-negotiable; every
milestone lands with its adversarial tests; no Stripe code before the
fake-money trade passes; the companion server never faces the internet.
