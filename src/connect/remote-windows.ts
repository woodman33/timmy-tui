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
 * - a stop checks that start time, then ends the supervisor's process tree with taskkill /T /F (Windows has no SIGTERM for
 *   a console program); the stop writes the end;
 * - a job's script is PowerShell (script.ps1); its bytes come on stdin, never in the command line.
 */
import { psQuote } from './shells.js';

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

/** One job's status lines (the POSIX timmy_status's answer, by PowerShell's means). Defines `St`; uses $job. */
const STATUS_FN = [
  'function St {',
  "  'TIMMY-STATUS-BEGIN'",
  "  $s = Join-Path $job 'status'",
  "  if (-not (Test-Path -LiteralPath $job)) { 'where=absent' }",
  "  elseif (-not (Test-Path -LiteralPath (Join-Path $job 'claim'))) { 'where=not started' }",
  "  elseif (-not (Test-Path -LiteralPath $s)) { 'where=claimed' }",
  '  else {',
  "    'where=status'; $t = Get-Content -LiteralPath $s; $t",
  "    $g = ($t | Where-Object { $_ -like 'pgid=*' } | Select-Object -First 1) -replace '^pgid=', ''",
  "    $r = ($t | Where-Object { $_ -like 'pid_start=*' } | Select-Object -First 1) -replace '^pid_start=', ''",
  '    $p = $null; if ($g -match \'^[0-9]+$\') { $p = Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue }',
  "    if (-not $p) { 'alive=no' } elseif ($p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') -eq $r) { 'alive=yes' } else { 'alive=reused' }",
  "    $k = Join-Path $job 'stop'; if (Test-Path -LiteralPath $k) { Get-Content -LiteralPath $k | ForEach-Object { 'stop.' + $_ } }",
  "    foreach ($f in 'out.log', 'err.log') { $o = Join-Path $job $f; if (Test-Path -LiteralPath $o) { Get-Content -LiteralPath $o -Tail 5 | ForEach-Object { 'out|' + $(if ($_.Length -gt 300) { $_.Substring(0, 300) } else { $_ }) } } }",
  '  }',
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
 * command line. The folder is made exclusively, the script's sha256 checked, the run claimed exclusively (a file opened
 * CreateNew) and started through WMI. Its answer has no status lines (cmd.exe's line limit): Timmy reads the status with
 * a call of its own right after (windowsStatusScript), as it does after a stop.
 */
export function windowsSubmitScript(remoteDir: string, id: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('a sha256 is 64 hex digits');
  return [
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    jobBase(remoteDir),
    `$job = Join-Path $base ${psQuote(id)}`,
    "try { [void][IO.Directory]::CreateDirectory($base) } catch { 'TIMMY-SUBMIT no-folder'; exit 0 }",
    "$created = 'no'; try { [void](New-Item -ItemType Directory -Path $job -ErrorAction Stop); $created = 'yes' } catch { }",
    "if (-not (Test-Path -LiteralPath $job)) { 'TIMMY-SUBMIT no-folder'; exit 0 }",
    "if (Test-Path -LiteralPath (Join-Path $job 'claim')) { 'TIMMY-SUBMIT already-started created=' + $created; exit 0 }",
    "[void][IO.Directory]::CreateDirectory((Join-Path $job 'work'))",
    '$ms = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($ms); $all = $ms.ToArray()',
    '$nl = [Array]::IndexOf($all, [byte]10); $h = [Text.Encoding]::ASCII.GetString($all, 0, [Math]::Max(0, $nl)).Split(\' \')',
    "if ($nl -lt 0 -or $h[0] -ne 'TIMMY-PARTS') { 'TIMMY-SUBMIT not-written'; exit 0 }",
    '$rn = [int]$h[1]; $sn = [int]$h[2]; $runner = New-Object byte[] $rn; $script = New-Object byte[] $sn',
    '[Array]::Copy($all, $nl + 1, $runner, 0, $rn); [Array]::Copy($all, $nl + 1 + $rn, $script, 0, $sn)',
    "$sum = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($script) | ForEach-Object { $_.ToString('x2') })",
    `if ($sum -ne ${psQuote(sha256)}) { 'TIMMY-SUBMIT sha256-differs got=' + $sum; exit 0 }`,
    "[IO.File]::WriteAllBytes((Join-Path $job 'script.ps1'), $script); [IO.File]::WriteAllBytes((Join-Path $job 'run.ps1'), $runner)",
    "try { $c = [IO.File]::Open((Join-Path $job 'claim'), 'CreateNew'); $c.Close() } catch { 'TIMMY-SUBMIT already-started created=' + $created; exit 0 }",
    "$cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + (Join-Path $job 'run.ps1') + '\" \"' + $job + '\"'",
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $job }",
    "if ($r.ReturnValue -ne 0) { Remove-Item -LiteralPath (Join-Path $job 'claim') -Force; 'TIMMY-SUBMIT no-detach'; exit 0 }",
    "'wmi' | Set-Content -LiteralPath (Join-Path $job 'detach')",
    "$n = 0; while (-not (Test-Path -LiteralPath (Join-Path $job 'status')) -and $n -lt 50) { Start-Sleep -Milliseconds 200; $n++ }",
    "'TIMMY-SUBMIT started created=' + $created + ' detach=wmi'",
  ].join('\n');
}

