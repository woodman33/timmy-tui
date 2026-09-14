// Hot-drop rules for godot/headless-export (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "godot"
	workflow:       "headless-export"
	rules: [
		{id: "project", match: "*.godot.zip", max_bytes: 1073741824, action: "run", note: "a zipped Godot 4 project with export presets"},
		{id: "scene", match: "*.{tscn,gd}", action: "stage", note: "loose scenes and scripts are staged; a project exports"},
		{id: "too-big", match: "*.godot.zip", action: "refuse", note: "over 1 GB: export it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
