// Unreal · blueprint-bake — compile every Blueprint in a dropped project (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Unreal Editor on this Mac. Uses the CompileAllBlueprints commandlet.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "unreal"
	id:             "blueprint-bake"
	title:          "Compile every Blueprint in a dropped project"
	objective:      "Run the editor headless with the CompileAllBlueprints commandlet over the project dropped as a .uproject (with its folder), so every Blueprint is compiled and any error is in the log before a build is attempted. The log is the report; a non-zero exit is a failed step."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.uproject", note: "the project (its folder must sit in drop/)"}]
	steps: [{
		id:    "compile"
		title: "UnrealEditor-Cmd <uproject> -run=CompileAllBlueprints"
		command: {
			bin:  "UnrealEditor"
			args: ["{drop}", "-run=CompileAllBlueprints", "-unattended", "-nopause", "-nosplash", "-NullRHI", "-log={out}/{stem}.compile.log"]
			timeout_ms: 1800000
		}
		produces: ["{stem}.compile.log"]
	}]
	outputs: [{id: "log", glob: "*.compile.log", kind: "report"}]
	acceptance: [
		"the log reports zero Blueprint compile errors, or the step fails",
		"the log names every Blueprint compiled",
		"the engine.run receipt cites the project sha256, the log sha256 and the UnrealEditor env-lock",
	]
	receipt: {kind: "engine.run", extra: ["blueprints", "errors"]}
	limits: {wall_ms: 1800000, cost_usd: 0}
	proven: false
}
