/**
 * Round R4 (helper H90): the POSIX sh scripts Timmy sends to a macOS or Linux device on stdin (`ssh … sh -s`). Each is
 * whole or nothing (src/connect/shells.ts wholeOrNothing), prints a marker line Timmy looks for, and answers in key=value
 * lines. They use only POSIX sh and programs both macOS and Linux have (ps -o lstart, date -u, mkdir, mv, sed, awk), plus:
 *
 * - detaching a job from the SSH session: `setsid` (Linux), or perl's POSIX::setsid (macOS has no setsid program, and
 *   ships perl); with neither, Timmy refuses to start the job there and says so. The job then runs in a session and a
 *   process group of its own (its first process, the supervisor, leads both), its stdin, stdout and stderr away from the
 *   SSH channel, so a dropped connection or a killed local ssh does not reach it;
 * - its status file, written by its supervisor through a temp file and a rename: running (its pid, its process group,
 *   and that process's start time as ps says it), then ended (its exit status, the signal a stop sent);
 * - exactly one run per id: the job folder is created exclusively (the answer says whether this call made it), and the
 *   run starts only for the call that creates its `claim` folder; any later call with the same id starts nothing;
 * - a stop signals the job's process group only after checking that its first process still has the recorded start time
 *   and still leads the recorded group, so a reused pid is never signalled; `ps` reads LC_ALL=C TZ=UTC, so the start time
 *   reads the same in every session. Where ps gives no start time, a status says "unchecked" and a stop refuses to signal.
 */
import { printfChunks, shQuote, wholeOrNothing } from './shells.js';

/** The programs a probe looks for on the device's PATH (found on PATH says only that: never supported or working). */
export const POSIX_PROGRAMS = ['sh', 'bash', 'zsh', 'perl', 'python3', 'node', 'git', 'make', 'tar', 'ffmpeg', 'blender', 'freecadcmd', 'openscad', 'docker', 'nvidia-smi', 'ollama', 'tailscale'] as const;

const HELPERS: readonly string[] = [
  'timmy_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
  'timmy_start_of() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed \'s/^ *//;s/ *$//\'; }',
  'timmy_live() { ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" \'$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }\'; }',
  'timmy_nap() { sleep 0.2 2>/dev/null || sleep 1; }',
  'timmy_value() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -n 1; }',
  // whether the job's first process (its supervisor) still runs, the same one: yes (its start time is the recorded one), no,
  // reused (that pid has another start time now), or unchecked (no start time was recorded there: ps gave none)
  'timmy_alive() {',
  '  pid=$(timmy_value pid "$job/status"); rec=$(timmy_value pid_start "$job/status")',
  '  case $pid in \'\'|*[!0-9]*) echo no; return ;; esac',
  '  if [ -z "$rec" ]; then if kill -0 "$pid" 2>/dev/null; then echo unchecked; else echo no; fi; return; fi',
  '  now=$(timmy_start_of "$pid")',
  '  if [ -z "$now" ]; then echo no; elif [ "$now" = "$rec" ]; then echo yes; else echo reused; fi',
  '}',
  'timmy_sha256() {',
  '  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -c1-64',
  '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -c1-64',
  '  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 < "$1" | sed \'s/^.*= *//\'',
  '  fi',
  '}',
  // what Timmy reads back about one job ($job): where it is, its status file, whether its first process still runs (the
  // same one: its start time), the stop it recorded, and its last output lines (prefixed, so none can pass for a marker)
  'timmy_status() {',
  '  echo "TIMMY-STATUS-BEGIN"',
  '  if [ ! -d "$job" ]; then echo "where=absent"',
  '  elif [ ! -d "$job/claim" ]; then echo "where=not started"',
  '  elif [ ! -f "$job/status" ]; then echo "where=claimed"',
  '  else',
  '    echo "where=status"',
  '    cat "$job/status"',
  '    echo "alive=$(timmy_alive)"',
  '    if [ -f "$job/stop" ]; then sed \'s/^/stop./\' "$job/stop"; fi',
  '    if [ -f "$job/out.log" ]; then tail -n 5 "$job/out.log" | cut -c1-300 | sed \'s/^/out|/\'; fi',
  '  fi',
  '  echo "TIMMY-STATUS-END"',
  '}',
];

