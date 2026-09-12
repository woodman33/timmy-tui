> Reference from frozen Study 03. Local source links remapped; historical capability claims are not renewed.

# Study 03: one language for Timmy

This document defines the communication system for a local research preview. It is not a specification of shipped Timmy features. The study uses retained native CAD artifacts, new analytical computations, and a shared presentation report. Production Timmy, Spline, Hana, Viser, Rerun, FiftyOne, Cosmos, OpenDesign, Instatic, and tldraw are integration directions unless separately demonstrated and identified.

The central promise is **Build with dimensions. Explain every change.** The language should help someone name a part, understand a relation, make a bounded change, and see what the available evidence actually supports.

## Who this is for

The primary audience is developers and technically curious designers building editable spatial tools. They need an approachable view of dimensions, dependencies, and checks without losing access to the underlying construction.

The study’s specific contribution is a shared explanation across a visual inspector, a terminal presentation, and a public-facing summary. It makes the scope of a spatial claim inspectable. It does not establish category superiority, universal spatial understanding, production readiness, or a substitute for CAD and simulation engines.

For a designer, the message is: **See which relationship a change affects.**

For a developer, the message is: **Use the same named predicates and results across surfaces.**

For someone evaluating Timmy, the message is: **Inspect a concrete working study and its limits.**

## Shared sentence structure

Every consequential sentence should resolve to these fields:

> **Object** · **relationship or quantity** · **value and unit** · **frame** · **condition** · **basis** · **revision or study state**

Examples:

- “Bore A · diameter 3 mm · part frame · matches the selected recipe · retained native check.”
- “Tool envelope · nearest inner-wall horizontal gap 2.5 mm · part frame · minimum 1 mm · analytical study calculation.”
- “Tool approach path · clearance · unmeasured · no complete swept-volume test.”

The ordinary view can shorten a sentence, but it must preserve the basis and scope. A selected word or value should open its supporting fields. Object names and predicate identifiers remain stable across the UI, TUI, and canvas; a change of presentation must not invent a second result.

Marketing can explain the value of this behavior in plain language. It must not replace the basis of a result with a broader claim.

## Six shared claim states

These labels describe individual claims. They are not a six-step project lifecycle, and a part does not receive one universal success badge.

| State | Meaning | UI language | TUI language | Mark |
| --- | --- | --- | --- | --- |
| Proposed | An intent or predicted edit is not yet a measured native result. | “Proposed envelope radius: 8 mm” | `[PLAN] tool.radius 4.5 -> 8 mm` | Hollow diamond; dotted geometry |
| Recorded | An artifact or observation has been retained; correctness is a separate question. | “Native model retained for this width” | `[REC] native model retained` | Square; neutral solid line |
| Passed | A particular check met its stated condition within its stated scope. | “Horizontal wall gap passed: 2.5 mm; minimum 1 mm” | `[PASS] wall_gap.horizontal 2.5 >= 1 mm; analytical` | Check mark plus word |
| Failed | A particular check returned a result outside its stated condition. | “Horizontal wall gap failed: -1 mm; minimum 1 mm” | `[FAIL] wall_gap.horizontal -1 < 1 mm; analytical` | Cross plus word |
| Unmeasured | No applicable result is available for that question. | “Complete approach path unmeasured” | `[?] tool.path; no swept-volume result` | Question mark; open endpoint |
| Stale | A retained observation does not cover the selected source revision. | “Previous measurement; source has changed” | `[OLD] measurement does not cover selected source` | Clock plus broken connection |

Use color as reinforcement. Keep the word, mark, and relevant value available in monochrome and in the terminal.

The current study need not fabricate examples of every state. If a presentation fixture demonstrates a stale, refused, or corrupted state, label it **Synthetic presentation fixture**. Never blend those fixtures into retained native evidence.

### Facts that remain separate

- **Activity:** preview only, calculating, running, completed, or refused.
- **Basis:** retained native check, analytical study calculation, model estimate, reviewer judgment, or synthetic fixture.
- **Freshness:** the source and revision covered by a result. Opening a report does not renew its measurements.
- **Authority:** whether an operation may execute. A visible plan is not permission.
- **Integrity:** whether retained bytes match their expected digest. This is distinct from producer authentication and geometric correctness.
- **Additional qualification:** held-out evaluation, independent execution replay, and physical validation each have their own result or “not run.”

A completed operation can produce a failed measurement. Verified artifact bytes can contain an incorrect result. A refused edit can leave a previously retained model intact. The language must allow those combinations.

## Drawing rules

| Visual element | Meaning |
| --- | --- |
| Thin line with two arrowheads and a unit-bearing label | A dimension |
| Labeled connection between named features | A declared relationship |
| Directional connection between construction steps | An operation dependency |
| Leader ending at a point, surface, or section | The location supporting an observation |
| Dotted or ghosted silhouette labeled “Preview” | Proposed geometry or explanatory geometry |
| Translucent outlined volume labeled “Tool envelope” | The analytical volume under inspection, not a native tray feature |
| Explicit cutting plane and section label | A section of the available native geometry |

