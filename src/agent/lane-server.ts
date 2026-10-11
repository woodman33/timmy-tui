/**
 * Where Timmy's lanes live, and what starting them runs (R4 H87).
 *
 * A lane is a multiplexer session in which one external agent program runs (src/agent/lanes.ts: opencode, hermes, pi,
 * openhands, jcode and minds in the six default sessions). They start only when the operator asks for them:
 * `timmy watch --lanes` (cli.tsx). The agent's own default is no multiplexer at all (src/agent/core.ts AgentOptions), so
 * the REPL, headless runs, the monitor without the flag and every other caller start no lane program and no session.
 * TIMMY_MULTIPLEXER picks which multiplexer runs the lanes once they are asked for (tmux unless it says zellij or rmux);
 * on its own it starts nothing.
 *
 * When asked, every lane session lives on a server of Timmy's own, never on the operator's: tmux and rmux on the socket
 * `-L timmy-lanes-<pid>` (the monitor's pid), started with `-f /dev/null` so the operator's configuration and its plugins
 * do not run there; zellij with a socket folder of its own (ZELLIJ_SOCKET_DIR). Cleanup acts only on that server and only on
 * the sessions this process made. They end when the monitor ends: its exit ends each session it made, and a watchdog on the
 * server ends the server once the monitor's pid is gone, so even a monitor that was killed leaves nothing running.
 *
 * Found on the Mac (r23b): `timmy watch` killed every `ortui-*` session on the operator's default tmux server, opened
 * ortui-1..6 there and typed each lane's startup script; six programs started about 3 s later, and one of them (jcode), on its
 * own first run, installed a LaunchAgent and loaded it into the operator's login session.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LANE_BINDINGS, LANE_RUNNERS } from './lanes.js';

/** Which multiplexer runs the lanes; 'none' starts no session and no program. */
export type LaneMultiplexer = 'tmux' | 'zellij' | 'rmux' | 'none';

/** The tmux (or rmux) socket of this process's lanes: `-L timmy-lanes-<pid>`. */
export const laneServerName = (pid: number = process.pid): string => `timmy-lanes-${pid}`;

/** The arguments that put a tmux (or rmux) command on this process's lane server, with no configuration of the operator's. */
export const laneServerArgs = (pid: number = process.pid): string[] => ['-L', laneServerName(pid), '-f', '/dev/null'];

/** A tmux command's arguments on this process's lane server: `execFileSync('tmux', laneTmux('capture-pane', '-pt', 'ortui-1'))`. */
export const laneTmux = (...args: string[]): string[] => [...laneServerArgs(), ...args];

/** The command a person types to watch a lane in a terminal of their own. */
export const laneAttachCommand = (id: string, bin = 'tmux'): string => `${bin} -L ${laneServerName()} attach -t ortui-${id}`;

const shellWord = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The watchdog, as a command on the lane server: in the background (`run-shell -b`) it waits for this process to be gone,
 * then ends that server (and with it every session there, all of them this process's own).
 */
export const laneWatchdog = (bin: string, pid: number = process.pid): string[] =>
  [...laneServerArgs(pid), 'run-shell', '-b', `while kill -0 ${pid} 2>/dev/null; do sleep 1; done; ${shellWord(bin)} -L ${laneServerName(pid)} kill-server`];

/** zellij's socket folder for this process's lanes (ZELLIJ_SOCKET_DIR), apart from the operator's own zellij sessions. */
export const zellijSocketDir = (pid: number = process.pid): string => join(tmpdir(), `timmy-zellij-${pid}`);

/** The multiplexer for the lanes: none unless the operator asked (`--lanes`); then TIMMY_MULTIPLEXER's zellij or rmux, else tmux. */
export function laneMultiplexer(asked: boolean, env: Record<string, string | undefined> = process.env): LaneMultiplexer {
  if (!asked) return 'none';
  const m = env.TIMMY_MULTIPLEXER?.trim();
  return m === 'zellij' || m === 'rmux' ? m : 'tmux';
}

/** The monitor's choice, carried on its agent configuration (cli.tsx sets `lanes`), as the agent's options. */
export function laneOptions(config: unknown): { multiplexer: LaneMultiplexer } {
  const m = (config as { lanes?: unknown } | null | undefined)?.lanes;
  return { multiplexer: m === 'tmux' || m === 'zellij' || m === 'rmux' ? m : 'none' };
}

/** The programs the default lanes start, by name, in session order. */
export function lanePrograms(): string[] {
  return Object.keys(DEFAULT_LANE_BINDINGS).sort((a, b) => Number(a) - Number(b))
    .map((id) => LANE_RUNNERS[DEFAULT_LANE_BINDINGS[id]]?.cmd)
    .filter((cmd): cmd is string => typeof cmd === 'string');
}

const listed = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Observed on the Mac (r23b): what a lane program's own first run did. */
export const LANE_HELPERS_WORDS = "a program's own first run may install its own background helpers (jcode's first run installed a macOS LaunchAgent and loaded it into the login session)";

/**
 * The one plain line wherever the monitor offers lanes: what starting them runs, each program by name, where, and what a
 * program may do on its own first run. With the lanes on, the same facts in the past tense.
 */
export function lanesWords(on: LaneMultiplexer, pid: number = process.pid): string {
  const programs = listed(lanePrograms());
  if (on === 'none') {
    return `Lanes are off. \`timmy watch --lanes\` starts them: it runs ${programs}, each in a tmux session on a tmux server of Timmy's own that ends with the monitor; ${LANE_HELPERS_WORDS}.`;
  }
  if (on === 'zellij') {
    return `Lanes are on (--lanes, zellij): one zellij session each, in a socket folder of Timmy's own (${zellijSocketDir(pid)}), ended with the monitor; zellij lanes start a shell and type no program. ${LANE_HELPERS_WORDS[0].toUpperCase()}${LANE_HELPERS_WORDS.slice(1)}.`;
  }
  return `Lanes are on (--lanes): ${programs} were started, each in a ${on} session on Timmy's own server (${on} -L ${laneServerName(pid)}), which ends with the monitor; ${LANE_HELPERS_WORDS}.`;
}

/** The `--lanes` option's help. */
export const LANES_OPTION_WORDS = `Start the lane programs (${listed(lanePrograms())}), each in a tmux session on a tmux server of Timmy's own that ends with the monitor (TIMMY_MULTIPLEXER=zellij or rmux picks another multiplexer); off by default. A program's own first run may install its own background helpers.`;
