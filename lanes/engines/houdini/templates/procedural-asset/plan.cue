// Houdini · procedural-asset — a dropped mesh or params file becomes a studded asset (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "houdini"
	id:             "procedural-asset"
	title:          "Build a procedural asset from a dropped mesh or spec"
	objective:      "hython builds a small SOP network from a dropped .obj (the base mesh) or a params .json (a primitive base): facet-extrude the base, scatter studs on its surface, union them with a Boolean, and save the result as a .bgeo.sc plus the scene and a report. Under the Apprentice licence the scene is .hipnc; Indie writes .hiplc; a commercial seat writes .hip."
	bridge:         "cli"
	inputs: [{id: "base", glob: "*.{obj,json}", note: "a base mesh, or a params .json (base, size, seed, scatter, stud)"}]
	steps: [{
		id:    "build"
		title: "hython script.py"
		command: {
			bin:  "hython"
			args: ["{template}/script.py", "{drop}", "{out}", "{stem}"]
			env:  {HOUDINI_USER_PREF_DIR: "{out}/.houdini-prefs"}
			timeout_ms: 600000
		}
		produces: ["{stem}.bgeo.sc", "{stem}.hip*", "{stem}.asset.json"]
	}]
	outputs: [
		{id: "geometry", glob: "*.bgeo.sc", kind: "mesh"},
		{id: "scene", glob: "*.hip*", kind: "archive"},
		{id: "report", glob: "*.asset.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.bgeo.sc exists and the report's point and primitive counts are non-zero",
		"the scene file's extension matches the licence category the report names",
		"the engine.run receipt cites the input sha256, every output sha256 and the Houdini env-lock (hython, husk)",
	]
	receipt: {kind: "engine.run", extra: ["points", "prims", "license"]}
	limits: {wall_ms: 600000, cost_usd: 0}
}
