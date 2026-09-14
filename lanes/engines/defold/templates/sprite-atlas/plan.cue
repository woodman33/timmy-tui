// Defold · sprite-atlas — compile a dropped project's atlases and keep the texture outputs (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "defold"
	id:             "sprite-atlas"
	title:          "Compile the atlases of a dropped Defold project"
	objective:      "Unzip a *.defold.zip into out/project, find every .atlas/.tilesource, hash the source PNGs they name, run bob build focused on those atlases (--build-input per atlas plus /builtins/graphics/default.texture_profiles; a full build if the focused one fails, and the report says so), copy the compiled .texturec and .texturesetc files into out/ as <stem>.<path>.texturec / .texturesetc, and write <stem>.atlas.json with the source image sha256s, sizes, and every compiled output's path and bytes."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.defold.zip", note: "a Defold project folder zipped with game.project at the root; must hold at least one .atlas or .tilesource"}]
	steps: [
		{
			id:    "unpack"
			title: "unzip into out/project, list atlases"
			command: {
				bin:        "/opt/homebrew/bin/node"
				args:       ["{template}/run.mjs", "{drop}", "{out}", "{stem}", "unpack"]
				timeout_ms: 60000
			}
			produces: ["project", "{stem}.project.json"]
		},
		{
			id:    "atlas"
			title: "bob --build-input <atlas>… build; copy .texturec/.texturesetc into out/"
			command: {
				bin:        "/opt/homebrew/bin/node"
				args:       ["{template}/run.mjs", "{drop}", "{out}", "{stem}", "atlas"]
				timeout_ms: 300000
			}
			produces: ["{stem}.atlas.json", "*.texturesetc", "*.texturec"]
		},
	]
	outputs: [
		{id: "texture", glob: "*.texturec", kind: "image"},
		{id: "textureset", glob: "*.texturesetc", kind: "archive"},
		{id: "report", glob: "*.atlas.json", kind: "report"},
		{id: "project-report", glob: "*.project.json", kind: "report"},
	]
	acceptance: [
		"out/ holds one .texturec and one .texturesetc per atlas, copied from build/default and hashed",
		"out/<stem>.atlas.json names each atlas, its source images with sha256 and size, and each compiled file with bytes",
		"the engine.run receipt cites the input sha256, every texture output sha256, the source PNG sha256 and the Defold env-lock",
	]
	receipt: {kind: "engine.run", extra: ["atlas_count", "atlas_paths", "source_images", "png_sha256", "compiled_count", "compiled_bytes", "focused", "engine_sha", "bob_version"]}
	limits: {wall_ms: 900000, cost_usd: 0}
}
