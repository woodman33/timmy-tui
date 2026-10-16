/**
 * Round R4 (helper H90): the POSIX sh scripts Timmy sends to a macOS or Linux device on stdin (`ssh … sh -s`). Each is
 * whole or nothing (src/connect/shells.ts wholeOrNothing), prints a marker line Timmy looks for, and answers in key=value
 * lines. They use only POSIX sh and programs both macOS and Linux have (ps -o lstart and args, date -u, mkdir, mv, cp, sed,
 * awk, grep), plus:
 *
 * - detaching a job from the SSH session: `setsid` (Linux), or perl's POSIX::setsid (macOS has no setsid program, and
 *   ships perl); with neither, Timmy refuses to start the job there and says so. The job then runs in a session and a
 *   process group of its own (its first process, the supervisor, leads both), its stdin, stdout and stderr away from the
 *   SSH channel, so a dropped connection or a killed local ssh does not reach it;
 * - its status file, written by its supervisor through a temp file and a rename: running (its pid, its process group,
 *   and that process's start time as ps says it), then ended (its exit status, the signal a stop sent);
 * - exactly one run per id: the job folder is created exclusively (the answer says whether this call made it) with an
 *   owner file holding the local record's nonce, and the run starts only for the call that creates its `claim` folder; a
 *   later call with the same id starts nothing, and a folder another job made (another owner) is never taken (id-taken);
 * - the job runs as the same account as these scripts, so it can write its own status file: what Timmy computes there
 *   (alive, runner, recorded, owner) is never read from that file (only the file's own keys are passed on), and a stop
 *   signals a process group only when (1) the status file names the process Timmy recorded when the job started, (2) that
 *   process still has the recorded start time, (3) it leads the recorded group, and (4) ps shows it running this job's
 *   supervisor (`sh <its folder>/run.sh <its folder>`); `ps` reads LC_ALL=C TZ=UTC, so the start time reads the same in
 *   every session. Where ps gives no start time, a status says "unchecked" and a stop refuses to signal.
 */
import { printfChunks, shQuote, wholeOrNothing } from './shells.js';
import type { RecordedProcess } from './types.js';

/** The programs a probe looks for on the device's PATH (found on PATH says only that: never supported or working). */
export const POSIX_PROGRAMS = ['sh', 'bash', 'zsh', 'perl', 'python3', 'node', 'git', 'make', 'tar', 'ffmpeg', 'blender', 'freecadcmd', 'openscad', 'docker', 'nvidia-smi', 'ollama', 'tailscale'] as const;

/** What Timmy's local record knows of a job, passed to the device as literals: its recorded first process, its nonce. */
export interface Known { process?: RecordedProcess; nonce?: string }

/** The status file's own keys: only these lines of it are passed on (never one in the shape of what Timmy computes). */
export const STATUS_KEYS = 'state|pid|pgid|pid_start|child|started_at|ended_at|exit_status|stop_signal|by';

