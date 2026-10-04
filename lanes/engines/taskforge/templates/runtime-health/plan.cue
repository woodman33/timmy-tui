// TaskForge · runtime-health — which executors are up, and is the AgentPass hook on (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "taskforge"
	id:             "runtime-health"
	title:          "TaskForge runtime health: executors available, AgentPass hook state"
	objective:      "GET /api/runtime/health and /api/runtime/agentpass/health from the local TaskForge API, store both, and report how many executors are available (shell, docker, tmux, ollama, litellm, pinokio, gepeto, paperclip, minio, qdrant, redis, modal, agentpass, openrouter, cloudflare) and whether the AgentPass governance hook is on. The inventory every TaskForge drop assumes."
	bridge:         "api"
	inputs: [{id: "trigger", glob: "*.health.json", note: "{} is enough"}]
	steps: [
		{id: "health", title: "node bridge.mjs health → {stem}.health.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "health", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.health.json"]},
		{id: "report", title: "node bridge.mjs report → {stem}.taskforge.json", command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "runtime-health", "{out}", "{stem}"], timeout_ms: 60000}, produces: ["{stem}.taskforge.json"]},
	]
	outputs: [
		{id: "health", glob: "*.health.json", kind: "report"},
		{id: "report", glob: "*.taskforge.json", kind: "report"},
	]
	acceptance: [
		"executors and executors_available come from the API, never from a list in this repo",
		"agentpass_hook is on | off | unreachable, read from /runtime/agentpass/health",
		"API down → status=not_configured and ok:false",
	]
	receipt: {kind: "engine.run", extra: ["status", "executors", "executors_available", "agentpass_hook", "api_ms"]}
	limits: {wall_ms: 120000, cost_usd: 0}
}
