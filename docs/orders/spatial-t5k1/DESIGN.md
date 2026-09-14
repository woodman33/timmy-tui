# Timmy: spatial authoring and visual language

This study demonstrates one concrete direction: Timmy turns declared dimensions and relationships into an editable construction program, executes native geometry operations, and presents the measurements alongside the result. A language model can help choose or revise the program. The geometry comes from the program and its native kernel.

## What this study actually does

The browser displays three locally built CadQuery tray variants, at 100, 140, and 180 mm width. Every variant preserves 80 mm depth, 30 mm height, 3 mm walls/base, four radius-6 mm supports, and four diameter-3 mm through bores. Support centers stay 10 mm from the exterior edges. The base is centered in X and Y at Z=0.

Four native operations are retained separately: outer block, cavity subtraction, support union, and bore subtraction. The browser verifies each loaded STL hash and its bounds; it shows the saved native measurements for that stage. It offers perspective orbit and orthographic top/front/side views. The selectors load already built variants and stages. They do not run CAD in the browser.

`model/build.py` is the editable source. `model/manifest.json` records the source hash, dimensions, native measurements, exports, and checks. `model/qualification.json` records the results. Each completed variant has a STEP export, a STEP reimport check, and separate Open3D checks of the tessellated mesh. These reports are unsigned local study artifacts, not production Timmy receipts.

The UI uses Three.js 0.186.0, with source files and its license retained in `vendor/`. It does not call Spline, Hana, Viser, Rerun, FiftyOne, Cosmos, OpenDesign, or Instatic. The mappings below describe the proposed integration.

## One language shared by the terminal and visual companion

The terminal should provide object search, named commands, dimensions, differences, and concise check results. The companion should display the same selected object, feature, revision, and operation in 3D. tldraw should show the plan and relationships. They must read one validated spatial report.

Suggested vocabulary:

| Item | Visual form | Exact meaning |
| --- | --- | --- |
| Part | Thumbnail plus stable name | An editable native component |
| Profile | Dimensioned 2D outline | A sketch on a named plane |
| Feature | Small operation card | One construction operation with typed inputs |
| Datum | Origin or plane marker | The reference frame used by a relationship |
| Constraint | Labeled binding | A computable relationship with units and tolerance |
| Materialize | Directed arrow to a named surface | Execute the pinned construction intent |
| Observation | Measurement marker | A result tied to source revision, time, and checker |
| Model judgment | Question mark and explicit wording | An interpretation that has not become a native measurement |

Use consistent statuses across all surfaces: declared, built, checked, failed, stale, missing, and inferred. Combine words, glyphs, and color. Keep receipt details one step away; show object identity and the meaningful discrepancy first.

Selecting a bore should select its tldraw feature, highlight its geometry, show its diameter and edge-offset constraints, and focus its construction step. In the TUI, the same selection could read: `Bore 3 · diameter 3 mm · edge offsets 10 / 10 mm · checked at revision 4`. This is proposed UI behavior, not a new command implemented by this study.

## A useful definition of spatial understanding

Timmy should be able to answer seven classes of question using explicit queries:

1. **Identity and hierarchy:** which part, instance, face, or feature is selected; what is its parent; which operation created it?
2. **Frames:** which origin, axis convention, unit, and local-to-world transform make a coordinate meaningful?
3. **Geometry:** what are its bounds, surface normal, volume, topology, nearest point, and intersection state?
4. **Relationships:** is it centered, parallel, concentric, touching, contained, or separated by a required clearance?
5. **Projection:** how does a point or silhouette project into a calibrated camera; which surfaces are occluded?
6. **Construction:** which feature can produce the intended shape, and what dependencies must update when a parameter changes?
7. **Evidence:** which answers are current native measurements, retained measurements, inferred judgments, or unavailable?

Distinguish an axis-aligned bounding box from the occupied shape. Overlapping boxes are only a candidate collision. Exact contact/interference needs a native geometric query. Distinguish screen-left from world-minus-X and optical depth from distance along a camera ray.

A drawing in tldraw starts in canvas pixels. Mapping it to millimetres needs an explicit scale or dimension. A single image does not supply hidden dimensions or unseen geometry. When a reference is ambiguous, preserve the ambiguity, expose a dimension for the user, or acquire a useful additional view.

## The construction program

Begin with a bounded set of native operations: sketch, extrude, revolve, union, subtract, hole, fillet, pattern, transform, and assemble. Each admitted operation needs a typed input contract, required capabilities, preserved native output, measurements, and explicit failure behavior. Support will grow operation by operation; the full list is not currently integrated.

The tray's relationships are simple enough to read:

```text
outside = [width, 80 mm, 30 mm]
wall = 3 mm
base = 3 mm
support_centers.x = ±(width / 2 − 10 mm)
support_centers.y = ±(80 mm / 2 − 10 mm)
support_radius = 6 mm
bore_radius = 1.5 mm
```

Changing width recomputes the support coordinates and affected geometry. It preserves the dimensions declared constant. A failed Boolean must remain a failed Boolean; replacing it with a visual overlap changes the operation's meaning.

Persist the editable recipe and source features. STEP is useful solid interchange, but does not preserve every author's feature history. GLB/STL are useful visual/mesh artifacts and do not become the parametric master. A topology-changing edit may invalidate face references; identify features through semantic names and geometric predicates, and mark ambiguous references unresolved.

## Roles of the requested tools

