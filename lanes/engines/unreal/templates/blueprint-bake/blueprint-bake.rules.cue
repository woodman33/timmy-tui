// Hot-drop rules for unreal/blueprint-bake (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "unreal"
	workflow:       "blueprint-bake"
	rules: [
		{id: "project", match: "*.uproject", action: "run", note: "the project descriptor; its folder rides along"},
		{id: "assets", match: "*.{uasset,umap}", action: "stage", note: "loose assets are staged, not compiled alone"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
