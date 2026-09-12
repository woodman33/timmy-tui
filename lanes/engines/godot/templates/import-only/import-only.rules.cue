// Hot-drop rules for godot/import-only (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "godot"
	workflow:       "import-only"
	rules: [
		{id: "project", match: "*.godot.zip", max_bytes: 1073741824, action: "run", note: "a zipped Godot 4 project"},
		{id: "asset", match: "*.{png,wav,ogg,glb,gltf}", action: "stage", note: "loose assets are staged; a project imports"},
		{id: "too-big", match: "*.godot.zip", action: "refuse", note: "over 1 GB: import it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
