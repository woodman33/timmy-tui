// Godot · headless-export — export a dropped project with a named preset (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Godot on this Mac (expected /opt/homebrew/bin/godot). Flags per the Godot 4 CLI docs.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "godot"
	id:             "headless-export"
	title:          "Export a dropped Godot project headless"
	objective:      "Unzip the dropped project, then run godot --headless --path <project> --export-release <preset> <out file> using the preset named in export_presets.cfg (Web by default), so the build lands in out/ with the editor log as the report. Export templates for the engine version must be installed on the runner."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.godot.zip", note: "a Godot 4 project zipped with project.godot and export_presets.cfg at the root"}]
	steps: [
		{
			id:    "unpack"
			title: "unzip into out/project"
			command: {
				bin:  "/usr/bin/unzip"
				args: ["-q", "-o", "{drop}", "-d", "{out}/project"]
				timeout_ms: 60000
			}
			produces: ["project"]
		},
		{
			id:    "export"
			title: "godot --headless --export-release Web"
			command: {
				bin:  "godot"
				args: ["--headless", "--path", "{out}/project", "--export-release", "Web", "{out}/{stem}.web/index.html"]
				timeout_ms: 1800000
			}
			produces: ["{stem}.web"]
		},
	]
	outputs: [
		{id: "bundle", glob: "*.web", kind: "bundle"},
		{id: "log", glob: "export.log", kind: "report"},
	]
	acceptance: [
		"out/<stem>.web/index.html exists beside the .wasm and .pck the preset writes",
		"the export log has no ERROR lines",
		"the engine.run receipt cites the project sha256, every bundle file sha256 and the godot env-lock",
	]
	receipt: {kind: "engine.run"}
	limits: {wall_ms: 1800000, cost_usd: 0}
	proven: false
}
