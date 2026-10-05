// RouteMux · balance-reconcile — read the wallet and key spend, compare with what the receipts predicted (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "routemux"
	id:             "balance-reconcile"
	title:          "Reconcile RouteMux spend against Timmy's predictions"
	objective:      "GET /v1/user/balance, /v1/key/info and /v1/account/info with the lane key, store the raw answers, and compare observed spend with the predicted spend carried by the dropped *.reconcile.json as expected_spend_usd (the sum of cost_predicted_usd over the chat-receipted receipts being reconciled; TIMMY_EXPECTED_SPEND_USD is only a fallback when the drop carries none). Within 5% or 1 cent counts as reconciled."
	bridge:         "api"
	inputs: [{id: "request", glob: "*.reconcile.json", note: "{expected_spend_usd?, since?}; the file is the trigger and carries the operator's expectation"}]
	steps: [
		{
			id:    "read"
			title: "node bridge.mjs balance → {stem}.balance.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "balance", "{out}", "{stem}", "{drop}"], timeout_ms: 60000}
			produces: ["{stem}.balance.json"]
		},
		{
			id:    "report"
			title: "node bridge.mjs report → {stem}.routemux.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "balance-reconcile", "{out}", "{stem}"], timeout_ms: 60000}
			produces: ["{stem}.routemux.json"]
		},
	]
	outputs: [
		{id: "balance", glob: "*.balance.json", kind: "report"},
		{id: "report", glob: "*.routemux.json", kind: "report"},
	]
	acceptance: [
		"balance_usd and spend_observed_usd are read from the gateway, never typed in",
		"spend_predicted_usd is the drop's expected_spend_usd (source=drop), else TIMMY_EXPECTED_SPEND_USD (source=env), else null — never invented",
		"reconciled is true only when |predicted − observed| ≤ max(0.01, 5% of predicted)",
		"without ROUTEMUX_API_KEY the run seals ok:false with status=not_configured",
	]
	receipt: {kind: "engine.run", extra: ["status", "balance_usd", "spend_observed_usd", "spend_predicted_usd", "spend_predicted_source", "reconciled", "request_id"]}
	limits: {wall_ms: 120000, cost_usd: 0}
}
