// Blender · render-still — one still frame of a dropped mesh (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "blender"
	id:             "render-still"
	title:          "Render a still of a dropped mesh"
	objective:      "Import a mesh dropped into the project (OBJ, glTF/GLB or a .blend), frame it with a camera and a key light, render one PNG with EEVEE, and leave the render and the scene beside it in out/."
	bridge:         "cli"
	inputs: [{id: "mesh", glob: "*.{obj,glb,gltf,blend}", note: "one mesh file; .blend is opened, the others are imported into a fresh scene"}]
	steps: [{
		id:    "render"
		title: "blender -b --python script.py"
		command: {
			bin:  "blender"
			args: ["-b", "--factory-startup", "--python", "{template}/script.py", "--", "{drop}", "{out}", "{stem}"]
			timeout_ms: 600000
		}
		produces: ["{stem}.render.png", "{stem}.blend", "{stem}.render.json"]
	}]
	outputs: [
		{id: "still", glob: "*.render.png", kind: "image"},
		{id: "scene", glob: "*.blend", kind: "archive"},
		{id: "report", glob: "*.render.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.render.png exists and is a PNG of the configured size",
		"out/<stem>.render.json names the imported object count, the camera and the resolution",
		"the engine.run receipt cites the input sha256, every output sha256 and the Blender env-lock",
	]
	receipt: {kind: "engine.run", extra: ["objects", "resolution", "render_engine"]}
	limits: {wall_ms: 600000, cost_usd: 0}
}