/** The job's supervisor (run.sh in its folder): runs ./script in ./work, its output to ./out.log, and writes ./status. */
export const RUNNER: readonly string[] = [
  '# Timmy Connect: the supervisor of one remote job, written by Timmy. It runs ./script in ./work (its output in',
  '# ./out.log) and writes ./status through a temp file and a rename: running (pid, process group, start time), then ended.',
  'job=$1',
  'cd "$job" || exit 70',
  'timmy_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
  'st=$(LC_ALL=C TZ=UTC ps -o lstart= -p $$ 2>/dev/null | sed \'s/^ *//;s/ *$//\')',
  'pg=$(ps -o pgid= -p $$ 2>/dev/null | tr -d \' \')',
  'started=$(timmy_now)',
  'stop_sig=',
  "trap 'stop_sig=TERM' TERM",
  "trap 'stop_sig=INT' INT",
  "trap 'stop_sig=HUP' HUP",
  '(cd work && exec sh ../script) </dev/null >>out.log 2>&1 &',
  'child=$!',
  '{ echo state=running; echo "pid=$$"; echo "pgid=$pg"; echo "pid_start=$st"; echo "child=$child"; echo "started_at=$started"; } > "status.tmp.$$" && mv -f "status.tmp.$$" status',
  'wait "$child"; code=$?',
  'while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done',
  'ended=$(timmy_now)',
  'if mkdir .end 2>/dev/null; then',
  '  { echo state=ended; echo "pid=$$"; echo "pgid=$pg"; echo "pid_start=$st"; echo "child=$child"; echo "started_at=$started"; echo "ended_at=$ended"; echo "exit_status=$code"; if [ -n "$stop_sig" ]; then echo "stop_signal=$stop_sig"; fi; echo by=supervisor; } > "status.tmp.$$" && mv -f "status.tmp.$$" status',
  'fi',
];

const jobVar = (remoteDir: string, id: string): string => `  job=${shQuote(remoteDir)}/${shQuote(id)}`;

/** Detects nothing and changes nothing but one test file in the job folder (made and removed at once, when it exists). */
export function posixProbeScript(remoteDir: string): string {
  return [
    ...HELPERS,
    wholeOrNothing('timmy_probe', [
      '  echo "TIMMY-PROBE-BEGIN"',
      '  echo "family=posix"',
      '  echo "os_name=$(uname -s 2>/dev/null)"',
      '  echo "os_version=$(uname -r 2>/dev/null)"',
      '  if command -v sw_vers >/dev/null 2>&1; then echo "macos_version=$(sw_vers -productVersion 2>/dev/null)"; fi',
      '  echo "arch=$(uname -m 2>/dev/null)"',
      '  echo "user=$(id -un 2>/dev/null)"',
      '  echo "login_shell=${SHELL##*/}"',
      `  base=${shQuote(remoteDir)}`,
      '  if [ -d "$base" ]; then',
      '    t="$base/.timmy-probe.$$"',
      '    if ( : > "$t" ) 2>/dev/null; then rm -f "$t"; echo "job_folder=writable"; else echo "job_folder=not writable"; fi',
      '  else',
      '    d=$base',
      '    while [ ! -d "$d" ]; do case $d in */*) d=${d%/*} ;; *) d=. ;; esac; if [ -z "$d" ]; then d=/; fi; done',
      '    if [ -w "$d" ]; then echo "job_folder=absent, can be made"; else echo "job_folder=absent, cannot be made"; fi',
      '  fi',
      '  if command -v setsid >/dev/null 2>&1; then echo "detach=setsid"',
      '  elif command -v perl >/dev/null 2>&1 && perl -MPOSIX -e 1 2>/dev/null; then echo "detach=perl"',
      '  else echo "detach=none"; fi',
      '  if command -v sha256sum >/dev/null 2>&1; then echo "sha256=sha256sum"',
      '  elif command -v shasum >/dev/null 2>&1; then echo "sha256=shasum"',
      '  elif command -v openssl >/dev/null 2>&1; then echo "sha256=openssl"',
      '  else echo "sha256=none"; fi',
      '  if [ -n "$(timmy_start_of $$)" ]; then echo "start_time=yes"; else echo "start_time=no"; fi',
      `  for p in ${POSIX_PROGRAMS.join(' ')}; do if command -v "$p" >/dev/null 2>&1; then echo "found=$p"; else echo "missing=$p"; fi; done`,
      '  echo "TIMMY-PROBE-END"',
    ]),
  ].join('\n');
}

/**
 * Submits one job: makes its folder (exclusively; the answer says whether this call made it), writes its script (the exact
 * bytes, checked against `sha256` there), its supervisor, then claims and starts it detached. A second submission of the
 * same id finds the claim and starts nothing (duplicate events); one that finds the folder without a claim (an earlier
 * submission cut off before it started) finishes it.
 */
