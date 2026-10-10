#!/usr/bin/env python3
"""timmy-pty-run: one command run on a pseudo-terminal of its own, the terminal's bytes copied to stdout as they come.

Usage: pty_run.py -- <command> [<arg> ...]

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

Python 3.8 or later, standard library only; macOS and Linux.
"""
import errno
import fcntl
import os
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

    def pump(self, timeout):
        """Copies what the terminal has to stdout; False once the terminal has ended."""
        data = read_terminal(self.master, timeout)
        if data is None:
            return True
        if not data:
            return False
        if self.out_ok:
            try:
                write_all(data)
            except OutputGone:
                self.out_ok = False
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
        own = os.getpgrp()
        groups, listed = tree_groups(self.child.pid, own)
        others = sorted(g for g in groups if g != self.child.pid)
        say('%s: stopping %s (process group %d)%s with %s%s' % (
            why, os.path.basename(self.cmd0), self.child.pid,
            (' and the %d process group%s it started (%s)' % (len(others), '' if len(others) == 1 else 's', ', '.join(str(g) for g in others))) if others else '',
            signame(sig), '' if listed else '; the process table (ps) could not be read, so only its own group is signalled'))
        send(groups, sig)
        if self.wait_gone(groups, STOP_GRACE):
            say('stopped: no process of those groups runs')
            return set()
        more, _ = tree_groups(self.child.pid, own)
        groups |= more
        say('some still ran after %.1f s: SIGKILL to process groups %s' % (STOP_GRACE, ', '.join(str(g) for g in sorted(groups))))
        send(groups, signal.SIGKILL)
        if self.wait_gone(groups, KILL_WAIT):
            say('stopped: no process of those groups runs')
            return set()
        left = live_groups(groups)
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


def main(argv):
    if len(argv) < 2 or argv[0] != '--':
        say('usage: pty_run.py -- <command> [<arg> ...]')
        return 64
    cmd = argv[1:]
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
        return 127
    os.close(slave)
    run = Run(cmd[0], child, master)
    say('%s runs as process %d, the leader of its own session, on a terminal of its own' % (os.path.basename(cmd[0]), child.pid))

    ended = None
    quiet = None
    open_ = True
    while True:
        if asked:
            left = run.stop(asked[0], '%s received' % signame(asked[0]))
            os.close(master)
            run.child.poll()
            end_by(asked[0], 1 if left else 128 + asked[0])
        if not run.out_ok:
            left = run.stop(signal.SIGHUP, 'its output could not be written any more')
            os.close(master)
            run.child.poll()
            end_by(signal.SIGHUP, 1 if left else 128 + signal.SIGHUP)
        if open_:
            data = read_terminal(master, POLL)
            if data is None:
                pass
            elif not data:
                open_ = False
            else:
                quiet = None
                if run.out_ok:
                    try:
                        write_all(data)
                    except OutputGone:
                        run.out_ok = False
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
    return exit_code(child.returncode)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
