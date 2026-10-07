#!/usr/bin/env bash
# Capture what a command really draws in a terminal (playbook §17.9: real PTY, not a snapshot).
#   scripts/ui/capture.sh NAME COLS ROWS WAIT -- CMD [ARGS...]
# Runs CMD inside a detached tmux session (a real PTY), waits WAIT seconds, and writes the screen
# with its colors to $TIMMY_UI_CAPTURE_DIR/NAME.ansi (default: a private temp directory, because a
# capture can show paths and names). Check it with scripts/ui/gate.ts; picture it with render.ts.
# KEYS="..." sends tmux keys before the capture (for example KEYS="5" to open view 5).
set -euo pipefail
NAME=$1 COLS=$2 ROWS=$3 WAIT=$4; shift 4
[ "${1:-}" = "--" ] && shift
OUT=${TIMMY_UI_CAPTURE_DIR:-${TMPDIR:-/tmp}/timmy-ui-captures}
mkdir -p "$OUT" && chmod 700 "$OUT"
HERE=$(cd "$(dirname "$0")" && pwd)
SOCK="timmy-ui-$NAME-$$"
cleanup() { tmux -L "$SOCK" kill-server 2>/dev/null || true; }
trap cleanup EXIT
tmux -L "$SOCK" -f "$HERE/tmux-capture.conf" new-session -d -s cap -x "$COLS" -y "$ROWS" \
  -e COLORTERM="${COLORTERM:-truecolor}" -e LC_ALL="${LC_ALL:-C.UTF-8}" "$@"
sleep "$WAIT"
if [ -n "${KEYS:-}" ]; then
  for k in $KEYS; do tmux -L "$SOCK" send-keys -t cap "$k"; sleep "${KEY_WAIT:-1}"; done
fi
tmux -L "$SOCK" capture-pane -t cap -e -p -N > "$OUT/$NAME.ansi"
echo "$OUT/$NAME.ansi"
