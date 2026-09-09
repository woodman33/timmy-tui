# TIMMY TUI — UX AUDIT BUNDLE (ORDER tui-audit-g4b7 / onebus-m5f2)
Findings (unchanged) from docs/ux-audit-ch1.md, followed by raw terminal captures
with a header per capture naming the view and its keybindings.

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



---

## CAPTURE: HOME / COMMAND (view 1)

_source: /tmp/audit/view-home.txt_

**Keybindings:** keys: [1-9] switch view · [Tab]/[⇧Tab] cycle pane · [^K] palette · [?] help · [q] quit · [L] telemetry · ACTIVITY rail [Enter] open · [Esc] back

```
 [TIMMY TRUST OS v1.0.8]             [1] 2  3  4  5  6  7  8  9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭───────────────────────────────────────────────────────────────────────────────────────╮  ╭─────────────────────────╮
 │ agents work · receipts prove it                                              [READY]  │  │ ◇ LATEST PROOF          │
 │                                                                                       │  │ the only thing that     │
 │ 275 plans · 49 escrows · 724 receipts                                                 │  │ glows green             │
 │ ▸ 2 spawn a lane           [5 then n]                                                 │  │                         │
 │ ▸ 3 verify receipt chain   [4]                                                        │  │ ✓ sha256_8…             │
 ╰───────────────────────────────────────────────────────────────────────────────────────╯  │ 21:40:11 · runs         │
                                                                                            ╰─────────────────────────╯
 ╭───────────────────────────────────────────────────────────────────────────────────────╮
 │ sovereign chat — Enter to speak · Esc back to nav                                     │  ╭─────────────────────────╮
 │                                                                                       │  │ ◇ ACTIVITY              │
 │ ▸ reply with one markdown sentence containing **bold**                                │  │ last five, in human     │
 │                                                                                       │  │ sentences               │
 │  his is a bold reply in one markdown sentence. 🛰️                                     │  │                         │
 │ ▸ one line about receipts                                                             │  │ receipt sealed · 00547c…│
 │ Receipts turn every agent run into a sealed, replayable proof — trust as a            │  │ receipt sealed · 2b1e7c…│
 │ first-class UI primitive.                                                             │  │ receipt sealed · f9c5b9…│
 │ ▸ say hello from the fallback                                                         │  │ receipt sealed · 278c12…│
 │                                                                                       │  │ receipt sealed · 86a5e3…│
 │ 👋 hello from the fallback — every shell call has been falling back to your local     │  │ · tailing live          │
 │ server is returning 404.ona                                                           │  ╰─────────────────────────╯
 │                                                                                       │
 │   one markdown sentence with **bold** and a two item list                             │
 │ This is a bold sentence with a list:                                                  │
 │   ▸ First item                                                                        │
 │   ▸ Second item                                                                       │
 │                                                                                       │
 │                                                                                       │
 │ ▸ [COMMAND POST — type a mission…]                                                    │
 ╰───────────────────────────────────────────────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: SLATE DAG & STORYBOARDS + GENERATION CONTROL ROOM (view 2)

_source: /tmp/audit/view2.txt_

**Keybindings:** keys: [↑↓] select · [↵] use template/open · [n] new project/prompt · [P][c][v][o] project actions

```
 [TIMMY TRUST OS v1.0.8]              1 [2] 3  4  5  6  7  8  9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭───────────────────────────────────────────────────────────────╮  [RUNNING] [J-BANG] dp_mtf2mjua_yv · openhands · do.…
 │ ◆ ◇ SLATE DAG & STORYBOARDS       [5 projects · 7 templates]  │  [RUNNING] [J-BANG] dp_mtf25xnm_gt · openhands · do.…
 │ Author storyboards + projects in the terminal; watch them     │  [RUNNING] [J-BANG] dp_mt8iqfou_82 · openhands · do.…
 │ live in a carbonyl canvas. One schema → HyperFrames, sites,   │  ╭─────────────────────────────────────────────────╮
 │ tldraw.                                                       │  │ ◇ ◆ GENERATION    [generations:10 (done:4       │
 │                                                               │  │ CONTROL ROOM      running:1 queued:2 failed:3)] │
 │ ▸ ◆ blocking      ◆ blocking                                  │  │ Queue prompts at any provider; watch statuses   │
 │   ◆ c             2026-08-14 05:21 · template: blocking       │  │ flip live; every run ledgered, costed, sealed.  │
 │   ◆ character     0 refs · 0 gens                             │  │                                                 │
 │   ◆ demo-north    • 0s–12s [BLOCKING] blocking — GOD/POV diag…│  │ ▸ ● 04:02 ernie-imag… ernie-image-turbo · queued│
 │   ◆ iceberg       [P] renders site/ · [c] TIMMY Clip · [v]    │  │   × 03:43 openrouter… 2026-08-23 11:02:47 ·     │
 │   ◇ blocking      canvas · [o] site pane                      │  │   ● 22:16 nano-banan… local                     │
 │   ◇ branching                                                 │  │   ● 09:41 nano-banan…                           │
 │   ◇ callsheet                                                 │  │   ● 09:36 open-desig… audit ping                │
 │   ◇ character                                                 │  │   ● 09:11 open-desig…                           │
 │   ◇ iceberg                                                   │  │   ● 10:38 runcomfy  …                           │
 │   ◇ moodboard                                                 │  │   × 10:38 venice-vid…                           │
 │   ◇ storyboard                                                │  │   ● 10:37 venice-unc…                           │
 │                                                               │  │   × 09:45 nano-banan…                           │
 │                                                               │  │                                                 │
 │                                                               │  │                                                 │
 │                                                               │  │                                                 │
 │                                                               │  │                                                 │
 │                                                               │  │                                                 │
 │                                                               │  │                                                 │
 │                                                               │  │                                                 │
 │                                                               │  │                                                 │
 │                                                               │  │                                                 │
 │ [↑↓] select · [↵] use template / open · [n] new project · […  │  │ [↑↓] select · [n] new prompt · []/[] option (w… │
 ╰───────────────────────────────────────────────────────────────╯  ╰─────────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: AUDIT LOG MONITOR (view 3)

_source: /tmp/audit/view3.txt_

**Keybindings:** keys: [H] raw view · [F] follow · [↑↓] scroll · [W] web companion

```
 [TIMMY TRUST OS v1.0.8]              1  2 [3] 4  5  6  7  8  9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
  ╭──────────────────────────────────────────────────────────────────────────╭────────────────────────────────────────╮
  │ ◇ AUDIT LOG MONITOR                                                  [LIV│ the app's one ambient motion    [LIVE] │
  │ [H] raw view · [F] follow on · [↑↓] scroll · [W] web companion           │     │                                  │
  │                                                                          │     │                                  │
  │  [1] TUI Core   [2] Agent Events   [3] Companion   [4] Browser           │       gen update · ernie-image-turbo   │
  │  [5] Workspace   [6] Event Bus                                           │       gen queued · openrouter          │
  ╰──────────────────────────────────────────────────────────────────────────│─      gen update                       │
   01:34:40  ×  Companion server failed to start (listen EADDRINUSE: address │       gen queued · nano-banana-2 ×3    │
   01:34:40  ×  TIMMY TUI will continue without the browser companion.       │       gen update                       │
   01:34:40  ●  run sealed · tui-startup                                     │       gen queued · open-design         │
   01:37:53  ×  Companion server failed to start (listen EADDRINUSE: address │       gen update                       │
   01:37:53  ×  TIMMY TUI will continue without the browser companion.       │       gen queued · open-design         │
   01:37:54  ●  run sealed · tui-startup                                     │       gen failed — see /gens           │
   01:39:09  ·  quit captured. Clean exit.                                   │       gen update ×2                    │
   01:39:16  ×  Companion server failed to start (listen EADDRINUSE: address │       gen queued · venice-video        │
   01:39:16  ×  TIMMY TUI will continue without the browser companion.       │       gen done — artifact in ledger    │
   01:39:17  ●  run sealed · tui-startup                                     │       gen update ×2                    │
   17:15:29  ×  companion unreachable                                        │       gen queued · venice-uncensored   │
   17:15:41  ●  run sealed · tui-startup ×3                                  │       gen failed — see /gens           │
   17:15:51  ·  quit captured. Clean exit.                                   │       gen update ×2                    │
   17:28:34  ●  run sealed · tui-startup ×3                                  │ 1m  health ok ×2 · nano-banana-2       │
   17:28:45  ·  quit captured. Clean exit.                                   │ 1m  run sealed · tui-startup           │
   22:14:45  ●  run sealed · tui-startup ×2                                  │ 1m  health ok ×2                       │
                                                                             │ 1m  run sealed · tui-startup           │
                                                                             │ …and 177 more · [↑↓] scroll            │
                                                                             ╰────────────────────────────────────────╯
  lines 73-88 of 88 (human view) · 81 KB · upd 22:14:45             ▸ following tail
  ⌁ companion http://localhost:4310 · [w] live browser view (headless/MCP sessions)


 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: ESCROW LEDGER + RECEIPT CHAIN (view 4, BEFORE hotfix)

_source: /tmp/audit/view4.txt_

**Keybindings:** keys: [↓] scroll · [Enter] open receipt · [Esc] back

```
 [TIMMY TRUST OS v1.0.8]              1  2  3 [4] 5  6  7  8  9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭──────────────────────────────────────────────────────────────────╮  ╭──────────────────────────────────────────────╮
 │ ◆ ● ESCROW LEDGER                                     [49 live]  │  │ ◇ ◆ RECEIPT CHAIN                  [✓ ✓ 724] │
 │ locks · draws · refunds · slashes                                │  │ merkle + chain verify, newest first          │
 │                                                                  │  │                                              │
 │ locked   esc_0e988cf0 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 86a5e3b3 · cut.park                   │
 │ locked   esc_198030e3 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 278c12d7 · render.review              │
 │ locked   esc_1f03c26e · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] f9c5b92d · render.cut                 │
 │ locked   esc_20dbc697 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 2b1e7cd6 · redact.map                 │
 │ locked   esc_28cc03fa · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 00547c9f · gate.rebase                │
 │ locked   esc_2ca83da2 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 2a3d585a · roster.amend               │
 │ locked   esc_2de26995 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] fdc3c094 · roster.amend               │
 │ …and 42 more · [↓] scroll                                        │  │ …and 5 more · [↓] scroll                     │
 │                                                                  │  │ [VERIFIED] chain ok · 724 receipts           │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 ╰──────────────────────────────────────────────────────────────────╯  ╰──────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: LANES / TELEMETRY (view 5)

