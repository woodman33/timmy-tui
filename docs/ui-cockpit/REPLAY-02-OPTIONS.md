# REPLAY-02: still blocked, and two ways to finish it (proposal)

Prepared on 2026-10-07 for the operator's 17:06 PT order: complete REPLAY-02 through Vercel on the
unchanged candidate, or propose a new freeze for another backend. Nothing here is applied.

## Where it stands

- **Vercel connector.** Tried again at 17:48 PT and refused, as at 15:29 and 15:30. One sandbox in the
  operator's Vercel project, from the public repository at `11d8e62` returned 403 forbidden: "You
  don't have permission to create the vercel sandbox". The connector can read the team and list its
  sandboxes (none), but its user lookup returns 404. That suggests it holds a token scoped to the
  team, without rights to create sandboxes.
- **The Mac's Vercel CLI.** Version 57.0.0 has no credentials: `vercel whoami` reports "No existing
  credentials found".
- **Cloudflare.** The connector fails to connect (410), and `wrangler` is not on the Mac's path.
- **Spent:** $0 of the $3 cap.

## Recommended: finish it on Vercel, on the unchanged candidate, with no new freeze

**One step for you, on the Mac:** `vercel login`, or reconnect the Vercel connector with permission
to create sandboxes. The sign-in is yours; it is never typed for you.

Then, with the Mac's CLI driving the sandbox:

1. **Create one Vercel Sandbox** in the operator's project: iad1, 2 vCPUs, 4 GB, not persistent, a
   45-minute timeout and the $3 cap. It is made from the public repository at `11d8e62`, the commit
   C-16 froze.
2. **Run the replay there:** `bash scripts/ui/replay-sandbox.sh <11d8e62, full> /tmp/replay
   vercel-sandbox`. Before it runs, tmux and a C.UTF-8 locale are installed if missing. The script
   then does `npm ci` and fetches Chromium (used only if it starts). It builds the synthetic monitor
   home, runs the frozen runner with REPLAY-02 and LIVE-01 skipped, then runs its controls.
3. **Copy the results out and stop the sandbox:** `freeze.json`, `results.json`, `controls.txt`,
   `replay.json` and `replay.log`.
4. **Judge them with C-16's own REPLAY-02 check**, in a scratch clone of `11d8e62`. The evidence
   goes into that clone's `c16/replay-02/`, so the check reads it exactly as it was frozen to.
5. **Commit the evidence and the verdict** to `docs/ui-cockpit/c16-replay-02/`.
   `docs/ui-cockpit/c16/` stays as accepted, its `BLOCKED.json` included, and
   `C16-ACCEPTED.sha256` still checks.

**Estimate:** under $0.50 and about 40 minutes.

## Alternative: a new freeze, C-17, on GitHub-hosted runners

This is the route if you would rather not sign in. GitHub's hosted runners are fresh, isolated
virtual machines, free for this public repository, and need no new credentials. AGENTS.md §10 names
Vercel and Cloudflare sandboxes, so this route needs your approval to amend it. The freeze would
change these files:

| File | What changes |
| --- | --- |
| `scripts/ui/qualify.ts` | REPLAY-02 accepts `github-actions` beside `vercel-sandbox`, and for it requires a GitHub-hosted runner and the run's ID. The evidence moves to `docs/ui-cockpit/c17/`. CLI-29 becomes a run check: `timmy -v`, `--version` and `repl -v` print only the version and exit 0. A negative control comes first. |
| `scripts/ui/replay-sandbox.sh` | For `github-actions`, it records the runner image and the run's ID. |
| `.github/workflows/replay-02.yml` (new) | Runs only when `docs/ui-cockpit/c17/REQUEST` changes on this branch. It uses ubuntu-24.04, Node 24 and tmux from apt, runs the replay script at the commit the request names, and uploads the evidence as an artifact. |

C-15 stays the historical baseline and C-16 the accepted revision. LIVE-01 has to run again on the
Mac at the new code: about $0.20 of the $2 cap ($0.68658 spent today).

**Estimate:** $0 for the runner, about $0.20 for LIVE-01, and about 90 minutes.

## Not proposed

- **Cloudflare Sandbox.** It needs the connector fixed and a Worker deployed with containers
  enabled.
- **A Runpod pod.** It is paid, and it is also outside §10.