| Tool | Role in this direction |
| --- | --- |
| tldraw SDK | Custom part/profile/constraint cards and persistent bindings; canvas editing compiles into typed relationships. A BindingUtil keeps canvas relationships attached; a separate solver enforces 3D constraints. |
| Native CadQuery / SolveSpace / Blender / Houdini | Solve admitted constraints, construct actual editable geometry, and answer domain-specific questions. Use the kernel appropriate to solids, sketches, meshes, or procedural scenes. |
| Spline | Interactive scene authoring, composition, materials, cameras, and presentation. Preserve its native objects and map them to Timmy feature IDs. Maintain an explicit unit/axis transform between CAD and Spline. |
| Viser | Spatial inspection, calibrated cameras, point clouds, controls, and manipulators. A drag creates a proposed transform; the native authoring adapter applies and measures it. |
| Rerun | Align operations, source captures, geometry, errors, and observations over time. It displays a projection of validated Timmy state. Recorded playback is not native execution replay. |
| FiftyOne | Organize an evaluation corpus of references, recipes, views, masks, failures, corrections, and reviewer labels. Similarity depends on its configured descriptors; the current local adapter uses pixel descriptors. |
| Cosmos 3 Edge reasoner | Propose part descriptions, suspicious relationships, or an additional camera view. Check those proposals against native state. Keep image/video generation outside the model construction path. |
| Roboflow / OCR / segmentation | Produce image-space detections, masks, and text observations for comparison with native renders. A missed detection does not prove a native object is absent. |
| Hana | Prototype and author the visual grammar: inspector transitions, selection states, diagrams, and interactive explanations. Product controls should produce typed Timmy requests and reflect returned state. |
| OpenDesign desktop | Develop reusable presentation components and design-system files for the existing Timmy companion. Bind its exact MCP tools and returned artifacts before treating outputs as retained evidence. |
| Instatic | Maintain recipe catalog pages, documentation, tutorials, and shareable explanations. Reuse the same report for embeds instead of creating a second geometry state store. |

## Existing seed and integration gaps

Canonical Timmy already has explicit spatial types, freshness/scene-head handling, deterministic recipe compilation, and native result checks. The recipe schema inspected here currently accepts `foundation.slab/1`. Its USD compiler handles primitives and can separately render OpenSCAD CSG when configured. The adjacent geometry executor includes a constrained CadQuery/SolveSpace fixture, geometric queries, calibrated camera projection, and a primitive reference core.

The main work is connecting those capabilities:

1. Add richer bounded recipes and a general representation of supported constraints.
2. Maintain a stable identity map across tldraw, recipe features, native objects, USD, Spline, and Viser. Export losses must be explicit.
3. Connect native edits and remeasurement to the same project revision and operation receipt.
4. Feed the validated report to the TUI, companion, canvas, and Rerun.
5. Curate failures in FiftyOne and improve retrieval, templates, and tests before claiming model learning.

Current qualifications are limited: the configured Viser/FiftyOne analytics runtime path was absent in this checkout; Cosmos Edge generation is disabled; the retained Rerun experimental filled-table fixture has a clear/forward-fill discrepancy. These do not prevent building a native part, but they matter before claiming an integrated live system.

## Next qualification for Timmy

Use this tray as a bounded `enclosure.tray/1` candidate. Then build a bracket and a dimensioned stand, each with named features and editable output. For every recipe, test more than one pleasing render:

- Changing a driving dimension moves only the intended dependent features.
- The same model is measured consistently after a coordinate-frame round trip.
- An impossible wall/hole arrangement reports the conflicting constraints.
- Native dimensions and volume match a predeclared analytical prediction where one is available.
- STEP reimport and independent mesh checks preserve the claimed geometry within declared tolerances.
- A removed object, stale observation, changed source, or unsupported operation cannot remain checked.
- A visual claim is tested from a second, previously unused view where possible.
- The same recipe can be rebuilt with recorded kernel/version/tolerance settings; compare geometry within tolerance, not assumed byte-identical exports.

A useful evaluation curriculum is primitive placement, transforms, constraints, CSG, assemblies, reference interpretation, and edits under partial visibility. Split evaluation cases by recipe/object family so nearby frames of the same scene do not masquerade as independent successes.

## Primary references

- [tldraw shape records](https://tldraw.dev/sdk-features/shapes) and [bindings](https://tldraw.dev/sdk-features/bindings)
- [CadQuery introduction](https://cadquery.readthedocs.io/en/latest/intro.html)
- [Spline parametric objects](https://docs.spline.design/designing-in-3-d/objects/working-with-parametric-objects) and [Boolean operations](https://docs.spline.design/designing-in-3-d/modeling/boolean-operations)
- [Viser](https://viser.studio/main/)
- [Rerun blueprints](https://rerun.io/docs/concepts/visualization/blueprints) and [Viewer MCP](https://rerun.io/docs/reference/viewer/mcp)
- [FiftyOne Brain](https://docs.voxel51.com/brain/index.html)
- [Cosmos 3 model and limitations](https://huggingface.co/nvidia/Cosmos3-Nano)
- [Hana exports](https://docs.spline.design/hana-a-canvas-for-interactivity/assets-and-export/exporting-in-hana)
- [OpenDesign desktop source](https://github.com/nexu-io/open-design)
- [Instatic agent interface](https://github.com/CoreBunch/Instatic/blob/main/docs/features/agent.md)
