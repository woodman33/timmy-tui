// Blender · glb-export — a dropped mesh or scene becomes one .glb (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "blender"
	id:             "glb-export"
	title:          "Export a dropped mesh or scene as glTF binary"
	objective:      "Open a .blend or import an OBJ/glTF dropped into the project, apply transforms, and export a single .glb with a JSON report of what went in and what came out, for the web companion and the Slate 3D viewer."
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
		produces: ["{stem}.glb", "{stem}.glb.json"]
	}]
	outputs: [
		{id: "glb", glob: "*.glb", kind: "mesh"},
		{id: "report", glob: "*.glb.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.glb exists and starts with the glTF binary magic",
		"out/<stem>.glb.json names the object count and vertex count exported",
		"the engine.run receipt cites the input sha256, the glb sha256 and the Blender env-lock",
	]
	receipt: {kind: "engine.run", extra: ["objects", "vertices", "glb_bytes"]}
	limits: {wall_ms: 600000, cost_usd: 0}
}
