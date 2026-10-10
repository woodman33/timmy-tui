#!/usr/bin/env python3
"""timmy-pty-run: one command run on a pseudo-terminal of its own, the terminal's bytes copied to stdout as they come.

Usage: pty_run.py [--parent <pid>] [--stop-file <path>] -- <command> [<arg> ...]

Round R4 (helper H58, ledger row 157): with its output a pipe, upmd 0.2.7 writes a block's start line, its output and
its end line all at once, when the block ends; on a terminal it draws each block as it starts and its output as it
runs. Timmy runs `upmd --ci -b <block> -d <dir> <file>` through this wrapper so a run's block states arrive as they
happen (src/workflows/upmd-live.ts reads them).

- The command runs as the leader of a new session (so of its own process group) with the pty as its controlling
  terminal and as its stdin, stdout and stderr. The terminal keeps the size a new pty has (none is set), as when
  upmd 0.2.7's terminal output was observed; TERM is set to xterm-256color only when it is not set at all. Nothing is
  typed into the terminal, and this process reads nothing from its own stdin.
- Every byte the terminal gives is written to stdout unchanged, as it comes. This process's own words go to stderr
  only, each line beginning `pty_run: `, so they never mix with the terminal's bytes.
- It exits with the command's exit code (128 + n when signal n ended it), 127 when the command did not start, 64 on a
  usage error.
- SIGTERM, SIGINT and SIGHUP stop the command and what it started: the process table (ps) is read for the command's
  processes and every process they started, including those in sessions of their own (upmd runs each block on a
  terminal of its own), the signal goes to each of their process groups (never to this process's own), SIGKILL goes to
  those still there after STOP_GRACE seconds, and this process then ends by the signal it received, saying on stderr
  what it did and which groups, if any, still run. Without ps, only the command's own group is signalled, and closing
  the terminal hangs up the rest.
- When stdout cannot be written any more (whatever read it is gone), the command is stopped the same way with SIGHUP,
  as a terminal that closes would.

Round R4 (helper H67, ledger row 162, r20 on the Mac): a REPL killed with SIGKILL while a block ran left this process,
upmd and the blocks running; upmd started the next block 5 s later, because nothing had been written to the dead pipe
before it did. So:
- Its parent: the process that started it (Timmy's REPL, whose job this is), named by --parent, else the parent it has
  as it starts. At every turn of its loop (every POLL seconds at most, one getppid call) it checks that this is still
  its parent: on macOS and Linux a process whose parent ends is given another (launchd or init, or a subreaper), so a
  changed parent process id means the parent has ended. The command is then stopped at once by the same path as a
  SIGTERM (its process group and every group it started; SIGKILL after STOP_GRACE), and this process ends as SIGTERM
  would end it. A parent named by --parent that had already ended when this process started: the command is not
  started. A command that had already ended when the parent's end is seen is not waited for any more.
- Its own reading of upmd's blocks: the same lines src/workflows/upmd-live.ts reads (a block's start ` [n/count] Lang`,
  its summary `==> name [block n]` and its end `✔ exited with code c` / `✘ exited with code c`, and `Block n failed -
  stopping dependency chain`), read from what the terminal gives, whoever still reads stdout. upmd runs one block at a
  time, so a start is taken only while no block runs (a block's output drawn at the start of a line is not a start).
- --stop-file: before it exits, whatever ended it (but a SIGKILL to it), it writes what it saw to that file as one JSON object (schema
  timmy.pty-stop/1), mode 0600, through a temporary file and a rename: why it ended, its parent and whether it had ended,
  whether it stopped the command (the signals, the process groups and any still running after SIGKILL), the command's
  exit, and each block it saw, in order: its number (and upmd's count), its name once upmd said it, its state
  (completed, failed, `stopped`: running when this process began to stop the command, `running`: its end not seen), its
  exit code and when its start and end were seen. Its own words name the command by its file name only. Timmy reads the
  file when the REPL that started the run has ended (src/repl/workflow-recover.ts): it is what this process saw that the
  REPL could not.

Python 3.8 or later, standard library only; macOS and Linux.
"""
import codecs
import datetime
import errno
import fcntl
import json
import os
import re
import select
import signal
import subprocess
import sys
import termios
import time

