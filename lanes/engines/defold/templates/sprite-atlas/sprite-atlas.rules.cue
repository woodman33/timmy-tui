// Hot-drop rules for defold/sprite-atlas (drop-rules/0).
//
// Runner note: in `timmy engine drop defold` the html5-bundle template sorts
// first and claims every *.defold.zip, so these rules only fire with
// `drop --workflow sprite-atlas`; `run defold sprite-atlas --input` bypasses rules.
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "defold"
	workflow:       "sprite-atlas"
	rules: [
		{id: "project-zip", match: "*.defold.zip", max_bytes: 536870912, action: "run", note: "a zipped Defold project with at least one .atlas or .tilesource"},
		{id: "too-big", match: "*.defold.zip", action: "refuse", note: "over 512 MB: too many textures for a laptop pass"},
		{id: "bare-atlas", match: "*.{atlas,tilesource}", action: "stage", note: "an atlas alone cannot compile: its images and game.project must come with it, zipped as <name>.defold.zip"},
		{id: "images", match: "*.{png,jpg,jpeg}", action: "stage", note: "loose images are staged; put them in the project zip beside their atlas"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
