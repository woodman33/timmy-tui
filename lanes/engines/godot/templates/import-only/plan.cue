// Godot · import-only — (re)import a dropped project's assets without opening the editor (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Godot on this Mac. --import per the Godot 4.4+ CLI docs.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "godot"
	id:             "import-only"
	title:          "Import a dropped project's assets headless"
	objective:      "Unzip the dropped project and run godot --headless --path <project> --import so every asset is imported and the .godot/imported cache is populated on the runner, which a CI export needs before it can run. The import log is the report."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.godot.zip", note: "a Godot 4 project zipped with project.godot at the root"}]
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
			id:    "import"
			title: "godot --headless --import"
			command: {
				bin:  "godot"
				args: ["--headless", "--path", "{out}/project", "--import"]
				timeout_ms: 1800000
			}
			produces: ["import.log"]
		},
	]
	outputs: [{id: "log", glob: "import.log", kind: "report"}]
	acceptance: [
		"out/project/.godot/imported exists and is non-empty after the run",
		"the import log has no ERROR lines",
		"the engine.run receipt cites the project sha256, the log sha256 and the godot env-lock",
	]
	receipt: {kind: "engine.run"}
	limits: {wall_ms: 1800000, cost_usd: 0}
	proven: false
}
