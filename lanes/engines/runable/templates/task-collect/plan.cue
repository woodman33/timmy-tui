// Runable · task-collect — Download a finished task's files and hash them (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "runable"
	id:             "task-collect"
	title:          "Download a finished task's files and hash them"
	objective:      "Call the files tool for the task id, download every URL it lists (and save any inline resources), hash each file and the file set, and report whether at least the predicted minimum number of files arrived."
	bridge:         "mcp"
	inputs: [{id: "request", glob: "*.collect.json", note: "{task_id}"}]
	steps: [
		{id: "collect", title: "node bridge.mjs collect → files/* + {stem}.files.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "collect", "{out}", "{stem}", "{drop}"], timeout_ms: 600000}, produces: ["{stem}.files.json"]},
		{id: "report", title: "node bridge.mjs report → {stem}.runable.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "task-collect", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.runable.json"]},
	]
	outputs: [
		{id: "files", glob: "*.files.json", kind: "report"},
		{id: "report", glob: "*.runable.json", kind: "report"},
	]
	acceptance: [
		"every downloaded file is hashed; the receipt carries the file-set sha256",
		"files_as_predicted is true only when at least files_min files arrived",
		"nothing is re-downloaded on a second drop with the same task id without a new receipt",
	]
	receipt: {kind: "engine.run", extra: ["status", "task_id", "files", "bytes", "files_sha256", "predicted_files_min", "files_as_predicted"]}
	model_policy: {requested: "runable tier as dropped", allow_paid: true, max_spend_usd: 0}
	limits: {wall_ms: 660000, cost_usd: 0}
}
