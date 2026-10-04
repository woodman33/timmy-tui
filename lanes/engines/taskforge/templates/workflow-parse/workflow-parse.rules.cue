// Hot-drop rules for taskforge/workflow-parse (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "taskforge"
	workflow:       "workflow-parse"
	rules: [
		{id: "request", match: "*.taskforge.json", max_bytes: 4194304, action: "run", note: "one workflow-parse per drop"},
		{id: "too-big", match: "*.taskforge.json", action: "refuse", note: "over 4 MB: TaskForge's API body limit"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
