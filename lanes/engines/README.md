# Engine shelf — engine-shelf/v0

Eight engines, one lane, three workflow templates each. An engine is reached
the way it is reached (CLI, MCP, SDK, API), its binaries are pinned by an
env-lock, and every workflow runs THROUGH a project's drop folder and seals one
`engine.run`. shelf-w6d3 step 4.

```
timmy engine inventory                 measure engines.json → inventory.json, fleet entries, env-locks
timmy engine envlock <engine>          sha256/size/mtime/version of the engine's binaries
timmy engine run <engine> <workflow> --project <p> [--input <file>]
timmy engine drop <engine> --project <p> [--workflow <w>]     process drop/ by the rules
timmy engine shelf                     the shelf table + engine.shelf receipt
```

| engine | on this Mac | bridge | templates | status |
|---|---|---|---|---|
| houdini | 22.0.429 (Current), Apprentice licence | cli (hython, husk) + mcp (houdini-gen) | procedural-asset · karma-still · usd-export | proven |
| usd | Apple USD Tools 0.25.2 (usdcat, usdzip) | cli | usd-validate · usdz-package · usd-flatten | proven |
| defold | 1.13.1 + its JDK 25, bob pinned to the engine sha | cli + api (build server) | html5-bundle · resolve-and-lint · sprite-atlas | proven |
| blender | 5.1.1 | cli | render-still · glb-export · usd-export | proven |
| unreal | not installed | cli + mcp (unreal-mcp) | level-import · blueprint-bake · movie-render-queue | authored, unproven |
| unity | not installed | cli | batch-build · asset-import · test-runner | authored, unproven |
| cocos | not installed | cli | web-build · asset-pack · scene-lint | authored, unproven |
| godot | not installed | cli | headless-export · gdscript-run · import-only | authored, unproven |

## A template

```
lanes/engines/<engine>/templates/<workflow>/
├── plan.cue               workflow: #Workflow & {…}   inputs, steps (bin + args + produces), outputs, acceptance
├── <workflow>.rules.cue   drop: #DropRules & {…}      what a dropped file triggers: run | stage | refuse
├── blueprint.json         kind "blueprint"            sheets inputs / steps / outputs / receipt (/ sources)
└── script.py | run.mjs    what the step actually runs
```

`lanes/engines/schemas/engine-workflow.cue` is the schema; `cue vet -c` checks a
template. Commands never run in a shell: `bin` is a key into `engines.json`
binaries (or an absolute path) and `args` are substituted for `{drop} {out}
{project} {template} {stem}` only.

## A run

1. the input is copied into `<project>/drop/` (so a run and a drop are the same path)
2. the rules pick the workflow (`run`), park the file (`stage`) or refuse it (`engine.refuse` receipt)
3. steps run in order in `out/<engine>/<workflow>/<stem>-<ts>/`; each leaves `<step>.log`; a step whose `produces` are missing fails the run
4. outputs are hashed; `engine.run.json` records everything; the input moves out of drop/
5. `engine.run` seals: engine, workflow, input sha, outputs with shas, template shas, env-lock sha, steps and timings, plus the `receipt.extra` fields read from the template's JSON report

`proofs.json` keeps the latest successful receipt per template; `inventory.json`
and `fleet/fleet.json` carry installed / proven per engine. Not-installed
engines keep their templates and stay `unproven` until a runner with the
engine executes them; their blueprints cite the vendor docs the commands were
written from.

## Env-lock

`lanes/engines/<engine>/env-lock.json`: for every binary the engine needs,
its resolved path, sha256, size, mtime and version string, plus the OS build.
The receipt carries the lock's sha256, so a run says exactly which Houdini,
which Blender, which JDK.
