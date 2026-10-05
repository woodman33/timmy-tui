// Hot-drop rules for routemux/balance-reconcile (drop-rules/0).
package engine

drop: #DropRules & {
	schema_version: "drop-rules/0"
	engine:         "routemux"
	workflow:       "balance-reconcile"
	rules: [
		{id: "trigger", match: "*.reconcile.json", max_bytes: 65536, action: "run", note: "reconcile on demand or on a schedule"},
	]
	out:     "out"
	refusal: "engine.refuse"
}
