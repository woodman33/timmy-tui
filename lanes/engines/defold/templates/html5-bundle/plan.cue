// Defold · html5-bundle — a dropped project zip becomes an HTML5 bundle (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "defold"
	id:             "html5-bundle"
	title:          "Bundle a dropped Defold project for HTML5"
	objective:      "Unzip a *.defold.zip into out/project, run bob resolve, then bob build+bundle for wasm-web (Defold 1.13's HTML5 platform; js-web is gone) with --archive, and leave <stem>.bundle/ (index.html, dmloader.js, <title>_wasm.js, <title>.wasm, archive/), a zip of it, and a JSON report in out/. bob.jar carries the prebuilt wasm-web engine, so a project with no native extensions bundles locally with no build server; a project with native extensions goes through bob's default build server (network). If the wasm-web bundle fails, the bundle step retries on the host platform (arm64-macos on this Mac) and the report's `fallback` and `platform` say so — the zip is then <stem>.macos.zip, not <stem>.html5.zip."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.defold.zip", note: "a Defold project folder zipped with game.project at the root (or inside one top-level folder); no native extensions needed"}]
	steps: [
		{
			id:    "unpack"
			title: "unzip into out/project"
			command: {
				bin:        "/opt/homebrew/bin/node"
				args:       ["{template}/run.mjs", "{drop}", "{out}", "{stem}", "unpack"]
				timeout_ms: 60000
			}
			produces: ["project", "{stem}.project.json"]
		},
		{
			id:    "resolve"
			title: "bob resolve (library dependencies)"
			command: {
				bin:        "/opt/homebrew/bin/node"
				args:       ["{template}/run.mjs", "{drop}", "{out}", "{stem}", "resolve"]
				timeout_ms: 300000
			}
			produces: ["{stem}.resolve.json"]
		},
		{
			id:    "bundle"
			title: "bob build bundle --platform wasm-web --archive --variant release"
			command: {
				bin:        "/opt/homebrew/bin/node"
				args:       ["{template}/run.mjs", "{drop}", "{out}", "{stem}", "bundle"]
				timeout_ms: 300000
			}
			produces: ["{stem}.bundle", "{stem}.{html5,macos,linux,win32}.zip", "{stem}.bundle.json"]
		},
	]
	outputs: [
		{id: "bundle-zip", glob: "*.{html5,macos,linux,win32}.zip", kind: "bundle"},
		{id: "report", glob: "*.bundle.json", kind: "report"},
		{id: "resolve-report", glob: "*.resolve.json", kind: "report"},
		{id: "project-report", glob: "*.project.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.bundle/ holds index.html, dmloader.js, <title>_wasm.js, <title>.wasm and archive/ (wasm-web), or a <title>.app when the report says fallback",
		"out/<stem>.html5.zip is a zip of that folder and out/<stem>.bundle.json lists every file with bytes and sha256, the platform, the engine sha and the bob version",
		"the engine.run receipt cites the input sha256, the zip sha256, platform, fallback and the Defold env-lock",
	]
	receipt: {kind: "engine.run", extra: ["platform", "fallback", "bundle_files", "bundle_bytes", "engine_sha", "bob_version", "build_server"]}
	limits: {wall_ms: 900000, cost_usd: 0}
}
