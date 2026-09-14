// Hot-drop rules for unity/test-runner (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "unity"
	workflow:       "test-runner"
	rules: [
		{id: "project", match: "*.unity.zip", max_bytes: 2147483648, action: "run", note: "a zipped Unity project with tests"},
		{id: "results", match: "*.results.xml", action: "stage", note: "results dropped back in are staged, not re-run"},
		{id: "too-big", match: "*.unity.zip", action: "refuse", note: "over 2 GB: test it on the Sparks"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
