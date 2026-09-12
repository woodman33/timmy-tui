// Engine shelf — workflow template schema (engine-shelf/v0, shelf-w6d3 step 4).
//
// Every engine ships three workflow templates. Each template is three files:
//   plan.cue            a #Workflow: the DispatchPlan for one engine job
//   blueprint.json      a tldraw-style blueprint board (kind "blueprint") the
//                       Slate 3D viewer renders as sheets: inputs, steps, outputs
//   <workflow>.rules.cue a #DropRules: what happens when a file lands in the
//                       project's drop/ folder (the hot-drop trigger)
//
// `cue vet -c` checks a template against this file:
//   cue vet -d '#Workflow' lanes/engines/schemas/engine-workflow.cue lanes/engines/blender/templates/render-still/plan.cue
package engine

#EngineId: "houdini" | "unreal" | "usd" | "unity" | "defold" | "cocos" | "godot" | "blender"

// A command the lane runs. {drop} {out} {project} {template} {stem} are
// substituted; nothing else is interpolated, and the command never runs in a shell.
#Command: {
	bin:  string & != ""       // key into engines.json binaries, or an absolute path
	args: [...string]
	cwd?: string               // default: the project's out/ folder
	env?: {[string]: string}
	timeout_ms: int & > 0 | *600000
}

#Workflow: {
	schema_version: "engine-workflow/0"
	engine:         #EngineId
	id:             string & =~"^[a-z0-9][a-z0-9-]{1,39}$"
	title:          string & != ""
	objective:      string & != ""
	// bridge the run uses
	bridge: "cli" | "mcp" | "sdk" | "api"
	inputs: [...{
		id:      string & != ""
		glob:    string & != ""   // matched against drop/
		note?:   string
		required: bool | *true
	}]
	steps: [...{
		id:      string & != ""
		title:   string & != ""
		command: #Command
		// the files this step must leave in out/ (globs); the lane hashes them
		produces: [...string]
	}]
	outputs: [...{
		id:   string & != ""
		glob: string & != ""
		kind: "image" | "video" | "mesh" | "usd" | "archive" | "bundle" | "report" | "text"
	}]
	acceptance: [...string]
	receipt: {
		kind:    "engine.run"
		// receipt meta beyond the standard (engine, workflow, inputs, outputs, env-lock)
		extra?: [...string]
	}
	model_policy: {
		requested:     string | *"none"
		allow_paid:    bool | *false
		max_spend_usd: number & >= 0 | *0
	}
	limits: {
		wall_ms:  int & > 0 | *900000
		cost_usd: number & >= 0 | *0
	}
	// true once a receipted run through the drop folder exists on an installed engine
	proven: bool | *false
	proven_by?: string   // receipt hash
}

// Hot-drop rules: the lane watches <project>/drop/; the first rule whose
// `match` fits a dropped file decides which workflow runs. Files that match
// nothing are left alone and listed in the lane's report. A rule can require
// a sidecar (e.g. a .json beside the file) and can refuse by size.
#DropRules: {
	schema_version: "drop-rules/0"
	engine:         #EngineId
	workflow:       string & != ""
	rules: [...{
		id:      string & != ""
		match:   string & != ""            // glob against the dropped file name
		sidecar?: string                   // glob for a required companion file
		max_bytes?: int & > 0
		action:  "run" | "stage" | "refuse"
		note?:   string
	}]
	// where outputs go, relative to the project
	out:     string | *"out"
	// what the lane seals when a drop is refused
	refusal: "engine.refuse"
}
