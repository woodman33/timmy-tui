// Houdini · karma-still — one Karma frame of a dropped mesh or spec (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "houdini"
	id:             "karma-still"
	title:          "Render one Karma still of a dropped mesh"
	objective:      "hython authors a small USD scene (the dropped mesh or a primitive from a .json spec, a camera framed on the bounding sphere, a dome and a key light, RenderSettings at /Render/settings), husk renders ONE 512×384 frame with Karma CPU, and a report step verifies the PNG and records the render time. Apprentice licence: the frame carries the Houdini watermark, and the report says so."
	bridge:         "cli"
	inputs: [{id: "subject", glob: "*.{obj,ply,geo,bgeo,usd,usda,usdc,json}", note: "a mesh, a USD layer, or a .json spec"}]
	steps: [
		{
			id:    "author"
			title: "hython author.py → {stem}.karma.usdc"
			command: {
				bin:  "hython"
				args: ["{template}/author.py", "{drop}", "{out}", "{stem}"]
				env:  {HOUDINI_USER_PREF_DIR: "{out}/.houdini-prefs"}
				timeout_ms: 600000
			}
			produces: ["{stem}.karma.usdc", "{stem}.karma.json"]
		},
		{
			id:    "render"
			title: "husk --settings /Render/settings → {stem}.karma.png"
			command: {
				bin:  "husk"
				args: ["--output", "{out}/{stem}.karma.png", "--camera", "/shelf_rig/cam", "--settings", "/Render/settings", "--verbose", "2", "{out}/{stem}.karma.usdc"]
				env:  {HOUDINI_USER_PREF_DIR: "{out}/.houdini-prefs"}
				timeout_ms: 900000
			}
			produces: ["{stem}.karma.png"]
		},
		{
			id:    "report"
			title: "node report.mjs (PNG check + render timing)"
			command: {
				bin:  "/opt/homebrew/bin/node"
				args: ["{template}/report.mjs", "{out}", "{stem}"]
				timeout_ms: 60000
			}
			produces: ["{stem}.karma.json"]
		},
	]
	outputs: [
		{id: "still", glob: "*.karma.png", kind: "image"},
		{id: "scene", glob: "*.karma.usdc", kind: "usd"},
		{id: "report", glob: "*.karma.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.karma.png is a PNG whose size matches the authored resolution",
		"out/<stem>.karma.json carries render_ok:true and the husk wall-clock time",
		"the engine.run receipt cites the input sha256, the still sha256 and the Houdini env-lock (hython, husk)",
	]
	receipt: {kind: "engine.run", extra: ["render_ok", "resolution", "license"]}
	limits: {wall_ms: 1500000, cost_usd: 0}
}
