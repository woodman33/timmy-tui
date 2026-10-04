// Hot-drop rules for routemux/chat-receipted (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "routemux"
	workflow:       "chat-receipted"
	rules: [
		{id: "request", match: "*.routemux.json", max_bytes: 1048576, action: "run", note: "one request in, one receipted response out"},
		{id: "too-big", match: "*.routemux.json", action: "refuse", note: "over 1 MB: split the prompt or attach files by reference"},
		{id: "feed", match: "*.feed.json", action: "stage", note: "belongs to model-feed-snapshot"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
