// Hot-drop rules for houdini/usd-export (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "houdini"
	workflow:       "usd-export"
	rules: [
		{id: "mesh", match: "*.{obj,ply,geo,bgeo,bgeo.sc}", max_bytes: 268435456, action: "run", note: "one mesh in, one crate out"},
		{id: "already-usd", match: "*.{usd,usda,usdc,usdz}", action: "stage", note: "already USD: staged for the usd engine"},
		{id: "too-big", match: "*.{obj,ply,geo,bgeo,bgeo.sc}", action: "refuse", note: "over 256 MB: export it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
