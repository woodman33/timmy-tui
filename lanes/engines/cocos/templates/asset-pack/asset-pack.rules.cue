// Hot-drop rules for cocos/asset-pack (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "cocos"
	workflow:       "asset-pack"
	rules: [
		{id: "project", match: "*.cocos.zip", max_bytes: 1073741824, action: "run", note: "a zipped project with Asset Bundle folders"},
		{id: "assets", match: "*.{png,jpg,jpeg,mp3,ogg}", action: "stage", note: "loose assets are staged; bundles come from a project"},
		{id: "too-big", match: "*.cocos.zip", action: "refuse", note: "over 1 GB: pack it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
