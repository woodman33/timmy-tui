#!/usr/bin/env bash
# REPLAY-02 (AGENTS.md §10): the frozen run (C-17), repeated in an isolated sandbox on a fresh clone.
#
#   bash scripts/ui/replay-sandbox.sh EXPECTED_COMMIT OUT_DIR PLATFORM [MODE]
#
# Run it from the root of a full clone (with origin/main), with tmux, pgrep, tar and a UTF-8 locale
# installed. OUT_DIR must be outside the clone: the run compares the clone's tree before and after, and
# nothing is written inside it except ignored paths (node_modules, .timmy). PLATFORM names where it
# runs: vercel-sandbox, or github-actions (a GitHub-hosted runner, under the cockpit exception in
# AGENTS.md §10; .github/workflows/replay-02.yml). On GitHub Actions the runner's own provenance (image,
# run, repository) is recorded whatever PLATFORM says, so a GitHub run can never pass as another platform.
# MODE is frozen (the default: the frozen run, which stops at the first failure) or development (every
# check runs, a rehearsal); a development run can never serve as REPLAY-02's evidence.
#
# Synthetic fixtures only: no model key; a monitor home made by `timmy init` for a sample operator; an
# empty shared receipt store, so the preservation check has a preimage. Chromium is fetched for the
# canvas check and used only if it starts here; otherwise CANVAS-01 is skipped, saying why. REPLAY-02
# and LIVE-01 are always skipped here: one is the evidence this replay feeds, the other a real model
# turn on the operator's Mac. Writes OUT_DIR/{freeze.json,results.json,controls.txt,replay.json} and
# OUT_DIR/replay.log; the raw evidence (PTY bytes, screens, captures) stays in OUT_DIR/q.
set -uo pipefail
usage='usage: replay-sandbox.sh EXPECTED_COMMIT OUT_DIR PLATFORM [frozen|development]'
expect=${1:?$usage}; out=${2:?$usage}; platform=${3:?$usage}; mode=${4:-frozen}
root=$(git rev-parse --show-toplevel) || exit 2
mkdir -p "$out" && out=$(cd "$out" && pwd)
case "$out/" in "$root"/*) echo "OUT_DIR must be outside the clone" >&2; exit 2 ;; esac
cd "$root" || exit 2
case "$platform" in vercel-sandbox|github-actions) ;; *) echo "PLATFORM must be vercel-sandbox or github-actions" >&2; exit 2 ;; esac
case "$mode" in frozen|development) ;; *) echo "MODE must be frozen or development" >&2; exit 2 ;; esac
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$out/replay.log"; }
die() { say "STOP: $*"; exit 1; }

head=$(git rev-parse HEAD)
[ "$head" = "$expect" ] || die "the clone is at $head, not $expect"
[ -z "$(git status --porcelain)" ] || die "the clone is not clean"
[ ! -f "$(git rev-parse --git-dir)/shallow" ] || die "a full clone is needed, not a shallow one"
git merge-base HEAD origin/main >/dev/null 2>&1 || die "origin/main is needed: PROC-01 names the branch's files from where it left main"
for tool in tmux pgrep tar sha256sum; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
locale -a 2>/dev/null | grep -qix 'c.utf-\?8' || die "no C.UTF-8 locale"
say "clone at $head, clean; $(tmux -V); node $(node --version)"

t0=$SECONDS
# --include=dev: the build and test tools are devDependencies, which NODE_ENV=production would omit.
npm ci --include=dev --ignore-scripts --no-audit --no-fund --loglevel=error >> "$out/setup.log" 2>&1 || die "npm ci failed"
install_s=$((SECONDS - t0))
say "npm ci in ${install_s}s"

# The canvas check needs a browser that starts here. If none does, the browser suite must skip (saying
# so) rather than fail on a browser that cannot start, so the run gets an empty browser folder.
canvas=started
if ! npx --no-install playwright install chromium >> "$out/setup.log" 2>&1 \
  || ! node -e "require('playwright').chromium.launch({headless:true}).then((b)=>b.close()).then(()=>process.exit(0),(e)=>{console.error(String(e.message).split('\n')[0]);process.exit(1)})" >> "$out/setup.log" 2>&1; then
  canvas=skipped
  mkdir -p "$out/no-browsers" && export PLAYWRIGHT_BROWSERS_PATH="$out/no-browsers"
fi
say "Chromium: $canvas"

# A synthetic monitor home, made the way tests/fixtures/ui-monitor-home.ts makes an initialized one
# (env -i: no model key or anything else comes from this shell).
mh="$out/monitor-home"; box=$(mktemp -d /tmp/rmh-XXXXXX)
mkdir -p "$mh/.config/timmy-tui-nodejs" "$box/repo"
(cd "$box/repo" && env -i PATH="$PATH" HOME="$mh" XDG_CONFIG_HOME="$mh/.config" XDG_DATA_HOME="$mh/.local/share" \
  XDG_STATE_HOME="$mh/.local/state" XDG_CACHE_HOME="$mh/.cache" TIMMY_HOME="$mh/timmy" TIMMY_REPO_ROOT="$box/repo" \
  TIMMY_STORE="$box/store" LANG=C.UTF-8 \
  node --import "$root/node_modules/tsx/dist/loader.mjs" "$root/src/cli.ts" init --yes --operator Sample --seed generate --project demo) \
  >> "$out/setup.log" 2>&1 || die "timmy init failed"
printf '{"onboarded": true}' > "$mh/.config/timmy-tui-nodejs/config.json"

# The shared receipt store, empty: an ignored path, so the tree is unchanged.
mkdir -p .timmy/receipts && : > .timmy/receipts/runs.jsonl
git check-ignore -q .timmy/receipts/runs.jsonl || die "the receipt store is not an ignored path"
[ -z "$(git status --porcelain)" ] || die "the setup changed the clone"

skip=REPLAY-02,LIVE-01
why="REPLAY-02 and LIVE-01 cannot run inside the sandbox replay: the first is the evidence it feeds, the second a real model turn on the operator's Mac"
if [ "$canvas" = skipped ]; then skip="$skip,CANVAS-01"; why="$why; CANVAS-01: no Chromium could be started here"; fi
q=(node --import ./node_modules/tsx/dist/loader.mjs scripts/ui/qualify.ts --out "$out/q" --monitor-home "$mh" --skip "$skip" --skip-why "$why")
"${q[@]}" --freeze 2>&1 | tee -a "$out/replay.log"
[ -f "$out/q/freeze/freeze.json" ] || die "the freeze failed"
say "frozen; the run starts ($mode)"
dev=(); [ "$mode" = development ] && dev=(--dev)
"${q[@]}" "${dev[@]}" --controls 2>&1 | tee -a "$out/replay.log"
code=${PIPESTATUS[0]}
cp "$out/q/freeze/freeze.json" "$out/q/results.json" "$out/q/controls.txt" "$out/" 2>/dev/null

. /etc/os-release 2>/dev/null
OS="${PRETTY_NAME:-$(uname -s)}" PLATFORM="$platform" STARTED="$started" CODE="$code" INSTALL_S="$install_s" CANVAS="$canvas" \
  SKIP="$skip" CPUS="$(nproc)" MEM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)" TMUXV="$(tmux -V)" GITV="$(git --version)" HEAD_SHA="$head" MODE="$mode" \
  node -e '
    const e = process.env;
    // The runner says what it is: on GitHub Actions these come from GitHub, not from this script.
    const github = e.GITHUB_ACTIONS === "true" ? { runner_environment: e.RUNNER_ENVIRONMENT, image_os: e.ImageOS, image_version: e.ImageVersion,
      run_id: e.GITHUB_RUN_ID, run_attempt: e.GITHUB_RUN_ATTEMPT, repository: e.GITHUB_REPOSITORY, workflow_sha: e.GITHUB_SHA,
      run_url: `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}/attempts/${e.GITHUB_RUN_ATTEMPT}` } : {};
    const out = { platform: e.PLATFORM, mode: e.MODE, sha: e.HEAD_SHA, ...github, os: e.OS, kernel: require("os").release(), arch: process.arch, cpus: Number(e.CPUS),
      memory_mb: Math.round(Number(e.MEM_KB) / 1024), node: process.version, tmux: e.TMUXV, git: e.GITV,
      started: e.STARTED, finished: new Date().toISOString().replace(/\.\d+Z$/, "Z"), npm_ci_s: Number(e.INSTALL_S),
      chromium: e.CANVAS, skipped: e.SKIP.split(","), exit: Number(e.CODE) };
    console.log(JSON.stringify(out, null, 2));' > "$out/replay.json"
say "done: runner exit $code"
exit "$code"