export function posixSubmitScript(remoteDir: string, id: string, script: Uint8Array, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('a sha256 is 64 hex digits');
  return [
    ...HELPERS,
    'timmy_write_script() {',
    ...printfChunks(script, 'part'),
    '  return 0',
    '}',
    'timmy_write_runner() {',
    `  cat > "$job/run.sh" <<'TIMMY_RUNNER_END'`,
    ...RUNNER,
    'TIMMY_RUNNER_END',
    '}',
    wholeOrNothing('timmy_submit', [
      '  umask 077',
      `  base=${shQuote(remoteDir)}`,
      jobVar(remoteDir, id),
      '  if ! mkdir -p "$base" 2>/dev/null; then echo "TIMMY-SUBMIT no-folder"; return 0; fi',
      '  created=no',
      '  if mkdir "$job" 2>/dev/null; then created=yes; fi',
      '  if [ ! -d "$job" ]; then echo "TIMMY-SUBMIT no-folder"; return 0; fi',
      '  if [ -d "$job/claim" ]; then echo "TIMMY-SUBMIT already-started created=$created"; timmy_status; return 0; fi',
      '  if ! mkdir -p "$job/work" 2>/dev/null; then echo "TIMMY-SUBMIT no-folder"; return 0; fi',
      '  part="$job/script.part.$$"',
      '  if ! : > "$part" 2>/dev/null; then echo "TIMMY-SUBMIT not-written"; return 0; fi',
      '  if ! timmy_write_script; then rm -f "$part"; echo "TIMMY-SUBMIT not-written"; return 0; fi',
      '  sum=$(timmy_sha256 "$part")',
      `  if [ "$sum" != ${shQuote(sha256)} ]; then rm -f "$part"; echo "TIMMY-SUBMIT sha256-differs got=\${sum:-none}"; return 0; fi`,
      '  mv -f "$part" "$job/script"',
      '  if ! timmy_write_runner; then echo "TIMMY-SUBMIT not-written"; return 0; fi',
      '  if ! mkdir "$job/claim" 2>/dev/null; then echo "TIMMY-SUBMIT already-started created=$created"; timmy_status; return 0; fi',
      '  abs=$(cd "$job" && pwd -P)',
      '  if command -v setsid >/dev/null 2>&1; then how=setsid; setsid sh "$abs/run.sh" "$abs" </dev/null >/dev/null 2>&1 &',
      "  elif command -v perl >/dev/null 2>&1 && perl -MPOSIX -e 1 2>/dev/null; then how=perl; perl -e 'use POSIX (); POSIX::setsid(); exec @ARGV or exit 127;' sh \"$abs/run.sh\" \"$abs\" </dev/null >/dev/null 2>&1 &",
      '  else rmdir "$job/claim"; echo "TIMMY-SUBMIT no-detach"; return 0; fi',
      '  echo "$how" > "$job/detach"',
      '  n=0; while [ ! -f "$job/status" ] && [ "$n" -lt 50 ]; do timmy_nap; n=$((n + 1)); done',
      '  echo "TIMMY-SUBMIT started created=$created detach=$how"',
      '  timmy_status',
    ]),
  ].join('\n');
}

/** Reads one job's status (reconcile): nothing is changed. */
export function posixStatusScript(remoteDir: string, id: string): string {
  return [...HELPERS, wholeOrNothing('timmy_read', [jobVar(remoteDir, id), '  timmy_status'])].join('\n');
}

/**
 * Stops one job: SIGTERM to its process group once its first process is checked to be the same one (its start time), then,
 * after 10 s, SIGKILL to what is left; the supervisor writes the end, or (after a SIGKILL) the stop does. Then its status.
 */
