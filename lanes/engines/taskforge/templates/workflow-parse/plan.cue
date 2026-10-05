// TaskForge · workflow-parse — prose → workflow JSON, with the confidence gate predicted first (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "taskforge"
	id:             "workflow-parse"
	title:          "Parse a plain-English task into a TaskForge workflow and score the gate prediction"
	objective:      "Seal what we expect the parser to produce (step count, executors, gate decision auto|review|clarify), POST the task to /api/parse, store the workflow JSON with its hash, and report whether steps and gate matched. The workflow file is what a later workflow-execute drop carries."
	bridge:         "api"
	inputs: [{id: "request", glob: "*.taskforge.json", note: "{task, context?, clarification?, predict:{steps, executors, gate}}"}]
	steps: [
		{id: "predict", title: "node bridge.mjs predict → {stem}.predict.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "predict", "workflow-parse", "{drop}", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.predict.json"]},
		{id: "parse", title: "POST /api/parse → {stem}.workflow.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "parse", "{out}", "{stem}", "{drop}"], timeout_ms: 300000}, produces: ["{stem}.workflow.json"]},
		{id: "report", title: "node bridge.mjs report → {stem}.taskforge.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "workflow-parse", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.taskforge.json"]},
	]
	outputs: [
		{id: "prediction", glob: "*.predict.json", kind: "report"},
		{id: "workflow", glob: "*.workflow.json", kind: "report"},
		{id: "report", glob: "*.taskforge.json", kind: "report"},
	]
	acceptance: [
		"the prediction exists before the parser is called",
		"the report carries steps, executors, gate, confidence and workflow_sha256",
		"a mock-parser answer (no Anthropic key in TaskForge) is labelled mock_parser:true, never passed off as a real parse",
	]
	receipt: {kind: "engine.run", extra: ["status", "task_id", "steps", "executors", "gate", "confidence", "steps_as_predicted", "gate_as_predicted", "workflow_sha256"]}
	limits: {wall_ms: 420000, cost_usd: 0}
}
