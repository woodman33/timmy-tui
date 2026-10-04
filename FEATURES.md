# TIMMY feature inventory (p10 audit, 2026-08-23)

Every row verified by execution: panels mounted headlessly
(`scripts/audit-panels.tsx`, run under the live app's tsx resolver) and in
tmux (`scripts/qa-keyboard-60s.ts` walk 1-9); MCP tools invoked through a
real stdio MCP client (`scripts/audit-mcp-tools.ts`, all 23). Statuses:
REACHABLE / CODED-UNMOUNTED / STUB-BROKEN.

## TUI surfaces (views 1-9, dispatcher keys)

| surface | status | how to see it |
|---|---|---|
| CommandView (chat + sovereign input) | REACHABLE | view 1 · Enter claims INPUT, Esc → NAV |
| SlatePanel (mission DAG/storyboards) | REACHABLE | view 2 left |
| GensPanel (generation control room) | REACHABLE | view 2 right |
| LogsPanel (audit log monitor) | REACHABLE | view 3 left |
| LogRain (live event bus) | REACHABLE | view 3 right |
| EscrowReceiptsView (ledger + receipt chain) | REACHABLE | view 4 |
| LanesPanel (live agent panes) | REACHABLE | view 5 left |
| DispatchRail (J-BANG cards) | REACHABLE | view 5 right |
| BrowsePanel (in-pane browser) | REACHABLE | view 6 left |
| FilesPanel (project files) | REACHABLE | view 6 right |
| ProjectsPanel (per-project tree) | REACHABLE | view 7 left |
| ClipPanel (EDL clip editing) | REACHABLE | view 7 right |
| OptionsPanel / SetupPanel / ModelExplorerPanel | REACHABLE | view 8 · Tab selects |
| CodeReviewPanel / DashboardPanel | REACHABLE | view 9 |
| Onboarding (splash + teach gates) | REACHABLE | first run (config.onboarded unset) |
| ^K palette (views + features + models) | REACHABLE | ^K anywhere at NAV |

## Quarantined (attic — coded but intentionally unmounted)

| surface | status | why |
|---|---|---|
| ChatPanel (legacy) | CODED-UNMOUNTED | superseded by CommandView; `src/tui/attic/ChatPanel.tsx` |
| router.tsx (8-mode legacy router) | CODED-UNMOUNTED | superseded by 9-view dispatcher; `src/tui/attic/router.tsx` |
| Draft1-5 + TUIDraftShowcase | CODED-UNMOUNTED | design explorations, never wired; `src/tui/attic/drafts/` |

## MCP backend (23 tools, invoked via stdio client)

| tool | status | verified behavior |
|---|---|---|
| timmy_env_lock | REACHABLE | real OS/arch/tool build hashes |
| timmy_events_tail | REACHABLE | real event bus tail |
| timmy_receipt_verify | REACHABLE | walks 388 receipts, epoch segments |
| timmy_clip_replay | REACHABLE | honest "no sealed run" for unknown job |
| timmy_gen_run | REACHABLE | honest "bridge unavailable" without provider |
| timmy_promo_apply | REACHABLE | applied beats delta → promo v9 html |
| timmy_llm_call | REACHABLE | honest needs_resolution when model absent |
| timmy_fusion_plan | REACHABLE | resolves local-first judge chain |
| timmy_promo_judge | REACHABLE | honest "no local judge — refuses to spend" |
| timmy_allyson_run | REACHABLE | wired; needs ALLYSON_API_KEY |
| timmy_apify_run | REACHABLE | wired; needs APIFY_API_TOKEN |
| timmy_3minapi_run | REACHABLE | wired; needs THREEMINAPI_KEY |
| timmy_openhands_run | REACHABLE | approval-gated; real sandbox or nothing |
| timmy_oapi_run | REACHABLE | listed petstore spec tools live |
| timmy_roboflow_run | REACHABLE | honest not_configured + receipt without key |
| timmy_list_lanes | REACHABLE | lane roster with availability |
| timmy_plan_dispatch | REACHABLE | CUE-validated plan stored + hash |
| timmy_mission_compile | REACHABLE | validator rejects malformed doc (works) |
| timmy_dispatch_plan | REACHABLE | arm/launch; honest unknown-plan |
| timmy_tail_lane | REACHABLE | honest no-session |
| timmy_pause_or_cancel_lane | REACHABLE | hold/cancel; receipted |
| timmy_geo_score | REACHABLE | voxel F1/IoU + Chamfer + F-score@τ against truth; metric unless fit=true (then `untrusted`, exit 2); receipted; not_configured without numpy+scipy |
| timmy_geo_scale | REACHABLE | per-view metric scales from self-consistency; `untrusted` when a scale pins to the grid bound; receipted |
| timmy_collect_run | REACHABLE | honest unknown-run |
| timmy_judge_loop | REACHABLE | phase-1 plan + needs_approval gate |

## Spine services

| service | status | how to see it |
|---|---|---|
| escrow engine (arm/lock/judge/settle/slash) | REACHABLE | view 4 + tests/escrow; refund = ceiling − drawn |
| receipts + verifyChain | REACHABLE | view 4 right card · `timmy_receipt_verify` |
| companion server :4310 (SSE, /mission, /mission/escrows) | REACHABLE | browser http://127.0.0.1:4310 |
| cmcp/mcporter bridge (lanes) | REACHABLE | view 5 · needs mcporter on PATH (present) |

Known cosmetic issue (2026-08-23): ink's TTY diff can clip the top chrome
row on capture-heavy panels (views 5/6/9) after a view switch; content and
footer MODE render correctly. Headless frames are correct; tracked as a
rendering quirk, not a functional defect.
