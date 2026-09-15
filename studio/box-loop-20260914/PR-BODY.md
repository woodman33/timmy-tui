S1 remains blocked: the pinned local Granite workflow still cites the property name `metric_depth` instead of the actual observation handle. Strict success remained **0/1 → 0/1**, so execution stopped before S2. This draft records the attempted binding repair and its failed gate; it is not a working-demo or merge-ready claim.

The patch adds a catalog projected from real tool observations without rewriting observations, correcting answers after generation, or weakening the strict verifier. It includes positive actual/renamed-handle controls and negative property-name/previous-handle controls. Validation: adapter tests **21/21**, workflow benchmark tests **15/15**; one live local model, two inference requests, one tool call, no retry.

DOCTRINE §15 records the exact measurement scope and box-with-bore decision. TRANSFORMS §9 records the six accepted corrections. Prior sealed document bytes remain preserved, with a separate supersession record and orphan attestation. No existing store listing was changed; the inspected local surfaces had no measured-3D listing.

**Review scope:** the shared developed seed contains untracked workflow implementation files. This draft carries only this checkpoint’s patch, baseline/frozen implementation, evidence and documentation, without staging unrelated shared work or presenting an incomplete runtime dependency tree as mergeable. Apply the patch against the matching developed seed after the failed gate is resolved. S2–S6, fleet C1, UI binding and FILM-PLAN v3 were not executed.

Seals (signatures and artifact hashes verified):

- `evidence.bind` **failed**: `rc_mu20rkhh_inhm` / `sha256_90dd7cd3dc8cabe2fc86e818fa09ebe16c2d4d171bcc20d4f45cac5369771666`
- `policy.amend`: `rc_mu20rkx1_srsp` / `sha256_3e7f0441d9378691cbbdfb0d26cbd93cdea7903002ec739bde7b6f60a310cba6`
- `receipt.orphan`: `rc_mu20rkpw_m8zn` / `sha256_d5e4091d253eab9abdd308d4975fa06852d62a605fd7179382443de57b2b6502`

Public review omits four artifacts containing local identity/path data. The TRANSFORMS document uses path placeholders; `PUBLIC-DERIVATION.json` records original/derived hashes. Original signed evidence stays unchanged locally. The public bundle is intentionally incomplete and does not claim that redacted bytes match original seals.
