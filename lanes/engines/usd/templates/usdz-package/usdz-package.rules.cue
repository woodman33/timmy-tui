// Hot-drop rules for usd/usdz-package (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "usd"
	workflow:       "usdz-package"
	rules: [
		{id: "layer", match: "*.{usda,usdc,usd}", max_bytes: 536870912, action: "run", note: "one layer in, one package out"},
		{id: "already-usdz", match: "*.usdz", action: "stage", note: "already packaged: staged for usd-validate"},
		{id: "assets", match: "*.{png,jpg,jpeg,exr}", action: "stage", note: "referenced textures ride along in the package"},
		{id: "too-big", match: "*.{usda,usdc,usd}", action: "refuse", note: "over 512 MB: not a laptop package"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
