# TIMMY → Framer MCP → CLI

The official Framer MCP is the editing backend. TIMMY's `framer` command
wraps the existing locked MCPorter dependency (0.12.4), without installing a
second Framer server or changing the existing MCP configuration. Node 24+.

## Start

From this checkout, after `npm ci` and `npm run build`:

```sh
node dist/timmy.js framer init
node dist/timmy.js framer auth
node dist/timmy.js framer tools
node dist/timmy.js framer open YOUR_FRAMER_PROJECT_URL
```

An installed package uses `timmy framer` instead. These changes must be in
that installation; they are not present in an older npm release. Source mode:
`node --import tsx src/cli.ts framer --help`.

OAuth needs the user's browser approval on the machine running the command.
ChatGPT's authenticated connection is not exported or reused. Tokens remain
in MCPorter's credential store, never in source or TIMMY's receipt chain.
`init` creates `.timmy/private/framer/mcporter.json` with no secrets and never
overwrites it. `TIMMY_FRAMER_CONFIG` selects an existing configuration for
controlled environments. Review that file before use: it chooses the server.

## Full tool surface, without a brittle wrapper for every feature

`tools` discovers current schemas. `call TOOL args.json` accepts every tool
the server exposes, including tools added later. Use exact discovered names.
`open` returns a session and project README. Read the required docs, starting
with `context.md`, before editing. A session is not an API key; reopen after
expiry rather than retrying mutations blindly.

```sh
timmy framer docs SESSION context.md
timmy framer exec SESSION inspect.js
timmy framer status SESSION
timmy framer publish SESSION
```

`inspect.js` example, after reading the relevant project API docs:

```js
return { capabilities: await api.getCapabilities(), publishing: await api.publishing.status() }
```

Publish checks readiness, then publishes the current project. Inspect status
first because all pending edits in the target may be included. Branches publish
their preview; staging projects publish staging; otherwise the target can be
production. The command does not automatically promote staging. Exact staging
promotion is available through an explicit script using the version returned
by `status()` and the current Framer hosting documentation. No automatic
retries of mutations, no invented success receipts, no credentials in scripts.

| Surface | How to operate it | Boundary |
| --- | --- | --- |
| Pages, layout, responsive breakpoints, styles, components | `docs`, then `exec` with documented tree APIs | Read current project skills and schemas first |
| CMS, forms, links, interactions | Same documented project API route | Only operations and access exposed by Framer |
| React code files and overrides | `exec` with `api.files` after code-component docs | Keep native editable source; validate diagnostics |
| Analytics and site settings | Discover and read the matching project docs | Plan and permission dependent |
| Publishing | `status`, `publish`; explicit staging promotion script | Real external mutation; no blind retries |
| Future MCP tools | `tools`, then `call TOOL args.json` | No claim of unsupported features |
| Motion animations | `motion OUTPUT.tsx`, then edit/build/deploy browser component | Browser runtime; does not animate ANSI terminals |

## Motion

```sh
timmy framer motion TimmyMotionStatus.tsx
# In the consuming React app, not necessarily the TIMMY CLI package:
npm install motion
```

The generated source includes layout transitions, hover/tap gestures,
AnimatePresence, accessible expand/collapse, and reduced-motion handling.
Its status text is caller-supplied; it does not verify receipts. It inherits
the consuming design system instead of inventing a second TIMMY palette.
It is an example component, not a complete cockpit or a live data connection.

Motion also offers scroll, SVG, drag, spring and motion-value APIs; compose
those in editable React/JS source using the current Motion documentation.
The open-source library does not unlock Motion+ assets/private packages.
For Framer upload, first read that project's `code-components` skill and
follow its import, sizing and property-control requirements. The CLI does not
silently upload or insert the generated file.

## CLI-Anything style generation and a second route

```sh
timmy framer types ./framer-client.ts
timmy framer generate-cli ./framer-tools.js
node ./framer-tools.js --help
```

These use MCPorter's real generators against live tool schemas. Authenticate
first. Output paths must be new. Generated artifacts depend on the MCPorter
runtime/generator's requirements; inspect their generated help before use.
This is not a claim that the separate CLI-Anything project is installed.

MCPorter-independent route: connect Cursor, Codex or another OAuth-capable
Streamable HTTP MCP client directly to `https://mcp.framer.com/mcp`. This
uses the same official backend with a different client; it is not independent
verification of Framer output. ChatGPT's Framer plugin is another such client.

## Status and completion

Implemented: isolated configuration, explicit OAuth, dynamic tool discovery,
generic tool calls, session/docs/scripts, publish readiness/publishing,
typed client/CLI generation, and local Motion source generation.

Development checks: focused unit tests, a real MCPorter subprocess against a
local MCP fixture, TypeScript compilation, and shipped-bin routing. The fixture
is explicitly synthetic; it does not establish live Framer CLI connectivity.
Live account read access and publish capability were observed through the
Framer ChatGPT plugin separately. Local-machine OAuth, live CLI edits, generated
remote clients, browser rendering and end-to-end publication remain unverified.
No npm release or Framer site publication is implied by publishing this source.

Smallest completion gate: authenticate locally, discover tools, open one
disposable project, read its docs, make one edit, inspect status, publish,
and independently read the published result. Keep rollout bounded to that
workflow before adding a full visual editor or another orchestration system.

## Governance and dependency inventory

Current user instruction authorizes building and publishing this connector.
This is mutable implementation, not immutable qualification. Allowed writes:
`src/framer/`, the additive route in `src/cli.ts`, `tests/framer*.test.ts`,
`tests/fixtures/framer-mcp.mjs`, and `docs/FRAMER-CLI.md`.
DOCTRINE §§2–3, DESIGN (no terminal redesign), and decisions (no forge-lane
changes) apply. Receipt stores, spatial HOLDs and existing adapters are untouched.
No new dependencies: MCPorter is already MIT-licensed and lockfile-pinned.
Framer is an authenticated remote SaaS; commands send selected tool arguments
and scripts to it. Motion is a separate browser dependency, not auto-installed.
Dependency upgrades remain explicit lockfile changes. No paid add-ons are enabled.

## Sources

- https://www.framer.com/help/articles/getting-started-with-framer-mcp/
- https://www.framer.com/help/articles/what-you-can-do-with-framer-mcp/
- https://github.com/openclaw/mcporter
- https://motion.dev/docs/react-installation

Revenue experiment (aspirational): sell a fixed-price Framer launch setup with
a readable change/publication record. First validate one paid pilot. Connecting
TIMMY operation records to a client's Framer handoff page is a later bridge;
this connector does not yet implement signed deployment receipts.
