#!/usr/bin/env bash
# Timmy review build __REV__: stops what ./launch.sh --studio started, by the process id it recorded, and only after
# checking that the process is this review's `timmy studio`. Nothing else is stopped.
#
# The Workbench stops with Ctrl+C in its terminal, and the browser companion it started stops with it. A run still going
# on keeps its record: open the Workbench again and the Control Room (key 7) shows it, with Stop.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
pidfile="$here/run/studio.pid"

if [ ! -f "$pidfile" ]; then
  echo "Nothing to stop: this review has not started Studio in the background."
  exit 0
fi
pid=$(cat "$pidfile")
if ! kill -0 "$pid" 2>/dev/null; then
  echo "Studio (pid $pid) has already ended."
  rm -f "$pidfile"
  exit 0
fi
cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
case "$cmd" in
  *"$here/prefix/"*) ;;
  *) echo "pid $pid is not this review's Studio ($cmd): not stopping it."; exit 1 ;;
esac
kill -TERM "$pid"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$pid" 2>/dev/null || { echo "Studio (pid $pid) stopped."; rm -f "$pidfile"; exit 0; }
  sleep 0.5
done
echo "Studio (pid $pid) did not stop within 5 s; it is still running. Stop it with: kill $pid"
exit 1
