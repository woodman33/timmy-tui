// Unreal · movie-render-queue — render a level with Movie Render Queue from the command line (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Unreal Editor on this Mac. Follows Epic's MRQ command-line rendering docs.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "unreal"
	id:             "movie-render-queue"
	title:          "Render a level through Movie Render Queue"
	objective:      "Launch the project in -game mode with a Movie Pipeline config asset (dropped as a .uasset beside the .uproject) and the PIE executor, so Movie Render Queue renders the queue unattended and writes its frames and log to out/. A queue without frames is a failed step."
	bridge:         "cli"
	inputs: [
		{id: "project", glob: "*.uproject", note: "the project (its folder must sit in drop/)"},
		{id: "config", glob: "MRQ_*.uasset", note: "a MoviePipelinePrimaryConfig asset exported into the project's Content/Shelf", required: false},
	]
	steps: [{
		id:    "render"
		title: "UnrealEditor-Cmd <uproject> <map> -game -MoviePipelineConfig=…"
		command: {
			bin:  "UnrealEditor"
			args: ["{drop}", "-game", "-MoviePipelineConfig=/Game/Shelf/MRQ_Config", "-MoviePipelineLocalExecutorClass=/Script/MovieRenderPipelineCore.MoviePipelinePIEExecutor", "-windowed", "-resx=1280", "-resy=720", "-unattended", "-nosplash", "-log={out}/{stem}.mrq.log"]
			timeout_ms: 3600000
		}
		produces: ["{stem}.mrq.log"]
	}]
	outputs: [
		{id: "log", glob: "*.mrq.log", kind: "report"},
		{id: "frames", glob: "*.{png,exr,mov,mp4}", kind: "video"},
	]
	acceptance: [
		"the log shows the pipeline reaching Finished with a non-zero frame count",
		"the frames the config names exist in out/ (the config's output directory must be out/)",
		"the engine.run receipt cites the project sha256, the log sha256, every frame sha256 and the UnrealEditor env-lock",
	]
	receipt: {kind: "engine.run", extra: ["frames", "resolution"]}
	limits: {wall_ms: 3600000, cost_usd: 0}
	proven: false
}
