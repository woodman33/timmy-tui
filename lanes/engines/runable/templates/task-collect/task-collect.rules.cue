// Hot-drop rules for runable/task-collect (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "runable"
	workflow:       "task-collect"
	rules: [
		{id: "request", match: "*.collect.json", max_bytes: 1048576, action: "run", note: "one task-collect per drop"},
		{id: "too-big", match: "*.collect.json", action: "refuse", note: "over 1 MB: attach inputs by reference"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