_source: /tmp/audit/view5.txt_

**Keybindings:** keys: [n] new lane · [↑↓] select · [Enter] open · [L] jump

```
 $0│
 │    try: fix the most…                        ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀…│  │ sandbox  host-ephemeral · neve
r the live c…│
 │   ● Hermes CLI                                                                    │  │ objective —
│
 │    governed agent ru…                                                             │  │ plan     — · draft
│
 │   ● Pi Daemon              ┃                                                      │  │ hash     — shown before launch
│
 │    minimal coding ag…      ┃  Ask anything... "Fix broken tests"                  │  │ armed    no
│
 │   ● Systems MCP            ┃                                                      │  │ rail: [o] objective · [h] harn
ess · [+-] c…│
 │    self-hosted Devin…      ┃  Build · MiniMax-M3 OpenCode Zen                     │  ╰───────────────────────────────
──────────────╯
 │   ● jcode                  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀…│
 │    coding agent on C…                                                      tab ag…│
 │   ● Minds CLI                                                                     │
 │    Animoca Brands Bu…     ~/Desktop/Code-Projects/timmy-tui:main  ⊙ 0 MCP /status…│
 │                                                                                   │
 │                                                                                   │
 │                                                                                   │
 │                                                                                   │
 │                                                                                   │
 │                                                                                   │
 │                                                                                   │
 │                                                                                   │
 │ first time here? this is your crew — six real agents, not decorations · [t] dele… │
 │                                                                                   │
 │ [↑↓] lane · [t/↵] type task · [g] approve · [n] spawn · [k] kill · [o] attach ·…  │
 ╰───────────────────────────────────────────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: BROWSE — DUAL-PANE WEB WORKSPACE (view 6)

_source: /tmp/audit/view6.txt_

**Keybindings:** keys: spawn carbonyl on any URL · [↑↓] pane · [Enter] focus

```
 [TIMMY TRUST OS v1.0.8]              1  2  3  4  5 [6] 7  8  9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭────────────────────────────────────────────────────────────╮  ╭────────────────────────────────────────────────────╮
 │ ◆ BROWSE — DUAL-PANE WEB WORKSPACE      [0 browser panes]  │  │ ◆ GOVERNED WORKSPACE OPERATOR      [UNINITIALIZED] │
 │ chromium in the terminal via carbonyl · heavier automation │  │ browse one safe local workspace root — secrets and │
 │  delegates through LANES                                   │  │ build folders hidden                               │
 │                                                            │  │                                                    │
 │                                                            │  │ TIMMY workspace uninitialized                      │
 │ no browser panes yet · [n] spawns carbonyl on any URL      │  │ required governed directories are missing under the│
 │                                                            │  │  workspace root:                                   │
 │                                                            │  │ /Users/williammeldman/Desktop/Code-Projects/timmy-t│
 │ [n] new pane (url) · [t] type into pane · [k] kill pane    │  │ ui                                                 │
 │                                                            │  │                                                    │
 │                                                            │  │ [Enter] initialize TIMMY workspace folders         │
 │                                                            │  │                                                    │
 │                                                            │  │ Select folders or files to inspect governed scope… │
 │                                                            │  │ [ files ] ▸ /files list█                           │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 │                                                            │  │                                                    │
 ╰────────────────────────────────────────────────────────────╯  ╰────────────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: PROJECTS — PER-PROJECT TREE + TIMMY CLIP (view 7)

