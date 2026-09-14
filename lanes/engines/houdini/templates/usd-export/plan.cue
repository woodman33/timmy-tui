// Houdini · usd-export — a dropped mesh becomes one USD crate through hython (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "houdini"
	id:             "usd-export"
	title:          "Export a dropped mesh to USD with hython"
	objective:      "hython loads the dropped mesh through a File SOP (anything Houdini reads: obj, ply, geo, bgeo), converts to polygons, adds vertex normals, and writes one UsdGeom.Mesh to a .usdc through pxr directly, then re-opens the stage to check the face count. The LOP USD ROP is avoided on purpose: under Apprentice it silently renames its output to .usdnc."
	bridge:         "cli"
	inputs: [{id: "mesh", glob: "*.{obj,ply,geo,bgeo,bgeo.sc}", note: "one mesh file"}]
	steps: [{
		id:    "export"
		title: "hython script.py → {stem}.usdc"
		command: {
			bin:  "hython"
			args: ["{template}/script.py", "{drop}", "{out}", "{stem}"]
			env:  {HOUDINI_USER_PREF_DIR: "{out}/.houdini-prefs"}
			timeout_ms: 600000
		}
		produces: ["{stem}.usdc", "{stem}.usd.json"]
	}]
	outputs: [
		{id: "usd", glob: "*.usdc", kind: "usd"},
		{id: "report", glob: "*.usd.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.usdc exists and re-opens with the same face count the report names",
		"out/<stem>.usd.json names points, faces and the prim path",
		"the engine.run receipt cites the input sha256, the usdc sha256 and the Houdini env-lock",
	]
	receipt: {kind: "engine.run", extra: ["points", "faces", "prim"]}
	limits: {wall_ms: 600000, cost_usd: 0}
}