/** The bytes a Windows submission sends on stdin: a header line, the supervisor, then the job's script. */
export function windowsSubmitInput(script: Uint8Array): Buffer {
  const runner = Buffer.from(WINDOWS_RUNNER, 'utf8');
  return Buffer.concat([Buffer.from(`TIMMY-PARTS ${runner.length} ${script.length}\n`, 'ascii'), runner, Buffer.from(script)]);
}

export function windowsStatusScript(remoteDir: string, id: string): string {
  return ["$ErrorActionPreference = 'SilentlyContinue'", jobBase(remoteDir), `$job = Join-Path $base ${psQuote(id)}`, STATUS_FN, 'St'].join('\n');
}

/** Stops one job on Windows: its supervisor's start time checked, then taskkill /T /F on its tree; the stop writes the end.
 *  Its answer has no status lines (cmd.exe's line limit): Timmy reads the status with a call of its own right after. */
export function windowsStopScript(remoteDir: string, id: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    jobBase(remoteDir),
    `$job = Join-Path $base ${psQuote(id)}`,
    "$s = Join-Path $job 'status'",
    "if (-not (Test-Path -LiteralPath $job)) { 'TIMMY-STOP absent'; exit 0 }",
    "if (-not (Test-Path -LiteralPath $s)) { 'TIMMY-STOP no-status'; exit 0 }",
    '$t = Get-Content -LiteralPath $s',
    "if ($t -contains 'state=ended') { 'TIMMY-STOP already-ended'; exit 0 }",
    "$g = ($t | Where-Object { $_ -like 'pgid=*' } | Select-Object -First 1) -replace '^pgid=', ''",
    "$r = ($t | Where-Object { $_ -like 'pid_start=*' } | Select-Object -First 1) -replace '^pid_start=', ''",
    "if ($g -notmatch '^[0-9]+$' -or -not $r) { 'TIMMY-STOP unreadable'; exit 0 }",
    '$p = Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue',
    "if (-not $p) { 'TIMMY-STOP gone'; exit 0 }",
    "if ($p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') -ne $r) { 'TIMMY-STOP reused'; exit 0 }",
    "$a = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')",
    "[IO.File]::WriteAllLines((Join-Path $job 'stop'), [string[]]@(\"asked_at=$a\", 'signals=taskkill'))",
    '& taskkill.exe /PID $g /T /F | Out-Null',
    '$n = 0; while ((Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue) -and $n -lt 50) { Start-Sleep -Milliseconds 200; $n++ }',
    "try { [void](New-Item -ItemType Directory -Path (Join-Path $job '.end') -ErrorAction Stop); $keep = $t | Where-Object { $_ -match '^(pid|pgid|pid_start|child|started_at)=' }; $e = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); [IO.File]::WriteAllLines((Join-Path $job 'status'), [string[]](@('state=ended') + $keep + @(\"ended_at=$e\", 'exit_status=', 'stop_signal=taskkill', 'by=stop'))) } catch { }",
    "'TIMMY-STOP done signals=taskkill'",
  ].join('\n');
}

/** Waits on the device until the job has ended, saying it still runs every 2 s; then its status. */
export function windowsWaitScript(remoteDir: string, id: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    jobBase(remoteDir),
    `$job = Join-Path $base ${psQuote(id)}`,
    STATUS_FN,
    "'TIMMY-WAIT begin'",
    "$n = 0; $s = Join-Path $job 'status'",
    "while (Test-Path -LiteralPath (Join-Path $job 'claim')) {",
    "  if (Test-Path -LiteralPath $s) { $t = Get-Content -LiteralPath $s; if ($t -contains 'state=ended') { break }",
    "    $g = ($t | Where-Object { $_ -like 'pgid=*' } | Select-Object -First 1) -replace '^pgid=', ''; if (-not (Get-Process -Id ([int]$g) -ErrorAction SilentlyContinue)) { break } }",
    '  elseif ($n -gt 100) { break }',
    "  if ($n % 10 -eq 0) { 'TIMMY-WAIT running ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); [Console]::Out.Flush() }",
    '  $n++; Start-Sleep -Milliseconds 200',
    '}',
    "'TIMMY-WAIT end'",
    'St',
  ].join('\n');
}

/** Sends one file of a job's folder on Windows: no reparse point (a link) on its path; Get-FileHash; the header; the bytes. */
export function windowsFetchScript(remoteDir: string, id: string, rel: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    jobBase(remoteDir),
    `$job = Join-Path $base ${psQuote(id)}; $rel = ${psQuote(rel)}`,
    "if (-not (Test-Path -LiteralPath $job -PathType Container)) { 'TIMMY-FETCH no-job'; exit 0 }",
    '$p = $job',
    "foreach ($part in $rel.Split('/')) { $p = Join-Path $p $part; $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { 'TIMMY-FETCH link'; exit 0 } }",
    "if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { 'TIMMY-FETCH not-a-file'; exit 0 }",
    "try { $sum = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant(); $bytes = [IO.File]::ReadAllBytes($p) } catch { 'TIMMY-FETCH not-readable'; exit 0 }",
    "[Console]::Out.Write('TIMMY-FETCH ok ' + $sum + ' ' + $bytes.Length + \"`n\"); [Console]::Out.Flush()",
    '$o = [Console]::OpenStandardOutput(); $o.Write($bytes, 0, $bytes.Length); $o.Flush()',
  ].join('\n');
}

/** The script a Windows job runs for `-- <command…>`: the words, each a literal, called with & (no parsing of them). */
export function windowsCommandScript(words: readonly string[]): string {
  return `& ${words.map(psQuote).join(' ')}\r\nexit $LASTEXITCODE\r\n`;
}
