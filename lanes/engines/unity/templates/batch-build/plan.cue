// Unity · batch-build — build a dropped project headless through a static build method (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Unity Editor on this Mac (expected under /Applications/Unity/Hub/Editor). Flags per Unity's CLI docs.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "unity"
	id:             "batch-build"
	title:          "Build a dropped Unity project headless"
	objective:      "Unzip the dropped project and run the editor with -batchmode -nographics -quit, executing the project's Shelf.Build.WebGL static method (the template ships it as an Editor script the unzip step copies in), which calls BuildPipeline.BuildPlayer into out/. The editor log is the report; a non-zero exit is a failed step. Unity licences must already be activated on the runner."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.unity.zip", note: "a Unity project zipped with Assets/ and ProjectSettings/ at the root"}]
	steps: [
		{
			id:    "unpack"
			title: "unzip + drop in the Shelf build script"
			command: {
				bin:  "/opt/homebrew/bin/node"
				args: ["{template}/unpack.mjs", "{drop}", "{out}", "{stem}"]
				timeout_ms: 120000
			}
			produces: ["project"]
		},
		{
			id:    "build"
			title: "Unity -batchmode -nographics -quit -executeMethod Shelf.Build.WebGL"
			command: {
				bin:  "unity-editor"
				args: ["-batchmode", "-nographics", "-quit", "-projectPath", "{out}/project", "-executeMethod", "Shelf.Build.WebGL", "-buildTarget", "WebGL", "-logFile", "{out}/{stem}.unity.log", "-shelfOut", "{out}/{stem}.webgl"]
				timeout_ms: 3600000
			}
			produces: ["{stem}.unity.log", "{stem}.webgl"]
		},
	]
	outputs: [
		{id: "bundle", glob: "*.webgl", kind: "bundle"},
		{id: "log", glob: "*.unity.log", kind: "report"},
	]
	acceptance: [
		"out/<stem>.webgl/index.html exists and the log ends with the build succeeded line",
		"the log has no error: lines from the compile step",
		"the engine.run receipt cites the project sha256, every bundle file sha256 and the Unity env-lock",
	]
	receipt: {kind: "engine.run"}
	limits: {wall_ms: 3600000, cost_usd: 0}
	proven: false
}
