// Reallusion Hub · content-sync — sync marketplace content to local libraries (engine-shelf/v0).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "reallusion"
	id:             "hub-content-sync"
	title:          "Sync Reallusion Hub content to local iClone/CC5 libraries"
	objective:      "Query the Reallusion Hub for available content, download selected packs, install into the target app's content library, and verify installation. Uses Hub REST API or CLI when available; falls back to manual verification."
	bridge:         "api"
	inputs: [{id: "content_spec", glob: "*.json", note: "JSON spec with content_id and target_app fields"}]
	steps: [
		{
			id:    "list"
			title: "Query Hub for installed/available content"
			command: {
				bin:  "node"
				args: ["{template}/hub_list.mjs", "{drop}", "{out}"]
				timeout_ms: 120000
			}
			produces: ["{stem}.catalog.json"]
		},
		{
			id:    "download"
			title: "Download selected content pack"
			command: {
				bin:  "node"
				args: ["{template}/hub_download.mjs", "{out}", "{stem}"]
				timeout_ms: 600000
			}
			produces: ["{stem}.download.json"]
		},
		{
			id:    "install"
			title: "Install/verify content in target app library"
			command: {
				bin:  "node"
				args: ["{template}/hub_install.mjs", "{out}", "{stem}"]
				timeout_ms: 300000
			}
			produces: ["{stem}.hub.manifest.json"]
		},
		{
			id:    "report"
			title: "Verify installation + record manifest"
			command: {
				bin:  "node"
				args: ["{template}/report.mjs", "{out}", "{stem}"]
				timeout_ms: 60000
			}
			produces: ["{stem}.hub.json"]
		},
	]
	outputs: [
		{id: "manifest", glob: "*.hub.manifest.json", kind: "manifest"},
		{id: "report", glob: "*.hub.json", kind: "report"},
	]
	acceptance: [
		"out/<stem>.hub.manifest.json lists installed content with paths",
		"out/<stem>.hub.json carries sync_ok:true and pack count",
		"the engine.run receipt cites the manifest sha256 and env-lock",
	]
	receipt: {kind: "engine.run", extra: ["sync_ok", "pack_count", "hub_version"]}
	limits: {wall_ms: 1200000, cost_usd: 0}
}
