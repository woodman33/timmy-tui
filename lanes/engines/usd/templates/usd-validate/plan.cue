// USD · usd-validate — parse-check a dropped layer with Apple's usdcat (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "usd"
	id:             "usd-validate"
	title:          "Validate a dropped USD layer"
	objective:      "Load a dropped .usda/.usdc/.usdz with usdcat --loadOnly, read the layer metadata and the composed prim list, and write a report that says ok or names the errors. A layer that does not load is a failed step, and the report still lands."
	bridge:         "cli"
	inputs: [{id: "layer", glob: "*.{usda,usdc,usd,usdz}", note: "one USD layer or package"}]
	steps: [{
		id:    "validate"
		title: "usdcat --loadOnly + metadata"
		command: {
			bin:  "/opt/homebrew/bin/node"
			args: ["{template}/run.mjs", "{drop}", "{out}", "{stem}"]
			timeout_ms: 300000
		}
		produces: ["{stem}.validate.json"]
	}]
	outputs: [{id: "report", glob: "*.validate.json", kind: "report"}]
	acceptance: [
		"out/<stem>.validate.json exists with ok:true, the usdcat version, the prim count and the default prim",
		"a layer that fails to load leaves ok:false with the usdcat errors and the step fails",
		"the engine.run receipt cites the layer sha256, the report sha256 and the USD tools env-lock",
	]
	receipt: {kind: "engine.run", extra: ["prims", "default_prim", "up_axis"]}
	limits: {wall_ms: 300000, cost_usd: 0}
}
