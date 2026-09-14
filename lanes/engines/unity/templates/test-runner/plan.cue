// Unity · test-runner — run a dropped project's tests headless (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Unity Editor on this Mac. -runTests per Unity's Test Framework CLI docs.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "unity"
	id:             "test-runner"
	title:          "Run a dropped project's EditMode tests headless"
	objective:      "Unzip the dropped project and run the editor with -runTests -testPlatform EditMode, writing the NUnit results XML and the editor log into out/. The XML is the report; a non-zero exit (a failed test) is a failed step, and the receipt still cites the XML."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.unity.zip", note: "a Unity project with the Test Framework package and tests"}]
	steps: [
		{
			id:    "unpack"
			title: "unzip the project"
			command: {
				bin:  "/usr/bin/unzip"
				args: ["-q", "-o", "{drop}", "-d", "{out}/project"]
				timeout_ms: 120000
			}
			produces: ["project"]
		},
		{
			id:    "test"
			title: "Unity -batchmode -runTests -testPlatform EditMode"
			command: {
				bin:  "unity-editor"
				args: ["-batchmode", "-nographics", "-projectPath", "{out}/project", "-runTests", "-testPlatform", "EditMode", "-testResults", "{out}/{stem}.results.xml", "-logFile", "{out}/{stem}.test.log"]
				timeout_ms: 3600000
			}
			produces: ["{stem}.results.xml", "{stem}.test.log"]
		},
	]
	outputs: [
		{id: "results", glob: "*.results.xml", kind: "report"},
		{id: "log", glob: "*.test.log", kind: "report"},
	]
	acceptance: [
		"out/<stem>.results.xml is NUnit XML with total, passed and failed counts",
		"the editor exits 0 when every test passes",
		"the engine.run receipt cites the project sha256, the results sha256 and the Unity env-lock",
	]
	receipt: {kind: "engine.run"}
	limits: {wall_ms: 3600000, cost_usd: 0}
	proven: false
}
