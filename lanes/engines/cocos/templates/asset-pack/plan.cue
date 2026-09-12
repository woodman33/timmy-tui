// Cocos Creator · asset-pack — build a dropped project's asset bundles only (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Cocos Creator on this Mac. Uses the documented --build with a bundle-only config file.
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "cocos"
	id:             "asset-pack"
	title:          "Build a dropped project's asset bundles"
	objective:      "Unzip the dropped project and run CocosCreator --project <dir> --build \"configPath=<template>/bundle.json\" where the config file (the documented way to pass a full build configuration) selects platform web-mobile with buildBundleOnly so only the Asset Bundles under assets/ are packed into out/build, then leave the bundle folders and the log in out/."
	bridge:         "cli"
	inputs: [{id: "project", glob: "*.cocos.zip", note: "a Cocos Creator 3.x project whose folders are marked as Asset Bundles"}]
	steps: [
		{
			id:    "unpack"
			title: "unzip into out/project"
			command: {
				bin:  "/usr/bin/unzip"
				args: ["-q", "-o", "{drop}", "-d", "{out}/project"]
				timeout_ms: 120000
			}
			produces: ["project"]
		},
		{
			id:    "pack"
			title: "CocosCreator --project … --build configPath=bundle.json"
			command: {
				bin:  "cocos"
				args: ["--project", "{out}/project", "--build", "configPath={template}/bundle.json;buildPath={out}/build"]
				timeout_ms: 1800000
			}
			produces: ["build"]
		},
	]
	outputs: [
		{id: "bundles", glob: "build", kind: "bundle"},
		{id: "log", glob: "pack.log", kind: "report"},
	]
	acceptance: [
		"out/build/web-mobile/assets/<bundle>/ folders exist with their config.<hash>.json and import/native subfolders",
		"the pack step exits 0",
		"the engine.run receipt cites the project sha256, every bundle file sha256 and the Cocos env-lock",
	]
	receipt: {kind: "engine.run"}
	limits: {wall_ms: 1800000, cost_usd: 0}
	proven: false
}
