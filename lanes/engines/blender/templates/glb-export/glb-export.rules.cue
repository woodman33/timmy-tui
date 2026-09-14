// Hot-drop rules for blender/glb-export (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "blender"
	workflow:       "glb-export"
	rules: [
		{id: "source", match: "*.{obj,blend,gltf}", max_bytes: 268435456, action: "run", note: "mesh or scene in, glb out"},
		{id: "already-glb", match: "*.glb", action: "stage", note: "a glb is already the target format; staged, not re-exported"},
		{id: "too-big", match: "*.{obj,blend,gltf}", action: "refuse", note: "over 256 MB: not a laptop job"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
