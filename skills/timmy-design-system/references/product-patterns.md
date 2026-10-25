# Product patterns — the one shell (ACCEPTED, `src/companion/client/{index.html,shell.js,companion.css}`, SHELL CONTRACT v1)

## Names

TIMMY is the umbrella; the page names stay as they are: Chat · Files · Workflows · Runs & receipts · Canvas · VoxVision ·
Motion & 3D · Models & accounts · Tools & integrations · Control Room · Settings · Account (Studio, VoxVision, Clip, Porter
remain product names). No new subbrands.

## The frame

```
aside#shell-rail.nav-rail             the permanent rail (a top strip + a sheet ≤ 720 px)
  .rail-brand                         the mark (canvas[data-timmy-mark] + "T") and TIMMY
  #rail-project / #rail-project-menu  the project switcher (chat-shell.js fills it); #rail-new-conv "New conversation"
  nav#rail-menu .rail-item[data-page][data-dest]   D3's groups: Chat · WORK Files, Workflows, Runs & receipts · CREATE Canvas,
                                      VoxVision, Motion & 3D · CONNECT Models & accounts, Tools & integrations · Control Room
  .rail-foot                          #shell-help "Help & find" (⌘K · ?), the account block (#rail-account …)
div#shell-main.shell-body
  header#shell-top.topbar             #shell-crumb-ws / #shell-crumb-page ("project / Page"), #shell-status (the live word is
                                      the SOCKET only: "Companion connected" — green ONLY while it is observed open — or
                                      "Companion offline · reconnecting"; a turn's activity is the Chat's console band word and
                                      the band's Records cell, never this word), .theme-switch [data-theme]
  nav.ws-nav[hidden] #ws-tabs         the old tab row: hidden, the keys 1–9/0 and companion.js's switcher drive it
  main#ws-main                        one section.page per destination (below)
  section#ws-activity                 the records band: the activity stream, foldable; the companion's own facts under Details
```

`body[data-page]` is the page shown (`data-dest` keeps the legacy tab id). Settings and Account are reached from the account
block and Help & find, not the rail; Home and Fleet & Clef keep their keys only. The project is named with ONE spelling — the
rail's card, the crumb and the band's Workspace cell all read the companion's display name (`#project-name`, R94).

### The landing rule (`TimmyShell.land(why?)`)

No launch token → the workspace page with the page's own no-token words (nothing is read). An identity provider configured
and no session → Account. Signed in → Models & accounts until a route is usable, then the workspace: the page the person
CHOSE (remembered in `localStorage` `timmy.shell.screen`), else the boot tab, else Chat — never Models & accounts or Account
themselves (the landing's own two stops are not places to land; the lead's 18:29 ruling). Models & accounts' "Continue to the
workspace" runs `land()`; pressed there the why is `continue`. A page's title takes the focus when a page opens (D11), with the
token focus ring (D17).

## The page scaffold (every destination)

```
section.page.ws-page[data-page][data-ws-page][data-state=empty|content|running|approval|error]
  header.page-head      .page-kicker ("NN / VERB PHRASE": the number is the rail's order) · h1.page-title · p.page-intro ·
                        .page-head-actions (.page-context-btn: the phone's opener; .page-primary: the ONE primary next action)
  div.page-band         .band-cell × Workspace · Model · Records (+ the page's own cells; a cell without words is not drawn) ·
                        .band-action ONLY for a verb that differs from the primary's (D19: the band never twins the primary)
  div.page-body         grid: .page-work (minmax 0 1fr) + aside.page-context (320 px; 280 at ≤ 1320; a sheet ≤ 720)
  div.page-dock         .dock-label · #ws-strip (the frame's actions, moved here) · .dock-tools (the page's) · .dock-stop
  div.page-records      quiet, expandable: <details class="records"> (the owner's)
```

Technical syntax (paths, ids, hashes, commands) goes behind `<details class="ui-details">` inside the region it belongs to.
The frame's Unfinished box (companion.js prepends it) sits between the head and the band.