PREFIX = 'pty_run: '
# Timmy's own stop (src/jobs) sends SIGKILL to this process's group 2 s after its SIGTERM: the whole sequence below
# (the signal, STOP_GRACE, SIGKILL, KILL_WAIT) fits well inside that.
STOP_GRACE = 0.8
KILL_WAIT = 0.8
# Once the command has ended: how long its terminal is still read while nothing new comes, and at most.
DRAIN_QUIET = 0.3
DRAIN_MAX = 2.0
POLL = 0.05
STOPS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
STOP_SCHEMA = 'timmy.pty-stop/1'


def say(text):
    try:
        os.write(2, (PREFIX + text + '\n').encode('utf-8', 'replace'))
    except OSError:
        pass


def signame(sig):
    try:
        return signal.Signals(sig).name
    except ValueError:
        return 'signal %d' % sig


def stamp():
    """Now, as src/jobs stamps its moments: UTC, milliseconds, `Z`."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class OutputGone(Exception):
    """stdout can no longer be written"""


def write_all(data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(1, view)
        except BlockingIOError:
            select.select([], [1], [], 1.0)
            continue
        except OSError:
            raise OutputGone()
        view = view[n:]


def read_terminal(fd, timeout):
    """What the terminal gives: bytes; b'' at its end (every copy of its other side closed); None when nothing came."""
    try:
        ready, _, _ = select.select([fd], [], [], timeout)
    except (OSError, ValueError):
        return b''
    if not ready:
        return None
    try:
        return os.read(fd, 65536)
    except OSError as e:
        if e.errno == errno.EIO:  # Linux: the other side is closed and nothing is left to read
            return b''
        raise


# ── upmd's blocks, as its terminal output shows them (src/workflows/upmd-live.ts reads the same lines) ──────────────

OSC = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?')
CSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
CHARSET = re.compile(r'\x1b[()*+][0-9A-Za-z]')
SHORT = re.compile(r'\x1b[@-Z\\-_]')
CONTROLS = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')
EOL = re.compile(r'\r\n|\r|\n')
HEADER = re.compile(r'^ ?\[([0-9]+)/([0-9]+)\](?: ([^\s\[]\S*))?(?:\s+\[([^\]]*)\])?$')
SUMMARY = re.compile(r'^==> (.+) \[block ([0-9]+)\]$')
END = re.compile('^\\s*[✔✘]\\s*exited with code (-?[0-9]+)$')
CHAIN = re.compile('^Block ([0-9]+) failed [-–—] stopping dependency chain$')
# upmd's own lines are short; a longer line is a block's output and is not read for them
LINE_READ = 4096
MAX_LINE = 64 * 1024


def terminal_text(line):
    """A line of terminal output as text: its ANSI sequences and control characters removed, trailing space too."""
    for pattern in (OSC, CSI, CHARSET, SHORT, CONTROLS):
        line = pattern.sub('', line)
    return line.rstrip()


class Lines:
    """Lines as src/jobs' LineSplitter makes them: \\r\\n, \\n and a lone \\r end a line (a \\r at a line's start makes
    none; a \\r at a chunk's end waits for the next chunk); a line longer than MAX_LINE is cut."""

    def __init__(self):
        self.rest = ''

    def push(self, text):
        buffer = self.rest + text
        held = buffer.endswith('\r')
        body = buffer[:-1] if held else buffer
        lines = []
        start = 0
        for m in EOL.finditer(body):
            line = body[start:m.start()]
            start = m.end()
            if m.group(0) == '\r' and not line:
                continue
            lines.append(line)
        rest = body[start:]
        while len(rest) > MAX_LINE:
            lines.append(rest[:MAX_LINE])
            rest = rest[MAX_LINE:]
        self.rest = rest + '\r' if held else rest
        return lines