const HELPERS: readonly string[] = [
  'timmy_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
  'timmy_start_of() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed \'s/^ *//;s/ *$//\'; }',
  'timmy_live() { ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" \'$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }\'; }',
  'timmy_nap() { sleep 0.2 2>/dev/null || sleep 1; }',
  'timmy_value() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -n 1; }',
  // whether the job's first process (its supervisor) still runs, the same one: yes (its start time is the recorded one), no,
  // reused (that pid has another start time now), or unchecked (no start time was recorded there: ps gave none). The
  // process is the one Timmy recorded when it has one ($want_pid), else the one the status file names.
  'timmy_alive() {',
  '  if [ -n "$want_pid" ]; then pid=$want_pid; rec=$want_start; else pid=$(timmy_value pid "$job/status"); rec=$(timmy_value pid_start "$job/status"); fi',
  '  case $pid in \'\'|*[!0-9]*) echo no; return ;; esac',
  '  if [ -z "$rec" ]; then if kill -0 "$pid" 2>/dev/null; then echo unchecked; else echo no; fi; return; fi',
  '  now=$(timmy_start_of "$pid")',
  '  if [ -z "$now" ]; then echo no; elif [ "$now" = "$rec" ]; then echo yes; else echo reused; fi',
  '}',
  // whether ps shows process $1 running this job's supervisor: `sh <the job folder>/run.sh <the job folder>`, as the
  // submission started it (any name for the shell: only the end of its command line is compared, as plain text)
  'timmy_runner() {',
  '  a=$(ps -ww -o args= -p "$1" 2>/dev/null | sed \'s/^ *//;s/ *$//\')',
  '  d=$(cd "$job" 2>/dev/null && pwd -P) || return 1',
  '  case $a in *" $d/run.sh $d") return 0 ;; esac',
  '  return 1',
  '}',
  'timmy_sha256() {',
  '  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -c1-64',
  '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -c1-64',
  '  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 < "$1" | sed \'s/^.*= *//\'',
  '  fi',
  '}',
  // the sha256 of this function's stdin (a descriptor), so a fetch hashes the open file it will send, not a path it
  // re-opens
  'timmy_sha256_stdin() {',
  '  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64',
  '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -c1-64',
  '  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 | sed \'s/^.*= *//\'',
  '  fi',
  '}',
  // which `stat` the device has, decided once by fstat-ing this function's stdin (an open descriptor): GNU coreutils
  // (`stat -c '%d:%i'`), BSD/macOS (`stat -f '%d:%i'`), or none (busybox and the like) — then a fetch cannot say what an
  // open file is and refuses. Given a path, both forms report the link itself (lstat), never what it points to.
  'timmy_stat_mode=',
  'timmy_detect_stat() {',
  '  if [ -n "$timmy_stat_mode" ]; then [ "$timmy_stat_mode" != none ]; return; fi',
  '  v=$(stat -c \'%d:%i\' - 2>/dev/null)',
  '  case $v in \'\'|*[!0-9:]*) ;; *) case $v in *:*) timmy_stat_mode=gnu; return 0 ;; esac ;; esac',
  '  v=$(stat -f \'%d:%i\' 2>/dev/null)',
  '  case $v in \'\'|*[!0-9:]*) ;; *) case $v in *:*) timmy_stat_mode=bsd; return 0 ;; esac ;; esac',
  '  timmy_stat_mode=none; return 1',
  '}',
  // dev:inode:size of the file open on this function's stdin (fstat), and dev:inode of a path without following a final
  // link (lstat); the form is whichever timmy_detect_stat found
  'timmy_statfd() {',
  '  case $timmy_stat_mode in gnu) stat -c \'%d:%i:%s\' - 2>/dev/null ;; bsd) stat -f \'%d:%i:%z\' 2>/dev/null ;; *) return 1 ;; esac',
  '}',
  'timmy_statpath() {',
  '  case $timmy_stat_mode in gnu) stat -c \'%d:%i\' "$1" 2>/dev/null ;; bsd) stat -f \'%d:%i\' "$1" 2>/dev/null ;; *) return 1 ;; esac',
  '}',
  // what Timmy reads back about one job ($job): whose its folder is, where it is, its status file's own keys, whether its
  // first process still runs (the same one: its start time) and runs this job's supervisor, whether the status file still
  // names the process Timmy recorded, the stop it recorded, and its last output lines (prefixed, so none can pass for a key
  // or a marker)
  'timmy_status() {',
  '  echo "TIMMY-STATUS-BEGIN"',
  '  if [ ! -d "$job" ]; then echo "where=absent"',
  '  else',
  '    if [ -n "$nonce" ]; then',
  '      if [ ! -s "$job/owner" ]; then echo "owner=none"; elif [ "$(head -n 1 "$job/owner")" = "$nonce" ]; then echo "owner=same"; else echo "owner=other"; fi',
  '    fi',
  '    if [ ! -d "$job/claim" ]; then echo "where=not started"',
  '    elif [ ! -f "$job/status" ]; then echo "where=claimed"',
  '    else',
  '      echo "where=status"',
  // R6 lead (CI at cce00f8, connect-ssh "interrupted connection": a job that ended by itself read as ended with no exit
  // status): whether its process runs is asked first, and only then is its status file read. Read the other way round, a
  // supervisor that wrote its end and exited between the two read as "running" and "not alive", an end with no code.
  // Asked first, a process gone means its last write, if it made one, is already in the file read after it.
  '      al=$(timmy_alive)',
  `      grep -E '^(${STATUS_KEYS})=' "$job/status"`,
  '      echo "alive=$al"',
  '      ck=$want_pid; if [ -z "$ck" ]; then ck=$(timmy_value pid "$job/status"); fi',
  '      case $al in yes|unchecked) if timmy_runner "$ck"; then echo "runner=yes"; else echo "runner=no"; fi ;; esac',
  '      if [ -n "$want_pid" ]; then',
  '        if [ "$(timmy_value pid "$job/status")" = "$want_pid" ] && [ "$(timmy_value pgid "$job/status")" = "$want_pgid" ] && [ "$(timmy_value pid_start "$job/status")" = "$want_start" ]; then echo "recorded=same"; else echo "recorded=differs"; fi',
  '      fi',
  '      if [ -f "$job/stop" ]; then grep -E \'^(asked_at|signals)=\' "$job/stop" | sed \'s/^/stop./\'; fi',
  '      if [ -f "$job/out.log" ]; then tail -n 5 "$job/out.log" | cut -c1-300 | sed \'s/^/out|/\'; fi',
  '    fi',
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

/** The literals of what Timmy knows (each quoted; empty when it knows nothing): the recorded process, the nonce. */
function knownVars(k: Known = {}): string {
  const p = k.process;
  const ok = p && Number.isInteger(p.pid) && p.pid > 1 && Number.isInteger(p.pgid) && p.pgid > 1;
  const nonce = k.nonce && /^[0-9a-f]{32}$/.test(k.nonce) ? k.nonce : '';
  return `  want_pid=${shQuote(ok ? String(p.pid) : '')}; want_pgid=${shQuote(ok ? String(p.pgid) : '')}; want_start=${shQuote(ok ? p.pid_start : '')}; nonce=${shQuote(nonce)}`;
}

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
      // which stat can identify an open file here (fstat of a descriptor): a fetch needs it to rule out a swap
      '  timmy_stat_mode=; timmy_detect_stat </dev/null; echo "identity=$timmy_stat_mode"',
      '  if [ -n "$(timmy_start_of $$)" ]; then echo "start_time=yes"; else echo "start_time=no"; fi',
      `  for p in ${POSIX_PROGRAMS.join(' ')}; do if command -v "$p" >/dev/null 2>&1; then echo "found=$p"; else echo "missing=$p"; fi; done`,
      '  echo "TIMMY-PROBE-END"',
    ]),
  ].join('\n');
}

