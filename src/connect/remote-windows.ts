/**
 * Round R4 (helper H90): the PowerShell scripts Timmy sends to a Windows device through Microsoft's OpenSSH Server, each as
 * `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64 of UTF-16LE>` (src/connect/shells.ts powershellWords),
 * which cmd.exe and PowerShell (either can be the server's default shell) pass through untouched. They answer in the same
 * key=value lines and markers as the POSIX scripts, so one reader reads both.
 *
 * NOT RUN ON WINDOWS: no Windows computer was available to this slice. These scripts are built and checked here (each
 * decodes back to itself and fits cmd.exe's 8,191 characters: tests/connect-windows.test.ts), and a FAKE Windows device
 * answers the probe from a fixture; none has run on Windows itself. The words Timmy prints say so.
 *
 * How they differ from POSIX, by Windows' own means:
 * - a job is started through WMI (Win32_Process.Create), so it is not in the SSH session's job object, which Windows'
 *   OpenSSH Server ends with the session; its supervisor's pid and start time (Get-Process StartTime, UTC) are recorded;
 * - a stop signals only the supervisor Timmy recorded: the status file must still name it, Get-Process must show its
 *   recorded start time, and its command line (WMI) must be this job's run.ps1; then taskkill /T /F ends its process tree
 *   (Windows has no SIGTERM for a console program), and the stop writes the end once that process is gone;
 * - a job's script is PowerShell (script.ps1); its bytes come on stdin, never in the command line. The control scripts
 *   themselves are in the command line (-EncodedCommand), with the job folder's name and, for a fetch, the file's path:
 *   that computer's process list shows them while they run.
 */
import { psQuote } from './shells.js';
import { STATUS_KEYS, type Known } from './remote-posix.js';

/** The programs a Windows probe looks for on PATH (found on PATH says only that). */
export const WINDOWS_PROGRAMS = ['git', 'python', 'python3', 'node', 'ffmpeg', 'blender', 'docker', 'nvidia-smi', 'ollama', 'tailscale', 'pwsh'] as const;

/** The detection step: one line every shell answers differently (cmd expands %OS%, PowerShell prints each word alone). */
export const DETECT_WORDS: readonly string[] = ['echo', 'TIMMY-PROBE', '%OS%'];

/** What the detection step's answer says about the device's shell. */
export function detectShell(answer: string): 'posix' | 'cmd' | 'powershell' | 'unknown' {
  const lines = answer.replace(/\r/g, '').split('\n').map((l) => l.trim());
  if (lines.includes('TIMMY-PROBE Windows_NT')) return 'cmd';
  const at = lines.indexOf('TIMMY-PROBE');
  if (at >= 0 && lines[at + 1] === '%OS%') return 'powershell';
  if (lines.includes('TIMMY-PROBE %OS%')) return 'posix';
  return 'unknown';
}

/** The job folder on the device: relative to the home ($HOME), or as given when absolute. */
const jobBase = (remoteDir: string): string => `$b = ${psQuote(remoteDir)}; $base = if ([IO.Path]::IsPathRooted($b)) { $b } else { Join-Path $HOME $b }`;

/** The literals of what Timmy knows: the recorded supervisor (its pid, which is its pgid here, and its start time). */
function knownPs(k: Known = {}): string {
  const p = k.process;
  const ok = p && Number.isInteger(p.pgid) && p.pgid > 0;
  return `$wp = ${psQuote(ok ? String(p.pgid) : '')}; $ws = ${psQuote(ok ? p.pid_start : '')}; $nonce = ${psQuote(k.nonce && /^[0-9a-f]{32}$/.test(k.nonce) ? k.nonce : '')}`;
}

/** Whether process $i's command line (WMI) is this job's supervisor: the one the submission started (run.ps1 of $job). */
const RUNNER_FN = "function Rn($i) { $c = (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $i)).CommandLine; [bool]($c -and $c.EndsWith((Join-Path $job 'run.ps1') + '\" \"' + $job + '\"')) }";
const START = "ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')";
const FILE_VALUE = (k: string): string => `($t | Where-Object { $_ -like '${k}=*' } | Select-Object -First 1) -replace '^${k}=', ''`;