class Blocks:
    """Each block upmd showed, in order: {'n', 'count', 'name', 'state', 'code', 'started_at', 'ended_at'}."""

    def __init__(self):
        self.lines = Lines()
        self.decode = codecs.getincrementaldecoder('utf-8')('replace').decode
        self.seen = []
        self.running = None
        self.summary = None
        # set once a stop begins: [the block running then, or None]
        self.frozen = None

    def find(self, n):
        for b in reversed(self.seen):
            if b['n'] == n:
                return b
        return None

    def feed(self, data):
        for line in self.lines.push(self.decode(data)):
            if len(line) <= LINE_READ:
                self.line(line)

    def line(self, raw):
        text = terminal_text(raw)
        if not text:
            return
        m = HEADER.match(text)
        if m:
            self.summary = None
            n = int(m.group(1))
            # upmd runs one block at a time: while one runs, this is its redraw, or a block's output, not a start
            if self.running is not None or n < 1 or self.find(n) is not None:
                return
            b = {'n': n, 'count': int(m.group(2)), 'state': 'running', 'started_at': stamp()}
            self.seen.append(b)
            self.running = b
            return
        m = SUMMARY.match(text)
        if m:
            n = int(m.group(2))
            b = self.find(n)
            if b is None:
                if self.running is not None:
                    return  # another block runs: not upmd's summary
                b = {'n': n, 'state': 'running'}  # its start was not seen: when it started is not known
                self.seen.append(b)
                self.running = b
            elif b is not self.running and not (b['state'] == 'failed' and 'code' not in b):
                return  # a block whose end was read already
            b['name'] = m.group(1)
            self.summary = b
            return
        m = END.match(text)
        if m:
            b = self.summary
            if b is None:
                return  # upmd's end line closes a summary
            b['code'] = int(m.group(1))  # the summary's last such line is upmd's own (a block's output comes before it)
            if b['state'] in ('running', 'completed', 'failed') and not (b['state'] == 'failed' and b.get('chain')):
                b['state'] = 'completed' if b['code'] == 0 else 'failed'
            b.setdefault('ended_at', stamp())
            if b is self.running:
                self.running = None
            return
        m = CHAIN.match(text)
        if m and self.running is not None and self.running['n'] == int(m.group(1)):
            b = self.running
            b['state'] = 'failed'
            b['chain'] = True
            b.setdefault('ended_at', stamp())
            self.running = None

    def freeze(self):
        """A stop begins: the block running now is the one it stops."""
        if self.frozen is None:
            self.frozen = [self.running]

    def report(self, stopped, stopping_at):
        out = []
        frozen = self.frozen[0] if self.frozen else None
        for b in self.seen:
            e = {'n': b['n']}
            for key in ('count', 'name'):
                if b.get(key) is not None:
                    e[key] = b[key]
            if stopped and (b is frozen or b['state'] == 'running'):
                e['state'] = 'stopped'
                e['stopped_at'] = stopping_at
            else:
                e['state'] = b['state']
            for key in ('code', 'started_at', 'ended_at'):
                if b.get(key) is not None:
                    e[key] = b[key]
            out.append(e)
        return out


# ── processes ────────────────────────────────────────────────────────────────