export function posixStopScript(remoteDir: string, id: string): string {
  return [
    ...HELPERS,
    wholeOrNothing('timmy_stop', [
      jobVar(remoteDir, id),
      '  if [ ! -d "$job" ]; then echo "TIMMY-STOP absent"; timmy_status; return 0; fi',
      '  if [ ! -f "$job/status" ]; then echo "TIMMY-STOP no-status"; timmy_status; return 0; fi',
      '  if [ "$(timmy_value state "$job/status")" = ended ]; then echo "TIMMY-STOP already-ended"; timmy_status; return 0; fi',
      '  pid=$(timmy_value pid "$job/status"); pg=$(timmy_value pgid "$job/status"); rec=$(timmy_value pid_start "$job/status")',
      '  case $pid$pg in \'\'|*[!0-9]*) echo "TIMMY-STOP unreadable"; timmy_status; return 0 ;; esac',
      '  if [ "$pg" -le 1 ]; then echo "TIMMY-STOP unreadable"; timmy_status; return 0; fi',
      '  if [ -z "$rec" ]; then echo "TIMMY-STOP no-start-time"; timmy_status; return 0; fi',
      '  now=$(timmy_start_of "$pid")',
      '  if [ -z "$now" ]; then echo "TIMMY-STOP gone"; timmy_status; return 0; fi',
      '  if [ "$now" != "$rec" ]; then echo "TIMMY-STOP reused"; timmy_status; return 0; fi',
      '  if [ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d \' \')" != "$pg" ]; then echo "TIMMY-STOP reused"; timmy_status; return 0; fi',
      '  asked=$(timmy_now)',
      '  { echo "asked_at=$asked"; echo "signals=TERM"; } > "$job/stop.tmp.$$" && mv -f "$job/stop.tmp.$$" "$job/stop"',
      '  kill -TERM -"$pg" 2>/dev/null',
      '  n=0; while timmy_live "$pg" && [ "$n" -lt 50 ]; do timmy_nap; n=$((n + 1)); done',
      '  sent=TERM',
      '  if timmy_live "$pg"; then',
      // its first process has run all along (the same start time), or has ended while the rest of its group ran on, which
      // keeps the group's number from being given to another process: only then is SIGKILL sent
      '    now=$(timmy_start_of "$pid")',
      '    if [ -z "$now" ] || [ "$now" = "$rec" ]; then',
      '      kill -KILL -"$pg" 2>/dev/null; sent="TERM KILL"',
      '      { echo "asked_at=$asked"; echo "signals=TERM KILL"; } > "$job/stop.tmp.$$" && mv -f "$job/stop.tmp.$$" "$job/stop"',
      '      n=0; while timmy_live "$pg" && [ "$n" -lt 25 ]; do timmy_nap; n=$((n + 1)); done',
      '    fi',
      '  fi',
      '  if ! timmy_live "$pg" && [ ! -d "$job/.end" ] && mkdir "$job/.end" 2>/dev/null; then',
      '    { echo state=ended; grep -E \'^(pid|pgid|pid_start|child|started_at)=\' "$job/status"; echo "ended_at=$(timmy_now)"; echo "exit_status="; echo "stop_signal=KILL"; echo by=stop; } > "$job/status.tmp.$$" && mv -f "$job/status.tmp.$$" "$job/status"',
      '  fi',
      '  echo "TIMMY-STOP done signals=$sent"',
      '  timmy_status',
    ]),
  ].join('\n');
}

/**
 * Waits on the device until the job has ended (or its first process is gone), saying it still runs every 2 s: a wait whose
 * local ssh is gone ends at its next line (SIGPIPE), and never touches the job. Then its status.
 */
export function posixWaitScript(remoteDir: string, id: string): string {
  return [
    ...HELPERS,
    wholeOrNothing('timmy_wait', [
      jobVar(remoteDir, id),
      '  echo "TIMMY-WAIT begin"',
      '  n=0',
      '  while [ -d "$job/claim" ]; do',
      '    if [ -f "$job/status" ]; then',
      '      if [ "$(timmy_value state "$job/status")" = ended ]; then break; fi',
      '      case $(timmy_alive) in yes|unchecked) ;; *) break ;; esac',
      '    elif [ "$n" -gt 100 ]; then break',
      '    fi',
      '    if [ $((n % 10)) -eq 0 ]; then echo "TIMMY-WAIT running $(timmy_now)"; fi',
      '    n=$((n + 1)); timmy_nap',
      '  done',
      '  echo "TIMMY-WAIT end"',
      '  timmy_status',
    ]),
  ].join('\n');
}

/**
 * Sends one file of a job's folder: refused when any part of its path is a symbolic link, when it is not a regular file,
 * or when no sha256 program is there; else a header line (TIMMY-FETCH ok <sha256> <bytes>) and then the file's bytes.
 */
export function posixFetchScript(remoteDir: string, id: string, rel: string): string {
  return [
    ...HELPERS,
    wholeOrNothing('timmy_fetch', [
      jobVar(remoteDir, id),
      `  rel=${shQuote(rel)}`,
      '  if [ ! -d "$job" ]; then echo "TIMMY-FETCH no-job"; return 0; fi',
      '  if ! cd "$job" 2>/dev/null; then echo "TIMMY-FETCH no-job"; return 0; fi',
      '  p=; rest=$rel',
      '  while [ -n "$rest" ]; do',
      '    part=${rest%%/*}',
      '    if [ "$part" = "$rest" ]; then rest=; else rest=${rest#*/}; fi',
      '    p=${p:+$p/}$part',
      '    if [ -L "$p" ]; then echo "TIMMY-FETCH link"; return 0; fi',
      '  done',
      '  if [ ! -f "$rel" ]; then echo "TIMMY-FETCH not-a-file"; return 0; fi',
      '  if [ ! -r "$rel" ]; then echo "TIMMY-FETCH not-readable"; return 0; fi',
      '  sum=$(timmy_sha256 "$rel")',
      '  if [ -z "$sum" ]; then echo "TIMMY-FETCH no-sha256"; return 0; fi',
      '  size=$(wc -c < "$rel" | tr -d \' \')',
      '  echo "TIMMY-FETCH ok $sum $size"',
      '  cat < "$rel"',
    ]),
  ].join('\n');
}

/** The script a job runs for `-- <command…>`: the words, each quoted, as one command line (exec, so it is the job). */
export function posixCommandScript(words: readonly string[]): string {
  return `exec ${words.map(shQuote).join(' ')}\n`;
}
