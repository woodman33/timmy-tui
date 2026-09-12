# ROUNDS — SYNTHETIC FIXTURE · eight hands · ui-cockpit-k7m3 C6 DEMO

This chart is the placeholder board for the film shot "the cockpit with eight
hands on screen". Every row is synthetic: the hand names, worktrees and seal
ids are fixture values (a seal id reads `fixt000N`, never a chain hash), and
the prompts are paraphrases of public commit messages. Nothing here is a claim
about a real session. The real board lives only in `.timmy/private/cockpit/`
and is never committed.

    timmy cockpit shot --rounds lanes/demos/hands-8.rounds.md   # stages it in a throwaway root
    timmy cockpit board import lanes/demos/hands-8.rounds.md    # or import it as your board

| hand | tool | worktree | order | round | state | last_seal |
| --- | --- | --- | --- | --- | --- | --- |
| cc1 | claude | wt-cockpit | ui-cockpit-k7m3 | R4 | running | sha256_fixt0001aaaaaaaa |
| cc2 | claude | wt-factory | factory-f1d0 | R2 | HOLD | sha256_fixt0002bbbbbbbb |
| cc3 | claude | wt-hana | hana-h2m6 | R2 | HOLD | sha256_fixt0003cccccccc |
| cc4 | claude | wt-engine-room | showpiece-spline-s8v2 | R3 | HOLD | sha256_fixt0004dddddddd |
| cc5 | claude | wt-blank-slate | blank-slate-v1k9 | R1 | needs-approval | sha256_fixt0005eeeeeeee |
| codex | codex-cli | wt-studio | studio-preservation | R1 | running | sha256_fixt0006ffffffff |
| qwen | qwen | wt-ui-next-2 | ui-next-2 | R3 | idle | sha256_fixt0007a1b2c3d4 |
| bugbot | external | — | review | R0 | STOP | — |

## prompt cc1 R4
C6 DEMO: the cockpit with 8 hands on screen is a film shot — capture it. PR against #47. HOLD.

## prompt cc2 R2
C2b: seal the forecast before any send; run the privacy gate over the exact prompt bytes before a transport exists; hash every take. HOLD.

## prompt cc3 R2
C2: THE RECEIPT CARD — a sealed card carrying PREDICTION | EVIDENCE | SEAL with a hidden REFUSE state; forecast sealed first. HOLD.

## prompt cc4 R3
C7: instruments and the code layer in THE ENGINE ROOM; seal the checkpoint, report, HOLD.

## prompt cc5 R1
Hash the identity terms, move the ledger into the private overlay, run the release check in docker. Report and HOLD.

## prompt codex R1
Preserve the studio inventory; keep the archive private and publish the preservation hash only.

## prompt qwen R3
FILM-PLAN-v2: DEMOS last in the LIBRARY rail so the Reuse moment sits at the visible bottom; narrow keeps it in the left column.