def process_table():
    """[(pid, ppid, pgid, stat)] read once with ps (POSIX keywords, as macOS needs), or None when it cannot be read."""
    try:
        done = subprocess.run(['ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat='],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              env=dict(os.environ, LC_ALL='C'), timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    rows = []
    for line in done.stdout.decode('ascii', 'replace').splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        try:
            rows.append((int(parts[0]), int(parts[1]), int(parts[2]), parts[3]))
        except ValueError:
            continue
    return rows or None


def tree_groups(root, own):
    """The process groups of `root` and of every process it started (by parent links in the process table), without
    this process's own group or 0 and 1; and whether the table could be read."""
    rows = process_table()
    if rows is None:
        return {root}, False
    children = {}
    group = {}
    for pid, ppid, pgid, _stat in rows:
        children.setdefault(ppid, []).append(pid)
        group[pid] = pgid
    seen = set()
    stack = [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        stack.extend(children.get(pid, []))
    groups = {root}
    for pid in seen:
        g = group.get(pid)
        if g is not None and g > 1 and g != own:
            groups.add(g)
    return groups, True


def live_groups(groups):
    """The groups of `groups` with a process that runs (a zombie runs nothing)."""
    rows = process_table()
    if rows is None:
        live = set()
        for g in groups:
            try:
                os.killpg(g, 0)
                live.add(g)
            except ProcessLookupError:
                pass
            except PermissionError:
                live.add(g)
        return live
    return {pgid for _pid, _ppid, pgid, stat in rows if pgid in groups and not stat.startswith('Z')}


def send(groups, sig):
    for g in sorted(groups):
        try:
            os.killpg(g, sig)
        except (ProcessLookupError, PermissionError):
            pass


class Run:
    def __init__(self, cmd0, child, master):
        self.cmd0 = cmd0
        self.child = child
        self.master = master
        self.out_ok = True
        self.blocks = Blocks()
        # what a stop did, for the stop file
        self.said = None
        self.signals = []
        self.groups = []
        self.left = []
        self.stopping_at = None

    def take(self, data):
        """What the terminal gave: read for upmd's blocks, and copied to stdout while it can be written."""
        self.blocks.feed(data)
        if self.out_ok:
            try:
                write_all(data)
            except OutputGone:
                self.out_ok = False

    def pump(self, timeout):
        """Copies what the terminal has to stdout; False once the terminal has ended."""
        data = read_terminal(self.master, timeout)
        if data is None:
            return True
        if not data:
            return False
        self.take(data)
        return True

    def wait_gone(self, groups, seconds):
        end = time.monotonic() + seconds
        open_ = True
        while True:
            if open_:
                open_ = self.pump(POLL)
            else:
                time.sleep(POLL)
            self.child.poll()
            if not live_groups(groups):
                return True
            if time.monotonic() >= end:
                return False

    def stop(self, sig, why):
        """Stops the command and every process group it started; the groups still running afterwards."""
        self.blocks.freeze()
        self.stopping_at = stamp()
        own = os.getpgrp()
        groups, listed = tree_groups(self.child.pid, own)
        others = sorted(g for g in groups if g != self.child.pid)
        self.said = '%s: stopping %s (process group %d)%s with %s%s' % (
            why, os.path.basename(self.cmd0), self.child.pid,
            (' and the %d process group%s it started (%s)' % (len(others), '' if len(others) == 1 else 's', ', '.join(str(g) for g in others))) if others else '',
            signame(sig), '' if listed else '; the process table (ps) could not be read, so only its own group is signalled')
        say(self.said)
        self.signals = [signame(sig)]
        self.groups = sorted(groups)
        send(groups, sig)
        if self.wait_gone(groups, STOP_GRACE):
            say('stopped: no process of those groups runs')
            return set()
        more, _ = tree_groups(self.child.pid, own)
        groups |= more
        self.groups = sorted(groups)
        say('some still ran after %.1f s: SIGKILL to process groups %s' % (STOP_GRACE, ', '.join(str(g) for g in sorted(groups))))
        self.signals.append('SIGKILL')
        send(groups, signal.SIGKILL)
        if self.wait_gone(groups, KILL_WAIT):
            say('stopped: no process of those groups runs')
            return set()
        left = live_groups(groups)
        self.left = sorted(left)
        say('processes of process groups %s still run after SIGKILL' % ', '.join(str(g) for g in sorted(left)))
        return left


def exit_code(returncode):
    return 128 - returncode if returncode < 0 else returncode


def end_by(sig, fallback):
    """Ends this process by `sig` (so whoever waits for it sees that signal), else with `fallback`."""
    try:
        signal.signal(sig, signal.SIG_DFL)
        os.kill(os.getpid(), sig)
        time.sleep(1)
    except OSError:
        pass
    os._exit(fallback)


def write_stop(path, record):
    """The stop file: one JSON object, mode 0600, written through a temporary file and a rename. Nothing when no path."""
    if not path:
        return
    data = (json.dumps(record, ensure_ascii=False) + '\n').encode('utf-8')
    temp = '%s.%d.tmp' % (path, os.getpid())
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
        finally:
            os.close(fd)
        os.replace(temp, path)
    except OSError as e:
        say('its stop file could not be written: %s' % (e.strerror or e))
        try:
            os.unlink(temp)
        except OSError:
            pass


def parse_args(argv):
    """(options, command) or None on a usage error: --parent <pid> and --stop-file <path>, each at most once, then --."""
    opts = {'parent': None, 'stop_file': None}
    i = 0
    while i < len(argv) and argv[i] != '--':
        key = {'--parent': 'parent', '--stop-file': 'stop_file'}.get(argv[i])
        if key is None or i + 1 >= len(argv) or opts[key] is not None:
            return None
        value = argv[i + 1]
        if key == 'parent':
            if not value.isdigit() or int(value) < 1:
                return None
            value = int(value)
        elif not value:
            return None
        opts[key] = value
        i += 2
    if i >= len(argv) or len(argv) - i < 2:
        return None
    return opts, argv[i + 1:]


def main(argv):
    parsed = parse_args(argv)
    if parsed is None:
        say('usage: pty_run.py [--parent <pid>] [--stop-file <path>] -- <command> [<arg> ...]')
        return 64
    opts, cmd = parsed
    stop_file = opts['stop_file']
    parent = opts['parent'] if opts['parent'] is not None else os.getppid()
    began = stamp()

    def record(why, run, stopped, exit_status, parent_ended):
        return {
            'schema': STOP_SCHEMA, 'wrapper_pid': os.getpid(), 'command': os.path.basename(cmd[0]),
            'command_pid': run.child.pid if run else None, 'started_at': began, 'at': stamp(), 'why': why,
            'parent': {'pid': parent, 'ended': parent_ended}, 'stopped': stopped,
            **({'stopping_at': run.stopping_at, 'said': run.said, 'signals': run.signals, 'groups': run.groups, 'left': run.left} if stopped else {}),
            'exit': exit_status, 'blocks': run.blocks.report(stopped, run.stopping_at) if run else [],
        }

    if os.getppid() != parent:
        why = 'its parent (process %d) had ended before %s started' % (parent, os.path.basename(cmd[0]))
        say('%s: it was not started' % why)
        write_stop(stop_file, record(why, None, False, None, True))
        return 1

    asked = []

    def on_stop(sig, _frame):
        if not asked:
            asked.append(sig)

    for sig in STOPS:
        signal.signal(sig, on_stop)

    env = dict(os.environ)
    if 'TERM' not in env:
        env['TERM'] = 'xterm-256color'
    master, slave = os.openpty()

    def controlling_terminal():
        # In the child, after setsid(): the pty (its fd 0 now) becomes its controlling terminal. Where that cannot be
        # done, the command still writes to a terminal; it only has no controlling one.
        try:
            fcntl.ioctl(0, getattr(termios, 'TIOCSCTTY'), 0)
        except Exception:
            pass

    try:
        child = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True,
                                 preexec_fn=controlling_terminal, close_fds=True)
    except (OSError, subprocess.SubprocessError) as e:
        os.close(slave)
        os.close(master)
        say('%s did not start: %s' % (cmd[0], getattr(e, 'strerror', None) or e))
        write_stop(stop_file, record('%s did not start' % os.path.basename(cmd[0]), None, False, None, os.getppid() != parent))
        return 127
    began = stamp()
    os.close(slave)
    run = Run(cmd[0], child, master)
    say('%s runs as process %d, the leader of its own session, on a terminal of its own' % (os.path.basename(cmd[0]), child.pid))

    def stop_and_end(sig, why, end_sig):
        left = run.stop(sig, why)
        os.close(master)
        run.child.poll()
        status = exit_code(run.child.returncode) if run.child.returncode is not None else None
        write_stop(stop_file, record(why, run, True, status, os.getppid() != parent))
        end_by(end_sig, 1 if left else 128 + end_sig)

    ended = None
    quiet = None
    open_ = True
    gone = None
    while True:
        if asked:
            stop_and_end(asked[0], '%s received' % signame(asked[0]), asked[0])
        if os.getppid() != parent:
            gone = 'its parent (process %d) ended' % parent
            if child.poll() is None:
                stop_and_end(signal.SIGTERM, gone, signal.SIGTERM)
            break  # the command had ended: no one reads what is left of its terminal
        if not run.out_ok:
            stop_and_end(signal.SIGHUP, 'its output could not be written any more', signal.SIGHUP)
        if open_:
            data = read_terminal(master, POLL)
            if data is None:
                pass
            elif not data:
                open_ = False
            else:
                quiet = None
                run.take(data)
                continue
        else:
            time.sleep(POLL)
        if child.poll() is None:
            continue
        # The command has ended: what it wrote is still read, until the terminal ends or stays quiet.
        now = time.monotonic()
        if ended is None:
            ended = now
        if quiet is None:
            quiet = now
        if not open_ or now - quiet >= DRAIN_QUIET or now - ended >= DRAIN_MAX:
            break
    os.close(master)
    child.wait()
    status = exit_code(child.returncode)
    write_stop(stop_file, record(gone or '%s ended by itself' % os.path.basename(cmd[0]), run, False, status, gone is not None or os.getppid() != parent))
    return status


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
