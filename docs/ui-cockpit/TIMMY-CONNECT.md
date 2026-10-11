# Timmy Connect: the operator's own computers over SSH (slice 1)

Status (2026-10-11, round R4, helper H90, branch `r4/connect-1`): **implemented and tested against FAKE OpenSSH programs**
in a container that has no OpenSSH. Not live-qualified: no real computer was contacted, the real-OpenSSH test
(`tests/connect-real-ssh.test.ts`) was skipped here and is to run on the Mac (r24), and **no Windows computer was
available**: the Windows command shapes are built and checked, never run on Windows. The capability matrix in
[CONNECT-AND-CLOUD.md](CONNECT-AND-CLOUD.md) is the lead's to update.

The owner's limits this slice keeps (CONNECT-AND-CLOUD.md, quoted there): a working connection does not prove CAD,
rendering, GPU acceleration or native application support; nothing here assumes live provisioning or account access;
customers are never put on the operator's tailnet (Tailscale is only a network here; Tailscale SSH is not used).

## What exists

| Surface | Where |
|---|---|
| `timmy connect …` (each verb takes `--json`) | `src/connect/cli.ts`, entered from `src/cli.ts` |
| `/connect …` in the REPL | `src/connect/repl.ts`, one entry in `src/repl/commands.ts` |
| `readConnect(home)` for God's Eye View (devices with their last probe, remote jobs with their states; plain JSON, paths from ~) | `src/connect/read.ts` |
| The verbs, once, for both surfaces | `src/connect/commands.ts` |

`timmy connect <tool>` (any word that is not one of the verbs below) is still the journey's env.lock step, as before.

```
timmy connect add <id> [<user>@]<address> [--user <name>] [--port <n>] (--key <file> | --agent)
                  [--name <text>] [--remote-dir <dir>] [--account-ssh-config]
timmy connect scan <id>                 fetch its host keys again
timmy connect trust <id> SHA256:<…>     a person confirms that exact fingerprint
timmy connect devices                   the computers, their keys and last probes (no contact)
timmy connect remove <id>               forget it here (nothing on it changes)
timmy connect probe <id>
timmy connect run <id> [--wait] -- <command…>      or  --script <file>
timmy connect jobs                      remote jobs as last read (no contact)
timmy connect status <job>              reads the device first, then says it
timmy connect wait <job>                Ctrl-C stops only the waiting
timmy connect retry <job>               sends again only when the device has no run of it
timmy connect stop <job>
timmy connect fetch <job> <path inside its folder> [--to <local file>]
timmy connect tailnet                   read only: the peers `tailscale status --json` lists; adds nothing
```

Exit codes: 0 done (whatever was read), 1 refused or not answered, 2 usage, 130 a Ctrl-C during a wait (143 for SIGTERM);
a wait (`run --wait`, `wait`) exits 0 only when the job ended with exit 0 on the device.
In the REPL the same verbs work as `/connect …` (no `--wait` there: `/connect status <job>` reads a job), and `/connect
trust <id> [SHA256:…]` asks in Timmy's own NEEDS YOU box.

## Where its files are

Timmy home is `TIMMY_HOME`, or `~/timmy`.

