// Blender · usd-export — a dropped mesh or scene becomes one .usdc (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "blender"
	id:             "usd-export"
	title:          "Export a dropped mesh or scene as OpenUSD"
	objective:      "Open or import the dropped file and write a single binary USD stage (.usdc) with a report, so the same asset can travel to Houdini, the USD tools and the Sparks without a Blender in the loop."
	bridge:         "cli"
	inputs: [{id: "source", glob: "*.{obj,blend,gltf,glb}", note: "one mesh or scene file"}]
	steps: [{
		id:    "export"
		title: "blender -b --python script.py"
		command: {
			bin:  "blender"
			args: ["-b", "--factory-startup", "--python", "{template}/script.py", "--", "{drop}", "{out}", "{stem}"]
			timeout_ms: 600000
		}
		produces: ["{stem}.usdc", "{stem}.usd.json"]
	}]
	outputs: [
		{id: "usd", glob: "*.usdc", kind: "usd"},
		{id: "report", glob: "*.usd.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.usdc exists and begins with the USD crate magic PXR-USDC",
		"out/<stem>.usd.json names the object count and the exported prim paths",
		"the engine.run receipt cites the input sha256, the usdc sha256 and the Blender env-lock",
	]
	receipt: {kind: "engine.run", extra: ["objects", "prims", "usd_bytes"]}
	limits: {wall_ms: 600000, cost_usd: 0}
}
