// Hot-drop rules for agentpass/passport-issue (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "agentpass"
	workflow:       "passport-issue"
	rules: [
		{id: "request", match: "*.passport.json", max_bytes: 65536, action: "run", note: "the drop is the approval"},
		{id: "call", match: "*.call.json", action: "stage", note: "belongs to call-tool"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