| File | Mode | Holds |
|---|---|---|
| `<home>/connect/` | 0700 | Connect's own folder |
| `connect/devices.json` | 0600 | the device records: id, name, address, port, user, the key's **file** (or `agent`), os, shell, the confirmed host key (type, SHA256 fingerprint, when, where) or none, the remote job folder, when added, the last probe (when, outcome, words). No key, no token. |
| `connect/known_hosts` | 0600 | Timmy's own known-hosts file: only keys a person confirmed, each under the device's own name (`timmy-<id>`, ssh's HostKeyAlias) |
| `connect/scanned_hosts` | 0600 | host keys ssh-keyscan fetched, waiting for a person; never given to ssh |
| `connect/ssh_config` | 0600 | Timmy's own ssh config, kept **empty**: ssh refuses to run (Timmy says why) if anything is in it |
| `connect/results/<job>/…` | 0700 | fetched files, when no `--to` is given |
| `<home>/jobs/r<8 hex>.json` | 0600 | a remote job's local record (kind `remote`; the job readers there list `j<6 hex>` records only, and read past it) |
| `<home>/jobs/r<8 hex>.script` | 0600 | the exact script bytes, kept only until the device confirms the run (a retry sends the same bytes) |

The account's `~/.ssh/known_hosts` and `~/.ssh/config` are never read or written by Timmy (a device may opt into the
account's own config: below).

## Every ssh call

Through the system's own `ssh`, with an argument array (never a shell on this side), and these settings whatever any
config says (command-line options win in ssh):

```
ssh -F <home>/connect/ssh_config \
    -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=<home>/connect/known_hosts -o GlobalKnownHostsFile=/dev/null \
    -o UpdateHostKeys=no -o HostKeyAlias=timmy-<id> \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ControlMaster=no -o ControlPath=none -o ForwardAgent=no -o ClearAllForwardings=yes \
    -o ForwardX11=no -o PermitLocalCommand=no -T \
    -i <key file> -o IdentitiesOnly=yes        (or, for "agent": -o IdentityFile=none)
    -p <port> -l <user> -- <address> sh -s
```

The remote command is always fixed words: `sh -s` (POSIX), or `powershell.exe -NoProfile -NonInteractive
-EncodedCommand <base64>` (Windows). What it runs comes on stdin, so no script, path or secret is ever in an argument list
on either computer. A POSIX script runs only once all of it has arrived (its body is a function called on its last line),
so a script cut off by a dropped connection runs nothing. `--account-ssh-config` drops only `-F`: ssh then reads the
account's `~/.ssh/config` (and `/etc/ssh/ssh_config`), and every word about that device says so.

Timmy never reads, copies or stores a private key or a password. A key file is named (Timmy checks it exists and is
readable by its owner only, with `stat`), and ssh reads it. A key with a passphrase needs the ssh agent (`ssh-add`):
BatchMode never asks.

## Host keys

1. `timmy connect add` records the device (no host key) and fetches its keys with `ssh-keyscan -T 10 -p <port> -t
   ed25519,ecdsa,rsa -- <address>`; ssh-keygen (`-l -E sha256`) gives each SHA256 fingerprint, checked against Timmy's own
   computation of the same key. They are shown; **nothing is trusted**.
2. A person checks the fingerprint on the computer itself (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on macOS or
   Linux; `ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub` on Windows), then confirms it:
   `timmy connect trust <id> SHA256:<…>` must equal one that was fetched, exactly; in the REPL, `/connect trust <id>` shows
   the fingerprint whole in the NEEDS YOU box (no "allow for session"). A receipt (`remote-trust`) records the confirmation.
3. A host key that changes later is refused by ssh itself (`StrictHostKeyChecking=yes`, "REMOTE HOST IDENTIFICATION HAS
   CHANGED"). Timmy records the refusal and the fingerprint ssh says the computer offered, shows it as needing a person,
   sends nothing more to that device, and **never re-pins it**. Only a person's new confirmation (`scan`, then `trust` with
   the new fingerprint) replaces the pin, and the words name the key it replaces.

## Probes: what each outcome means

`timmy connect probe <id>` first sends `echo TIMMY-PROBE %OS%`: cmd.exe expands `%OS%` to `Windows_NT`, PowerShell prints
each word on its own line, a POSIX shell prints it as it is. A Windows device is recognised from that answer, never
assumed. Then the probe of that family.

| Outcome | Means |
|---|---|
| `connected` | ssh logged in and the probe answered: operating system, architecture, user, shell family, the job folder (writable, absent and can be made, …), how a job detaches there, the sha256 program, and which programs of a fixed list are **found on PATH** |
| `unreachable` (`timed out`, `refused`, `no route`, `name not resolved`, `network unreachable`, `closed`) | ssh could not reach it; ssh's own words are kept beside Timmy's |
| `host-key-unconfirmed` | Timmy holds no confirmed key for it, so ssh refused to log in |
| `host-key-changed` | it offered a key other than the confirmed one; ssh refused it |
| `auth-refused` | it did not accept the key (`Permission denied (publickey)`) |
| `error` | anything else, in ssh's words |

"Found on PATH" is all that is said of a program. It is not "supported" or "working": a CAD, rendering, GPU or native
application claim needs a run of its own, with its own evidence.

## Remote jobs

`timmy connect run <id> -- <command…>` runs the words as one command (each word quoted; no shell on either side);
`--script <file>` sends a POSIX script (a PowerShell one for Windows) over stdin, and its sha256 is recorded.

- **The id** (`r` and 8 hex digits) is chosen here before anything is sent, and names the job's folder on the device:
  `<remote dir>/<id>` (default `<remote home>/.timmy-connect/jobs/<id>`).
- **One run per id** (duplicate events): the device makes the folder exclusively (the answer says whether this call made
  it), checks the script's sha256 there, and starts the run only for the call that creates the job's `claim` folder. The
  same id sent twice, even at once, starts one run; a later call says "already started" and starts nothing.
- **Detached** from the SSH session: the job's supervisor starts in a session and a process group of its own, with `setsid`
  (Linux) or, where there is no setsid program (macOS), perl's `POSIX::setsid`; with neither, Timmy refuses to start a
  job there and says so. Its stdin, stdout and stderr are away from the SSH channel, so a dropped connection or a killed
  local ssh does not reach it. On Windows the job starts through WMI (`Win32_Process.Create`), outside the session's job
  object (built, not run on Windows).
- **Its status file** (`status`), written by the supervisor through a temp file and a rename: `running` with its pid, its
  process group and that process's start time (`ps -o lstart`, read as `LC_ALL=C TZ=UTC`), then `ended` with the shell's
  exit status, the signal a stop sent, and who wrote the end. Its output goes to `out.log`, its working folder is `work/`.

The local record holds one state:

| State | Means |
|---|---|
| `submitted` | sent and not confirmed by the device, or not sent at all (the words say which: "not sent: …") |
| `running` | the device's status file said so, read at the time named |
| `ended` | with its exit; or "its process is gone and it recorded no end" (killed, or the computer restarted) |
| `unknown` | the device did not answer: since when, why, when it was last seen and what is not known |
| `stop asked` | a person asked for a stop and the device has not confirmed it |
| `stopped` | the device's status file confirms the stop |

`timmy connect status <job>` reads the device's status file before it says anything, and so does every `retry`, which
sends the job again (same id, same bytes) only when the device has no started run of it.

**Exit words.** A POSIX shell reports a job that died by signal N as status 128+N, which a job could also exit with on
purpose; Timmy says "exit status 137 (a shell reports a death by SIGKILL so; it may also have exited with that code)", and
says "stopped" only when its stop sent the signal.

**Stopping.** `timmy connect stop <job>`: the device checks that the job's first process still has the recorded start time
(a reused pid is never signalled), sends SIGTERM to its process group, waits up to 10 s, then SIGKILL to what is left (the
start time checked again), and reads its status back. On Windows: the start time checked, then `taskkill /T /F` on its
process tree (built, not run on Windows). When the device does not answer, the record says the stop was asked and not
confirmed; a later `status` confirms it, or says the stop never reached the device.

**Waiting.** `--wait` (or `timmy connect wait <job>`) keeps one ssh call open that the device answers every 2 s. Ctrl-C
stops only that local ssh: Timmy says the remote job was not stopped and prints `timmy connect stop <job>` (exit 130). A
connection that drops leaves the job `unknown`, with when it was last seen.

## Fetching results

`timmy connect fetch <job> <path> [--to <local file>]`: only a path inside the job's folder (`work/out.bin`, `out.log`):
no `..`, no absolute path, and no symbolic link at any part of it (refused on the device). The device computes the sha256
(`sha256sum`, `shasum -a 256` or `openssl`; Windows: `Get-FileHash`), then sends the bytes over the ssh channel; Timmy
computes the local sha256 as they arrive. Equal: the file, never over an existing one, and a `remote-fetch` receipt on the
runs chain (the same chain and sealing the native jobs use). Different: the bytes are kept as `<file>.partial`, the fetch
is said failed, and a failed receipt names both hashes.

## Secrets and words

No password, key or token in an argument list, a record, a receipt or printed text. What a device sends back (a job's last
output lines, ssh's own words) is scrubbed before it is stored or shown (`src/connect/scrub.ts`): private-key blocks
(whole, or cut at either end of the text, or a lone key line) and the token shapes Timmy knows. A fetched file is the one
exception: it is kept byte for byte, since its sha256 is checked. Paths under the account's home are written from `~`.

## What is not proven

- No real computer was contacted; every test here ran against FAKE OpenSSH programs. The real-OpenSSH test is written and
  skipped here (below).
- Windows: nothing ran on Windows. The probe, fetch, job, stop and wait scripts are built, encoded and checked (each
  decodes back to itself and fits cmd.exe's 8,191 characters); a FAKE Windows device answers the probe from a hand-written
  fixture. How Windows' OpenSSH Server and PowerShell handle stdin, output encoding and WMI-started processes is not proven.
- That a job survives a dropped connection is proven here against the FAKE ssh (real processes, sessions and signals on
  Linux, and the perl path with no setsid program); on macOS it is for the Mac run to show.
- Tailscale: `timmy connect tailnet` reads `tailscale status --json` (tested with a FAKE tailscale). On a Mac the app's
  command-line program may not be on PATH.
- `ssh-keyscan` does not read ssh configs: a device that opts into the account's config through a `Host` alias is scanned
  at its address as given.

## The operator's steps for a real computer (a plan; nothing here has been run)

Each step below changes the operator's computers, so each is the operator's to approve and run (CONNECT-AND-CLOUD.md,
"Before any live step").

**On this computer (where Timmy runs):**

1. Make a key for Timmy only: `ssh-keygen -t ed25519 -f ~/.ssh/timmy_connect -C timmy-connect` (a passphrase is fine if
   you load it with `ssh-add ~/.ssh/timmy_connect` before using Timmy; BatchMode never asks for one).
2. `timmy connect add studio <its tailnet name or address> --user <your login there> --key ~/.ssh/timmy_connect`.

**On the computer to reach (macOS or Linux):**

3. SSH must be on: macOS, System Settings → General → Sharing → Remote Login (a machine service change: off again there);
   Linux, the `openssh-server` package and its service.
4. Add one line to `~/.ssh/authorized_keys` of the account Timmy logs in as (the public key from step 1, restricted):
   `restrict ssh-ed25519 AAAA…(the contents of ~/.ssh/timmy_connect.pub)… timmy-connect`
5. Read its host key's fingerprint there: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, and confirm that one:
   `timmy connect trust studio SHA256:<…>`.
6. The job folder, `~/.timmy-connect/jobs` (made by Timmy's first job with mode 0700 when it is absent; `timmy connect probe`
   says whether it can be), or another one with `--remote-dir` when adding.

**To undo both:** remove that line from `~/.ssh/authorized_keys` on that computer, and remove the job folder there
(`rm -rf ~/.timmy-connect`, after fetching what you need); here, `timmy connect remove studio` (its record and its confirmed
key), and delete `~/.ssh/timmy_connect` and `~/.ssh/timmy_connect.pub` if no other device uses them.

**Windows (Microsoft's OpenSSH Server; a machine service change; a plan only).** From Microsoft's "Get started with OpenSSH
for Windows" (learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse); check each command
against that page before running it, in PowerShell as an administrator:

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'   # is it there already?
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'                          # made by the install; it opens TCP 22
```

- The key line: for a standard account, `C:\Users\<account>\.ssh\authorized_keys`; for an account in the Administrators
  group, `C:\ProgramData\ssh\administrators_authorized_keys`, which must be readable by Administrators and SYSTEM only:
  `icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`.
- Its host key's fingerprint: `ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub`.
- The default shell may stay cmd.exe: Timmy sends PowerShell encoded either way. (Setting PowerShell as the default shell
  is a registry change, `HKLM:\SOFTWARE\OpenSSH` `DefaultShell`; Timmy does not need it.)
- **To turn it all off:** `Stop-Service sshd`, `Set-Service -Name sshd -StartupType Disabled`,
  `Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`, and, if the rule is still there,
  `Remove-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'`; remove the key line, and the job folder
  (`%USERPROFILE%\.timmy-connect`).

## The real-OpenSSH test (the Mac run, r24)

`tests/connect-real-ssh.test.ts` runs only with `TIMMY_TEST_REAL_SSH=1` where `ssh`, `ssh-keyscan`, `ssh-keygen` and `sshd`
exist (sshd on PATH, else `/usr/sbin/sshd`, or `TIMMY_TEST_SSHD=<path>`). As the sandbox user, from a clone at the branch:

```sh
TIMMY_TEST_REAL_SSH=1 npx vitest run tests/connect-real-ssh.test.ts
```

What it does: makes one temporary folder (the sandbox, under the user's TMPDIR) holding a host key, a second host key, a
client key and a stranger's key (`ssh-keygen -t ed25519 -N ''`), `authorized_keys` (the client key, `restrict`), an
`sshd_config` (127.0.0.1 only, a free port, that host key, that authorized_keys, `AllowUsers <the user>`, no password,
`UsePAM no`, `StrictModes no`, `PerSourcePenalties no` where sshd knows it, the pid file in the sandbox), Timmy home
(`TIMMY_HOME`) and the jobs' remote folder (`<sandbox>/remote-jobs`, given as the device's `--remote-dir`); starts
`sshd -D -e -f <config>` as the current user; then: keyscan, a wrong fingerprint refused and the right one trusted, a
probe (`connected`); a detached job whose wait's local ssh is killed, found and ended by `status`, its file fetched with
sha256 equal and a receipt; one id sent twice starting one run, and a confirmed stop; sshd stopped (`unreachable:
refused`), restarted with the second host key (`host-key-changed`, recorded), and a stranger's key (`auth-refused`).

What it checks afterwards: every job's process group is ended; its sshd has exited (its pid no longer answers `kill -0`);
the account's `~/.ssh/known_hosts` and `~/.ssh/config` have the same bytes as before; no `~/.timmy-connect` appeared; the
sandbox is removed. The remote commands start through the user's login shell, which reads its own startup files (zsh:
`~/.zshenv`), read only.
