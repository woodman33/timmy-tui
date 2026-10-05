// Hot-drop rules for routemux/model-feed-snapshot (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "routemux"
	workflow:       "model-feed-snapshot"
	rules: [
		{id: "trigger", match: "*.feed.json", max_bytes: 65536, action: "run", note: "any small JSON trigger snapshots the feed"},
		{id: "request", match: "*.routemux.json", action: "stage", note: "belongs to chat-receipted"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
