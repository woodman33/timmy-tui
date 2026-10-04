// RouteMux · model-feed-snapshot — pin the public pricing feed and diff it against the last snapshot (engine-shelf/v0, service).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "routemux"
	id:             "model-feed-snapshot"
	title:          "Snapshot and diff the RouteMux public model + pricing feed"
	objective:      "GET api.routemux.com/public/pricing (no key needed), store the feed with its sha256, and diff it against the previous snapshot in this project: models added or removed and prices that changed. Later chat-receipted runs read this snapshot to predict cost."
	bridge:         "api"
	inputs: [{id: "request", glob: "*.feed.json", note: "{} or {watch:[model ids]}; the file is only the trigger"}]
	steps: [
		{
			id:    "fetch"
			title: "node bridge.mjs feed → {stem}.feed.json + {stem}.feed-diff.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "feed", "{out}", "{stem}", "{project}"], timeout_ms: 120000}
			produces: ["{stem}.feed.json", "{stem}.feed-diff.json"]
		},
		{
			id:    "report"
			title: "node bridge.mjs report → {stem}.routemux.json"
			command: {bin: "node", args: ["{template}/../../bridge.mjs", "report", "model-feed-snapshot", "{out}", "{stem}"], timeout_ms: 60000}
			produces: ["{stem}.routemux.json"]
		},
	]
	outputs: [
		{id: "feed", glob: "*.feed.json", kind: "report"},
		{id: "diff", glob: "*.feed-diff.json", kind: "report"},
		{id: "report", glob: "*.routemux.json", kind: "report"},
	]
	acceptance: [
		"the feed file's sha256 appears in the receipt as an output hash and in the report as feed_sha256",
		"added/removed/price_changes count against the previous snapshot in <project>/out/routemux/model-feed-snapshot",
		"no key is used or needed; the run works on a machine with no RouteMux account",
	]
	receipt: {kind: "engine.run", extra: ["status", "models", "feed_sha256", "feed_updated", "added", "removed", "price_changes"]}
	limits: {wall_ms: 180000, cost_usd: 0}
}
