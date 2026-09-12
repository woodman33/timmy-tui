// Hot-drop rules for unreal/movie-render-queue (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "unreal"
	workflow:       "movie-render-queue"
	rules: [
		{id: "project", match: "*.uproject", sidecar: "MRQ_*.uasset", action: "run", note: "a project with its queue config beside it"},
		{id: "config", match: "MRQ_*.uasset", action: "stage", note: "a config alone waits for its project"},
		{id: "video", match: "*.{mp4,mov}", action: "refuse", note: "MRQ renders from a level, not from a video"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
