# Fleets, decisions and Cloudroom (round R4, 2026-10-15)

The operator's 09:44 PT order: add Cloudflare Clef-Omni as a decision model, and Cloudroom as a backend for fleets of up to
100 agents and 100 VMs. This page says what exists on branch `r4/fleet-clef`, what is simulated, what was tested, what was
qualified against a live service (nothing yet), how to try it, and what a real rollout needs.

Everything here runs offline. No VM, sandbox, Core service or model was started or called. No credential was copied, and
nothing was spent, deployed or published.

## The words used here

- **planned / requested / admitted / queued / running / delivered / verified** are kept apart in every count. "Delivered"
  is the runtime's word: it said "completed". Nothing a fleet run delivers is verified by the run.
- **FAKE** labels the offline backend and every answer file written by hand. A FAKE fleet is a simulation: no compute, no
  harness, no model and no cost.
- **A session is not a VM, and a branch is not isolation.** Isolation is named for what the provider gives:
  - `shared-session`: a session on a shared machine;
  - `container`;
  - `provider-sandbox`: a provider's sandbox, such as Modal's gVisor containers;
  - `microvm`;
  - `vm`.

  A plan the provider cannot honour is refused in words, never run with less.
- **A recommendation** from the decision model is drawn in amber. It is never applied. Green is kept for a state that is
  actually live, passed or sealed. Nothing in the fleet parts is green.

## Capability table

Every row below is implemented. "Tested" means the named suites, run offline. "Live-qualified" means checked against a real
service. No row is live-qualified yet.

| Capability | Simulated? | Tested |
|---|---|---|
| Fleet plan (1–100 workers): concurrency cap, provider, isolation, harness and model, CPU/RAM/disk, TTL, compute and inference budgets, policy (review, local-only, free-only). Refusals in words. | — | `fleet-core`, `fleet-service` |
| FAKE backend: provisioner and runtime with faults (unknown create, timeout, drop, expiry, child in parent, refusal, leaked token). | yes, all of it | `fleet-core` (17) |
| Scheduler. See (a). | on FAKE | `fleet-core`: 100 workers at a cap of 4, peak ≤ 4 |
| One Timmy operation per plan; a prediction receipt before the run and a run receipt after; `timmy op` reads it. | — | `fleet-service` |
| `timmy fleet providers\|plan\|run\|status\|events\|stop\|reconcile\|collect`. Agents need an operator-minted token (`timmy approve <hash>`) under review-before-dispatch; paid compute always needs one. | FAKE backend only | `fleet-service`, through the shipped entry |
| MCP `timmy_fleet_*`. Same parser, same checks; an MCP caller is an agent. | FAKE backend only | `fleet-service`; `timmy_fleet_status` was called through both MCP-to-CLI routes (sdk and mcporter) |
| God's Eye View's Fleets part: first-screen line, `/overview fleet`, board card, a real fleet's leftovers in Needs you. See (b). | FAKE plans | `overview-fleet` (7); actual captures: REPL in tmux, board in Chromium at 1280 and 390 px |
| Clef-Omni decision provider (H120). See (c). | FAKE answers and FAKE HTTP servers on 127.0.0.1 | `decision-*` (147) |
| `timmy decide` and MCP `timmy_decide_route`. | as above | `decision-cli`; called through both MCP-to-CLI routes |
| A fleet plan's route advice: one question per plan, shown, never applied. See (d). | FAKE answer (`fleet-route-pi.json`) | `fleet-route` (3) |
| Child sessions: a provider may declare a child in its parent's sandbox "detected, not prevented"; the worker fails. | on FAKE | `fleet-core` (child isolation) |
| Cloudroom Core adapter (H121, wired by the lead). See (e). | FAKE Core on 127.0.0.1 | `fleet-cloudroom` (18), including 100 workers at a cap of 8; `fleet-cloudroom-cli` (3), through the shipped CLI over real HTTP |
| Modal sandbox provisioner. See (f). | — | — |
| Control Room, live board (Browser Companion) and Studio nodes for fleets. See (g). | — | — |

Notes:

- **(a) What the scheduler does:**
  - It keeps concurrency bounded.
  - It records each allocation's identity before bootstrap.
  - It settles an unknown create by lookup before any other create.
  - It handles timeouts, cancellation (signal or CANCEL file) and crash recovery.
  - It collects results before teardown. Stopping a harness, closing a session and destroying compute are separate steps.
  - It sweeps orphans.
- **(b)** The Fleets part is present only in a project with a fleet plan, so other projects' screens are unchanged.
- **(c) What the decision provider covers:**
  - Settings, all off or cautious by default: "Use Clef routing" off, "Allow cloud analysis" off, "Require review before
    dispatch" on.
  - A token file read only with 0600 or 0400 permissions.
  - Workers AI REST and SystemOne transports.
  - The allowed-choice set, egress, budget and media rules, stale revisions, and admission.
  - Each decision recorded once, with a deterministic fallback.
