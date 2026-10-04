// Hot-drop rules for runable/task-start (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "runable"
	workflow:       "task-start"
	rules: [
		{id: "request", match: "*.runable.json", max_bytes: 1048576, action: "run", note: "one task-start per drop"},
		{id: "too-big", match: "*.runable.json", action: "refuse", note: "over 1 MB: attach inputs by reference"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
