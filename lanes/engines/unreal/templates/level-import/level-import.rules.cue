// Hot-drop rules for unreal/level-import (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "unreal"
	workflow:       "level-import"
	rules: [
		{id: "mesh", match: "*.{fbx,obj}", sidecar: "*.uproject", max_bytes: 1073741824, action: "run", note: "a mesh with a project beside it"},
		{id: "project", match: "*.uproject", action: "stage", note: "a project on its own waits for a mesh"},
		{id: "too-big", match: "*.{fbx,obj}", action: "refuse", note: "over 1 GB: not a laptop import"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