Do not reuse a materialize arrow as a generic decorative connector. A materialize arrow names an execution target and a pinned intent; an ordinary relationship binding names a constraint. A binding does not, by itself, establish that a solver enforced the relationship.

Keep the model’s material and the surrounding empty volume visually distinct. For the tool envelope, show the horizontal distance to the relevant inner-wall plane. A negative value means overlap in this analytical horizontal relation. It is not a completed collision test of the tool, holder, tray, and full motion path.

## Frames and units are part of the sentence

Use a persistent, compact frame line:

> **Part frame · millimetres · Z up**

Switching to World rewrites the coordinate description of the same selected point. A displayed scene-placement rotation is distinct from rebuilding the native CAD file.

For the study’s 0° or 90° rotation about Z, expose the transform alongside the result. A simple explanatory point, explicitly labeled as an example, can demonstrate the arithmetic:

```text
Example point: (10, 20, 30) mm in Part
Placement: +90 degrees about Z, right-handed, no translation
Same point: (-20, 10, 30) mm in World
Same point: (-0.020, 0.010, 0.030) m in World
```

Switching millimetres to metres changes the displayed unit and scale of the numbers. It does not rescale the physical part. Switching frames does not give a retained measurement a new validation date. If the transform or units are unavailable, say so rather than choosing a plausible convention.

In a later direct-manipulation interface, “move left” must resolve to a named frame or camera. A screen drag does not establish an unobserved depth.

## Coverage comes before a global verdict

Always show the complete selected query set and the basis of each result. The study has six questions:

1. Outside width: retained native check.
2. Bore diameter: retained native check.
3. Edge offset: retained native check.
4. Tool-envelope horizontal gap to the nearest inner wall: analytical study calculation.
5. Complete tool-path clearance: unmeasured.
6. Physical validation: unmeasured.

At a 4.5 mm envelope radius, the intended report is **4 passed / 0 failed / 2 unmeasured**, with the basis line **3 retained native + 1 analytical + 2 unmeasured**.

At an 8 mm envelope radius, it is **3 passed / 1 failed / 2 unmeasured**, with the same basis line.

The three native checks do not become analytical, and the analytical check does not become native. The aggregate count is a navigation aid, not a claim that the model or proposed process is fully validated. Filters must disclose hidden failures and unmeasured questions.

## Progressive disclosure

**First glance:** name the selected part or envelope, its relevant relation, result, unit, basis, and full-set coverage. Example: “Horizontal wall gap: 2.5 mm · analytical · minimum 1 mm.”

**Select a claim:** show the condition, geometric witness, applicable frame, source revision, and explanation. Example: “10 mm edge offset - 3 mm wall - 4.5 mm envelope radius.”

**Inspect evidence:** show the retained native report or analytical inputs, method, artifact identity, and freshness. Place long digests here. Do not use a digest as the primary product label.

**Inspect qualification:** show independent replay, held-out evaluation, and physical validation with their own methods and results, or “not run.”

The terminal should make the same facts available without requiring an image. Preserve Timmy’s existing keyboard conventions rather than inventing global shortcuts for this study.

## Exact language: use and avoid

| Use | Avoid | Why |
| --- | --- | --- |
| “Horizontal gap meets the 1 mm condition in this analytical calculation.” | “The tool is collision-free.” | One horizontal relation does not establish full-path clearance. |
| “Three retained native checks passed.” | “Everything is verified.” | Scope and omitted checks matter. |
| “Hash matches the retained artifact.” | “Cryptographic proof that the model is correct.” | A content digest does not establish geometric correctness. |
| “Scene placement rotated 90° about Z.” | “CAD rebuilt successfully.” | A placement transform is a different operation. |
| “Preview predicts the proposed result.” | “Executed” when only the preview changed | Prediction and execution require different evidence. |
| “Two questions remain unmeasured.” | “No issues found.” | Missing evidence must remain visible. |
| “The width comes from the selected native artifact.” | “Timmy understands any 3D object.” | A bounded study does not establish universal capability. |
| “Proposed integration with Spline and Viser.” | “Connected to Spline and Viser” without a demonstrated connection | Installed or available tools do not establish an integrated path. |
| “A model estimate suggests another view.” | “Vision proved the hidden feature is absent.” | Image-space inference is not native geometry access. |

## A three-minute demonstration

### 0:00 — State the scope

“This is a local research preview of Timmy’s spatial language. The tray is a retained native CAD model. The tool envelope is a new analytical explanation we can adjust here. We will keep those two kinds of evidence visible.”

### 0:20 — Name the object and the question

