// Runable · task-poll — Poll a Runable task until it finishes, within a time cap (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "runable"
	id:             "task-poll"
	title:          "Poll a Runable task until it finishes, within a time cap"
	objective:      "Read the task id from the drop (or from a start in the same folder), call the progress tool every N seconds, append every answer to a JSONL log with its hash, and stop on done, failed or the cap. The report scores the predicted minutes against the measured ones."
	bridge:         "mcp"
	inputs: [{id: "request", glob: "*.poll.json", note: "{task_id, max_minutes?, every_seconds?}"}]
	steps: [
		{id: "poll", title: "node bridge.mjs poll → {stem}.progress.jsonl + {stem}.final.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "poll", "{out}", "{stem}", "{drop}"], timeout_ms: 1500000}, produces: ["{stem}.progress.jsonl", "{stem}.final.json"]},
		{id: "report", title: "node bridge.mjs report → {stem}.runable.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "task-poll", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.runable.json"]},
	]
	outputs: [
		{id: "progress", glob: "*.progress.jsonl", kind: "text"},
		{id: "final", glob: "*.final.json", kind: "report"},
		{id: "report", glob: "*.runable.json", kind: "report"},
	]
	acceptance: [
		"every progress answer is logged with a timestamp and sha256 before the next poll",
		"the run seals ok:false with status=timed_out when the cap is reached — a slow task is a finding, not a success",
		"minutes_error_pct compares the operator's predicted minutes with the measured wall time",
	]
	receipt: {kind: "engine.run", extra: ["status", "task_id", "task_status", "polls", "minutes", "predicted_minutes", "minutes_error_pct"]}
	model_policy: {requested: "runable tier as dropped", allow_paid: true, max_spend_usd: 0}
	limits: {wall_ms: 1560000, cost_usd: 0}
}