/**
 * One job's status lines (the POSIX timmy_status's answer, by PowerShell's means): only the status file's own keys are
 * passed on; alive, runner, recorded and owner are computed here. Defines `St` (and `Rn`); uses $job, $wp, $ws, $nonce.
 */
const STATUS_FN = [
  RUNNER_FN,
  'function St {',
  "  'TIMMY-STATUS-BEGIN'",
  "  $s = Join-Path $job 'status'",
  "  if (-not (Test-Path -LiteralPath $job)) { 'where=absent' } else {",
  "  if ($nonce) { $o = Join-Path $job 'owner'; if (-not (Test-Path -LiteralPath $o)) { 'owner=none' } elseif ((Get-Content -LiteralPath $o -TotalCount 1) -eq $nonce) { 'owner=same' } else { 'owner=other' } }",
  "  if (-not (Test-Path -LiteralPath (Join-Path $job 'claim'))) { 'where=not started' }",
  "  elseif (-not (Test-Path -LiteralPath $s)) { 'where=claimed' }",
  '  else {',
  // R6 lead: as on POSIX (remote-posix.ts timmy_status), the process is asked before the status file's keys are given: the
  // file is read once for the process it names, and read again for its keys after that process was asked
  `    'where=status'; $t = Get-Content -LiteralPath $s`,
  `    $g = ${FILE_VALUE('pgid')}; $r = ${FILE_VALUE('pid_start')}`,
  "    if ($wp) { if ($g -eq $wp -and $r -eq $ws) { 'recorded=same' } else { 'recorded=differs' }; $g = $wp; $r = $ws }",
  '    $p = $null; if ($g -match \'^[0-9]+$\') { $p = Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue }',
  `    if (-not $p) { 'alive=no' } elseif ($p.StartTime.${START} -eq $r) { 'alive=yes'; if (Rn $g) { 'runner=yes' } else { 'runner=no' } } else { 'alive=reused' }`,
  `    Get-Content -LiteralPath $s | Where-Object { $_ -match '^(${STATUS_KEYS})=' }`,
  "    $k = Join-Path $job 'stop'; if (Test-Path -LiteralPath $k) { Get-Content -LiteralPath $k | Where-Object { $_ -match '^(asked_at|signals)=' } | ForEach-Object { 'stop.' + $_ } }",
  "    foreach ($f in 'out.log', 'err.log') { $o = Join-Path $job $f; if (Test-Path -LiteralPath $o) { Get-Content -LiteralPath $o -Tail 5 | ForEach-Object { 'out|' + $(if ($_.Length -gt 300) { $_.Substring(0, 300) } else { $_ }) } } }",
  '  } }',
  "  'TIMMY-STATUS-END'",
  '}',
].join('\n');

export function windowsProbeScript(remoteDir: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue'",
    "'TIMMY-PROBE-BEGIN'",
    "'family=powershell'",
    "'os_name=Windows'",
    "'os_version=' + [Environment]::OSVersion.Version.ToString()",
    "'arch=' + $env:PROCESSOR_ARCHITECTURE",
    "'user=' + [Environment]::UserName",
    "'login_shell=' + $(if ($env:PSModulePath -and $Host.Name) { 'powershell ' + $PSVersionTable.PSVersion.ToString() } else { 'unknown' })",
    jobBase(remoteDir),
    '$d = $base',
    'if (Test-Path -LiteralPath $d -PathType Container) {',
    "  $t = Join-Path $d ('.timmy-probe.' + $PID)",
    "  try { [IO.File]::WriteAllText($t, ''); Remove-Item -LiteralPath $t -Force; 'job_folder=writable' } catch { 'job_folder=not writable' }",
    '} else {',
    '  while ($d -and -not (Test-Path -LiteralPath $d -PathType Container)) { $d = Split-Path -Parent $d }',
    "  $t = if ($d) { Join-Path $d ('.timmy-probe.' + $PID) } else { $null }",
    "  try { [IO.File]::WriteAllText($t, ''); Remove-Item -LiteralPath $t -Force; 'job_folder=absent, can be made' } catch { 'job_folder=absent, cannot be made' }",
    '}',
    "if (Get-Command Invoke-CimMethod) { 'detach=wmi' } else { 'detach=none' }",
    "if (Get-Command Get-FileHash) { 'sha256=Get-FileHash' } else { 'sha256=none' }",
    "'start_time=yes'",
    `foreach ($p in ${WINDOWS_PROGRAMS.map(psQuote).join(', ')}) { if (Get-Command $p) { 'found=' + $p } else { 'missing=' + $p } }`,
    "'TIMMY-PROBE-END'",
  ].join('\n');
}

