// AgentPass · passport-issue — issue a scoped, time-boxed, budgeted passport and prove it matches the request (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "agentpass"
	id:             "passport-issue"
	title:          "Issue an AgentPass passport for one agent, one tool, one scope, one budget"
	objective:      "Seal the expected passport (agent, tool, scope, ttl, budget) from the dropped request first, then call `taskforge passport issue` and check field by field that the passport AgentPass returned is the one that was asked for. Dropping the request is the operator's approval; the receipt proves nothing wider was granted."
	bridge:         "cli"
	inputs: [{id: "request", glob: "*.passport.json", note: "{agent, tool, scope, ttl, budget[, predict:{outcome}]}"}]
	steps: [
		{
			id:    "predict"
			title: "node bridge.mjs predict → {stem}.predict.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "predict", "passport-issue", "{drop}", "{out}", "{stem}"], timeout_ms: 60000}
			produces: ["{stem}.predict.json"]
		},
		{
			id:    "issue"
			title: "agentpass.py taskforge passport issue --agent --tool --scope --ttl --budget → {stem}.passport.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "act", "passport-issue", "{out}", "{stem}", "{drop}"], timeout_ms: 180000}
			produces: ["{stem}.passport.json"]
		},
		{
			id:    "report"
			title: "node bridge.mjs report → {stem}.agentpass.json (fields as predicted?)"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "passport-issue", "{out}", "{stem}"], timeout_ms: 60000}
			produces: ["{stem}.agentpass.json"]
		},
	]
	outputs: [
		{id: "prediction", glob: "*.predict.json", kind: "report"},
		{id: "passport", glob: "*.passport.json", kind: "report"},
		{id: "report", glob: "*.agentpass.json", kind: "report"},
	]
	acceptance: [
		"the prediction is sealed before the passport exists",
		"fields_as_predicted is true only when agent, tool, scope, ttl and budget are all present in the passport and match the request exactly; a missing field is a mismatch (status=mismatch, ok:false), never a pass",
		"the passport's sha256 is in the report; the passport itself never leaves the project",
	]
	receipt: {kind: "engine.run", extra: ["status", "agent", "tool", "scope", "ttl", "budget_usd", "passport_id", "fields_as_predicted", "fields_missing"]}
	limits: {wall_ms: 300000, cost_usd: 0}
}
