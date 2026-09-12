# Factory lane — ORDER factory-f1d0 · C2 omma.build · C3 tournament → hana.frame → verifiers

`omma.build(intent, inputs: JSON | CSV | GLB) → site | scene`, run the Timmy way: the forecast is
sealed before anything is sent, every prompt passes the privacy gate before the transport sees it,
every take is hashed and carries a status, the cost of every real call is sealed, and the takes
compete in a tournament whose winner is finished into a Hana frame and verified four ways.

| file | what |
|---|---|
| `omma.mjs` | the lane: `build`, `predict`, `takes`; parses inputs, seals the forecast, gates, sends, hashes |
| `gate.mjs` | pre-send privacy gate over the whole prompt (intent + inputs), `lanes/privacy` pattern set: any `pii.*`/`identity.*` finding at any severity, or any medium+ finding, refuses **before** the transport is called |
| `predict.mjs` | deterministic forecast: target (site/scene), pages, elements, named text, take count; hashed |
| `transports/documented.mjs` | the Omma agent API — **fails closed**: `omma.tools` is unsealed because the documented surface (the `omma` skill and `omma.build/docs/agents`) is not published; no route scraped from the web client is replayed |
| `transports/stub.mjs` | explicit `--stub`: a deterministic local site/scene so the pipeline can be exercised; takes are `STUB`, never `GENERATED`, and cost nothing to seal |
| `tournament.mjs` | C3: ranks takes on structure (verifier passes vs forecast), latency and cost; picks ONE winner, records the losers |
| `verifiers/*.mjs` | jsoup (JBang), OCR (tesseract on a Playwright screenshot), Playwright (load, console errors, counts), Instatic snapshot (self-describing site folder + manifest hash) |
| `finish.mjs` | hana.frame: prepares the winner for the Hana bridge (`write_html`-class tool) and drives it only with `--hana` and a running editor |
| `seal.mts` | `tsx lanes/factory/seal.mts <subject> …` on the pinned runs chain; one committed line per seal in `seals.jsonl` |
| `omma.tools.json` | absent by design until the documented contract exists (see C2a) |

Statuses: `PREDICTED` → `GENERATED` (documented transport) · `STUB` · `REFUSED` (gate or contract).
Seals: `omma.prediction` (before the first send) · `omma.cost` (one per real call) · `omma.tools`
(when the documented contract is admitted) · `factory.c2b` / `factory.c3` (checkpoints).

```
node lanes/factory/omma.mjs predict --intent "…" --inputs data.json [--takes 3]
node lanes/factory/omma.mjs build   --intent "…" --inputs data.csv  [--takes 3] [--stub] [--out out]
node lanes/factory/tournament.mjs   --out out            # C3: rank, verify, pick, finish request
node lanes/factory/verifiers/probe.mjs                   # which verifiers this machine can run
```

## C2a — PROBE (held)

Key: `.timmy/private/omma.env` (`OMMA_API_KEY`, never printed). The only documented programmatic
surface is the API-keys settings page's "Connect Agent": `npx skills add https://github.com/splinetool/omma-agent-skills --skill omma`
and `https://omma.build/docs/agents`. Both are unpublished (404 / repository not found on
2026-09-12). Rule carried from the operator: a captured request is not an authorization; only the
documented surface is used, so `omma.tools` stays unsealed and `transports/documented.mjs` refuses.

## Negative control

A prompt carrying a personal string (a home path, an email, a hashed identity term) is refused by
`gate.mjs` before any transport is constructed; `tests/factory-omma.test.ts` asserts the transport
spy saw zero calls. A clean prompt reaches the transport.
