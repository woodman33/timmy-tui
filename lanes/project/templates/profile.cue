// TIMMY project profile — project-folder/v0 (mindship-v5c2 step 5).
// One file per project at ~/timmy/projects/<name>/profile.cue. Read by
// `timmy project menu` and by every harness menu (fleet/harness-menu.mjs).
// `cue vet profile.cue` checks it when cue is installed; the reader tolerates
// the plain key: "value" subset when it is not.
package project

#Profile: {
	name:     string & =~"^[a-z0-9][a-z0-9._-]{0,39}$"
	owner:    string
	created:  string // ISO-8601
	standard: "project-folder/v0"
	harnesses: {
		allowed:   [...string]
		preferred: string | *""
	}
	budget: {
		max_spend_usd: number & >=0 | *2
	}
	models: {
		mind:   string | *"google/gemini-3.7-flash"
		actors: [...string] | *[]
	}
	// OpenRouter routing flags every call under this project carries
	// (swarm-b3k7 step 6): zero data retention, provider logging opt-out,
	// and the per-project key whose limit IS the budget (management-api-keys).
	routing: {
		zdr:             bool | *false
		data_collection: "allow" | "deny" | *"allow"
		project_key:     "none" | "minted" | *"none"
	}
	receipts: {
		// the root receipt store (the committed .timmy/store-pin); never a subdirectory
		store: string
	}
	paths: {
		skills: "skills"
		plans:  "plans"
		boards: "boards"
		drop:   "drop"
		out:    "out"
	}
	tags: [...string] | *[]
}

profile: #Profile & {
	name:     "__NAME__"
	owner:    "__OWNER__"
	created:  "__CREATED__"
	standard: "project-folder/v0"
	harnesses: {
		allowed:   [__ALLOWED__]
		preferred: "__PREFERRED__"
	}
	budget: {
		max_spend_usd: __BUDGET__
	}
	receipts: {
		store: "__STORE__"
	}
	tags: [__TAGS__]
	routing: {
		zdr:             __ZDR__
		data_collection: "__DATA_COLLECTION__"
		project_key:     "__PROJECT_KEY__"
	}
}
