// Hot-drop rules for usd/usd-validate (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "usd"
	workflow:       "usd-validate"
	rules: [
		{id: "layer", match: "*.{usda,usdc,usd,usdz}", max_bytes: 536870912, action: "run", note: "any USD layer or package is checked"},
		{id: "too-big", match: "*.{usda,usdc,usd,usdz}", action: "refuse", note: "over 512 MB: check it on the Sparks"},
		{id: "textures", match: "*.{png,jpg,jpeg,exr}", action: "stage", note: "textures the layer references are staged beside it"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
