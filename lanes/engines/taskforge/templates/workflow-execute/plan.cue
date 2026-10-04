// TaskForge · workflow-execute — run a parsed workflow and capture its event stream (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "taskforge"
	id:             "workflow-execute"
	title:          "Execute a TaskForge workflow, stream its logs, score the prediction"
	objective:      "Seal the expectation (steps, executors, minutes, failures) and the workflow hash, POST /api/execute with the dropped {taskId, workflow}, capture GET /api/logs/stream/:taskId (SSE) into a hashed JSONL log while polling /api/status/:taskId, and report the terminal status, failed steps and minutes against the prediction. autoAccept is honoured, userApproved only when the operator wrote it into the drop."
	bridge:         "api"
	inputs: [{id: "request", glob: "*.execute.json", note: "{taskId, workflow, autoAccept?, userApproved?, max_minutes?, predict:{minutes, failures}} — copy taskId + workflow from a workflow-parse response"}]
	steps: [
		{id: "predict", title: "node bridge.mjs predict → {stem}.predict.json (workflow sha256, expected steps/minutes/failures)", command: {bin: "node", args: ["{template}/../../bridge.mjs", "predict", "workflow-execute", "{drop}", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.predict.json"]},
		{id: "execute", title: "POST /api/execute + SSE /api/logs/stream → {stem}.events.jsonl, {stem}.result.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "execute", "{out}", "{stem}", "{drop}"], timeout_ms: 2100000}, produces: ["{stem}.events.jsonl", "{stem}.result.json"]},
		{id: "report", title: "node bridge.mjs report → {stem}.taskforge.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "workflow-execute", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.taskforge.json"]},
	]
	outputs: [
		{id: "prediction", glob: "*.predict.json", kind: "report"},
		{id: "events", glob: "*.events.jsonl", kind: "text"},
		{id: "result", glob: "*.result.json", kind: "report"},
		{id: "report", glob: "*.taskforge.json", kind: "report"},
	]
	acceptance: [
		"the workflow hash in the prediction equals the workflow that was executed",
		"every SSE event is logged with a timestamp and sha256; the receipt carries the event count",
		"a run that hits the cap seals status=timed_out; failures_as_predicted compares failed steps with the prediction",
	]
	receipt: {kind: "engine.run", extra: ["status", "task_id", "task_status", "steps", "steps_failed", "events", "minutes", "predicted_minutes", "failures_as_predicted"]}
	limits: {wall_ms: 2220000, cost_usd: 0}
}
