// Godot · gdscript-run — run a dropped GDScript headless (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Godot on this Mac. Flags per the Godot 4 CLI docs.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "godot"
	id:             "gdscript-run"
	title:          "Run a dropped GDScript headless"
	objective:      "Run godot --headless --script <file> on a dropped .gd that extends SceneTree (its _init runs, prints, and calls quit()). Whatever the script prints is the report; a non-zero exit is a failed step. The way to run a tool script, a data migration or a check without a project."
	bridge:         "cli"
	inputs: [{id: "script", glob: "*.gd", note: "extends SceneTree; _init() does the work and calls quit()"}]
	steps: [{
		id:    "run"
		title: "godot --headless --script <file>"
		command: {
			bin:  "godot"
			args: ["--headless", "--script", "{drop}"]
			timeout_ms: 600000
		}
		produces: ["run.log"]
	}]
	outputs: [{id: "log", glob: "run.log", kind: "report"}]
	acceptance: [
		"the script exits 0 and its printed lines are in run.log",
		"the engine.run receipt cites the script sha256, the log sha256 and the godot env-lock",
	]
	receipt: {kind: "engine.run"}
	limits: {wall_ms: 600000, cost_usd: 0}
	proven: false
}