### Registration (`window.TimmyShell`)

```js
TimmyShell.page(id, { kicker, title, intro, primary: { label, run, disabled?, why? }, context: 'models'|'selection'|null, band?: [{k,v}], bandAction?: { label, run, disabled?, why? }, dock? });
TimmyShell.state(id, 'empty'|'content'|'running'|'approval'|'error', { words?, next?: { label, run } });
TimmyShell.band(id, { workspace?, model?, records? });
TimmyShell.go(id, why);        // a page id or a legacy tab id (studio → canvas, logs → runs, create → motion)
TimmyShell.current();          // the page id
TimmyShell.sheet('rail'|'context'|'help', open?);  TimmyShell.theme('amber'|'glacier');
TimmyShell.on('page'|'screen'|'session'|'identity'|'sheet'|'theme', fn);
TimmyShell.mount(screenId, draw);   // account, connections: draw(section, shell) writes into the section's scaffold regions
```

What a page does not register is drawn from the frame (the tab's primary action becomes the default primary) and the shell's
own verb-led defaults; nothing is left blank, nothing is invented. `state()` moves the dock (Stop slot while running) and the
band (NEEDS YOU first on approval, amber with its glyph); empty / error words carry a verb-led next action.

## States and words

Empty, content, running, approval and error on every page, each with a verb-led next action. Nothing is green unless observed;
"installed" is not "working"; a FAKE fixture says FAKE on the page; unknown metadata stays unknown.

## The phone (≤ 720 px)

The rail is a 56 px strip (the mark, Menu) and a sheet (`#rail-sheet`, `role=dialog aria-modal` while open; Escape and the
scrim close it; the focus returns to Menu); the sheet's list (`.rail-scroll`) is its one scroll area, its foot stays put, the
last group clears the foot (R99). The topbar is two rows: the crumb with the theme switch as WORDS ("Glacier" · "Amber", the
active one pressed — never two dots, R92), the live word under them. The context is a bottom sheet (`.page-context.is-open`,
opened by `.page-context-btn`, shown only while the column holds something). The head is a grid: the opener on the kicker's row,
the intro two lines at most, the primary full width; the band shows its first two facts WHOLE (what waits on you before them)
and folds the rest behind a "· more" disclosure (D19: never a label with an empty value); the dock is one sticky row scrolling
sideways and says nothing when the frame gives no actions; the records band is folded (44 px). Nothing is cut, nothing scrolls
sideways. No focus trap.

## Help & find (`#shell-help-dialog`)

⌘K / Ctrl+K anywhere, `?` when not typing, the rail's button: one dialog, one search over three lists — Go to (destinations),
On this page (the registration's primary, the frame's actions, the theme switch), Keys. Enter opens the first; Escape closes
and returns the focus. Verb-led copy ("Open Workflows", "Choose a model", "Stop the turn").

## Components a page uses (companion.css, the shell block)

`.ui-primary` (the one primary: the accent gradient, accent-ink label, its halo), `.ui-btn` (raised material), `.ui-panel`,
`.ui-raised`, `.ui-paper` (the light focal object; `.ui-muted`/small in ink-soft), `.ui-details`, `.ui-state` (`.is-live`
only for an observed state, `.is-attn` amber), `.dock-btn`, `.records`.

## The terminal (B10, unchanged)

Pure-black canvas; `#333333` structure / `#444444` execution; `#FFB000` focus, intent, predict, selection, what waits; `#28FE14`
observed live / passed / sealed with its word. The hierarchy above is translated into character cells (the Workbench), never
scaled from CSS pixels; no Glacier blue reaches a terminal.

## PROPOSED (not built or not ruled)

- Pages still on their round-4/-6 compositions inside the scaffold adopt `.page-context` / `.page-dock` / `.page-records` as
  their owners move them (the transitional rules in companion.css are marked per owner and go with the move).
