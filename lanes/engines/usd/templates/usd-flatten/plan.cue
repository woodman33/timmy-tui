// USD · usd-flatten — compose a dropped layer into one self-contained crate (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "usd"
	id:             "usd-flatten"
	title:          "Flatten a dropped USD layer"
	objective:      "Compose the dropped layer with usdcat --flatten into one binary crate that carries every sublayer, reference and variant selection baked in, re-load the result, count its prims, and write a report. The flattened file is what travels to an engine that should not chase references."
	bridge:         "cli"
	inputs: [{id: "layer", glob: "*.{usda,usdc,usd}", note: "one USD layer; usdz packages are not flattened here"}]
	steps: [{
		id:    "flatten"
		title: "usdcat --flatten → {stem}.flat.usdc"
		command: {
			bin:  "/opt/homebrew/bin/node"
			args: ["{template}/run.mjs", "{drop}", "{out}", "{stem}"]
			timeout_ms: 300000
		}
		produces: ["{stem}.flat.usdc", "{stem}.flat.json"]
	}]
	outputs: [
		{id: "flat", glob: "*.flat.usdc", kind: "usd"},
		{id: "report", glob: "*.flat.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.flat.usdc exists and re-loads with usdcat",
		"out/<stem>.flat.json names the prim count before and after flattening",
		"the engine.run receipt cites the layer sha256, the crate sha256 and the USD tools env-lock",
	]
	receipt: {kind: "engine.run", extra: ["prims", "flat_bytes"]}
	limits: {wall_ms: 300000, cost_usd: 0}
}
