// Hot-drop rules for cocos/web-build (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "cocos"
	workflow:       "web-build"
	rules: [
		{id: "project", match: "*.cocos.zip", max_bytes: 1073741824, action: "run", note: "a zipped Cocos Creator 3.x project"},
		{id: "scene", match: "*.scene", action: "stage", note: "loose scenes are staged; a project builds"},
		{id: "too-big", match: "*.cocos.zip", action: "refuse", note: "over 1 GB: build it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
