// Hot-drop rules for runable/task-poll (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "runable"
	workflow:       "task-poll"
	rules: [
		{id: "request", match: "*.poll.json", max_bytes: 1048576, action: "run", note: "one task-poll per drop"},
		{id: "too-big", match: "*.poll.json", action: "refuse", note: "over 1 MB: attach inputs by reference"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
