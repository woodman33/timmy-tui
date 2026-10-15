# Timmy review build __REV__

An installable build of Timmy for review: the terminal Workbench as the main space, with the browser companion and
Timmy Studio shown on request. It is not a release: nothing was published, tagged or deployed.

## What you need

- Node 24 or newer, and npm (the first launch installs the package's dependencies from the npm registry into this folder).
- Optional, for chat: an OpenRouter key (`timmy setup` inside the review asks for it, or set `OPENROUTER_API_KEY`), or a
  local Ollama with a model already pulled. Without either, chat says it has no route and how to set one up.
- Optional: a browser on this computer, for the companion (c) and Studio (s).

## Start, look, stop

```sh
shasum -a 256 -c timmy-review-__REV__.tar.gz.sha256     # Linux: sha256sum -c …
tar -xzf timmy-review-__REV__.tar.gz && cd timmy-review-__REV__
./launch.sh             # or ./launch.sh --studio to serve Studio in the background too
```

The launcher checks Node and this folder's checksums, installs into `./prefix` the first time, prints where everything
is (the install, a review home, the review project, the companion's and Studio's addresses), asks each service once
with free requests (`timmy workspace check`), then starts the Workbench. Everything stays in this folder; your own Timmy,
its settings and your projects are not read or changed.

To stop: Ctrl+C in the Workbench (the companion it started stops with it), then `./stop.sh` if you used `--studio`. A
run still going on keeps its record; the Control Room (key 7) shows it next time, with Stop.

## A short walkthrough

1. **Home (1).** The project, the ten tabs, the one next step in amber, and the connections as observed: green `●
   live` only for a service that answered in the last 30 minutes. Press `,` for Quick settings (open the companion or
   Studio at start).
2. **Chat (2).** One conversation for this project, shared with the companion. With no key and no local model it says
   so and how to set one up.
3. **Workflows (3).** Run a workflow block, review what it changed, and see its receipt; the prediction is sealed
   before the run and never shown as an observed result.
4. **Studio (4).** `s` opens Timmy Studio: add or edit a card, see it saved, close it and open it again.
5. **Companion (c).** The same project in the browser: the same tabs (keys 1 to 0), the same actions and the same log.
6. **Control Room (7) and Logs & Receipts (0).** What runs, what waits on you, Stop, and the raw logs beside the
   receipts.

## What is simulated

The fleet's FAKE backend and Cloudroom's FAKE Core are simulations and say so on every line. Clef is off by default
and uncalibrated. No paid model is called unless you add your own key and choose a paid model.