Select Bore A and the axial tool envelope. Its envelope extends from Z = 11 mm to Z = 61 mm in the part frame. Say:

“We are asking one bounded question: how much horizontal space separates this envelope from the nearest inner wall?”

Show the full six-question set. Three questions carry retained native checks; two remain unmeasured.

### 0:40 — Explain the passing relation

With the tool radius at 4.5 mm, open the calculation:

```text
Horizontal gap = edge offset - wall thickness - envelope radius
               = 10 - 3 - 4.5
               = 2.5 mm
Required minimum = 1 mm
Basis = analytical study calculation
```

“This relation passes. It does not establish the clearance of the complete tool path.”

### 1:05 — Make a change and expose its cause

Increase the envelope radius to 8 mm. The horizontal gap becomes -1 mm. The analytical predicate fails while the retained width, bore-diameter, and edge-offset checks remain unchanged.

“The changed radius explains this changed result. The tray did not rebuild, and its retained measurements did not renew.”

Point to **3 passed / 1 failed / 2 unmeasured** and its basis line. The negative space should be visually legible through the envelope boundary, wall plane, and labeled relation.

### 1:35 — Change the frame, preserve the meaning

Rotate the displayed group 90° about Z. Switch Part to World and millimetres to metres.

“The coordinate description changes with the frame and unit. The named part and the horizontal relation being inspected remain identifiable. This is a scene-placement transform, not a new CAD build.”

### 2:00 — Switch to terminal presentation

Show the same report in compact text. A sample arrangement is:

```text
STUDY 03  |  local research preview
Selection: Bore A / tool envelope
Basis: 3 retained native + 1 analytical + 2 unmeasured

[PASS] outside.width   matches selected native variant
[PASS] bore.diameter   3 mm; retained native
[PASS] edge.offset     10 mm; retained native
[FAIL] wall_gap.horizontal  -1 < 1 mm; analytical
[?]    tool.path       complete swept volume not tested
[?]    physical        not validated

Coverage: 3 passed / 1 failed / 2 unmeasured
Envelope radius: 8 mm
Native execution: no new CAD operation in this interaction
```

The displayed width and any revision identifiers must come from the actual shared report. Do not hardcode a fictional native measurement into the product view.

### 2:30 — Close with the product direction

“The direction is a shared language for the terminal, canvas, and native tools: name a relationship, change a driving value, and inspect exactly what the result supports. This study demonstrates a bounded part of that direction.”

## Finished public-facing copy

### Marketing hero

**Research preview · Timmy spatial language**

# Build with dimensions. Explain every change.

Explore a CAD part through named relationships, clear reference frames, and explicit checks. See a proposed tool envelope change, follow the calculation, and keep unanswered questions in view.

**Primary action:** Explore the study

**Secondary action:** Inspect the checks

**Scope line:** Local interactive study using retained native CAD artifacts and analytical calculations. Production Timmy integration is future work.

### Fifty-word description

Timmy’s spatial language research connects named geometry, reference frames, and explicit checks across visual and terminal views. This local study combines retained CAD measurements with an analytical tool-clearance envelope. Change the envelope, inspect the result, and see which questions remain unanswered before native execution or physical validation is ever claimed.

### Short launch-post draft

We’re exploring a visual language for Timmy that makes spatial reasoning inspectable.

In this local research preview, an editable CAD recipe supplies the tray and retained native checks. A separate tool-envelope calculation shows why changing a radius changes the horizontal gap to an inner wall. The visual and terminal presentations share the same result and the same unanswered questions.

Three native checks, one analytical relation, two unmeasured questions. The distinction stays visible.

This is a research preview, not a shipped Timmy integration. It’s a concrete step toward building with dimensions and explaining every change.

### Alternative positioning lines

- **See what changed. Know what was checked.** Best for a demonstration focused on result comparison and trustworthy communication.
- **Turn relationships into editable parts.** Best when showing an actual native construction or rebuild, with its supported recipe scope stated.
- **One part. Several views. The same meaning.** Best for the frame, unit, UI, and TUI presentation switcher.

## Integration guidance

Hana and OpenDesign can develop the reusable interaction components. tldraw can express the named plan and bindings. Spline and Viser can provide spatial authoring or inspection views. Rerun can show retained changes over time, and FiftyOne can organize evaluated examples. Those surfaces should consume or map to the same validated identity and result model instead of maintaining independent truth badges.

Do not describe these paths as implemented by Study 03. The present demonstration is the bounded shared-report interaction described above.

## Sources within this workspace

- [Spatial workbench design](../DESIGN.md): native-study scope, construction source, geometry limitations, and integration direction.
- [Canonical spatial presentation handoff](../../../docs/SPATIAL-QWEN-HANDOFF.md): independent evidence facts, stale/error behavior, retained observations, fixtures, and keyboard conventions.
