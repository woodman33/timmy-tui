# Vision Register (spec §11)

Long-term north-star targets, codified so architecture stays documented
**without ever conflating targets with runtime receipts**. Everything in this
register is a TARGET: unverified, unshipped, non-binding on the controller.
Everything outside it that claims "shipped" must point at a signed receipt in
the runs chain (or an `.agentrun` bundle for clip spines). Two columns that
must never merge.

| Rule | Meaning |
|---|---|
| Targets are not receipts | A vision entry confers no capability. Code may not check "is X in the vision" to enable behavior; only receipts, env locks, and CUE-validated plans gate runtime paths. |
| Exit criteria are receipt-grade | Each entry states what would verify it. An entry graduates only when a sealed receipt (or bundle) demonstrates the criterion; graduation is a CHANGELOG event, not an edit here. |
| Fail-closed stays | If a target's sandbox/isolation/spend story cannot be verified, it remains a target forever (REAL SANDBOX OR NOTHING; default-deny spend). |

## ~~V-01 · Hierarchical Context Cone~~ — GRADUATED at v0.7.7

**Target.** Context is a cone, not a window: a hot tip (current turn), a warm
mantle (session receipts + project slate), and a cold base (cross-project
memory), each tier with its own redaction + cost policy; the compiler selects
tiers per plan instead of stuffing one prompt.

**Why.** Judge loops and multi-shot productions already pay for context they
cannot budget; tiered selection makes context a planned resource like spend.

**Graduated criterion.** A dispatched plan carries a `context_manifest` whose
entries are tagged by tier, the receipt records per-tier token/cost counts,
and an ablation run (mantle removed) seals a comparable receipt showing the
delta.

**Proof.** `scripts/phaseE-cone-bench.ts`: cone-budgeted capsule vs
unconstrained raw-repo dump over the same repo — tokens 19,525 → 5,515
(72% reduction) at fact recall 1.0 on both routes; mantle ablation drops
recall to 2/3 (delta shown); per-tier tokens L0 961 / L1 389 / L2 4,165;
dispatched plan `dp_mt0ztp1x_tfzy` carries the tier-tagged manifest.
Graduation receipt `sha256_08d24235…`. CHANGELOG [0.7.7]. The remaining
cone scope (cross-project cold base, redaction policies per tier) is not
covered by this graduation and stays target-grade work.

## ~~V-02 · Tri-modal 3D USD Stack~~ — GRADUATED at v0.8.0

**Target.** One USD spine served three ways: Houdini (hython lane), Unreal
(unreal-mcp lane), and browser preview — with the EDL/OTIO media spine
addressing USD stages the way it addresses clips (fragment addressing,
sha-pinned handoffs, replay verification).

**Why.** The 3D lanes exist but are siloed; a shared stage format is what
makes "receipt-bound 3D" instead of "three exporters".

**Graduated criterion.** A mission compiles a capsule per lane against the
SAME stage artifact (one sha256 in three manifests), and a replay of the USD
handoff byte-compares.

**Proof.** `scripts/phaseF-usd-bench.ts`: one stage `sha256:eea40ee0…`
(CSG + PBR + hero composed) carried in three lane manifests (houdini-mcp,
unreal-mcp, webcontainers — plans dp_mt150w11_ek28 / dp_mt150w1k_3nof /
dp_mt150w21_sgfz); write→read replay byte-compares; fresh compiles are
deterministic. Graduation receipt `sha256_0fd8a091…`. CHANGELOG [0.8.0].
Real lane execution against the stage (hython/unreal renders, EDL fragment
addressing for USD) stays target-grade.

## ~~V-03 · AgentPass Escrow Clearinghouse~~ — GRADUATED at v0.8.0

**Target.** Spend authority becomes an escrow: plans deposit a signed
max_spend ceiling; executors draw against it per sealed receipt; the
clearinghouse nets child receipts against the parent ceiling and refunds the
delta on cancel/fail. Multi-party (fleet bidding) builds on the same escrow.

