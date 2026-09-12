# TIMMY TUI — UX AUDIT (findings only, no redesign)
ORDER `tui-audit-g4b7` · captured live via tmux TTY (120×32) on v1.0.8 · no code changed.

## 1. Screens captured (paths)
| screen | path |
|---|---|
| home / command (nav) | /tmp/audit/view-home.txt (=view1) |
| view2 slate DAG + generation control room (lanes RUNNING) | /tmp/audit/view2.txt |
| view3 audit log monitor | /tmp/audit/view3.txt |
| view4 escrow ledger + receipt chain (verify green + FAIL rows) | /tmp/audit/view4.txt |
| view5 lanes/telemetry | /tmp/audit/view5.txt |
| view6 browse dual-pane web workspace | /tmp/audit/view6.txt |
| view7 projects tree + timmy clip | /tmp/audit/view7.txt |
| view8 system settings | /tmp/audit/view8.txt |
| view9 systems web capability map + companion | /tmp/audit/view9.txt |
| help / which-key overlay (?) | /tmp/audit/help.txt |
| command palette (^K) | /tmp/audit/palette.txt |
| receipt detail (attempt via Enter) | /tmp/audit/receipt-detail.txt |
| companion (browser, probed HTTP 200; Fira Code) | localhost:3001 (not raster-captured; browser surface) |

## 2. Inventory
### Tabs (1–9)
1 home/command — hero card + sovereign chat + LATEST PROOF / ACTIVITY rails
2 SLATE DAG & STORYBOARDS + GENERATION CONTROL ROOM (queue/run/fail ledger)
3 AUDIT LOG MONITOR (ambient log, [H] raw [F] follow [W] web)
4 ESCROW LEDGER + RECEIPT CHAIN (merkle+chain verify, newest first)
5 lanes / telemetry (objective, per-harness status, sparkline)
6 BROWSE — DUAL-PANE WEB WORKSPACE (carbonyl chromium) + GOVERNED WORKSPACE OPERATOR
7 PROJECTS per-project tree + TIMMY CLIP (video editing)
8 SYSTEM SETTINGS (local settings, secrets/bindings)
9 SYSTEMS WEB CAPABILITY MAP + companion (localhost:3001, in-pane browser)

### Keybindings (scope)
| key | action | scope |
|---|---|---|
| 1–9 | switch view | global |
| Tab / ⇧Tab | cycle pane focus | global |
| ^K | models + command palette | global |
| ? | help overlay | global |
| q / ^C | quit | global |
| L | jump to TELEMETRY | global |
| Enter | open/select (nav) OR submit (chat input) | view/input (overloaded) |
| Esc | close overlay / back to nav / cancel input | global (overloaded) |
| ↑↓ | select/scroll | view |
| n | new project/prompt | view2 |
| P,c,v,o | project actions (render/clip/canvas/site) | view2 |
| H,F,W | raw / follow / web companion | view3 |
| ↓ | scroll list | view4 |

### Footer / status lines (derived from)
- header: `[TIMMY TRUST OS v1.0.8]` + tab rail + `● DOCKER: <state> ● COMFY: <state> COST: $<ledger>` (env/doctor + cost ledger)
- footer: `~/timmy · run_<id> MODE:<NAV|MODAL:HELP>` + key hints (session id + mode machine)
- rails: LATEST PROOF = chain head sha; ACTIVITY = last five events (receipts/tail)

### Colors (theme.ts "Clearinghouse", DESIGN.md §2.3)
| token | hex | meaning |
|---|---|---|
| accent | #37D2FF | interaction (focus, active tab, selected, live) |
| seal | #3BE08C | cryptographic truth ONLY (sealed/verified/settled/passed) |
| warn | #F0B454 | warning · queued · pending approval · cost |
| danger | #FF5D75 | fail · denied · slashed · destructive confirm |
| ident | #B49AF5 | View2 DAG identity nodes ONLY |
| text 3-step | #D9E4F5/#8CA0BE/#46587A | primary/secondary/muted |
| ground/surface/line | #070C14/#0B1322/#20304C | field/card/border |

