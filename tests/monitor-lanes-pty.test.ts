// R4 (H87): the monitor (`timmy watch`, cli.tsx) starts no lane program and no tmux session unless the operator asks for
// them (`timmy watch --lanes`). Found on the Mac (r23b): on `timmy watch` in a sandbox, the monitor's agent killed every
// `ortui-*` session on the operator's default tmux server, opened ortui-1..6 there and typed each lane's startup script,
// which started six external agent programs about 3 s later; one of them, on its own first run, installed a LaunchAgent.
//
// Every program here is a FAKE: a stub script on PATH named like a lane program (opencode, hermes, pi, openhands, jcode,
// minds) that writes one line and its pid, then sleeps. tmux is the real tmux, on servers in this test's own folder
// (TMUX_TMPDIR): "default" stands for the operator's default server, holding a session of its own (ortui-keep), and the
// monitor runs with TMUX unset, as from a terminal outside tmux. Nothing touches a server outside the test's folder.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOADER, MONITOR, argsOf, monitorHome, type HomeKind, type MonitorHome } from './fixtures/ui-monitor-home.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LANE_PROGRAMS = ['opencode', 'hermes', 'pi', 'openhands', 'jcode', 'minds'];

interface Rig { h: MonitorHome; marks: string; sockets: string; script(extra: string): string }

function rig(kind: HomeKind): Rig {
  const h = monitorHome(kind, { git: true });
  const bin = join(h.box, 'fakebin');
  const marks = join(h.box, 'marks');
  mkdirSync(bin);
  mkdirSync(marks);
  for (const name of LANE_PROGRAMS) {
    // FAKE lane program: says it ran (with its pid, whose command line becomes `sleep 600`), then waits to be ended.
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $$" >> '${marks}/ran.log'\nexec sleep 600\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // The "default" server of this test's folder, with a session of the operator's own whose name looks like a lane's.
  execFileSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', 'ortui-keep', '-x', '80', '-y', '24'], { env: h.env });
  const sockets = join(h.box, `tmux-${process.getuid!()}`);
  // The monitor from a terminal outside tmux (TMUX unset), with the FAKE programs first on PATH.
  const script = (extra: string): string => `env -u TMUX PATH='${bin}':"$PATH" ${process.execPath} --import ${LOADER} ${MONITOR} --no-companion${extra}; echo EXIT=$?; sleep 60`;
  return { h, marks, sockets, script };
}

/** The sessions on the server at this socket, or null when no server answers there. */
function sessionsAt(h: MonitorHome, socket: string): string[] | null {
  try {
    return execFileSync('tmux', ['-S', socket, 'list-sessions', '-F', '#S'], { env: h.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).sort();
  } catch { return null; }
}

/** Every tmux server in the test's folder that answers, with its sessions. */
function servers(r: Rig): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of existsSync(r.sockets) ? readdirSync(r.sockets) : []) {
    const s = sessionsAt(r.h, join(r.sockets, name));
    if (s) out[name] = s;
  }
  return out;
}

