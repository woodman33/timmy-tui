// Hot-drop rules for usd/usd-flatten (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "usd"
	workflow:       "usd-flatten"
	rules: [
		{id: "layer", match: "*.{usda,usdc,usd}", max_bytes: 536870912, action: "run", note: "a layer with references becomes one crate"},
		{id: "package", match: "*.usdz", action: "stage", note: "already a package: staged for usd-validate, not flattened"},
		{id: "too-big", match: "*.{usda,usdc,usd}", action: "refuse", note: "over 512 MB: flatten it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
