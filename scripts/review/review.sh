#!/usr/bin/env bash
# Timmy review package (R4 lead's launcher, carried into R5 by the R5 lead): the packed Timmy of one exact revision, run in
# a home of its own beside this script. Nothing is installed globally. Timmy writes only under the sandbox folder (and in a
# project you point it at). Linux and macOS, bash 3.2 or later. Start with:  ./review.sh help
# scripts/review/build-review.sh fills in the revision and the package's name.
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REV="__REV__"
TGZ="$HERE/__TGZ__"
BOX="${TIMMY_REVIEW_HOME:-$HERE/sandbox}"
PREFIX="$BOX/prefix"
H="$BOX/home"
WORK="$H/work"
# R5: 4440-4442, apart from an earlier review's 4430-4432 that may still be open on the same computer
STUDIO_PORT="${TIMMY_STUDIO_PORT:-4440}"
LOGS_PORT="${TIMMY_LOGS_PORT:-4441}"
COMPANION_PORT="${TIMMY_COMPANION_PORT:-4442}"

say() { printf '%s\n' "$*"; }
die() { printf 'review.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# the review's PATH: the installed timmy first, then the FAKE lane stand-ins (so no real lane program can start), then upmd
# 0.2.7 from bin/ on Linux x86_64 when this computer has no upmd of its own, then this computer's PATH
review_path() {
  local p="$PREFIX/node_modules/.bin:$HERE/fake-lanes"
  if ! command -v upmd >/dev/null 2>&1 && [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] && [ -x "$HERE/bin/upmd" ]; then
    p="$p:$HERE/bin"
  fi
  printf '%s:%s' "$p" "$PATH"
}

# runs "$@" in the review's environment: its own HOME, Timmy home, settings, tmux and temporary folders, its ports, no
# model key from your shell (a key reaches Timmy only if you give it to `./review.sh timmy init` yourself)
run() {
  mkdir -p "$H" "$WORK" "$BOX/tmp" "$BOX/tmux" "$BOX/mcp-home/.mcporter"
  [ -f "$BOX/mcp-home/.mcporter/mcporter.json" ] || printf '{"mcpServers": {}}\n' > "$BOX/mcp-home/.mcporter/mcporter.json"
  env -i \
    PATH="$(review_path)" HOME="$H" USER="${USER:-review}" LOGNAME="${LOGNAME:-review}" SHELL="${SHELL:-/bin/bash}" \
    TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-}" LANG="${LANG:-C.UTF-8}" LC_ALL="${LC_ALL:-}" \
    TMPDIR="$BOX/tmp" TMUX_TMPDIR="$BOX/tmux" \
    TIMMY_HOME="$H/timmy" TIMMY_SETTINGS_DIR="$BOX/settings" TIMMY_MCP_HOME="$BOX/mcp-home" \
    TIMMY_STUDIO_PORT="$STUDIO_PORT" TIMMY_LOGS_PORT="$LOGS_PORT" TIMMY_COMPANION_PORT="$COMPANION_PORT" TIMMY_LOGS_OPEN=0 \
    TIMMY_REVIEW="$REV" FAKE_LANES_LOG="$BOX/fake-lanes.log" ${TIMMY_CHAT_FREE_ONLY:+TIMMY_CHAT_FREE_ONLY="$TIMMY_CHAT_FREE_ONLY"} \
    ${TIMMY_PALETTE:+TIMMY_PALETTE="$TIMMY_PALETTE"} \
    "$@"
}

# the active project's folder, as Timmy records it (<Timmy home>/state/active-project.json), when it is still there
active_root() {
  node -e 'try { const fs = require("fs"); const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).root; if (typeof r === "string" && fs.statSync(r).isDirectory()) process.stdout.write(r); } catch {}' "$H/timmy/state/active-project.json" 2>/dev/null
}