/** The Windows supervisor (run.ps1): runs script.ps1 in .\\work (its output in out.log and err.log) and writes .\\status. */
export const WINDOWS_RUNNER = [
  'param([string]$job)',
  'Set-Location -LiteralPath $job',
  "$st = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
  "function Now { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }",
  "function Put($l) { $t = Join-Path $job ('status.tmp.' + $PID); [IO.File]::WriteAllLines($t, [string[]]$l); Move-Item -LiteralPath $t -Destination (Join-Path $job 'status') -Force }",
  '$started = Now',
  "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $job 'script.ps1') -WorkingDirectory (Join-Path $job 'work') -RedirectStandardOutput (Join-Path $job 'out.log') -RedirectStandardError (Join-Path $job 'err.log') -WindowStyle Hidden -PassThru",
  "Put @('state=running', \"pid=$PID\", \"pgid=$PID\", \"pid_start=$st\", \"child=$($p.Id)\", \"started_at=$started\")",
  '$p.WaitForExit()',
  "try { [void](New-Item -ItemType Directory -Path (Join-Path $job '.end') -ErrorAction Stop); Put @('state=ended', \"pid=$PID\", \"pgid=$PID\", \"pid_start=$st\", \"child=$($p.Id)\", \"started_at=$started\", \"ended_at=$(Now)\", \"exit_status=$($p.ExitCode)\", 'by=supervisor') } catch { }",
].join('\n');

/**
 * Submits one job on Windows: stdin carries `TIMMY-PARTS <runner bytes> <script bytes>` then both, so neither is in the
 * command line. The folder is made exclusively with an owner file holding the record's nonce (a folder already there is
 * this job's only when its owner file holds that nonce, or when it has no owner file and is untouched: no claim, no script;
 * otherwise "id-taken", and nothing changes there; no Windows job folder was ever made before owner files), the script's
 * sha256 checked, the run claimed exclusively (a file opened CreateNew) and started through WMI. Its answer has no status
 * lines (cmd.exe's line limit): Timmy reads the status with a call of its own right after (windowsStatusScript), as it does
 * after a stop and a wait.
 */
