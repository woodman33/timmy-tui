// Defold · resolve-and-lint — resolve a dropped project's libraries and compile it, no bundle (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "defold"
	id:             "resolve-and-lint"
	title:          "Resolve and compile a dropped Defold project"
	objective:      "Unzip a *.defold.zip into out/project, run bob resolve (library dependencies into .internal/lib), then bob --verbose build for the host platform with no bundle, and write <stem>.lint.json: the declared and resolved dependencies, bob's warning and error counts (protobuf JVM chatter filtered out and counted separately), and every compiled resource under build/default with bytes. A non-zero bob exit is a failed step; the report is still written."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.defold.zip", note: "a Defold project folder zipped with game.project at the root (or inside one top-level folder)"}]
	steps: [
		{
			id:    "unpack"
			title: "unzip into out/project"
			command: {
				bin:        "/opt/homebrew/bin/node"
				args:       ["{template}/run.mjs", "{drop}", "{out}", "{stem}", "unpack"]
				timeout_ms: 60000
			}
			produces: ["project", "{stem}.project.json"]
		},
		{
			id:    "resolve"
			title: "bob resolve (library dependencies)"
			command: {
				bin:        "/opt/homebrew/bin/node"
				args:       ["{template}/run.mjs", "{drop}", "{out}", "{stem}", "resolve"]
				timeout_ms: 300000
			}
			produces: ["{stem}.resolve.json"]
		},
		{
			id:    "lint"
			title: "bob --verbose --platform <host> build"
			command: {
				bin:        "/opt/homebrew/bin/node"
				args:       ["{template}/run.mjs", "{drop}", "{out}", "{stem}", "lint"]
				timeout_ms: 300000
			}
			produces: ["{stem}.lint.json"]
		},
	]
	outputs: [
		{id: "lint", glob: "*.lint.json", kind: "report"},
		{id: "resolve-report", glob: "*.resolve.json", kind: "report"},
		{id: "project-report", glob: "*.project.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.lint.json names the declared dependencies, the resolved libraries, warnings, errors and the compiled resource count",
		"bob exited 0 (a non-zero exit fails the lint step and leaves the diagnostics in the report and lint.log)",
		"the engine.run receipt cites the input sha256, the report sha256, the counts and the Defold env-lock",
	]
	receipt: {kind: "engine.run", extra: ["resources", "warnings", "errors", "dependency_count", "engine_sha", "bob_version", "platform"]}
	limits: {wall_ms: 900000, cost_usd: 0}
}
