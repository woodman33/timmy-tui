/**
 * Test helpers for operations and `timmy act` (round R4, helper H51): a project in a temporary folder, a `timmy` on PATH
 * that is the real CLI (src/cli.ts through tsx, as tests/drop-cli.test.ts runs it), a Workspace over the project's own
 * receipt chain, and `timmy act` run as a real child process whose output can be waited on and which can be signalled.
 *
 * FAKE pieces, each labelled where a test uses them:
 * - tests/fixtures/fake-code-agent.mjs, a TEST DOUBLE code agent (no model, nothing sent), run as Qwen Code on a local
 *   endpoint (TIMMY_AGENT_QWEN_BIN, TIMMY_AGENT_MODEL);
 * - tests/fixtures/fake-openscad.mjs, a TEST DOUBLE of OpenSCAD with no geometry engine (a box sized by -D values);
 * - tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7's --ci behaviour (each block through sh -c).
 * Every folder is under os.tmpdir(); HOME and TIMMY_HOME are the sandbox's own, so nothing outside it is touched.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { folderProject } from '../../src/project/index.js';
import { Workspace } from '../../src/repl/workspace.js';
import { glyphSet } from '../../src/term/glyphs.js';
import { appendReceipt, readChain } from '../../src/utils/receipts.js';

export const REPO = path.resolve(__dirname, '..', '..');
export const FIXTURES = path.join(REPO, 'tests', 'fixtures');
export const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
export const CLI = path.join(REPO, 'src', 'cli.ts');
export const FAKE_AGENT = path.join(FIXTURES, 'fake-code-agent.mjs');
export const FAKE_UPMD = path.join(FIXTURES, 'fake-upmd.mjs');
export const FAKE_OPENSCAD = path.join(FIXTURES, 'fake-openscad.mjs');
export const SCAD_STARTER = path.join(REPO, 'templates', 'scad-starter');

export const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
export const json = (abs: string): Record<string, unknown> => JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
export const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export async function until(pred: () => boolean, ms = 30_000, what = 'a condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Temporary folders and workspaces, cleaned up by `cleanup()` (call it in afterEach). */
export function opsKit() {
  const dirs: string[] = [];
  const spaces: Workspace[] = [];
  const children: ChildProcess[] = [];
  return {
    dirs, spaces, children,
    cleanup: async (): Promise<void> => {
      for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      for (const w of spaces.splice(0)) await w.close();
      vi.unstubAllEnvs();
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}
export type OpsKit = ReturnType<typeof opsKit>;

export interface Sandbox {
  base: string;
  root: string;
  home: string;
  bin: string;
  /** the environment a `timmy act` child gets: the sandbox's PATH, HOME, TIMMY_HOME, receipt store and FAKE tools */
  env: NodeJS.ProcessEnv;
}

/** A project from the OpenSCAD starter (box.scad, box.params.json), a `timmy` on PATH that is the real CLI, and the FAKE tools. */
export function sandbox(kit: OpsKit, prefix = 'ops-'): Sandbox {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  kit.dirs.push(base);
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  for (const d of [root, home, bin]) fs.mkdirSync(d, { recursive: true });
  for (const f of ['box.scad', 'box.params.json']) fs.copyFileSync(path.join(SCAD_STARTER, f), path.join(root, f));
  fs.writeFileSync(path.join(bin, 'timmy'), `#!/bin/sh\nexec "${TSX}" "${CLI}" "$@"\n`, { mode: 0o755 });
  fs.copyFileSync(FAKE_OPENSCAD, path.join(bin, 'openscad'));
  fs.chmodSync(path.join(bin, 'openscad'), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    TIMMY_HOME: path.join(home, 'timmy'),
    // The project's own chain: the REPL's Workspace here and every `timmy act` seal on it.
    TIMMY_STORE: path.join(root, '.timmy', 'receipts'),
    TIMMY_AGENT_QWEN_BIN: FAKE_AGENT,
    TIMMY_AGENT_MODEL: 'qwen3:4b',
    TIMMY_OPENSCAD: path.join(bin, 'openscad'),
    NO_COLOR: '1',
  };
  delete env.TIMMY_OPERATION;
  return { base, root, home, bin, env };
}

/**
 * This process as the REPL of the sandbox: what its jobs inherit (the job manager passes this process's environment on)
 * is the sandbox's, and its Workspace seals on the project's own chain.
 */
export function replOf(kit: OpsKit, s: Sandbox): { ws: Workspace; notes: string[] } {
  for (const k of ['PATH', 'HOME', 'TIMMY_HOME', 'TIMMY_STORE', 'TIMMY_AGENT_QWEN_BIN', 'TIMMY_AGENT_MODEL', 'TIMMY_OPENSCAD', 'NO_COLOR'] as const) vi.stubEnv(k, s.env[k] ?? '');
  vi.stubEnv('TIMMY_OPERATION', '');
  const notes: string[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { ...process.env, UPMD_BIN: FAKE_UPMD },
    onPath: () => null,
    notify: (l) => notes.push(l.map((x) => x.text).join('')),
    openWeb: (u) => u,
    link: (t) => t,
    seal: (input) => appendReceipt('runs', input, s.root).hash.slice(7, 15),
    receipts: () => readChain('runs', s.root),
    // The jobs folder every Timmy of this HOME shares (as the REPL's and `timmy act`'s do: TIMMY_HOME/jobs).
    jobsDir: path.join(s.home, 'timmy', 'jobs'),
    chdir: () => {},
    recoverAtStart: false,
    roomTools: async () => [],
  }, folderProject(s.root));
  kit.spaces.push(ws);
  return { ws, notes };
}

export interface ActRun {
  child: ChildProcess;
  /** stdout and stderr so far */
  out(): string;
  stdout(): string;
  /** resolves once the output matches */
  waitFor(re: RegExp, ms?: number): Promise<RegExpExecArray>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
}

/** `timmy act <args>` as a real child process (the CLI through tsx), in `cwd` (the project by default). */
export function act(kit: OpsKit, s: Sandbox, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ActRun {
  const child = spawn(path.join(s.bin, 'timmy'), ['act', ...args], { cwd: o.cwd ?? s.root, env: o.env ?? s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  kit.children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const out = (): string => `${stdout}${stderr}`;
  return {
    child, out, stdout: () => stdout, done,
    waitFor: async (re, ms = 60_000) => {
      let m: RegExpExecArray | null = null;
      let ended = false;
      void done.then(() => { ended = true; });
      await until(() => { m = re.exec(out()); return !!m || ended; }, ms, `${re} in the output of timmy act ${args.join(' ')}`);
      if (!m) m = re.exec(out());
      if (!m) throw new Error(`timmy act ${args.join(' ')} ended without ${re}:\n${out()}`);
      return m;
    },
  };
}
