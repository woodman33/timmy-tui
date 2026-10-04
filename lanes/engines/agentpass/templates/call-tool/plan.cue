// AgentPass · call-tool — one brokered tool call, audited, with the audit delta predicted (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "agentpass"
	id:             "call-tool"
	title:          "Call one tool through the AgentPass broker and prove it was audited"
	objective:      "Read the audit count, seal the prediction (agent, tool, payload hash, expected audit delta = 1), make the brokered call with `taskforge call-tool`, read the audit count again, and report whether the broker logged exactly one event. The payload hash is checked between predict and act so the call cannot be swapped under the receipt."
	bridge:         "cli"
	inputs: [{id: "request", glob: "*.call.json", note: "{agent, tool, payload:{…}[, predict:{audit_delta, outcome}]}"}]
	steps: [
		{
			id:    "predict"
			title: "node bridge.mjs predict → {stem}.predict.json (audit count before, payload sha256)"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "predict", "call-tool", "{drop}", "{out}", "{stem}"], timeout_ms: 120000}
			produces: ["{stem}.predict.json"]
		},
		{
			id:    "call"
			title: "agentpass.py taskforge call-tool --agent --tool --payload → {stem}.call.json + status after"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "act", "call-tool", "{out}", "{stem}", "{drop}"], timeout_ms: 300000}
			produces: ["{stem}.call.json", "{stem}.status-after.json"]
		},
		{
			id:    "report"
			title: "node bridge.mjs report → {stem}.agentpass.json (audit delta as predicted?)"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "call-tool", "{out}", "{stem}"], timeout_ms: 60000}
			produces: ["{stem}.agentpass.json"]
		},
	]
	outputs: [
		{id: "prediction", glob: "*.predict.json", kind: "report"},
		{id: "call", glob: "*.call.json", kind: "report"},
		{id: "status_after", glob: "*.status-after.json", kind: "report"},
		{id: "report", glob: "*.agentpass.json", kind: "report"},
	]
	acceptance: [
		"the payload sha256 in the prediction equals the payload that was sent",
		"audit_delta_ok is true: the broker's audit count rose by exactly the predicted amount",
		"approval_required is reported from the broker's own permission metadata, not assumed",
	]
	receipt: {kind: "engine.run", extra: ["status", "agent", "tool", "approval_required", "audit_events_before", "audit_events_after", "audit_delta_ok", "result_sha256"]}
	limits: {wall_ms: 480000, cost_usd: 0}
}
