# ORDER spatial-t5k1 · phase 2

Study 03 and its relative workbench dependencies are frozen privately: 74 files,
manifest SHA-256 `75c769960b9057834b0e58c85397e57b9aa02ccb44836ca955a501ba679ed804`,
`lab.spatial-03` seal `rc_mtyh4e9v_hh9v`.

Parts [A](../../../reference/study03/TECHNOLOGY.md) and
[C](../../../reference/study03/COMMUNICATION.md) are historical references.
[Part B](../../../reference/study03/IMPLEMENTATION.md) is the source proposal;
this phase implements the user's bounded subset, not its four full future PRs.
C's marketing lines feed [FILM-PLAN](../../../FILM-PLAN.md), with the analytical,
native, and unmeasured boundaries preserved.

`timmy inspect <question>` reads a signed SceneIR and its native source, checks
hashes and the complete 72-check inventory, and returns the shared report. It
never launches CAD, appends receipts, or renews observation time. Supported
questions: `clearance`, `frame`, `empty spaces`, `arrows`, `bore A`, `coverage`.
Unknown questions stay unsupported. A missing or altered report stays unavailable.

Use `--receipt ID` to inspect a retained failed scenario. The default retains the
passing scene; recording a failed clearance does not replace it. `--frame world
--rotation 90 --unit m` changes only display coordinates. The frame chip names
frame, unit, origin, up axis and handedness. Pixel-to-physical conversion is not
admitted. The shared SceneIR/view-model is ready for consumers; this phase does
not wire new controls into the browser, tldraw, or external authoring tools.

Four named analytical empty-space features (`tool.A` through `tool.D`) identify
axial envelopes in the part's mm frame. They are not native-built geometry.
SceneIR separates three arrow types: proposed materialization with bound intent
and source revision; nonexecuting dependency; nonexecuting hypothesis with
missing evidence. No arrow grants execution authority.

The original 72-check gate is carried forward exactly: radius, Z-parallel axis,
X offset, Y offset, Z span and complete cylinder, for A/B/C/D in w100/w140/w180.
The fixed native observer rereads frozen STEP geometry after its prediction is
sealed. This complements, not replaces, phase 1's 30-check rebuild gate.

Clearance uses **2 mm**, overriding Study 03's historical 1 mm demonstration.
A radius of 4.5 gives 2.5 mm PASS, radius 5 gives 2 mm PASS, and radius 5.5 gives
1.5 mm FAIL. Each forecast precedes its result seal. This is an analytical
horizontal wall-gap relation, not full swept-tool clearance. Complete tool path
and physical validation remain unmeasured.

Native acceptance: set `TIMMY_CADQUERY_PYTHON` and `TIMMY_SPATIAL03_FREEZE`, then
run `npx tsx lanes/recipes/spatial03/qualify.ts`. This is explicit local work,
not an automatic watcher. Run `npm test -- --run tests/tray-recipe.test.ts
tests/spatial03.test.ts` for contract regressions. See [evidence](evidence.json).

PR review, then HOLD. Claude Code retains merge-train ownership.
