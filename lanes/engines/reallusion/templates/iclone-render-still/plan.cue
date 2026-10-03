// Reallusion iClone 8 · render-still — one rendered frame from a dropped project or asset (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "reallusion"
	id:             "iclone-render-still"
	title:          "Render one still frame from an iClone 8 project or imported asset"
	objective:      "iClonepy loads the dropped .iProject or imports the dropped .fbx/.obj, configures camera + resolution + lights via RLPy, calls RGlobal.RenderImage to produce one PNG, and a report step verifies the output. Requires iClone 8 running with Python API plugin active."
	bridge:         "cli"
	inputs: [{id: "project_or_asset", glob: "*.{iProject,fbx,obj,3dx}", note: "an iClone project or importable 3D asset"}]
	steps: [
		{
			id:    "load"
			title: "iClonepy.exe load_scene.py → scene loaded"
			command: {
				bin:  "C:\\Program Files\\Reallusion\\iClone 8\\Bin64\\iClonepy.exe"
				args: ["{template}/load_scene.py", "{drop}", "{out}"]
				timeout_ms: 300000
			}
			produces: ["{stem}.scene.json"]
		},
		{
			id:    "configure"
			title: "iClonepy.exe setup_render.py → render settings applied"
			command: {
				bin:  "C:\\Program Files\\Reallusion\\iClone 8\\Bin64\\iClonepy.exe"
				args: ["{template}/setup_render.py", "{out}", "{stem}"]
				timeout_ms: 120000
			}
			produces: ["{stem}.config.json"]
		},
		{
			id:    "render"
			title: "iClonepy.exe render_still.py → {stem}.iclone.png"
			command: {
				bin:  "C:\\Program Files\\Reallusion\\iClone 8\\Bin64\\iClonepy.exe"
				args: ["{template}/render_still.py", "{out}", "{stem}"]
				timeout_ms: 600000
			}
			produces: ["{stem}.iclone.png"]
		},
		{
			id:    "report"
			title: "node report.mjs (PNG check + render timing)"
			command: {
				bin:  "node"
				args: ["{template}/report.mjs", "{out}", "{stem}"]
				timeout_ms: 60000
			}
			produces: ["{stem}.iclone.json"]
		},
	]
	outputs: [
		{id: "still", glob: "*.iclone.png", kind: "image"},
		{id: "report", glob: "*.iclone.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.iclone.png is a valid PNG at the configured resolution",
		"out/<stem>.iclone.json carries render_ok:true and render timing",
		"the engine.run receipt cites the input sha256, the still sha256 and the Reallusion env-lock",
	]
	receipt: {kind: "engine.run", extra: ["render_ok", "resolution", "iclone_version"]}
	limits: {wall_ms: 1200000, cost_usd: 0}
}
