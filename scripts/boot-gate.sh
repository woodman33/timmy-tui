#!/usr/bin/env bash
# tui.boot gate (roster kind=threshold): first frame ≤1000ms, HOME ≤3000ms.
# Measures the documented entry (node boot.cjs) inside tmux, 3 runs, all must pass.
# Negative control: run against a pre-fix build (main before opentui-u4e9) → FAIL.
set -u
cd "$(dirname "$0")/.." || exit 2
ENTRY="${TIMMY_BOOT_ENTRY:-node boot.cjs}"
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
FAIL=0
for run in 1 2 3; do
  T0=$(ms); FIRST=""; SETTLED=""
  tmux new-session -d -s bootgate -x 120 -y 32 "cd $PWD && $ENTRY >/dev/null 2>/tmp/bootgate.err" 2>/dev/null
  for i in $(seq 1 300); do
    sleep 0.1
    tmux capture-pane -p -t bootgate > /tmp/bootgate.txt 2>/dev/null
    if [ -z "$FIRST" ] && grep -q 'TIMMY' /tmp/bootgate.txt && grep -q 'chain ·' /tmp/bootgate.txt; then FIRST=$(ms); fi
    if [ -z "$SETTLED" ] && grep -q 'YOUR JOURNEY' /tmp/bootgate.txt; then SETTLED=$(ms); break; fi
  done
  tmux kill-session -t bootgate 2>/dev/null
  tmux kill-server 2>/dev/null
  sleep 1
  if [ -z "$FIRST" ] || [ -z "$SETTLED" ]; then echo "FAIL run$run: no frames captured"; FAIL=1; continue; fi
  F=$((FIRST-T0)); H=$((SETTLED-T0))
  echo "run$run first_frame=${F}ms home=${H}ms"
  [ "$F" -le 1000 ] || { echo "FAIL first_frame ${F}ms > 1000ms"; FAIL=1; }
  [ "$H" -le 3000 ] || { echo "FAIL home ${H}ms > 3000ms"; FAIL=1; }
done
tmux kill-server 2>/dev/null
if [ "$FAIL" = 1 ]; then echo "GATE tui.boot FAIL"; exit 1; fi
echo "GATE tui.boot PASS"
exit 0
