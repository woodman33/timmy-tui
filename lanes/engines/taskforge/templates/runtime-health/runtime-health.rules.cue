// Hot-drop rules for taskforge/runtime-health (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "taskforge"
	workflow:       "runtime-health"
	rules: [
		{id: "request", match: "*.health.json", max_bytes: 4194304, action: "run", note: "one runtime-health per drop"},
		{id: "too-big", match: "*.health.json", action: "refuse", note: "over 4 MB: TaskForge's API body limit"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
