// Hot-drop rules for blender/render-still (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "blender"
	workflow:       "render-still"
	rules: [
		{id: "mesh", match: "*.{obj,glb,gltf,blend}", max_bytes: 268435456, action: "run", note: "one mesh in, one still out"},
		{id: "too-big", match: "*.{obj,glb,gltf,blend}", action: "refuse", note: "over 256 MB: render it on the Sparks, not the laptop"},
		{id: "textures", match: "*.{png,jpg,jpeg,exr}", action: "stage", note: "textures are staged beside the mesh and picked up by the import"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
