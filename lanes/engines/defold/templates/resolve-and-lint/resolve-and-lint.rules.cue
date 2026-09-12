// Hot-drop rules for defold/resolve-and-lint (drop-rules/0).
//
// Runner note: in `timmy engine drop defold` the html5-bundle template sorts
// first and claims every *.defold.zip, so these rules only fire with
// `drop --workflow resolve-and-lint`; `run defold resolve-and-lint --input` bypasses rules.
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "defold"
	workflow:       "resolve-and-lint"
	rules: [
		{id: "project-zip", match: "*.defold.zip", max_bytes: 536870912, action: "run", note: "a zipped Defold project; resolved and compiled, never bundled"},
		{id: "too-big", match: "*.defold.zip", action: "refuse", note: "over 512 MB: compile it where it lives, not through the drop folder"},
		{id: "bare-game-project", match: "game.project", action: "stage", note: "a lone game.project has no tree to compile; zip the project folder as <name>.defold.zip"},
		{id: "loose-source", match: "*.{script,lua,collection,go,atlas,gui}", action: "stage", note: "single Defold sources are staged; bob needs the whole project"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
