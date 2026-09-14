// Hot-drop rules for unity/batch-build (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "unity"
	workflow:       "batch-build"
	rules: [
		{id: "project", match: "*.unity.zip", max_bytes: 2147483648, action: "run", note: "a zipped Unity project"},
		{id: "package", match: "*.unitypackage", action: "stage", note: "packages go to asset-import"},
		{id: "too-big", match: "*.unity.zip", action: "refuse", note: "over 2 GB: build it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
