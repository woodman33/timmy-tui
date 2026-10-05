// AgentPass · broker-health — is the authority layer up, and what does it govern (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "agentpass"
	id:             "broker-health"
	title:          "AgentPass broker health and inventory (packs, tools, audit, approvals)"
	objective:      "Run the AgentPass TaskForge-bridge CLI twice — `taskforge health` and `taskforge status` — store both JSON answers, and report mode, fake mode, broker availability and the pack/tool/audit/approval counts. This is the lane's smoke test and the inventory every other AgentPass template assumes."
	bridge:         "cli"
	inputs: [{id: "trigger", glob: "*.health.json", note: "{} is enough; the file is the trigger"}]
	steps: [
		{
			id:    "health"
			title: "agentpass.py taskforge health → {stem}.health.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "cli", "{out}", "{stem}.health.json", "taskforge", "health"], timeout_ms: 120000}
			produces: ["{stem}.health.json"]
		},
		{
			id:    "status"
			title: "agentpass.py taskforge status → {stem}.status.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "cli", "{out}", "{stem}.status.json", "taskforge", "status"], timeout_ms: 120000}
			produces: ["{stem}.status.json"]
		},
		{
			id:    "report"
			title: "node bridge.mjs report → {stem}.agentpass.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "broker-health", "{out}", "{stem}"], timeout_ms: 60000}
			produces: ["{stem}.agentpass.json"]
		},
	]
	outputs: [
		{id: "health", glob: "*.health.json", kind: "report"},
		{id: "status", glob: "*.status.json", kind: "report"},
		{id: "report", glob: "*.agentpass.json", kind: "report"},
	]
	acceptance: [
		"health.ok and status.ok are both true in the stored JSON",
		"the report carries mode, fake_mode, packs, tools, audit_events and pending_approvals",
		"without the AgentPass repo (AGENTPASS_REPO_PATH) the run seals ok:false with status=not_configured",
	]
	receipt: {kind: "engine.run", extra: ["status", "mode", "fake_mode", "broker_available", "packs", "tools", "audit_events", "pending_approvals"]}
	limits: {wall_ms: 300000, cost_usd: 0}
}
