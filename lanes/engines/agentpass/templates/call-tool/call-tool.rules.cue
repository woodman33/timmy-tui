// Hot-drop rules for agentpass/call-tool (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "agentpass"
	workflow:       "call-tool"
	rules: [
		{id: "request", match: "*.call.json", max_bytes: 1048576, action: "run", note: "one brokered call per drop"},
		{id: "too-big", match: "*.call.json", action: "refuse", note: "over 1 MB: pass large inputs by reference"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
