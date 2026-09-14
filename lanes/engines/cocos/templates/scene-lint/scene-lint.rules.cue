// Hot-drop rules for cocos/scene-lint (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "cocos"
	workflow:       "scene-lint"
	rules: [
		{id: "project", match: "*.cocos.zip", max_bytes: 1073741824, action: "run", note: "a zipped Cocos Creator project"},
		{id: "scene", match: "*.scene", action: "stage", note: "a scene alone has no library to lint against; staged"},
		{id: "too-big", match: "*.cocos.zip", action: "refuse", note: "over 1 GB: lint it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
