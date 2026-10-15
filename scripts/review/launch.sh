#!/usr/bin/env bash
# Timmy review build __REV__: installs once into this folder and starts the terminal Workbench, the main operating space.
# Everything stays in this folder: the install (./prefix), npm's cache (./npm-cache), Timmy's home (./home), its
# settings (./settings), the review project (./projects/review) and the logs (./logs). Your own Timmy, its settings and
# your projects are not read or changed.
#
#   ./launch.sh             check, install if needed, check the connections, start the Workbench
#   ./launch.sh --studio    the same, and serve Timmy Studio in the background first (./stop.sh stops it)
#   ./launch.sh --check     check and install only, then print the workspace and start nothing
#
# Ports (this computer only, 127.0.0.1): the browser companion asks for TIMMY_COMPANION_PORT (3101 here) and says
# which port it took if that one is busy; Studio uses TIMMY_STUDIO_PORT (4437 here). Override either before launching.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
mode=${1:-}
case "$mode" in ''|--studio|--check) ;; *) echo "usage: ./launch.sh [--studio | --check]" >&2; exit 2 ;; esac

say() { printf '%s\n' "$*"; }

# 1. Node 24 or newer.
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 24 ]; then
  say "Timmy needs Node 24 or newer; found: $(node --version 2>/dev/null || echo 'no node')."
  say "  macOS (Homebrew): brew install node@24, then put its bin first on PATH. Linux: nodejs.org or your package manager."
  exit 2
fi

# 2. The bundle's files are the ones that were built.
if command -v sha256sum >/dev/null 2>&1; then check() { sha256sum -c --quiet SHA256SUMS; }; else check() { shasum -a 256 -c --quiet SHA256SUMS; }; fi
if ! check; then say "A file in this folder does not match SHA256SUMS: not starting."; exit 2; fi

# 3. Install once, into ./prefix (its dependencies come from the npm registry).
if [ ! -x prefix/node_modules/.bin/timmy ]; then
  say "Installing __TGZ__ into $here/prefix (first run only) ..."
  mkdir -p logs
  npm install --prefix "$here/prefix" --cache "$here/npm-cache" --no-audit --no-fund "$here/__TGZ__" > logs/install.log 2>&1 \
    || { say "The install failed; its output is in logs/install.log."; exit 1; }
fi

export PATH="$here/prefix/node_modules/.bin:$PATH"
export TIMMY_HOME="$here/home"
export TIMMY_SETTINGS_DIR="$here/settings"
export TIMMY_COMPANION_PORT="${TIMMY_COMPANION_PORT:-3101}"
export TIMMY_STUDIO_PORT="${TIMMY_STUDIO_PORT:-4437}"
mkdir -p "$TIMMY_HOME" "$TIMMY_SETTINGS_DIR" projects/review logs run

say ""
say "Timmy review build __REV__ ($(timmy --version 2>/dev/null | head -n 1))"
say "  installed:  $here/prefix"
say "  home:       $TIMMY_HOME (a review home: run 'timmy setup' here for a key or a local model)"
say "  project:    $here/projects/review"
say "  companion:  http://127.0.0.1:$TIMMY_COMPANION_PORT/  (press c in the Workbench; it opens with a one-time token)"
say "  studio:     http://127.0.0.1:$TIMMY_STUDIO_PORT/  (press s in the Workbench; it opens with a one-time grant)"
say ""

cd "$here/projects/review"

if [ "$mode" = "--studio" ]; then
  if [ -f "$here/run/studio.pid" ] && kill -0 "$(cat "$here/run/studio.pid")" 2>/dev/null; then
    say "Studio is already served by this review (pid $(cat "$here/run/studio.pid"))."
  else
    nohup timmy studio --port "$TIMMY_STUDIO_PORT" > "$here/logs/studio.log" 2>&1 &
    echo $! > "$here/run/studio.pid"
    say "Studio: serving in the background (pid $(cat "$here/run/studio.pid"), log logs/studio.log); ./stop.sh stops it."
  fi
fi

say "Checking connections (free requests only: OpenRouter's key endpoint, the local Ollama, Studio, the edge if set up) ..."
timmy workspace check || true

if [ "$mode" = "--check" ]; then exit 0; fi

say ""
say "Starting the Workbench. Keys: 1-9 and 0 switch tabs, c Companion, s Studio, ? every key, Ctrl+C quits."
exec timmy workbench