export function windowsSubmitScript(remoteDir: string, id: string, sha256: string, nonce = ''): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('a sha256 is 64 hex digits');
  if (nonce && !/^[0-9a-f]{32}$/.test(nonce)) throw new Error('a nonce is 32 hex digits');
  return [
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    jobBase(remoteDir),
    `$job = Join-Path $base ${psQuote(id)}; $nonce = ${psQuote(nonce)}; $want = ${psQuote(sha256)}`,
    'function J($x) { Test-Path -LiteralPath (Join-Path $job $x) }',
    "try { [void][IO.Directory]::CreateDirectory($base) } catch { 'TIMMY-SUBMIT no-folder'; exit 0 }",
    "$o = Join-Path $job 'owner'; $created = 'no'; try { [void](New-Item -ItemType Directory -Path $job -ErrorAction Stop); $created = 'yes'; if ($nonce) { [IO.File]::WriteAllText($o, $nonce) } } catch { }",
    "if (-not (Test-Path -LiteralPath $job)) { 'TIMMY-SUBMIT no-folder'; exit 0 }",
    "if ($created -eq 'no') { $n = 0; while ($nonce -and -not (J owner) -and $n -lt 5) { Start-Sleep -Milliseconds 200; $n++ }",
    "  $ours = if (J owner) { $nonce -and (Get-Content -LiteralPath $o -TotalCount 1) -eq $nonce } elseif ((J claim) -or (J script.ps1)) { $false } else { if ($nonce) { [IO.File]::WriteAllText($o, $nonce) }; $true }",
    "  if (-not $ours) { 'TIMMY-SUBMIT id-taken'; exit 0 } }",
    "if (J claim) { 'TIMMY-SUBMIT already-started created=' + $created; exit 0 }",
    "[void][IO.Directory]::CreateDirectory((Join-Path $job 'work'))",
    '$ms = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($ms); $all = $ms.ToArray()',
    '$nl = [Array]::IndexOf($all, [byte]10); $h = [Text.Encoding]::ASCII.GetString($all, 0, [Math]::Max(0, $nl)).Split(\' \')',
    "if ($nl -lt 0 -or $h[0] -ne 'TIMMY-PARTS') { 'TIMMY-SUBMIT not-written'; exit 0 }",
    '$rn = [int]$h[1]; $sn = [int]$h[2]; $runner = New-Object byte[] $rn; $script = New-Object byte[] $sn',
    '[Array]::Copy($all, $nl + 1, $runner, 0, $rn); [Array]::Copy($all, $nl + 1 + $rn, $script, 0, $sn)',
    "$sum = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($script) | ForEach-Object { $_.ToString('x2') })",
    "if ($sum -ne $want) { 'TIMMY-SUBMIT sha256-differs got=' + $sum; exit 0 }",
    "[IO.File]::WriteAllBytes((Join-Path $job 'script.ps1'), $script); [IO.File]::WriteAllBytes((Join-Path $job 'run.ps1'), $runner)",
    "try { $c = [IO.File]::Open((Join-Path $job 'claim'), 'CreateNew'); $c.Close() } catch { 'TIMMY-SUBMIT already-started created=' + $created; exit 0 }",
    "$cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + (Join-Path $job 'run.ps1') + '\" \"' + $job + '\"'",
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $job }",
    "if ($r.ReturnValue -ne 0) { Remove-Item -LiteralPath (Join-Path $job 'claim') -Force; 'TIMMY-SUBMIT no-detach'; exit 0 }",
    "'wmi' | Set-Content -LiteralPath (Join-Path $job 'detach')",
    "$n = 0; while (-not (J 'status') -and $n -lt 50) { Start-Sleep -Milliseconds 200; $n++ }",
    "'TIMMY-SUBMIT started created=' + $created + ' detach=wmi'",
  ].join('\n');
}

/** The bytes a Windows submission sends on stdin: a header line, the supervisor, then the job's script. */
export function windowsSubmitInput(script: Uint8Array): Buffer {
  const runner = Buffer.from(WINDOWS_RUNNER, 'utf8');
  return Buffer.concat([Buffer.from(`TIMMY-PARTS ${runner.length} ${script.length}\n`, 'ascii'), runner, Buffer.from(script)]);
}

export function windowsStatusScript(remoteDir: string, id: string, known: Known = {}): string {
  return ["$ErrorActionPreference = 'SilentlyContinue'", jobBase(remoteDir), `$job = Join-Path $base ${psQuote(id)}`, knownPs(known), STATUS_FN, 'St'].join('\n');
}

/**
 * Stops one job on Windows: only the supervisor Timmy recorded (the status file must still name it), its start time and
 * its command line (this job's run.ps1) checked, then taskkill /T /F on its tree; once that process is gone, the stop writes
 * the end. Its answer has no status lines (cmd.exe's line limit): Timmy reads the status with a call of its own right after.
 */
export function windowsStopScript(remoteDir: string, id: string, known: Known = {}): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    jobBase(remoteDir),
    `$job = Join-Path $base ${psQuote(id)}`,
    knownPs(known),
    RUNNER_FN,
    "$s = Join-Path $job 'status'",
    "if (-not (Test-Path -LiteralPath $job)) { 'TIMMY-STOP absent'; exit 0 }",
    "if (-not (Test-Path -LiteralPath $s)) { 'TIMMY-STOP no-status'; exit 0 }",
    '$t = Get-Content -LiteralPath $s',
    "if ($t -contains 'state=ended') { 'TIMMY-STOP already-ended'; exit 0 }",
    `$g = ${FILE_VALUE('pgid')}; $r = ${FILE_VALUE('pid_start')}`,
    "if ($g -notmatch '^[0-9]+$' -or -not $r) { 'TIMMY-STOP unreadable'; exit 0 }",
    "if ($wp -and ($g -ne $wp -or $r -ne $ws)) { 'TIMMY-STOP status-differs'; exit 0 }",
    '$p = Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue',
    "if (-not $p) { 'TIMMY-STOP gone'; exit 0 }",
    `if ($p.StartTime.${START} -ne $r) { 'TIMMY-STOP reused'; exit 0 }`,
    "if (-not (Rn $g)) { 'TIMMY-STOP not-runner'; exit 0 }",
    "$a = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')",
    "[IO.File]::WriteAllLines((Join-Path $job 'stop'), [string[]]@(\"asked_at=$a\", 'signals=taskkill'))",
    '& taskkill.exe /PID $g /T /F | Out-Null',
    '$n = 0; while ((Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue) -and $n -lt 50) { Start-Sleep -Milliseconds 200; $n++ }',
    "if (-not (Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue)) { try { [void](New-Item -ItemType Directory -Path (Join-Path $job '.end') -ErrorAction Stop); $keep = $t | Where-Object { $_ -match '^(pid|pgid|pid_start|child|started_at)=' }; $e = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); [IO.File]::WriteAllLines((Join-Path $job 'status'), [string[]](@('state=ended') + $keep + @(\"ended_at=$e\", 'exit_status=', 'stop_signal=taskkill', 'by=stop'))) } catch { } }",
    "'TIMMY-STOP done signals=taskkill'",
  ].join('\n');
}

