// Hot-drop rules for taskforge/workflow-execute (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "taskforge"
	workflow:       "workflow-execute"
	rules: [
		{id: "request", match: "*.execute.json", max_bytes: 4194304, action: "run", note: "one workflow-execute per drop"},
		{id: "too-big", match: "*.execute.json", action: "refuse", note: "over 4 MB: TaskForge's API body limit"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
