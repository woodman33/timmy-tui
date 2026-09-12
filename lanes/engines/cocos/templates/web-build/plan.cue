// Cocos Creator · web-build — build a dropped project for web-mobile from the command line (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Cocos Creator on this Mac (expected /Applications/CocosCreator.app). Flags per the Cocos Creator 3.x publish-in-command-line docs.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "cocos"
	id:             "web-build"
	title:          "Build a dropped Cocos Creator project for web-mobile"
	objective:      "Unzip the dropped project and run CocosCreator --project <dir> --build \"platform=web-mobile;debug=false;buildPath=<out>/build\" headless, so the web-mobile build lands in out/build with the editor log as the report. A non-zero exit (Cocos reports build errors with exit codes 32-36) is a failed step."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.cocos.zip", note: "a Cocos Creator 3.x project zipped with package.json and assets/ at the root"}]
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
			id:    "build"
			title: "CocosCreator --project … --build platform=web-mobile"
			command: {
				bin:  "cocos"
				args: ["--project", "{out}/project", "--build", "platform=web-mobile;debug=false;md5Cache=true;buildPath={out}/build"]
				timeout_ms: 1800000
			}
			produces: ["build"]
		},
	]
	outputs: [
		{id: "bundle", glob: "build", kind: "bundle"},
		{id: "log", glob: "build.log", kind: "report"},
	]
	acceptance: [
		"out/build/web-mobile/index.html exists beside the assets and the cocos-js runtime",
		"the build step exits 0",
		"the engine.run receipt cites the project sha256, every build file sha256 and the Cocos env-lock",
	]
	receipt: {kind: "engine.run"}
	limits: {wall_ms: 1800000, cost_usd: 0}
	proven: false
}
