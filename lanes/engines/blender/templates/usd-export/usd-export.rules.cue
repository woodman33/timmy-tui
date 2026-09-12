// Hot-drop rules for blender/usd-export (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "blender"
	workflow:       "usd-export"
	rules: [
		{id: "source", match: "*.{obj,blend,gltf,glb}", max_bytes: 268435456, action: "run", note: "mesh or scene in, usdc out"},
		{id: "already-usd", match: "*.{usd,usda,usdc,usdz}", action: "stage", note: "already USD: staged for the usd engine, not re-exported"},
		{id: "too-big", match: "*.{obj,blend,gltf,glb}", action: "refuse", note: "over 256 MB: not a laptop job"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
