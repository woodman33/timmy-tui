// Hot-drop rules for unity/asset-import (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "unity"
	workflow:       "asset-import"
	rules: [
		{id: "package", match: "*.unitypackage", sidecar: "*.unity.zip", max_bytes: 1073741824, action: "run", note: "a package with its project beside it"},
		{id: "project", match: "*.unity.zip", action: "stage", note: "a project alone waits for a package (or goes to batch-build)"},
		{id: "too-big", match: "*.unitypackage", action: "refuse", note: "over 1 GB: import it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
