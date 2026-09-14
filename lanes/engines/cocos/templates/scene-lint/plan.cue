// Cocos Creator · scene-lint — import a dropped project's assets and report what the editor sees (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Cocos Creator on this Mac. Uses the documented --import (import-only launch) plus a scan of the library the import writes.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "cocos"
	id:             "scene-lint"
	title:          "Import a dropped project and lint its scenes"
	objective:      "Unzip the dropped project, run CocosCreator --project <dir> --import so the editor imports every asset headless and writes library/ and temp/, then scan assets/ for .scene files and report each scene's prefab and asset references against the import result, so a broken reference shows up before a build is attempted."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.cocos.zip", note: "a Cocos Creator 3.x project"}]
	steps: [
		{
			id:    "unpack"
			title: "unzip into out/project"
			command: {
				bin:  "/usr/bin/unzip"
				args: ["-q", "-o", "{drop}", "-d", "{out}/project"]
				timeout_ms: 120000
			}
			produces: ["project"]
		},
		{
			id:    "import"
			title: "CocosCreator --project … --import"
			command: {
				bin:  "cocos"
				args: ["--project", "{out}/project", "--import"]
				timeout_ms: 1800000
			}
			produces: ["project"]
		},
		{
			id:    "lint"
			title: "node lint.mjs: scenes × references × library"
			command: {
				bin:  "/opt/homebrew/bin/node"
				args: ["{template}/lint.mjs", "{out}/project", "{out}", "{stem}"]
				timeout_ms: 300000
			}
			produces: ["{stem}.lint.json"]
		},
	]
	outputs: [{id: "report", glob: "*.lint.json", kind: "report"}]
	acceptance: [
		"out/<stem>.lint.json lists every .scene with its referenced UUIDs and whether the library has each",
		"a missing reference is counted, not hidden; the lint step fails when any is missing",
		"the engine.run receipt cites the project sha256, the report sha256 and the Cocos env-lock",
	]
	receipt: {kind: "engine.run", extra: ["scenes", "missing"]}
	limits: {wall_ms: 1800000, cost_usd: 0}
	proven: false
}
