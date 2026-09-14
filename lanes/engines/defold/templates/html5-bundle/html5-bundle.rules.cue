// Hot-drop rules for defold/html5-bundle (drop-rules/0).
//
// Runner note: `timmy engine drop defold` tries templates alphabetically and the
// first template with ANY matching rule claims the file, so a *.defold.zip
// dropped without --workflow always lands here (html5-bundle sorts first).
// Use `drop --workflow resolve-and-lint|sprite-atlas` or `run` to reach the others.
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "defold"
	workflow:       "html5-bundle"
	rules: [
		{id: "project-zip", match: "*.defold.zip", max_bytes: 536870912, action: "run", note: "a zipped Defold project (game.project at the root); bundled for wasm-web"},
		{id: "too-big", match: "*.defold.zip", action: "refuse", note: "over 512 MB: not a laptop bundle — trim assets or build on the Sparks"},
		{id: "bare-game-project", match: "game.project", action: "stage", note: "a lone game.project has no tree to build; zip the project folder as <name>.defold.zip"},
		{id: "other-zip", match: "*.zip", action: "stage", note: "zips not named *.defold.zip are staged, never built"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
