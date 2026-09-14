// TIMMY swarm spec — swarm/v1 (ORDER swarm-b3k7 step 1).
//
// One swarm = a set of MEMBERS run under one TOPOLOGY with one BUDGET, one
// JUDGE tier and one NETWORK policy. The same shape is validated here with
// CUE (`cue vet -c lanes/swarm/schemas/swarm.cue <preset>.cue`) and mirrored
// in TypeScript by workers/ai-proxy/src/swarm-core.ts parseSwarmSpec(), which
// the durable commander applies to every POST /commander/:room/swarm body.
//
// Members:
//   model   — one chat model. provider "openrouter" (the edge mind) or
//             "ollama:<node>" (Level 0: a parallel slot on that node) or
//             "ollama-cloud" (Ollama Cloud through the local daemon).
//   harness — one locally installed agent harness (jcode, opencode, pi,
//             hermes, openhands, minds). Runs on the operator's machine, never
//             at the edge; its role in a crew comes from harness.abilities.
//   timmy   — one durable Timmy agent (Level 2: a project's Timmy Durable
//             Object exposing MCP). The root commander calls it as a tool.
package swarm

import "list"

#Kind:     "model" | "harness" | "timmy"
#Node:     "edge" | "mac" | "spark1" | "spark2" | "spark3"
#Sandbox:  "none" | "openhands" | "sbx" | "closed"
#Topology: "fanout" | "fusion" | "relay" | "coordinator" | "tournament" | "council" | "crew" | "closed"
#JudgeTier: "local" | "edge" | "frontier"
#Policy:   "open" | "tailnet" | "closed"

#Member: {
	id:   string & =~"^[a-z0-9][a-z0-9._:-]{0,39}$"
	kind: #Kind
	// where it runs; "edge" = the durable commander itself
	node:    #Node | *"edge"
	sandbox: #Sandbox | *"none"
	// crew role; derived from harness.abilities when absent
	role?: string & =~"^[a-z][a-z0-9-]{0,23}$"
	// vote weight in a council (default 1)
	weight: int & >=1 & <=5 | *1

	if kind == "model" {
		model:    string & !=""
		provider: "openrouter" | "ollama-cloud" | =~"^ollama:(mac|spark[123])$" | *"openrouter"
	}
	if kind == "harness" {
		harness: "jcode" | "opencode" | "pi" | "hermes" | "openhands" | "minds"
		model?:  string
		// a harness never runs at the edge
		node: "mac" | "spark1" | "spark2" | "spark3"
	}
	if kind == "timmy" {
		// the Timmy Durable Object instance name (a project room), e.g. "project:ship"
		room: string & =~"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$"
		node: "edge"
	}
}

#Budget: {
	usd:       number & >=0
	max_calls: int & >=1 | *64
	max_ms:    int & >=1000 | *600000
}

#Judge: {
	tier:   #JudgeTier
	model?: string & !=""
}

#Network: {
	policy: #Policy
	// hosts/CIDRs a closed swarm may still reach; empty = deny-all
	egress_allow: [...string] | *[]
}

#Swarm: {
	v:        1
	id:       string & =~"^[a-z0-9][a-z0-9._-]{0,63}$"
	preset?:  string
	topology: #Topology
	members:  [...#Member] & list.MinItems(1) & list.MaxItems(32)
	// size is the member count, written out so a reader can check it
	size: int & >=1 & <=32
	size: len(members)
	budget:  #Budget
	judge:   #Judge
	network: #Network
	// council rounds (ignored by other topologies)
	rounds: int & >=1 & <=6 | *2
	// free-text hint stored with the spec (never the task itself)
	note?: string

	// A closed swarm may not reach the public internet: local members only,
	// a local judge, an empty egress allowlist, hands under sbx deny-all.
	if topology == "closed" {
		network: policy: "closed"
		network: egress_allow: []
		judge: tier: "local"
		members: [...{kind: "model", provider: =~"^ollama:", sandbox: "closed"} | {kind: "harness", sandbox: "closed"}]
	}
	if network.policy == "closed" {
		topology: "closed"
	}
	// fusion/tournament/council/coordinator/crew all need a judge model somewhere
	if topology == "fusion" || topology == "tournament" || topology == "coordinator" || topology == "crew" {
		judge: model: string & !=""
	}
	// a council votes, so it needs at least three voices and two rounds
	if topology == "council" {
		size: >=3
		rounds: >=2
	}
	// a relay is a chain, so it needs at least two links
	if topology == "relay" {
		size: >=2
	}
	// a tournament needs candidates to pick from
	if topology == "tournament" {
		size: >=2
	}
}

swarm: #Swarm
