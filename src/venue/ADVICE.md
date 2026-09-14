# Venue build advice — companion to THREATS.md

> v0.1, 2026-08-22. Read `THREATS.md` first; this file is sequencing and
> strategy guidance layered on top of it. Threat IDs (T-nn) refer to that file.

## 1. Launch single-sided — the owner is the only seller

The biggest schedule lever available. Roughly half the threat model (T-01
Sybil identity, T-06 self-judging, T-08 fabricated chains, T-21 seller
stalling) only exists because sellers are strangers. If v1 is "buyers purchase
execution of the owner's workflows," the seller is trusted by definition and
the launch set shrinks to:

- escrow custody at the venue (T-03/T-05),
- the tier filter with degraded previews (T-10/T-11/T-12),
- authenticated switchboard sessions (T-17/T-18).

That is weeks of work, not months. Real revenue and usage data still flow, and
THREATS.md becomes the roadmap for opening the seller side later instead of a
launch gate.

## 2. Let the deterministic-judge constraint curate the catalog

Launching with only mechanically-checkable jobs (renders matching a spec, data
passing a CUE/schema vet, media hitting duration/dimension targets) sounds
limiting but is market discipline: it forces every listing to state verifiable
success criteria, which is exactly what makes a stranger willing to prepay.
A job that cannot state a deterministic success check is not ready to be a
product. Model judges and human dispute windows are v2 (T-06 ruling).

## 3. Do not build a reputation system

Settled-job count with links to countersigned receipts IS the reputation, and
it falls out of the escrow flow for free. A separate ratings feature at this
stage is attack surface (ratings spam is T-22's twin) with no added trust.
Discovery for v1 is a signed listing index, nothing more.

## 4. Sequencing inside M1

1. **Escrow custody relocation first.** Move `src/utils/escrow-engine.ts`
   behind the venue domain (Cloudflare worker Durable Object). Single-writer
   serialization comes free from DOs, which also closes the draw-race (T-05).
   No trading party ever writes escrow state again (T-03).
2. **Tier filter second** (M2 is a launch blocker per THREATS.md ruling 2):
   default-deny per-escrow tool allowlist, schema-filtered arguments, preview
   degradation stage, `error_class`-only error passthrough.
3. **Fake-money end-to-end trade third.** Run one complete trade with the
   owner as both buyer and seller before any Stripe code exists: lock →
   bound tool calls through the filter → deterministic judge → settle →
   countersigned receipts on all three chains. If the loop doesn't work with
   play money, Stripe only adds ways to lose real money.

## 5. Payments and identity land together, last (M5)

Stripe Connect with the venue as platform solves three problems at once:
Sybil cost (T-01: payment onboarding IS the identity anchor), payout rails
(T-15: auth at `locked`, capture at `settled`, cancel at `slashed`, webhook
is the only event that flips the paid bit), and custody (T-24: funds flow
Stripe → seller with a venue application fee, the venue never holds money).
The worker's `Env` in `src/companion/cloudflare-worker.ts` already stubs
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and Clerk keys — reuse them.

## 6. Non-code blocker: the legal read (T-24)

Holding buyer funds pending settlement can legally be money transmission.
The Stripe Connect platform shape likely sidesteps it, but get a real legal
read before the first real dollar moves. This is flagged in THREATS.md as a
lawyer question, not a code question — do not let code outrun it.

## 7. Hard boundaries carried over from THREATS.md rulings

- The companion server (`src/companion/server.ts`) never faces the internet;
  the public switchboard is a new, minimal, worker-hosted surface (T-17).
- Every cross-domain receipt is countersigned by venue + both parties; the
  venue publishes its chain head via the `receipts.ts` release-epoch
  mechanism (T-04/T-23).
- `bindPuppet` method scoping is NOT tool scoping — no paid binding exists
  without the tier filter in the path (T-10).