/**
 * Submits one job: makes its folder (exclusively, with an owner file holding the record's nonce; the answer says whether
 * this call made it), writes its script (the exact bytes, checked against `sha256` there), its supervisor, then claims and
 * starts it detached. A folder that was there already is this job's only when its owner file holds this nonce (a folder
 * from before owner files: when its script has this sha256; an empty one is taken); otherwise the answer is "id-taken" and
 * nothing in that folder changes. A second submission of the same job finds the claim and starts nothing (duplicate
 * events); one that finds the folder without a claim (an earlier submission cut off before it started) finishes it.
 */
export function posixSubmitScript(remoteDir: string, id: string, script: Uint8Array, sha256: string, nonce = ''): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('a sha256 is 64 hex digits');
  if (nonce && !/^[0-9a-f]{32}$/.test(nonce)) throw new Error('a nonce is 32 hex digits');
  return [
    ...HELPERS,
    'timmy_write_script() {',
    ...printfChunks(script, 'part'),
    '  return 0',
    '}',
    // R6 lead (CI at 6dfdb19, connect-ssh "one id submitted twice starts one run": "claimed there, and its supervisor wrote no
    // status"): a second submission of the same job that passed the claim check before the first claimed it rewrote run.sh in
    // place (cat > run.sh) while the first's `sh run.sh` was starting, so that shell could read a truncated supervisor and
    // write no status. The supervisor is written to a file of its own and renamed over run.sh: a shell that has opened run.sh
    // keeps the bytes it opened, and one that opens it later finds it whole (the same bytes)
    'timmy_write_runner() {',
    `  cat > "$job/run.sh.tmp.$$" <<'TIMMY_RUNNER_END' && mv -f "$job/run.sh.tmp.$$" "$job/run.sh"`,
    ...RUNNER,
    'TIMMY_RUNNER_END',
    '}',
    // whether the folder that was there already is this job's: its owner file (written at once by the submission that made
    // the folder; one that is being made now has it within a second), else, for a folder from before owner files, its script
    'timmy_ours() {',
    '  o="$job/owner"; n=0',
    '  while [ -n "$nonce" ] && [ ! -s "$o" ] && [ "$n" -lt 5 ]; do timmy_nap; n=$((n + 1)); done',
    '  if [ -s "$o" ]; then [ -n "$nonce" ] && [ "$(head -n 1 "$o")" = "$nonce" ]; return; fi',
    '  if [ -n "$nonce" ]; then',
    '    if [ -e "$job/claim" ] || [ -e "$job/script" ]; then return 1; fi',
    '    echo "$nonce" > "$o"; return 0',
    '  fi',
    '  if [ -f "$job/script" ]; then [ "$(timmy_sha256 "$job/script")" = "$want" ]; return; fi',
    '  return 0',
    '}',
    wholeOrNothing('timmy_submit', [
      '  umask 077',
      `  base=${shQuote(remoteDir)}`,
      jobVar(remoteDir, id),
      knownVars({ nonce }),
      `  want=${shQuote(sha256)}`,
      '  if ! mkdir -p "$base" 2>/dev/null; then echo "TIMMY-SUBMIT no-folder"; return 0; fi',
      '  created=no',
      '  if mkdir "$job" 2>/dev/null; then created=yes; if [ -n "$nonce" ]; then echo "$nonce" > "$job/owner"; fi; fi',
      '  if [ ! -d "$job" ]; then echo "TIMMY-SUBMIT no-folder"; return 0; fi',
      '  if [ "$created" = no ] && ! timmy_ours; then echo "TIMMY-SUBMIT id-taken"; return 0; fi',
      '  if [ -d "$job/claim" ]; then echo "TIMMY-SUBMIT already-started created=$created"; timmy_status; return 0; fi',
      '  if ! mkdir -p "$job/work" 2>/dev/null; then echo "TIMMY-SUBMIT no-folder"; return 0; fi',
      '  part="$job/script.part.$$"',
      '  if ! : > "$part" 2>/dev/null; then echo "TIMMY-SUBMIT not-written"; return 0; fi',
      '  if ! timmy_write_script; then rm -f "$part"; echo "TIMMY-SUBMIT not-written"; return 0; fi',
      '  sum=$(timmy_sha256 "$part")',
      '  if [ "$sum" != "$want" ]; then rm -f "$part"; echo "TIMMY-SUBMIT sha256-differs got=${sum:-none}"; return 0; fi',
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
export function posixStatusScript(remoteDir: string, id: string, known: Known = {}): string {
  return [...HELPERS, wholeOrNothing('timmy_read', [jobVar(remoteDir, id), knownVars(known), '  timmy_status'])].join('\n');
}

/**
 * Stops one job: SIGTERM to its process group once all four checks hold (the status file names the process Timmy recorded;
 * that process has the recorded start time, leads the recorded group, and runs this job's supervisor), then, after 10 s,
 * SIGKILL to what is left (its start time checked again); the supervisor writes the end, or (when the group ended without
 * it) the stop does, naming the last signal it sent. Then its status.
 */
export function posixStopScript(remoteDir: string, id: string, known: Known = {}): string {
  return [
    ...HELPERS,
    wholeOrNothing('timmy_stop', [
      jobVar(remoteDir, id),
      knownVars(known),
      '  if [ ! -d "$job" ]; then echo "TIMMY-STOP absent"; timmy_status; return 0; fi',
      '  if [ ! -f "$job/status" ]; then echo "TIMMY-STOP no-status"; timmy_status; return 0; fi',
      '  if [ "$(timmy_value state "$job/status")" = ended ]; then echo "TIMMY-STOP already-ended"; timmy_status; return 0; fi',
      '  pid=$(timmy_value pid "$job/status"); pg=$(timmy_value pgid "$job/status"); rec=$(timmy_value pid_start "$job/status")',
      '  case $pid$pg in \'\'|*[!0-9]*) echo "TIMMY-STOP unreadable"; timmy_status; return 0 ;; esac',
      '  if [ "$pg" -le 1 ]; then echo "TIMMY-STOP unreadable"; timmy_status; return 0; fi',
      // (1) the status file still names the process Timmy recorded when the job started (when it recorded one)
      '  if [ -n "$want_pid" ] && { [ "$pid" != "$want_pid" ] || [ "$pg" != "$want_pgid" ] || [ "$rec" != "$want_start" ]; }; then echo "TIMMY-STOP status-differs"; timmy_status; return 0; fi',
      '  if [ -z "$rec" ]; then echo "TIMMY-STOP no-start-time"; timmy_status; return 0; fi',
      // (2) that process has the recorded start time (a reused pid is never signalled), (3) it leads the recorded group
      '  now=$(timmy_start_of "$pid")',
      '  if [ -z "$now" ]; then echo "TIMMY-STOP gone"; timmy_status; return 0; fi',
      '  if [ "$now" != "$rec" ]; then echo "TIMMY-STOP reused"; timmy_status; return 0; fi',
      '  if [ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d \' \')" != "$pg" ]; then echo "TIMMY-STOP reused"; timmy_status; return 0; fi',
      '  if [ "$pid" != "$pg" ]; then echo "TIMMY-STOP not-leader"; timmy_status; return 0; fi',
      // (4) ps shows it running this job's supervisor: a status file that names another process (even one of this account's,
      // in a session of its own) is never acted on
      '  if ! timmy_runner "$pid"; then echo "TIMMY-STOP not-runner"; timmy_status; return 0; fi',
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
      // the group ended and its supervisor wrote no end: the stop writes it, naming the last signal it sent
      '  last=${sent##* }',
      '  if ! timmy_live "$pg" && [ ! -d "$job/.end" ] && mkdir "$job/.end" 2>/dev/null; then',
      '    { echo state=ended; grep -E \'^(pid|pgid|pid_start|child|started_at)=\' "$job/status"; echo "ended_at=$(timmy_now)"; echo "exit_status="; echo "stop_signal=$last"; echo by=stop; } > "$job/status.tmp.$$" && mv -f "$job/status.tmp.$$" "$job/status"',
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
export function posixWaitScript(remoteDir: string, id: string, known: Known = {}): string {
  return [
    ...HELPERS,
    wholeOrNothing('timmy_wait', [
      jobVar(remoteDir, id),
      knownVars(known),
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
 * Sends one file of a job's folder, never a byte from outside it, by any link, swap or race. Each folder on the path is
 * entered on its own (`cd -P`), refused when it is a symbolic link or when the folder reached is not inside the job's
 * folder; the file is refused when it is a link or not a regular file; the job's folder itself is refused when it is a
 * link. Then, with no copy anywhere, the file is opened once on a descriptor and its identity is pinned: the descriptor's
 * dev:inode (fstat) must equal the name's dev:inode read without following a link (lstat), and the name must not be a
 * link — so a swap between the checks above and the open is caught (the opened file and the name would then differ).
 * The sha256 and the size come from that descriptor; then a second descriptor is opened on the name and checked to be the
 * same dev:inode as the first and as the name again, and its bytes are sent. A swap landing anywhere is caught by the
 * dev:inode comparison and refused; this does not depend on `cp` (GNU cp happens to lstat-then-open-O_NOFOLLOW, but BSD/
 * macOS cp opens following, which the old copy-first path could be raced into following out of the folder). Refused when
 * the device has no sha256 program, or no `stat` that can identify an open file (`no-identity`: a swap could not be ruled
 * out). If the file's own bytes change between the hash and the send, this computer's sha256 check fails it and keeps the
 * job's own bytes as `.partial` — never outside bytes. Its answer: a header line (TIMMY-FETCH ok <sha256> <bytes>) and the
 * file's bytes. A hard link the job itself makes inside its folder is a file of its folder: its bytes are fetched like any
 * other of its files.
 */
export function posixFetchScript(remoteDir: string, id: string, rel: string): string {
  return [
    ...HELPERS,
    wholeOrNothing('timmy_fetch', [
      jobVar(remoteDir, id),
      `  rel=${shQuote(rel)}`,
      '  if [ -L "$job" ]; then echo "TIMMY-FETCH job-link"; return 0; fi',
      '  if [ ! -d "$job" ] || ! cd -P "$job" 2>/dev/null; then echo "TIMMY-FETCH no-job"; return 0; fi',
      '  top=$(pwd -P)',
      '  name=${rel##*/}; dirs=; case $rel in */*) dirs=${rel%/*} ;; esac',
      '  while [ -n "$dirs" ]; do',
      '    part=${dirs%%/*}',
      '    if [ "$part" = "$dirs" ]; then dirs=; else dirs=${dirs#*/}; fi',
      '    if [ -L "./$part" ]; then echo "TIMMY-FETCH link"; return 0; fi',
      '    if [ ! -d "./$part" ]; then echo "TIMMY-FETCH not-a-file"; return 0; fi',
      '    if ! cd -P "./$part" 2>/dev/null; then echo "TIMMY-FETCH not-readable"; return 0; fi',
      '    case $(pwd -P) in "$top"/*) ;; *) echo "TIMMY-FETCH link"; return 0 ;; esac',
      '  done',
      '  if [ -L "./$name" ]; then echo "TIMMY-FETCH link"; return 0; fi',
      '  if [ ! -f "./$name" ]; then echo "TIMMY-FETCH not-a-file"; return 0; fi',
      '  if [ ! -r "./$name" ]; then echo "TIMMY-FETCH not-readable"; return 0; fi',
      // open the file once; `command exec` so a failed open does not kill the shell, and the descriptor stays open so its
      // inode cannot be reused while Timmy checks and sends it
      '  if ! { command exec 3<"./$name"; } 2>/dev/null; then echo "TIMMY-FETCH not-readable"; return 0; fi',
      '  if ! timmy_detect_stat <&3; then echo "TIMMY-FETCH no-identity"; command exec 3<&-; return 0; fi',
      '  s3=$(timmy_statfd <&3); ino3=${s3%:*}; size=${s3##*:}',
      '  case $ino3 in \'\'|*[!0-9:]*) echo "TIMMY-FETCH no-identity"; command exec 3<&-; return 0 ;; esac',
      '  case $size in \'\'|*[!0-9]*) echo "TIMMY-FETCH no-identity"; command exec 3<&-; return 0 ;; esac',
      '  lp=$(timmy_statpath "./$name")',
      // the open file is the name, read without following (lstat), and the name is not a link: a swap between the path
      // checks above and this open is caught here (the opened inode and the name's inode differ)
      '  if [ -L "./$name" ] || [ -z "$lp" ] || [ "$ino3" != "$lp" ]; then echo "TIMMY-FETCH changed"; command exec 3<&-; return 0; fi',
      '  sum=$(timmy_sha256_stdin <&3)',
      '  if [ -z "$sum" ]; then echo "TIMMY-FETCH no-sha256"; command exec 3<&-; return 0; fi',
      // a second descriptor to send from: it must be the same file (dev:inode) as the one hashed, and the name still it,
      // still not a link — otherwise a swap landed between the hash and the send and nothing is sent
      '  if ! { command exec 4<"./$name"; } 2>/dev/null; then echo "TIMMY-FETCH changed"; command exec 3<&-; return 0; fi',
      '  s4=$(timmy_statfd <&4); ino4=${s4%:*}',
      '  lp2=$(timmy_statpath "./$name")',
      '  if [ -L "./$name" ] || [ "$ino4" != "$ino3" ] || [ "$lp2" != "$ino3" ]; then echo "TIMMY-FETCH changed"; command exec 3<&- 4<&-; return 0; fi',
      '  echo "TIMMY-FETCH ok $sum $size"',
      '  cat <&4',
      '  command exec 3<&- 4<&-',
    ]),
  ].join('\n');
}

/** The script a job runs for `-- <command…>`: the words, each quoted, as one command line (exec, so it is the job). */
export function posixCommandScript(words: readonly string[]): string {
  return `exec ${words.map(shQuote).join(' ')}\n`;
}
