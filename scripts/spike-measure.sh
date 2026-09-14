#!/usr/bin/env bash
# tui.spike measurement (warroom-t3b1): ink vs @opentui/core on boot,
# log-rain frame latency, memory, mouse. Isolated TIMMY_STORE per renderer.
set -u
cd "$(dirname "$0")/.." || exit 2
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
newstore() { local d; d=$(mktemp -d); mkdir -p "$d/receipts"; echo "$d"; }
rain() { # count store
  for i in $(seq 1 "$1"); do
    printf '{"ts":"%s","kind":"rain-%03d","payload":{}}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$i" >> "$2/receipts/runs.jsonl"
    sleep 0.05
  done
}
latency() { # session marker store: time from marker append to frame showing it
  local s=$1 m=$2 st=$3 t0 t1
  printf '{"ts":"%s","kind":"%s","payload":{}}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$m" >> "$st/receipts/runs.jsonl"
  t0=$(ms)
  for i in $(seq 1 100); do
    sleep 0.1
    tmux capture-pane -p -t "$s" > /tmp/spike-cap.txt 2>/dev/null
    grep -q "$m" /tmp/spike-cap.txt && { t1=$(ms); echo $((t1 - t0)); return; }
  done
  echo -1
}

echo "== opentui =="
D=$(newstore)
T0=$(ms); FIRST=""; HOMEAT=""
tmux new-session -d -s spk -x 120 -y 32 "cd $PWD && TIMMY_STORE=$D/receipts npx tsx src/tui-opentui/spike.ts 2>/tmp/spk.err"
for i in $(seq 1 200); do
  sleep 0.1
  tmux capture-pane -p -t spk > /tmp/spike-cap.txt 2>/dev/null
  [ -z "$FIRST" ] && grep -q 'TIMMY-OT' /tmp/spike-cap.txt && FIRST=$(ms)
  [ -z "$HOMEAT" ] && grep -q 'doctor' /tmp/spike-cap.txt && { HOMEAT=$(ms); break; }
done
PID=$(pgrep -f 'tui-opentui/spike' | head -1)
rain 40 "$D" &
LAT1=$(latency spk rain-080 "$D")
LAT2=$(latency spk rain-081 "$D")
wait
RSS=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
tmux set-option -t spk mouse on 2>/dev/null
tmux send-keys -t spk -M 'MouseDown:4,4' 2>/dev/null
sleep 1
tmux capture-pane -p -t spk > /tmp/spike-cap.txt 2>/dev/null
MOUSE=$(grep -c 'selected:' /tmp/spike-cap.txt)
tmux kill-session -t spk 2>/dev/null; tmux kill-server 2>/dev/null
echo "first_frame=$((FIRST - T0))ms home=$((HOMEAT - T0))ms rain_latency=${LAT1}/${LAT2}ms rss=${RSS}KB mouse_selected=$MOUSE"

echo "== ink =="
D2=$(newstore)
T0=$(ms); FIRST=""; HOMEAT=""
tmux new-session -d -s ink -x 120 -y 32 "cd $PWD && TIMMY_STORE=$D2/receipts node boot.cjs 2>/tmp/ink.err"
for i in $(seq 1 200); do
  sleep 0.1
  tmux capture-pane -p -t ink > /tmp/ink-cap.txt 2>/dev/null
  [ -z "$FIRST" ] && grep -q 'TIMMY' /tmp/ink-cap.txt && FIRST=$(ms)
  [ -z "$HOMEAT" ] && grep -q 'YOUR JOURNEY' /tmp/ink-cap.txt && { HOMEAT=$(ms); break; }
done
PID=$(pgrep -f 'dist/fast-entry.js' | head -1)
rain 40 "$D2" &
LAT1=$(latency ink rain-080 "$D2")
LAT2=$(latency ink rain-081 "$D2")
wait
RSS=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
tmux kill-session -t ink 2>/dev/null; tmux kill-server 2>/dev/null
echo "first_frame=$((FIRST - T0))ms home=$((HOMEAT - T0))ms rain_latency=${LAT1}/${LAT2}ms rss=${RSS}KB mouse_selected=0(no mouse handlers)"
