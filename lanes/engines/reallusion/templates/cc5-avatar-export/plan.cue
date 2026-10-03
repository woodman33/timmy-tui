// Reallusion CC5 · avatar-export — export a character from Character Creator 5 (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "reallusion"
	id:             "cc5-avatar-export"
	title:          "Export a CC5 character to FBX/OBJ/GLB"
	objective:      "CharacterCreatorpy loads the dropped .ccAvatar or imports the dropped .fbx, optionally applies morph/material presets, exports to the requested format (FBX default), and a report step verifies the output. Requires CC5 running with Python API plugin active."
	bridge:         "cli"
	inputs: [{id: "avatar", glob: "*.{ccAvatar,fbx,obj}", note: "a CC5 character or importable mesh"}]
	steps: [
		{
			id:    "load"
			title: "CharacterCreatorpy.exe load_avatar.py → character loaded"
			command: {
				bin:  "C:\\Program Files\\Reallusion\\Character Creator 5\\Bin64\\CharacterCreatorpy.exe"
				args: ["{template}/load_avatar.py", "{drop}", "{out}"]
				timeout_ms: 300000
			}
			produces: ["{stem}.loaded.json"]
		},
		{
			id:    "configure"
			title: "CharacterCreatorpy.exe apply_settings.py → morphs/materials applied"
			command: {
				bin:  "C:\\Program Files\\Reallusion\\Character Creator 5\\Bin64\\CharacterCreatorpy.exe"
				args: ["{template}/apply_settings.py", "{out}", "{stem}"]
				timeout_ms: 180000
			}
			produces: ["{stem}.settings.json"]
		},
		{
			id:    "export"
			title: "CharacterCreatorpy.exe export_avatar.py → {stem}.cc5.fbx"
			command: {
				bin:  "C:\\Program Files\\Reallusion\\Character Creator 5\\Bin64\\CharacterCreatorpy.exe"
				args: ["{template}/export_avatar.py", "{out}", "{stem}"]
				timeout_ms: 600000
			}
			produces: ["{stem}.cc5.fbx"]
		},
		{
			id:    "report"
			title: "node report.mjs (verify export + stats)"
			command: {
				bin:  "node"
				args: ["{template}/report.mjs", "{out}", "{stem}"]
				timeout_ms: 60000
			}
			produces: ["{stem}.cc5.json"]
		},
	]
	outputs: [
		{id: "mesh", glob: "*.cc5.fbx", kind: "mesh"},
		{id: "report", glob: "*.cc5.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.cc5.fbx exists and is non-empty",
		"out/<stem>.cc5.json carries export_ok:true and vertex count",
		"the engine.run receipt cites the input sha256, the export sha256 and the Reallusion env-lock",
	]
	receipt: {kind: "engine.run", extra: ["export_ok", "format", "vertex_count", "cc5_version"]}
	limits: {wall_ms: 1200000, cost_usd: 0}
}
