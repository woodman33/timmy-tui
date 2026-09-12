// USD · usdz-package — pack a dropped layer into a .usdz (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "usd"
	id:             "usdz-package"
	title:          "Package a dropped USD layer as usdz"
	objective:      "Pack the dropped layer and the assets it references into one .usdz with usdzip, list the package entries, re-load it with usdcat, and write a report. The .usdz is the drop-in for AR Quick Look, the companion and any viewer that wants one file."
	bridge:         "cli"
	inputs: [{id: "layer", glob: "*.{usda,usdc,usd}", note: "one USD layer; referenced assets must sit beside it in drop/"}]
	steps: [{
		id:    "package"
		title: "usdzip --asset → {stem}.usdz"
		command: {
			bin:  "/opt/homebrew/bin/node"
			args: ["{template}/run.mjs", "{drop}", "{out}", "{stem}"]
			timeout_ms: 300000
		}
		produces: ["{stem}.usdz", "{stem}.usdz.json"]
	}]
	outputs: [
		{id: "usdz", glob: "*.usdz", kind: "archive"},
		{id: "report", glob: "*.usdz.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.usdz exists, lists its entries and re-loads with usdcat",
		"out/<stem>.usdz.json names the entry count and the root layer",
		"the engine.run receipt cites the layer sha256, the package sha256 and the USD tools env-lock",
	]
	receipt: {kind: "engine.run", extra: ["entry_count", "root_layer", "compliance"]}
	limits: {wall_ms: 300000, cost_usd: 0}
}