# where a command starts: the folder you are in when it is inside the review's home (a project of the review), else the
# active project's folder (so `./review.sh timmy receipts` reads that project's receipts), else the work folder
start_dir() {
  case "$(pwd -P)/" in "$H"/*) pwd -P; return ;; esac
  local a
  a="$(active_root)"
  if [ -n "$a" ]; then printf '%s' "$a"; else printf '%s' "$WORK"; fi
}

need_install() { [ -x "$PREFIX/node_modules/.bin/timmy" ] || die "not installed yet: run ./review.sh install first" 2; }

cmd="${1:-help}"
[ $# -gt 0 ] && shift
case "$cmd" in
  help|-h|--help)
    cat <<HELP
Timmy review package, revision $REV

  ./review.sh install        install the packed Timmy into $BOX/prefix (Node 24 or later; npm fetches its dependencies)
  ./review.sh demo           a blank Timmy home with two projects: "blank", then "tray" (from the tray-workflow starter),
                             which is the active project at the end
  ./review.sh workbench      the terminal Workbench, the main space: keys 1-9 and 0 are the ten tabs, c shows the browser
                             companion, s shows Studio, ? lists every key (on the active project; p switches)
  ./review.sh check          the shared workspace frame, after asking each service once with a free request
                             (timmy workspace check: OpenRouter's key endpoint, your Ollama, Studio, the companion)
  ./review.sh repl           the REPL (plain timmy), on the active project
  ./review.sh watch          the full-screen monitor
  ./review.sh ollama HOST MODEL   chat on your own Ollama (no key, no charge): HOST like 127.0.0.1:11434, MODEL one it lists
  ./review.sh timmy ARGS...  any timmy command (for example: timmy op <id> --project <folder>, timmy receipts, timmy tools)
  ./review.sh shell          a shell in the review's environment (type timmy ... yourself; exit to leave)
  ./review.sh where          the folders and ports this review uses
  ./review.sh clean          remove the sandbox ($BOX), only that

Ports (127.0.0.1 only): Studio $STUDIO_PORT, the log companion $LOGS_PORT, the browser companion $COMPANION_PORT
(set TIMMY_STUDIO_PORT, TIMMY_LOGS_PORT or TIMMY_COMPANION_PORT before a command to change them).
HELP
    ;;
  install)
    command -v node >/dev/null 2>&1 || die "node is not on PATH: the package needs Node 24 or later" 3
    [ "$(node_major)" -ge 24 ] || die "node $(node --version) is older than the package asks (Node 24 or later)" 3
    command -v npm >/dev/null 2>&1 || die "npm is not on PATH" 3
    [ -f "$TGZ" ] || die "the package file is missing: $TGZ" 3
    mkdir -p "$PREFIX"
    say "Installing $(basename "$TGZ") into $PREFIX (npm fetches its dependencies; --ignore-scripts: no install script runs)..."
    npm install --prefix "$PREFIX" --no-audit --no-fund --ignore-scripts --loglevel=error "$TGZ" || die "npm install failed (above)" 1
    run timmy --version
    ;;
  demo)
    need_install
    ( cd "$WORK" 2>/dev/null || { mkdir -p "$WORK" && cd "$WORK"; }
      run timmy init --yes && \
      run timmy act '/project new blank' && \
      run timmy act '/project new tray --from tray-workflow' ) || die "the demo setup stopped (above)" 1
    say ""
    say "Ready: ./review.sh workbench (tray, the active project now), or ./review.sh repl"
    ;;
  ollama)
    need_install
    [ $# -eq 2 ] || die "usage: ./review.sh ollama HOST MODEL   (HOST like 127.0.0.1:11434; MODEL one your Ollama lists)" 2
    ( cd "$WORK" && run timmy init --yes --chat local --ollama "$1" --model "$2" )
    ;;
  check)
    need_install
    ( cd "$(start_dir)" && run timmy workspace check "$@" )
    ;;
  workbench|repl|watch)
    need_install
    DIR="$(start_dir)"
    if [ "$cmd" = repl ]; then ( cd "$DIR" && run timmy "$@" ); else ( cd "$DIR" && run timmy "$cmd" "$@" ); fi
    ;;
  timmy)
    need_install
    ( cd "$(start_dir)" && run timmy "$@" )
    ;;
  shell)
    need_install
    say "A shell in the review's environment (Timmy $REV). Type timmy ...; exit to leave."
    ( cd "$(start_dir)" && run bash --norc --noprofile -i )
    ;;
  where)
    say "revision      $REV"
    say "package       $TGZ"
    say "sandbox       $BOX"
    say "install       $PREFIX"
    say "home          $H (Timmy home: $H/timmy)"
    say "work folder   $WORK"
    say "active        $(active_root || true)"
    say "ports         Studio $STUDIO_PORT, log companion $LOGS_PORT, browser companion $COMPANION_PORT (127.0.0.1)"
    say "free-only     ${TIMMY_CHAT_FREE_ONLY:-the setting in the sandbox (off unless you turned it on: ./review.sh timmy act '/model free-only on')}"
    say "upmd          $(PATH="$(review_path)" command -v upmd || echo 'not found: workflows say how to install it')"
    say "node          $(command -v node || echo 'not found') $(node --version 2>/dev/null)"
    ;;
  clean)
    case "$BOX" in /|"$HOME"|"") die "refusing to remove $BOX" 2 ;; esac
    [ -d "$BOX" ] || { say "nothing to remove: $BOX is not there"; exit 0; }
    printf 'Remove %s and everything in it? Type yes: ' "$BOX"
    read -r answer
    [ "$answer" = yes ] || { say "kept"; exit 0; }
    rm -r -- "$BOX" && say "removed $BOX"
    ;;
  *)
    die "unknown command: $cmd (./review.sh help)" 2
    ;;
esac