### Fonts
TUI: terminal monospace, single size; weight/dim carry hierarchy (seal = only bold green). Companion: Fira Code 400/500/700 (browser).

## 3. Audit vs criteria
- first-try: home teaches via inline hints (`▸ 2 spawn a lane [5 then n]`, `▸ 3 verify [4]`) — good. doctor has NO in-TUI path (header shows DOCKER: DOWN with no key to fix).
- ambiguity: [Enter]/[Esc] overloaded across scopes with no on-screen disambiguation; receipt row → detail gesture undefined.
- dead space: view4 escrow ~60% empty; chain card empty middle; view2 left card lower half empty. Low density vs available 120×32.
- Miller chunking: rails cap activity at 5 and lists at 7–8 + "…and N more" — good chunking; but hero card mixes stats + 3 hints + chat (4 chunks) borderline.
- state visibility: ACTIVITY rail + [RUNNING]/[QUEUED] pills good; BUT view4 shows red [FAIL] on every receipt while same pane says [VERIFIED] chain ok — direct contradiction (C1). MODE indicator omits INPUT mode.
- color semantics: danger(red) applied to valid sealed receipts = violation of "danger = fail/denied" truthfulness; film/card palette (phosphor #33FF66 / orange #FF8C1A) diverges from TUI clearinghouse (seal/accent/warn) across surfaces.
- keybinding conflicts: Enter/Esc overloaded (above); no hard global conflicts otherwise.
- latency: ActionCards/generation poll on 3000ms interval; companion-open and verify have no immediate "working" indicator in some paths.

## 4. Journey test (first ten minutes, new user)
| step | keystrokes | discoverable w/o docs? | stuck? |
|---|---|---|---|
| timmy → home | 0 | yes (hints) | no |
| doctor | q + CLI `timmy doctor` | NO (no in-TUI path) | yes |
| connect a tool | ~3 (9,Tab,Enter) | low (view6/8/9 all claim config) | yes |
| run a lane | ~4 (5,n,type,Enter) | yes (home hint) | no |
| receipt lands | 0 | yes (ACTIVITY rail) | no |
| verify | 1 (4) | yes (home hint) | YES — [FAIL] rows contradict [VERIFIED] (C1) |
| companion QR | ~2–3 (9,Enter/W) | medium (buried in view9 list) | minor |
Total ≈ 12–14 keystrokes; stuck at doctor, verify-trust, receipt-detail.

## 5. Ranked findings
CRITICAL
- C1 view4 RECEIPT CHAIN labels every recent receipt red [FAIL] while the same pane reports [VERIFIED] chain ok · 724. Contradictory trust state on the app's core proof screen; danger color misapplied to valid seals.
- C2 Individual receipt detail not reachable by the obvious select+Enter gesture; no affordance → core inspect-a-receipt workflow blocked.
WARNING
- W1 Help overlay does not dim/blank background; underlying card text bleeds through → poor legibility.
- W2 Large dead space (view4 both cards, view2 left) → low information density.
- W3 Header `● DOCKER: DOWN` reads alarming for a non-problem; no consequence explained.
- W4 No immediate "working" indicator for >400ms actions in some paths (companion open, verify); status only refreshes on 3s poll.
- W5 MODE indicator lacks INPUT mode → key-scope invisibility while typing.
- W6 Enter/Esc overloaded across nav/input/modal scopes without on-screen disambiguation.
OPPORTUNITY
- O1 Extend the home inline key-hint pattern to every card footer (currently inconsistent).
- O2 Surface companion QR / in-pane preview more prominently from view9 (currently a list item).
- O3 Reconcile film/card palette (phosphor/orange) with TUI clearinghouse (seal/accent/warn) or document the mapping so "green = chain" reads identically across surfaces.
- O4 Add the view3 `[W] web companion` cross-link to the view4 chain for deep inspection.

screens=12 · findings=12 (2C/6W/4O)
