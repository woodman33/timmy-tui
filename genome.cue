// genome.cue — the policy genome for the two ledgers (ORDER ledger-r4k2). ONE source of
// truth for per-project-room OpenRouter guardrails and model-tier policy. Terraform reads
// #Room.guardrails to provision the workspace/key and enforce caps + ZDR; the swarm and the
// commander read #Genome.tiers to pick a routing tier; `timmy reconcile` and the nightly
// ledger.reconcile compare the sealed generation receipts against these limits.
package genome

#Tier: "floor" | "nitro" | "default"

// The routing tier a role gets. :floor = cheapest that fits (judges); :nitro = fastest
// provider, no fallback compromise (commander). Recorded served tier comes from the
// generation receipt, not assumed here.
#Roles: {
	commander: #Tier | *"nitro"
	judge:     #Tier | *"floor"
	actor:     #Tier | *"default"
}

#Guardrails: {
	// hard monthly spend ceiling for the room's OpenRouter key (USD). Terraform sets the key
	// limit to this; the commander's in-call cap must be <= this.
	limit_usd: number & >0
	// require zero-data-retention routing (only ZDR-eligible providers).
	enforce_zdr: bool | *false
	// deny training on prompts/completions.
	deny_training: bool | *true
}

#Room: {
	id:         string & =~"^[a-z0-9][a-z0-9._:-]{0,63}$"
	guardrails: #Guardrails
	roles:      #Roles
}

#Genome: {
	schema:  "timmy.genome/1"
	// defaults applied to every room unless overridden.
	defaults: #Guardrails & {limit_usd: 25, enforce_zdr: true, deny_training: true}
	tiers:    #Roles
	rooms: [ID=string]: #Room & {id: ID}
}

genome: #Genome & {
	tiers: {commander: "nitro", judge: "floor", actor: "default"}
	rooms: {
		"war-room": {guardrails: {limit_usd: 50, enforce_zdr: true, deny_training: true}, roles: tiers}
		"ship":     {guardrails: {limit_usd: 25, enforce_zdr: true, deny_training: true}, roles: tiers}
		// NEGATIVE-CONTROL room for the Terraform drift test (part 2): its declared cap here is
		// deliberately LOW so a provisioned key with a wrong (higher) cap shows up as policy.drift.
		"drift-negative-control": {guardrails: {limit_usd: 1, enforce_zdr: true, deny_training: true}, roles: tiers}
	}
}