- **(d)** The route advice is drawn in amber in the CLI, in status and in God's Eye View.
- **(e) Cloudroom Core:**
  - An adapted subset of Core's own TypeScript client (`integrations/bb/client.ts` at `3949daa`, Apache-2.0, its license
    beside it), a runtime, and a provisioner for one self-hosted Core. Each worker is a session on that shared machine,
    never a VM.
  - `timmy fleet connect cloudroom <url> --token-file <file>` records which Core and where its 0600 token file is. It never
    reads or copies the token, and it is a person's step, not an MCP tool.
  - `TIMMY_FLEET_CLOUDROOM=1` turns the configured Core on as provider `cloudroom`. `TIMMY_FLEET_CLOUDROOM=fake` starts a FAKE
    Core in the process as provider `cloudroom-fake`, labelled a simulation everywhere.
  - Every child request is refused at once, so Core's no-answer fallback into the parent's folder never fires. A
    `--shared-sandbox` child fails its worker under a strict plan. An `unknown` receipt is never resent.
  - A plan for a real runtime needs task words (`--prompt`). A plan asking for a VM per worker is refused: one Core gives
    sessions on one machine.
- **(f)** The Modal provisioner is the Codex assignment below.
- **(g)** The live board draws the same Overview HTML, so the Fleets card appears there too, but it was not exercised on
  the live board in this round. Control Room rows and Studio nodes for fleets are not built yet.

## Try it today (offline, in any git project)

```sh
timmy fleet providers                                  # FAKE available; Cloudroom, Modal, Hostinger unavailable, with why
timmy fleet plan --workers 100 --concurrency 4         # a SIMULATION on the FAKE backend; nothing starts
timmy fleet run <plan>                                 # from a terminal (a person); an agent needs: timmy approve <hash>
timmy fleet status <plan>                              # counts kept apart; delivered (not verified)
timmy fleet events <plan> --worker 1                   # normalized events, each with the runtime's own event (redacted)
timmy op <operation>                                   # the run detail: prediction, run receipt, verdict
timmy decide route --option codex --option pi --deterministic codex   # Clef is off by default: the deterministic option, recorded
TIMMY_CLEF=1 timmy decide route --option codex --option pi --option openhands --deterministic codex \
  --fixture tests/fixtures/clef-omni/response-route-ok.json            # a FAKE answer: a recommendation, never applied
```

In the REPL, `/overview` shows one Fleets line, and `/overview fleet` shows everything. `/board` draws the card.

The Cloudroom adapter, offline:

```sh
TIMMY_FLEET_CLOUDROOM=fake timmy fleet providers       # cloudroom-fake available: a FAKE Core in this process
TIMMY_FLEET_CLOUDROOM=fake timmy fleet plan --provider cloudroom-fake --isolation shared-session --workers 5 --prompt "FAKE task"
TIMMY_FLEET_CLOUDROOM=fake timmy fleet run <plan>      # real HTTP to the FAKE Core; SIMULATION on every line
timmy fleet connect cloudroom https://<your Core> --token-file <a 0600 file of yours>   # records; contacts nothing
```

## Staged rollout (each stage needs the operator's go-ahead)

1. **Now: offline.** Everything above, FAKE only.
2. **One environment.**
   - One self-hosted Cloudroom Core on a machine the operator owns, from the pinned revision `3949daa` (Ubuntu 24.04,
     its own install script), reached privately (Tailscale or SSH).
   - Its scoped token goes in a 0600 file; Timmy never borrows the desktop app's or a harness's login.
   - One worker, `shared-session`, TTL 30, review on.
   - Qualify `health`, `ready`, `capabilities`, one session, its event stream with a reconnect, interrupt, close and the
     recovery check. Write down what passed.
   - Clef: one Workers AI call with a capped budget ($0.15 per million input tokens; output is free), or a self-hosted
     SystemOne on a large GPU (about 70.5 GB of weights, about 64 GB of GPU memory). Report hosted and self-hosted
     separately.
3. **A small fleet.** Five workers at a concurrency of 2 on the same Core, then two provider sandboxes (Modal) once that
   adapter exists, each with its own Core. Measure, and compare the counts with the provider's own listing.
4. **100 workers, only when authorized.**
   - Explicit compute and inference budgets, a TTL and a concurrency cap.
   - An operator-minted approval token.
   - Orphan sweep and teardown checked against the provider's listing after the run.

## What needs the operator

