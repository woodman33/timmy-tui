# Creative loops + SLATE remix — organized plan (2026-08-15)

Owner directive: allyson-mcp animated SVGs into the tab that owns HyperFrames editing;
mcporter as the CLI driver; log every use (prompts, workflows, results); review logs →
think → vision-compare → consult tldraw templates → re-prompt; repeat like the other
creative loops. Apify MCP from the MCP Market account too. UI remap is the umbrella.

## 1. The allyson creative loop (wired; key-gated)

`timmy_allyson_run` (MCP tool #10) drives `allyson-mcp` via mcporter stdio. One tool on
the server: `generate_svg_animation(prompt, svg_path, output_path)` → animated TSX.
Every use: `.timmy/runs/mcp-allyson-*.log` (full mcporter traffic) + sealed receipt +
event-bus entry. Loop protocol (orchestrator = next increment, `timmy_allyson_loop`):

1. prompt → `timmy_allyson_run` (source SVG from Slate project / studio comp)
2. read the log; render source + output to PNG (`rsvg-convert` / `qlmanage`)
3. vision-compare: cheap vision model (gemini-3.7-flash) scores motion vs intent
4. consult tldraw SDK templates (layout/motion vocabulary) + Slate templates
5. re-prompt with the delta; seal each iteration; stop at score ≥ threshold or N=3

**Blocker:** ALLYSON_API_KEY absent everywhere — sign up at allyson.ai. Lane returns an
honest `needs_key` until then. Repo cloned at ~/Desktop/Code-Projects/allyson-mcp.

## 2. Apify lane (wired; token-gated)

`timmy_apify_run` (tool #11) → `mcp.apify.com` via mcporter http, bearer from env.
Proven up to the wall: the `.env` APIFY_API_KEY (46 chars) is REJECTED by Apify console
(`invalid_token`) — it's MCP-Market-provisioned, not a console token. Fix: mint a token
at console.apify.com/account/integrations → `.env` APIFY_API_TOKEN. Logs + receipts
already land per use (see `.timmy/runs/mcp-apify-*.log`).

## 3. MCP Market account — honest answer

mcpmarket.com is a directory/storefront; no public API to enumerate "my servers"
(probe blocked 429; no documented registry endpoint). The `link.mcpmarket.com/<handle>/...`
URLs are storefront/affiliate links. Same outcome, our way: each wanted server gets a
fleet entry + mcporter config line (allyson + apify done; add more on demand). TIMMY's
fleet registry IS the account view.

## 4. tldraw templates — where they live, visibility today

- `src/utils/templates.ts` — Slate schema templates (beats/at/dur/label), agent-authorable, `/template`, `/market`
- `TIMMY_SLATE_URL` (default :5173) — the tldraw companion canvas; `/panes` opens it in a carbonyl pane; SLATE `[c]`/`[o]`
- during generation: canvas pane visible via /panes; after: `site/index.html` publish + canvas persists
- tldraw SDK templates (official examples) = the consult source for the allyson loop; not yet vendored → queue: vendor 3-5 SDK examples into studio/tldraw-refs/

## 5. SVG in terminal — decision

No mainstream TUI renders *animated* SVG (terminaltrove blocked 403; verified from
tooling knowledge: chafa/viu/timg/catimg rasterize static frames only). Decision:
- static SVG preview → `rsvg-convert` → chafa (house style, projecttree previewFile)
- animated SVG / tldraw / live logs → carbonyl browser pane (the owner's fallback IS the right architecture)

## 6. SLATE remix (the UI-remap umbrella, per docs/UI-VISION.md)

SLATE becomes the creative cockpit, four rows in the stage:
1. **prompt composer** (existing) + lane picker gains `allyson` + `apify` entries
2. **templates** — Slate templates left, tldraw SDK refs right (vendored)
3. **live logs** — event-bus tail (LogsPanel primitive) + companion URL + `[w]`
4. **model rail** — local-first chain status (fusion_plan availability) + cost

GENS gains allyson/apify as providers (fleet.json entries, transport `mcp`, runner =
mcporter). Key grammar unchanged; PanelFrame shared component first so the remix is
one composition, not another one-off.

## 7. Build queue (ordered)

1. commit allyson/apify lanes + this doc (word?)
2. PanelFrame shared component → SLATE remix rows
3. `timmy_allyson_loop` orchestrator (vision-compare + tldraw consult + re-prompt)
4. promo v10 apply (judge edits approved? hook1/cost/connect) → render → seal
5. fleet entries for allyson/apify in GENS picker
6. Apify token + Allyson key from owner → first live runs, receipted