const ran = (r: Rig): Array<{ name: string; pid: number }> => {
  const file = join(r.marks, 'ran.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const [name, pid] = l.split(' '); return { name, pid: Number(pid) }; });
};

/** Ends what the test made: every server in its folder (the fixture ends its own pty server) and any FAKE program still running (only its own pids). */
async function teardown(r: Rig): Promise<void> {
  for (const p of ran(r)) if (argsOf(p.pid) === 'sleep 600') { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const name of existsSync(r.sockets) ? readdirSync(r.sockets) : []) {
    if (name === 'pty') continue;
    try { execFileSync('tmux', ['-S', join(r.sockets, name), 'kill-server'], { env: r.h.env, stdio: 'ignore' }); } catch { /* none */ }
  }
  await r.h.dispose();
}

/** Waits for the FAKE lane programs to have started, then reads this monitor's own lane server from the test's folder. */
async function lanesUp(r: Rig): Promise<{ own: string; pid: number }> {
  for (const end = Date.now() + 30_000; ran(r).length < LANE_PROGRAMS.length && Date.now() < end;) await sleep(200);
  const own = Object.keys(servers(r)).filter((n) => n.startsWith('timmy-lanes-'));
  expect(own.length).toBe(1);
  return { own: own[0], pid: Number(own[0].slice('timmy-lanes-'.length)) };
}

describe('the monitor and lane programs (R4 H87)', () => {
  it('without --lanes, a first-run monitor starts no lane program, makes no tmux session anywhere, and leaves the operator\'s ortui-keep alone', async () => {
    const r = rig('first-run');
    try {
      r.h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '30', '-c', r.h.repo, 'bash', '--norc', '-c', r.script(''));
      await r.h.waitFor(/TIMMY · FIRST RUN/);
      // the old monitor's lane scripts slept 3 s before starting each program: wait well past that
      await sleep(7000);
      expect({ programs: ran(r).map((p) => p.name), servers: servers(r) }).toEqual({
        programs: [],
        servers: { default: ['ortui-keep'], pty: ['t'] },
      });
    } finally {
      await teardown(r);
    }
  }, 120_000);

  it('with --lanes, the lanes live on a tmux server of Timmy\'s own, their programs start, and all of it ends with the monitor', async () => {
    const r = rig('initialized');
    try {
      r.h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '120', '-y', '40', '-c', r.h.repo, 'bash', '--norc', '-c', r.script(' --lanes'));
      await r.h.waitFor(/YOUR JOURNEY/);
      for (const end = Date.now() + 30_000; ran(r).length < LANE_PROGRAMS.length && Date.now() < end;) await sleep(200);
      const during = servers(r);
      const own = Object.keys(during).filter((n) => n.startsWith('timmy-lanes-'));
      expect({ programs: ran(r).map((p) => p.name).sort(), own: own.length, default: during.default, pty: during.pty })
        .toEqual({ programs: [...LANE_PROGRAMS].sort(), own: 1, default: ['ortui-keep'], pty: ['t'] });
      expect(during[own[0]]).toEqual(['ortui-1', 'ortui-2', 'ortui-3', 'ortui-4', 'ortui-5', 'ortui-6']);
      // the server is this monitor's: its name carries the monitor's pid
      const pid = Number(own[0].slice('timmy-lanes-'.length));
      expect(argsOf(pid)).toContain(MONITOR);
      r.h.tmux('send-keys', '-t', 't', 'C-c');
      const exit = Number((await r.h.waitFor(/EXIT=(\d+)/, 20_000))[1]);
      await sleep(500);
      expect({ exit, servers: servers(r), still: ran(r).filter((p) => argsOf(p.pid) === 'sleep 600').map((p) => p.name) })
        .toEqual({ exit: 130, servers: { default: ['ortui-keep'], pty: ['t'] }, still: [] });
    } finally {
      await teardown(r);
    }
  }, 150_000);

  it('with --lanes, a monitor killed outright (SIGKILL: no exit handler runs) still leaves no lane server and no lane program behind', async () => {
    const r = rig('initialized');
    try {
      r.h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '120', '-y', '40', '-c', r.h.repo, 'bash', '--norc', '-c', r.script(' --lanes'));
      await r.h.waitFor(/YOUR JOURNEY/);
      const { own, pid } = await lanesUp(r);
      expect(argsOf(pid)).toContain(MONITOR);
      process.kill(pid, 'SIGKILL');
      // the watchdog on the lane server checks every second
      for (const end = Date.now() + 15_000; (servers(r)[own] || ran(r).some((p) => argsOf(p.pid) === 'sleep 600')) && Date.now() < end;) await sleep(250);
      expect({ servers: servers(r), still: ran(r).filter((p) => argsOf(p.pid) === 'sleep 600').map((p) => p.name) })
        .toEqual({ servers: { default: ['ortui-keep'], pty: ['t'] }, still: [] });
    } finally {
      await teardown(r);
    }
  }, 150_000);
});
