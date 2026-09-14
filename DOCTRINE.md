# DOCTRINE v0 — TIMMY task law (adopted 2026-08-29)

Companion to DESIGN.md (Clearinghouse constitution) and decisions.md
(forge ADR log). Every task cites all three. Supersede by adding, never editing.

## 1. TOOL LANES
- walnut = pixels may only be SELECTED / ARRANGED: ffmpeg -c copy cuts,
  Remotion compositing of real captured assets. No synthesis in this lane.
- forge = pixels CREATED (any generative model). Inert unless TIMMY_FORGE=1
  (decisions.md D1).
- forge NEVER touches Chapter 1 material (walnut runbook verbs, receipts
  core, run-of-show). The lanes do not cross.

## 2. WRITE BUDGETS
- Every task declares its allowed writes up front (exact files/dirs).
- Undeclared writes are refusals, not mistakes. The budget is the contract.

## 3. EVIDENCE
- Fixes cite receipts: every claimed fix names the seal or verify receipt
  that proves it (sha256_… / ok:true). No receipt, no claim.

## 4. ANCHORING
- At every render seal, the chain (.timmy/receipts/) and the cut docs
  (cut/*.json, cut/*.md) are anchored to the sibling repo
  ../timmy-anchors (dedicated, local) and to the chain-anchors branch.
- Anchor commit messages carry the full chain-head sha256.
- Anchoring never touches main; worktree state on main stays uncommitted.


- ORDER-TEMPLATE PREFLIGHT: before any seal, print the resolved store
  path (`store: …`); if it is not the pinned root store, STOP. The pin
  (.timmy/store-pin) routes seals from any subdirectory to ONE chain.

## 5. MOTION FLOOR
- No frame of a cut may be static ≥0.5s; freezedetect (n=0.003, d=0.5)
  is a pre-seal gate on every render.cut. Zero events or no seal.

## 6. CUT ON RISE
- Cuts land on rising motion: out-point at ≥60% of the clip's peak
  energy with positive slope; in-point on live motion; never in the
  tail plateau (bottom 25%). Verified with tools/motion-curve.py
  pre-seal on every footage pull.

## 7. CITE-SYNC
- Any VO line naming an artifact must show that artifact on screen
  for ≥50% of the line's duration; audited against the claims-map
  pre-seal. No citation without its artifact.

## 10. REDACTION LANE
- Redactions REMOVE information, never add claims. Every redacted region
  is enumerated in a sealed redact.map (shot, frame range, bbox, method,
  reason). Inpainted pixels exist only inside those regions; all other
  pixels are camera-original.
- Clean-plate method: sharpest reference frame, mask from the PII scan,
  inpaint ONCE (blank fill, no invented text), per-frame ORB/SIFT +
  findHomography warp, 2px feather, grain-match. No frame-by-frame
  generative passes.
- End-card fine print carries: "PII redacted for privacy; redact.map sealed."

## 11. THE ROSTER
- A gate that can be forgotten is not a gate. gates/roster.json is the
  sealed, versioned list of every gate required for render.cut: runtime,
  coverage, motion floor, cut-on-rise p95, cite-sync, click, pii.scan,
  captions, text.collision, vo-tail spectral.
- render.cut REFUSES to seal unless the scorecard carries a row for every
  roster gate — pass or fail, but never absent. A recorded failure is
  honest; an omitted gate is not.
- Changing the roster itself seals only via roster.amend with a reason;
  plain roster seals are refused by the tooling.
- Threshold rebases are gate.rebase seals with evidence. The runtime gate
  stands at 61.0 per the standing rebase (sha256_b937b79d4…, evidence:
  pause-table).

## 12. NEGATIVE CONTROL
- No gate enters gates/roster.json on a pass. A gate that has never
  failed has never been tested.
- A new gate is admitted only by demonstrating FAIL on a known-defective
  artifact, sealed as gate.control --meta artifact=<sha> expected=fail.
- Gates admitted before §12 carry status "provisional" until they carry
  a gate.control seal; a provisional gate may not certify picture lock.
- Control expectations are fixed before the gate runs. If the gate passes
  a defective artifact, the tool is wrong — fix the tool, not the
  expectation.
- Gates are not tuned to targets — a threshold chosen to produce a
  desired flag is a fitted instrument.

## 14. CITE-EXISTS
- A seal that cites an artifact must cite a hash that EXISTS at seal time.
  `timmy seal --artifact <path>` refuses (exit 2, no seal) when the path is
  absent; the artifact's sha256 is recorded in the seal so the citation can
  be re-verified later.
- `timmy seal --cite <hash|id>` refuses when the cited receipt is not on the
  chain. Seals may cite receipts; they may not cite ghosts.
- A seal discovered after the fact to cite a missing or stale artifact is
  attested with a `receipt.orphan` seal naming the original seal, the cited
  file/hash, and the store path + cwd it was sealed from. Orphans are
  evidence, not erasure: the original seal stays on the chain.
- Toolchain artifacts live IN the repo (tools/, man/, script ledgers). A
  ledger or roster sealed from outside the repo is an orphan waiting to
  happen.