/**
 * Waits on the device until the job has ended (or its supervisor is gone or reused), saying it still runs every 2 s. Its
 * answer ends at "TIMMY-WAIT end" with no status lines (cmd.exe's line limit): Timmy reads the status with a call of its own.
 */
export function windowsWaitScript(remoteDir: string, id: string, known: Known = {}): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    jobBase(remoteDir),
    `$job = Join-Path $base ${psQuote(id)}`,
    knownPs(known),
    "'TIMMY-WAIT begin'",
    "$n = 0; $s = Join-Path $job 'status'",
    "while (Test-Path -LiteralPath (Join-Path $job 'claim')) {",
    "  if (Test-Path -LiteralPath $s) { $t = Get-Content -LiteralPath $s; if ($t -contains 'state=ended') { break }",
    `    $g = if ($wp) { $wp } else { ${FILE_VALUE('pgid')} }; $q = Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue; if (-not $q -or ($ws -and $q.StartTime.${START} -ne $ws)) { break } }`,
    '  elseif ($n -gt 100) { break }',
    "  if ($n % 10 -eq 0) { 'TIMMY-WAIT running ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); [Console]::Out.Flush() }",
    '  $n++; Start-Sleep -Milliseconds 200',
    '}',
    "'TIMMY-WAIT end'",
  ].join('\n');
}

/**
 * Sends one file of a job's folder on Windows: no reparse point (a link) on its path, before and after it is read; its
 * bytes read once, and the sha256 is of those very bytes (no second open); the header; the bytes.
 */
export function windowsFetchScript(remoteDir: string, id: string, rel: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    jobBase(remoteDir),
    `$job = Join-Path $base ${psQuote(id)}; $rel = ${psQuote(rel)}`,
    "if (-not (Test-Path -LiteralPath $job -PathType Container)) { 'TIMMY-FETCH no-job'; exit 0 }",
    "function Lk { $q = $job; foreach ($part in $rel.Split('/')) { $q = Join-Path $q $part; $i = Get-Item -LiteralPath $q -Force -ErrorAction SilentlyContinue; if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $true } }; $false }",
    "$p = $job; foreach ($part in $rel.Split('/')) { $p = Join-Path $p $part }",
    "if (Lk) { 'TIMMY-FETCH link'; exit 0 }",
    "if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { 'TIMMY-FETCH not-a-file'; exit 0 }",
    "try { $bytes = [IO.File]::ReadAllBytes($p) } catch { 'TIMMY-FETCH not-readable'; exit 0 }",
    "if (Lk) { 'TIMMY-FETCH link'; exit 0 }",
    "$sum = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })",
    "[Console]::Out.Write('TIMMY-FETCH ok ' + $sum + ' ' + $bytes.Length + \"`n\"); [Console]::Out.Flush()",
    '$o = [Console]::OpenStandardOutput(); $o.Write($bytes, 0, $bytes.Length); $o.Flush()',
  ].join('\n');
}

/** The script a Windows job runs for `-- <command…>`: the words, each a literal, called with & (no parsing of them). */
export function windowsCommandScript(words: readonly string[]): string {
  return `& ${words.map(psQuote).join(' ')}\r\nexit $LASTEXITCODE\r\n`;
}
