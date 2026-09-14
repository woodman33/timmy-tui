// Hot-drop rules for houdini/karma-still (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "houdini"
	workflow:       "karma-still"
	rules: [
		{id: "subject", match: "*.{obj,ply,geo,bgeo,usd,usda,usdc,json}", max_bytes: 268435456, action: "run", note: "one subject in, one frame out"},
		{id: "too-big", match: "*.{obj,ply,geo,bgeo,usd,usda,usdc}", action: "refuse", note: "over 256 MB: render it on the Sparks"},
		{id: "textures", match: "*.{png,jpg,jpeg,exr,rat}", action: "stage", note: "textures are staged beside the scene"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
