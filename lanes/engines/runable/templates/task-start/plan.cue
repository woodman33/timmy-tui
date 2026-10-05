// Runable · task-start — Start one Runable task over MCP, prediction sealed first (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "runable"
	id:             "task-start"
	title:          "Start one Runable task over MCP, prediction sealed first"
	objective:      "Discover the server's tools (tools/list is snapshotted and hashed, so a renamed tool is a visible change), seal the expected deliverable (kind, minimum files, minutes), then call the start-task tool once with the dropped prompt and record the task id. Polling and collection are separate drops, so the loop is async end to end."
	bridge:         "mcp"
	inputs: [{id: "request", glob: "*.runable.json", note: "{prompt, mode?, model?, arguments?, predict:{minutes, files_min, kind}}"}]
	steps: [
		{id: "predict", title: "node bridge.mjs predict → tools/list snapshot + expected deliverable", command: {bin: "node", args: ["{template}/../../bridge.mjs", "predict", "{drop}", "{out}", "{stem}"], timeout_ms: 120000}, produces: ["{stem}.predict.json", "{stem}.tools.json"]},
		{id: "start", title: "node bridge.mjs start → tools/call <start task> → {stem}.task.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "start", "{out}", "{stem}"], timeout_ms: 180000}, produces: ["{stem}.task.json"]},
		{id: "report", title: "node bridge.mjs report → {stem}.runable.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "task-start", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.runable.json"]},
	]
	outputs: [
		{id: "prediction", glob: "*.predict.json", kind: "report"},
		{id: "tools", glob: "*.tools.json", kind: "report"},
		{id: "task", glob: "*.task.json", kind: "report"},
		{id: "report", glob: "*.runable.json", kind: "report"},
	]
	acceptance: [
		"tools.json lists the server's tools and the report carries their names' sha256",
		"exactly one start call is made per drop and the task id is in the receipt",
		"without credentials the run seals ok:false with status=not_configured",
	]
	receipt: {kind: "engine.run", extra: ["status", "task_id", "task_status", "tool", "tools_count", "tools_sha256", "predicted_minutes", "predicted_files_min"]}
	model_policy: {requested: "runable tier as dropped", allow_paid: true, max_spend_usd: 0}
	limits: {wall_ms: 420000, cost_usd: 0}
}