- **A Cloudroom Core to connect to.** It can be self-hosted, or hosted (invite-only), plus its token. Then a person runs
  `timmy fleet connect cloudroom <url> --token-file <file>` and sets `TIMMY_FLEET_CLOUDROOM=1`. Until then, the provider
  says it is unavailable and why.
- **Authorization for any live call or spend.** That includes the first Workers AI call.
- **CODEX_UI_SPEC.md** was not found on any pushed branch.
  - The fleet parts use the theme's attention token (`#E5B550`) for amber. They do not use `#FFB000`.
  - They follow the 2026-10-15 rule: green only for live, passed or sealed.
  - DESIGN.md B9 still draws commands green elsewhere. A person decides whether to align them (see
    `B9-MONITOR-PROPOSAL.md`).
- **PostgreSQL is not needed by Timmy.** Cloudroom Core keeps its own history in PostgreSQL on its own machine; Timmy is
  only its client.

## Decisions on H120's questions

1. The MCP tool is `timmy_decide_route`, like every other tool on Timmy's server.
2. The `human_review` probability is recorded and shown, and does not change the outcome. No threshold for it has been
   evaluated.
3. A paid Clef call's budget is the fleet plan's inference budget; standalone, it is `--budget-usd`. Without either, a paid
   call is refused. There is never a silent paid fallback.
4. The same operation and revision return the recorded decision, even after Clef is turned on. A new operation asks again.
   That is the "reuse decisions on retries" rule.
5. A folder that is not a git repository has no revision to bind to, so it falls back to the deterministic option, said so.

The judge's thresholds (0.60 top, 0.15 margin) are placeholders. They have not been evaluated against outcomes, and the
model's numbers are not calibrated.

## Decisions on H121's questions

1. **An `unknown` receipt is final for Timmy**, even though Core may settle it later. It is never resent. A reconcile may
   read what Core says now and record it.
2. **`subagents` alone counts as "may share the parent"**. That is the safe side.
3. **The FAKE Core has its own provider id**, `cloudroom-fake`, so a simulation can never be shown as a Core.
4. **The BB MIT notice does not travel with `client.ts`.** It was adapted from the core's Apache-2.0 copy. The
   byte-identical copy in the GUI repository is recorded in `CLOUDROOM-PROVENANCE.md`.

Known limits:
- Each Core record becomes one stored event with an fsync, which a real Core's text deltas will make slow; batching is
  for the live stage.
- Close and interrupt cannot yet say "nothing to do".
- Codex's own sub-agents bypass Core's child path and are not counted.

`CLOUDROOM-PROVENANCE.md` lists the ten places where Core's contract is ambiguous.

## Codex assignment: the Modal sandbox provisioner

This assignment is independent of all UI work. It owns only `src/fleet/modal/**` and `tests/fleet-modal*.test.ts`.

- **Interface.** Implement `Provisioner` (`src/fleet/backend.ts`) against an injected client, shaped like the upstream
  `ModalSandboxClient`: cloudroom-gui `f939f41`, `gui/plugins/environment-modal-sandbox/providers/modal/client.ts`,
  Apache-2.0. The client covers `create`, `fromId`, `fromName`, `listByKey`, `terminate` and `observe`.
- **No new dependency.** Load the real `modal` SDK only when a flag names it.
- **Naming and records.**
  - Sandbox names come from allocation keys.
  - Write a pending-allocation record before `create`.
  - Settle an unknown create with `fromName`.
  - Tag with `timmy.plan` and `timmy.alloc`; list by tag for the orphan sweep.
  - `terminate`, then verify the sandbox is gone.
- **Capabilities.** Isolation is `provider-sandbox` only: these are gVisor containers, not VMs. Report `paid: true` with a
  price only when the operator supplies one; otherwise "unknown".
- **Tests.** Use a FAKE client covering create timeouts, unknown outcomes, refusals, expiry, orphans and partial failure.
  Run nothing live.
- **Don't touch:** `src/fleet/{service,cli,mcp,scheduler,plan}.ts` and any UI file. Write seam changes as requests to the
  lead.

## Provenance

- **Clef-Omni:** read only; no model call and no weight download.
  - <https://developers.cloudflare.com/workers-ai/models/clef-omni/> and its `schema-input.json` and `schema-output.json`
  - <https://huggingface.co/Cloudflare/clef-omni> (Apache-2.0)

  Pinned in `src/decision/clef-contract.ts`.
- **Cloudroom:** read at core `3949daaea3c7613458e9ad14afddbd267a0a56bc` and app `f939f4103c5a2946f03d85de37af94d1a58053fb`.
  The files reused or read, each with its license, are listed in `CLOUDROOM-PROVENANCE.md`.
- **Deliberately not reused from the app:**
  - its sandbox service, which copies the Mac's Codex, Claude, gh and other logins into cloud sandboxes;
  - `runOnVm`, which is host control;
  - teleport.
