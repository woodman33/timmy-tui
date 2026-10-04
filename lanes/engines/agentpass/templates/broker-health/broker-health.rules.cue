// Hot-drop rules for agentpass/broker-health (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "agentpass"
	workflow:       "broker-health"
	rules: [
		{id: "trigger", match: "*.health.json", max_bytes: 65536, action: "run", note: "smoke test + inventory"},
		{id: "passport", match: "*.passport.json", action: "stage", note: "belongs to passport-issue"},
		{id: "call", match: "*.call.json", action: "stage", note: "belongs to call-tool"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