**Why.** Today max_spend is a gate, not a ledger — cancellation doesn't
refund, and cross-agent bidding has no settlement primitive.

**Graduated criterion.** A cancelled run seals a refund receipt whose amount
equals ceiling minus drawn child receipts, and `verifyChain` walks
ceiling→draws→refund clean.

**Proof.** `scripts/phaseG-escrow-bench.ts`: settle refunds 0.75 =
1.00 − 0.25 drawn; a cancelled run seals refund 1.50 = 2.00 − 0.50 and
`verifyChain` walks ceiling→draws→refund clean; a tampered Merkle proof
slashes with settle refused (no payout path). Escrows esc_af8826ef /
esc_0dfbb92b / esc_175a885c; graduation receipt `sha256_9a628849…`.
CHANGELOG [0.8.0]. Multi-party fleet bidding stays target-grade.

## ~~V-04 · ComfyUI Federation (determinism rung)~~ — GRADUATED at v0.7.5

**Graduated criterion.** A 5s golden run seals a receipt whose output sha256
reproduces on a second run with the same env lock (determinism), and the
workflow's checkpoint name came from runtime discovery, never a hardcoded
string.

**Proof.** `scripts/phaseD-golden.ts`: two FRESH headless executions (server
restarted between runs so no node cache is reused), seed pinned 1337,
checkpoint discovered at runtime (`v1-5-pruned-emaonly.safetensors`) →
byte-identical output `sha256:50aa3c528d0e110214967b50d979787580e0ec3268ce949ec12c237089f30a69`
(timmy-golden-5s_00004/00005). Graduation receipt `sha256_253c4a08…`,
children = the two run receipts. CHANGELOG [0.7.5].

**Re-verification.** After the ComfyUI 0.28 tool-env fix the proof re-ran:
two more fresh executions (timmy-golden-5s_00006/00007) reproduce the same
sha — 4/4 byte-identical runs across server restarts; receipt
`sha256_363f1b8e…`.

The remaining federation scope (workflow-as-fragment into DispatchPlans at
scale, cloud/local routing under one approval/spend law) is re-registered as
V-05 below.

## V-05 · ComfyUI Federation (routing rung)

**Target.** Workflow-as-fragment compilation into DispatchPlans and
cloud/local routing under the same approval/spend law, building on the
graduated deterministic local lane (V-04).

**Why.** The local lane is proven; federation is what makes the media fabric
elastic without a second governance model.

**Verifies when.** A mission compiles a ComfyUI fragment into a CUE plan,
routes local vs cloud by policy, and both routes seal receipts that verify
in the same chain under the same approval token format. Until then: target.

## V-06 · Public-Repo Privacy Gate (ORDER privacy-d5n9)

**Target.** Nothing personal or site-specific reaches the public tree or its
history: no emails, phone numbers, home paths or login names; no tailnet,
LAN or MAC addresses, hostnames or policy text; no card serials or customer
names; no secrets; no brand material beyond the public pitch site. The
public tree keeps templates with placeholders; the real registry lives in
the gitignored `.timmy/private/` overlay (`lanes/privacy/overlay.mjs`).

**Why.** The repo is public. A receipt that names a Spark by its tailnet
address, or an orders line that names a login, is a leak with a hash on it.

**Verifies when.** Three gates agree, every time: the pre-commit hook
(`timmy privacy hook install`) refuses a staged match, CI
(`.github/workflows/privacy.yml`) fails a pushed match, and the seal tool
(`timmy seal`) refuses a receipt that carries one. Each audit seals
`privacy.audit` (pattern-set sha, counts per severity for every worktree and
the full history, gitleaks report sha).

**§12 negative control.** `lanes/privacy/fixtures/must-fail.txt` is a fixture
that MUST trip the gate — `timmy privacy fixture` runs first in CI and fails
the job when the fixture passes clean. A gate that cannot fail its own
fixture is not a gate; the graduation receipt cites the fixture run.

---

Maintenance: edits here are documentation-only. Moving a target into runtime
is a work order + PR + receipts, and the entry is then struck through with a
pointer to the graduating release.
