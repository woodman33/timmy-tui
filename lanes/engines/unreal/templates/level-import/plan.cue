// Unreal · level-import — import a dropped mesh into a project with the ImportAssets commandlet (engine-shelf/v0).
// AUTHORED, UNPROVEN: no Unreal Editor on this Mac. Commands follow Epic's commandlet docs (see blueprint.json sources).
package engine

workflow: #Workflow & {
	schema_version: "engine-workflow/0"
	engine:         "unreal"
	id:             "level-import"
	title:          "Import a dropped FBX/OBJ into an Unreal project"
	objective:      "Run the editor headless with the ImportAssets commandlet: the dropped mesh lands under /Game/Shelf in the project named by the .uproject beside it in drop/, unattended, with the editor log kept as the report. Proven only when an editor exists on the runner."
	bridge:         "cli"
	inputs: [
		{id: "mesh", glob: "*.{fbx,obj}", note: "the asset to import"},
		{id: "project", glob: "*.uproject", note: "the project it goes into (the whole project folder must sit in drop/)", required: true},
	]
	steps: [{
		id:    "import"
		title: "UnrealEditor-Cmd <uproject> -run=ImportAssets"
		command: {
			bin:  "UnrealEditor"
			args: ["{drop}/../{stem}.uproject", "-run=ImportAssets", "-source={drop}", "-dest=/Game/Shelf", "-replaceexisting", "-unattended", "-nopause", "-nosplash", "-NullRHI", "-log={out}/{stem}.import.log"]
			timeout_ms: 1800000
		}
		produces: ["{stem}.import.log"]
	}]
	outputs: [{id: "log", glob: "*.import.log", kind: "report"}]
	acceptance: [
		"the editor log ends with the commandlet's success line and names the imported asset under /Game/Shelf",
		"the project's Content/Shelf folder gains one .uasset per imported mesh",
		"the engine.run receipt cites the mesh sha256, the log sha256 and the UnrealEditor env-lock",
	]
	receipt: {kind: "engine.run", extra: ["imported"]}
	limits: {wall_ms: 1800000, cost_usd: 0}
	proven: false
}
