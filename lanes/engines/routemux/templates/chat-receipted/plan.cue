// RouteMux · chat-receipted — one model call, predicted before it runs and reconciled after (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "routemux"
	id:             "chat-receipted"
	title:          "One receipted chat completion through the RouteMux gateway"
	objective:      "Predict tokens, cost and outcome from the dropped request, seal the prediction, send the request once with X-Idempotency-Key = request hash, record X-Request-ID and X-RouteMux-Billed, then score the prediction against usage and latency. The key stays in the environment; the receipt carries hashes and headers only."
	bridge:         "api"
	inputs: [{id: "request", glob: "*.routemux.json", note: "{model, messages[, system, max_tokens, protocol: openai|anthropic, predict:{tokens_out,cost_usd,latency_ms}]}"}]
	steps: [
		{
			id:    "predict"
			title: "node bridge.mjs predict → {stem}.predict.json (request sha256, idempotency key, predicted tokens/cost)"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "predict", "{drop}", "{out}", "{stem}", "{project}"], timeout_ms: 60000}
			produces: ["{stem}.predict.json"]
		},
		{
			id:    "call"
			title: "node bridge.mjs chat → POST /v1/chat/completions (or /anthropic/v1/messages) once"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "chat", "{out}", "{stem}"], timeout_ms: 300000}
			produces: ["{stem}.response.json", "{stem}.headers.json"]
		},
		{
			id:    "report"
			title: "node bridge.mjs report → {stem}.routemux.json (prediction vs actual)"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "chat-receipted", "{out}", "{stem}"], timeout_ms: 60000}
			produces: ["{stem}.routemux.json"]
		},
	]
	outputs: [
		{id: "prediction", glob: "*.predict.json", kind: "report"},
		{id: "response", glob: "*.response.json", kind: "report"},
		{id: "headers", glob: "*.headers.json", kind: "report"},
		{id: "report", glob: "*.routemux.json", kind: "report"},
	]
	acceptance: [
		"the prediction file exists and is hashed before the call step starts",
		"the call carries X-Idempotency-Key = timmy-<request sha256>; a replay returns 409 and is recorded as status=replayed, never billed twice",
		"the report carries request_id, billed, tokens_in/out, cost_usd, latency_ms and the error of each prediction",
		"without ROUTEMUX_API_KEY the run seals ok:false with status=not_configured (honesty clause)",
	]
	receipt: {kind: "engine.run", extra: ["status", "model", "request_id", "billed", "idempotency_key", "tokens_in", "tokens_out", "cost_usd", "cost_predicted_usd", "latency_ms"]}
	model_policy: {requested: "as dropped", allow_paid: true, max_spend_usd: 1}
	limits: {wall_ms: 420000, cost_usd: 1}
}
