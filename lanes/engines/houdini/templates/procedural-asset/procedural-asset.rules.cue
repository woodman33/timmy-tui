// Hot-drop rules for houdini/procedural-asset (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "houdini"
	workflow:       "procedural-asset"
	rules: [
		{id: "base", match: "*.{obj,json}", max_bytes: 268435456, action: "run", note: "a base mesh or a params spec"},
		{id: "too-big", match: "*.obj", action: "refuse", note: "over 256 MB: build it on the Sparks"},
		{id: "textures", match: "*.{png,jpg,jpeg,exr}", action: "stage", note: "textures are staged beside the asset"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
