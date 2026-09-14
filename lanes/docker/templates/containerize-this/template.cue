// "containerize this" — a jbone template (ORDER captain-y9g4). Point it at a
// project drop folder; it emits a Dockerfile + .dockerignore + compose service
// from the detected stack, and the timmy verbs to build/run it through the
// Docker lane. The plan is CUE-validated (schema.cue) before anything runs.
package containerize

#Stack: "node" | "python" | "rust" | "go" | "static"

#Plan: {
	name:    string & =~"^[a-z0-9][a-z0-9._-]{0,39}$"
	stack:   #Stack
	// the container's start command and the port it listens on
	entry:   string
	port:    int & >0 & <=65535 | *3000
	// build context (relative to the project drop folder) and the base image
	context: string | *"."
	base: {
		node:   string | *"node:24-slim"
		python: string | *"python:3.13-slim"
		rust:   string | *"rust:1.97-slim"
		go:     string | *"golang:1.24"
		static: string | *"nginx:alpine"
	}
	// what the lane seals when it builds/runs this: docker.run cites the image sha
	seal: "docker.run"
	// the mcp-probe admission gate must pass before the Docker MCP gateway is
	// used to drive the build; a raw `docker build` fallback needs no gateway.
	gateway_required: bool | *false
}

plan: #Plan & {
	name:  "__NAME__"
	stack: "__STACK__"
	entry: "__ENTRY__"
	port:  __PORT__
}
