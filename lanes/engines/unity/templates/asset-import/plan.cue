// Unity · asset-import — import a dropped .unitypackage into a project headless (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Unity Editor on this Mac. -importPackage per Unity's CLI docs.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "unity"
	id:             "asset-import"
	title:          "Import a dropped .unitypackage headless"
	objective:      "Run the editor in batch mode against the project that sits beside the package in drop/ with -importPackage, so the package's assets land in Assets/ and the asset database is refreshed, then quit. The editor log is the report."
	bridge:         "cli"
	inputs: [
		{id: "package", glob: "*.unitypackage", note: "the package to import"},
		{id: "project", glob: "*.unity.zip", note: "the project it goes into", required: true},
	]
	steps: [
		{
			id:    "unpack"
			title: "unzip the project"
			command: {
				bin:  "/usr/bin/unzip"
				args: ["-q", "-o", "{drop}/../{stem}.unity.zip", "-d", "{out}/project"]
				timeout_ms: 120000
			}
			produces: ["project"]
		},
		{
			id:    "import"
			title: "Unity -batchmode -quit -importPackage"
			command: {
				bin:  "unity-editor"
				args: ["-batchmode", "-nographics", "-quit", "-projectPath", "{out}/project", "-importPackage", "{drop}", "-logFile", "{out}/{stem}.import.log"]
				timeout_ms: 1800000
			}
			produces: ["{stem}.import.log"]
		},
	]
	outputs: [{id: "log", glob: "*.import.log", kind: "report"}]
	acceptance: [
		"the log shows the package imported and the editor exiting 0",
		"out/project/Assets gains the package's files",
		"the engine.run receipt cites the package sha256, the log sha256 and the Unity env-lock",
	]
	receipt: {kind: "engine.run"}
	limits: {wall_ms: 1800000, cost_usd: 0}
	proven: false
}
