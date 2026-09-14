// Hot-drop rules for godot/gdscript-run (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "godot"
	workflow:       "gdscript-run"
	rules: [
		{id: "script", match: "*.gd", max_bytes: 1048576, action: "run", note: "one standalone script"},
		{id: "scene", match: "*.tscn", action: "stage", note: "scenes need a project; staged"},
		{id: "too-big", match: "*.gd", action: "refuse", note: "over 1 MB is not a script"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