_source: /tmp/audit/view7.txt_

**Keybindings:** keys: [↑↓] navigate · [Enter] open · [Tab] pane

```
 [TIMMY TRUST OS v1.0.8]              1  2  3  4  5  6 [7] 8  9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭──────────────────────────────────────────────╮  ╭──────────────────────────────────────────────────────────────────╮
 │ ◆ PROJECTS — PER-PROJECT TREE   [5 projects] │  │ ◇ TIMMY CLIP — VIDEO EDITING                           [2 jobs]  │
 │ context-optimized: PROJECT.md index first,   │  │ receipt-linked generations in, edited video out — powered by     │
 │ descend only when relevant · cross-linked by │  │ open-edit.                                                       │
 │ gen-id                                       │  │                                                                  │
 │                                              │  │ ▸ clip_msuaq007 ·…  clip_msuaq007 · launch                       │
 │ ▸ block…  studio/blocking/ — 0 gens · PROJEC…│  │   clip_msu4puqj ·…  instruction: T1 exit: EDL cut-list,          │
 │   c       ▸ slate.json                    …  │  │                     env-locked + signed, replay from cut-list    │
 │   chara…                                     │  │                     alone                                        │
 │   demo-…                                     │  │                                                                  │
 │   icebe…                                     │  │                     · launch render v3 → /Users/williammeldman/… │
 │                                              │  │                     out: /Users/williammeldman/Desktop/Code-Pro… │
 │                                              │  │                                                                  │
 │                                              │  │                     deterministic layer ([y] yanks these):       │
 │                                              │  │                       ffmpeg -i '/Users/williammeldman/heygen:h… │
 │                                              │  │                       ffmpeg -i '/Users/williammeldman/heygen:h… │
 │                                              │  │                       ffmpeg -i '/Users/williammeldman/heygen:h… │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │                                              │  │                                                                  │
 │ [←→] pane · [↑↓] move · [p] preview in term… │  │ [↑↓] job · [n] new job · [r] run headless + seal · [o] runbook…  │
 ╰──────────────────────────────────────────────╯  ╰──────────────────────────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: SYSTEM SETTINGS (view 8)

_source: /tmp/audit/view8.txt_

**Keybindings:** keys: [↑↓] navigate · [Enter] toggle · [Tab] pane

```
 [TIMMY TRUST OS v1.0.8]              1  2  3  4  5  6  7 [8] 9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭─────────────────────────────────────────────────────────────────────────────────────────╮
 │ ◆ SYSTEM SETTINGS                                                               [LOCAL] │
 │ TIMMY Settings & Options — change simple local settings · runtime secrets and bindings  │
 │ stay untouched                                                                          │
 │                                                                                         │
 │ ── configuration deck ───────────────────────────────────────────────────────────────── │
 │ ▸ Animations           Visual motion indicators                                [ON]     │
 │   Developer Mode       Show developer utilities                               [OFF]     │
 │   Sidebar Auto-hide    Auto hide left nav column                              [OFF]     │
 │   Browser Auto-open    Open browser companion                                 [OFF]     │
 │   Theme                Color palette and accents                      [Timmy Amber]     │
 │   OpenRouter Model     Active model for workflows                         [not set]     │
 │   Multiplexer          Terminal multiplexer backend (restart req..           [tmux]     │
 │ …and 4 more · [↓] scroll                                                                │
 │                                                                                         │
 │ ── auth & authority                                                                     │
 │ human auth      Local                                                                   │
 │ agentpass       Active                                                         [ACTIVE] │
 │ passports       Enabled                                                                 │
 │ visas           Enabled                                                                 │
 │ stamps          Enabled                                                       [STAMPED] │
 │ receipts        Local                                                          [SEALED] │
 │                                                                                         │
 │ [ options ] ▸ /options toggle animations to ON█                                         │
 ╰─────────────────────────────────────────────────────────────────────────────────────────╯





 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: SYSTEMS WEB CAPABILITY MAP + COMPANION (view 9)

_source: /tmp/audit/view9.txt_

**Keybindings:** keys: [Enter] open in-pane browser · [W] web companion

```
 [TIMMY TRUST OS v1.0.8]              1  2  3  4  5  6  7  8 [9]              ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭──────────────────────────────────────────────────────╮    ╭──────────────────────────────────────────────────────╮
 │ choose where work happens — carbonyl in-pane browser │    │ ◇ SYSTEMS WEB CAPABILITY MAP              [7 ACTIVE] │
 │  · companion mirror · tmux fallback                  │    │ navigate system capabilities — specs, safety scopes, │
 │                                                      │    │  and risk tiers pipe to the trust inspector          │
 │ ▸ Open In-Pane Browser          [READY]              │    │                                                      │
 │   Open Browser Companion        [RUNNING]            │    │ "Quartermaster here: Navigate Systems Web            │
 │                                                      │    │ capabilities below. Detailed specs, safety scopes,   │
 │   Open Local Files              [READY]              │    │ and risk tiers are piped straight to your Trust      │
 │   View Logs                     [READY]              │    │ Inspector on the right in real-time."                │
 │                                                      │    │                                                      │
 │   Show tmux Fallback            [READY]              │    │ ── installed system capabilities                     │
 │ ── selected ──────────────────────────────────────── │    │ ▸ MCP Tools Engine                 [ACTIVE] (CORE)   │
 │ Open In-Pane Browser                                 │    │                                                      │
 │                                                      │    │   TIMMY Porter Scanner             [ACTIVE] (CORE)   │
 │ Spawns a carbonyl session (real Chromium renderer)   │    │                                                      │
 │ as a tracked TIMMY lane inside your active           │    │   ACP Agent Bridge                 [ACTIVE] (EDGE)   │
 │ multiplexer backend. Browsing happens headlessly in  │    │                                                      │
 │ the terminal.                                        │    │   AgentPass Passport               [ACTIVE] (CORE)   │
 │                                                      │    │                                                      │
 │ http://localhost:3001                                │    │   RMUX Flight Recorder       [AVAILABLE] (SANDBOX)   │
 │                                                      │    │                                                      │
 │ [Enter] Open In-Pane Browser                         │    │   Cloudflare DO Embassy            [ACTIVE] (EDGE)   │
 │                                                      │    │                                                      │
 │ OpenHands Runner: not configured                     │    │   TIMMY Context Packs              [ACTIVE] (CORE)   │
 │                                                      │    │                                                      │
 │ ── diagnostics                                       │    │ …and 1 more · [↓] scroll                             │
 │ Press arrows / Tab to navigate. Enter selects        │    │                                                      │
 │ surface.                                             │    │ ── highlighted specs preview                         │
 │ [ workspace ] ▸ /workspace launch carbonyl█          │    │ Description: Dynamic server connection and raw capa… │
 ╰──────────────────────────────────────────────────────╯    ╰──────────────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: HELP / WHICH-KEY OVERLAY (?)

_source: /tmp/audit/help.txt_

**Keybindings:** keys: [?] open · [Esc] close · lists [1-9]/[Tab]/[L]/[^K]/[q]

```
 [TIMMY TRUST OS v1.0.8]              1  2  3  4  5  6  7  8 [9]              ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭──────────────────────────────────────────────────────╮    ╭──────────────────────────────────────────────────────╮
 │ choose where work happens — carbonyl in-pane browser │    │ ◇ SYSTEMS WEB CAPABILITY MAP              [7 ACTIVE] │
 │  · companion mirro ╭────────────────────────────────────────────────────╮ m capabilities — specs, safety scopes, │
 │                    │ ◆ VIEW GRAMMAR — REVIEW                            │ s pipe to the trust inspector          │
 │ ▸ Open In-Pane Bro │ press ? or esc to close                            │                                        │
 │   Open Browser Com │                                                    │  here: Navigate Systems Web            │
 │                    │ WHAT IS TIMMY?                                     │ elow. Detailed specs, safety scopes,   │
 │   Open Local Files │ Terminal-first Agent Trust OS — a flight recorder  │  are piped straight to your Trust      │
 │   View Logs        │ for AI agent runs.                                 │ he right in real-time."                │
 │                    │ What is a receipt? Every action seals a SHA-256 /  │                                        │
 │   Show tmux Fallba │ ed25519 receipt; chains verify from [4] ESCROW.    │ ystem capabilities                     │
 │ ── selected ────── │                                                    │ gine                 [ACTIVE] (CORE)   │
 │ Open In-Pane Brows │ [1-9]     switch views                             │                                        │
 │                    │ [Tab]     cycle pane focus (⇧Tab reverses)         │  Scanner             [ACTIVE] (CORE)   │
 │ Spawns a carbonyl  │ [L]       jump to TELEMETRY                        │                                        │
 │ as a tracked TIMMY │ [^K]      models + command palette                 │ idge                 [ACTIVE] (EDGE)   │
 │ multiplexer backen │ [?]       this overlay · [q] quit · ^C quit        │                                        │
 │ the terminal.      ╰────────────────────────────────────────────────────╯ ssport               [ACTIVE] (CORE)   │
 │                                                      │    │                                                      │
 │ http://localhost:3001                                │    │   RMUX Flight Recorder       [AVAILABLE] (SANDBOX)   │
 │                                                      │    │                                                      │
 │ [Enter] Open In-Pane Browser                         │    │   Cloudflare DO Embassy            [ACTIVE] (EDGE)   │
 │                                                      │    │                                                      │
 │ OpenHands Runner: not configured                     │    │   TIMMY Context Packs              [ACTIVE] (CORE)   │
 │                                                      │    │                                                      │
 │ ── diagnostics                                       │    │ …and 1 more · [↓] scroll                             │
 │ Press arrows / Tab to navigate. Enter selects        │    │                                                      │
 │ surface.                                             │    │ ── highlighted specs preview                         │
 │ [ workspace ] ▸ /workspace launch carbonyl█          │    │ Description: Dynamic server connection and raw capa… │
 ╰──────────────────────────────────────────────────────╯    ╰──────────────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:MODAL:HELP                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  …

```



---

## CAPTURE: COMMAND PALETTE (^K)

_source: /tmp/audit/palette.txt_

**Keybindings:** keys: [↑↓] scroll · [Enter] choose · [Esc] dismiss

```
 [TIMMY TRUST OS v1.0.8]              1  2  3  4  5  6  7  8 [9]              ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭──────────────────────────────────────────────────────╮    ╭──────────────────────────────────────────────────────╮
 │ choose where work happens — carbonyl in-pane browser │    │ ◇ SYSTEMS WEB CAPABILITY MAP              [7 ACTIVE] │
 │  · companion mirro ╭────────────────────────────────────────────────────╮ m capabilities — specs, safety scopes, │
 │                    │ ◆ COMMAND PALETTE                                  │ s pipe to the trust inspector          │
 │ ▸ Open In-Pane Bro │ ^K anything · arrows scroll · enter choose · esc   │                                        │
 │   Open Browser Com │ dismiss                                            │  here: Navigate Systems Web            │
 │                    │                                                    │ elow. Detailed specs, safety scopes,   │
 │   Open Local Files │ ▸  1. go · [1] COMMAND — clean conversation        │  are piped straight to your Trust      │
 │   View Logs        │    2. go · [2] MISSION — DAG + capsules            │ he right in real-time."                │
 │                    │    3. go · [3] TELEMETRY — logs + rain             │                                        │
 │   Show tmux Fallba │    4. go · [4] ESCROW — ledger + receipts          │ ystem capabilities                     │
 │ ── selected ────── │    5. go · [5] LANES — harness lanes + dispatch    │ gine                 [ACTIVE] (CORE)   │
 │ Open In-Pane Brows │ rail                                               │                                        │
 │                    │    6. go · [6] LIBRARY — browse + files            │  Scanner             [ACTIVE] (CORE)   │
 │ Spawns a carbonyl  │    7. go · [7] PROJECTS — projects + clips         │                                        │
 │ as a tracked TIMMY │    8. go · [8] SYSTEM — options / setup / models   │ idge                 [ACTIVE] (EDGE)   │
 │ multiplexer backen │ (Tab)                                              │                                        │
 │ the terminal.      │    9. go · [9] REVIEW — code review + dashboard    │ ssport               [ACTIVE] (CORE)   │
 │                    │   10. feature · J-BANG dispatch rail               │                                        │
 │ http://localhost:3 │   11. feature · harness lanes                      │ Recorder       [AVAILABLE] (SANDBOX)   │
 │                    │   12. feature · escrow ledger + refunds            │                                        │
 │ [Enter] Open In-Pa │   13. feature · receipt chain verify               │ O Embassy            [ACTIVE] (EDGE)   │
 │                    │   14. feature · live log relay + passport          │                                        │
 │ OpenHands Runner:  │   15. feature · mission DAG + capsules             │ t Packs              [ACTIVE] (CORE)   │
 │                    │   16. feature · clips + EDL replay                 │                                        │
 │ ── diagnostics     │   17. feature · model explorer                     │ [↓] scroll                             │
 │ Press arrows / Tab │   18. feature · setup / onboarding prefs           │                                        │
 │ surface.           │   19. feature · code review + dashboard            │  specs preview                         │
 │ [ workspace ] ▸ /w │   20. model · Claude 4.7 Opus · reasoning          │ ynamic server connection and raw capa… │
 ╰─────────────────── │   21. model · GPT-5.5 · general                    │ ───────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:MODAL:PALETTE                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Hel…

```



---

## CAPTURE: RECEIPT DETAIL (attempt via Enter on view4, pre-hotfix)

_source: /tmp/audit/receipt-detail.txt_

**Keybindings:** keys: [Enter] open · [Esc] back

```
 [TIMMY TRUST OS v1.0.8]              1  2  3 [4] 5  6  7  8  9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭──────────────────────────────────────────────────────────────────╮  ╭──────────────────────────────────────────────╮
 │ ◆ ● ESCROW LEDGER                                     [49 live]  │  │ ◇ ◆ RECEIPT CHAIN                  [✓ ✓ 724] │
 │ locks · draws · refunds · slashes                                │  │ merkle + chain verify, newest first          │
 │                                                                  │  │                                              │
 │ locked   esc_0e988cf0 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 86a5e3b3 · cut.park                   │
 │ locked   esc_198030e3 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 278c12d7 · render.review              │
 │ locked   esc_1f03c26e · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] f9c5b92d · render.cut                 │
 │ locked   esc_20dbc697 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 2b1e7cd6 · redact.map                 │
 │ locked   esc_28cc03fa · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 00547c9f · gate.rebase                │
 │ locked   esc_2ca83da2 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] 2a3d585a · roster.amend               │
 │ locked   esc_2de26995 · ceil 1 · drawn 0 · refund=1.00           │  │ [FAIL] fdc3c094 · roster.amend               │
 │ …and 42 more · [↓] scroll                                        │  │ …and 5 more · [↓] scroll                     │
 │                                                                  │  │ [VERIFIED] chain ok · 724 receipts           │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 │                                                                  │  │                                              │
 ╰──────────────────────────────────────────────────────────────────╯  ╰──────────────────────────────────────────────╯
 ~/timmy · run_i7gvbo3 MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```



---

## CAPTURE: ESCROW LEDGER + RECEIPT CHAIN (view 4, AFTER hotfix C1/C2)

_source: /tmp/audit/view4-after.txt_

**Keybindings:** keys: [↓] scroll · [Enter] open receipt · [Esc] back · footer hint [Enter] open · [Esc] back

```
 [TIMMY TRUST OS v1.0.8]              1  2  3 [4] 5  6  7  8  9               ● DOCKER: DOWN ● COMFY: READY COST: $0.00
 ╭────────────────────────────────────────────────────────╮  ╭────────────────────────────────────────────────────────╮
 │ ◆ ● ESCROW LEDGER                           [51 live]  │  │ ◇ ◆ RECEIPT CHAIN                            [✓ ✓ 738] │
 │ locks · draws · refunds · slashes                      │  │ merkle + chain verify, newest first                    │
 │                                                        │  │                                                        │
 │ locked   esc_0e988cf0 · ceil 1 · drawn 0 · refund=1.…  │  │ ▸[OK] 0fb01729 · chain.anchor                          │
 │ locked   esc_198030e3 · ceil 1 · drawn 0 · refund=1.…  │  │  [FAIL] eb61ca5d · comfy golden blocked (workflow mi.… │
 │ locked   esc_1f03c26e · ceil 1 · drawn 0 · refund=1.…  │  │  [OK] d559e173 · escrow esc_e384605d · locked (dis...  │
 │ locked   esc_20dbc697 · ceil 1 · drawn 0 · refund=1.…  │  │  [OK] 5d23e0ba · escrow esc_e384605d armed · ceili...  │
 │ locked   esc_2721a924 · ceil 1 · drawn 0 · refund=1.…  │  │  [OK] c75c32d8 · agent-pass ap_66d31f57 · merkle b...  │
 │ locked   esc_28cc03fa · ceil 1 · drawn 0 · refund=1.…  │  │  [OK] bc1ba121 · inspector parent                      │
 │ locked   esc_2ca83da2 · ceil 1 · drawn 0 · refund=1.…  │  │  [FAIL] 7baf1ff7 · comfy golden blocked (workflow mi.… │
 │ …and 44 more · [↓] scroll                              │  │ …and 5 more · [↓] scroll                               │
 │                                                        │  │ [VERIFIED] chain ok · 738 receipts                     │
 │                                                        │  │                                                        │
 │                                                        │  │ [Enter] open · [Esc] back                              │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 │                                                        │  │                                                        │
 ╰────────────────────────────────────────────────────────╯  ╰────────────────────────────────────────────────────────╯
 ~/timmy · run_mzmwgtf MODE:NAV                  [Tab] Switch Card  [1-9] Switch View  [^K] Palette  [?] Help  [q] Quit

```
