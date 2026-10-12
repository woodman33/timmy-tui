/**
 * R4 lead (2026-10-12; found by H115 reading the Pi lane for Pi Durable): a lane's one-shot command (src/utils/dispatch.ts
 * dispatchPlan) put the plan's objective into the pane's shell with only " escaped, so $(...), `...`, $VAR, \ and the
 * replacement patterns of String.replace ($&) in an objective (a dropped file's name, a page's request, a phrase) ran as shell
 * code or rewrote the command. laneCommand now makes the objective one shell word holding it exactly where the template
 * quotes it, and quoted words where the template takes words (paths and flags).
 *
 * Real: bash runs each command as the pane's shell would. The lane programs are stand-ins (printf), labelled.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LANE_RUNNERS } from '../src/agent/lanes.js';
import { laneCommand, shellWord } from '../src/utils/dispatch.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const bash = (cmd: string, cwd: string): string => execFileSync('bash', ['--norc', '--noprofile', '-c', cmd], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd } });

describe('a lane task reaches the shell as text, never as shell code (R4 lead)', () => {
  it('a quoted task ("{task}", a prompt): the objective arrives exactly, and nothing in it runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-quoting-'));
    dirs.push(dir);
    const objectives = [
      'fix the build $(touch made-by-dollar-paren)',
      'read `touch made-by-backticks` first',
      'print $HOME and ${PATH} and $1',
      'quotes " and \' and \\" and \\\\ backslashes',
      'a replacement pattern $& and $\' and $` and $$',
      'two lines\nsecond; touch made-by-semicolon',
    ];
    for (const objective of objectives) {
      // a stand-in lane program: printf prints its one argument
      const cmd = laneCommand('printf "%s" "{task}"', objective);
      expect(bash(cmd, dir)).toBe(objective);
    }
    expect(['made-by-dollar-paren', 'made-by-backticks', 'made-by-semicolon'].filter((f) => existsSync(join(dir, f)))).toEqual([]);
  });

  it('a task taken as words (paths and flags): each word quoted, none of it shell code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-quoting-'));
    dirs.push(dir);
    const cmd = laneCommand('printf "%s|" {task}', 'comps/intro.html --fps 30 $(touch made-by-words) ;touch made-by-semicolon');
    expect(bash(cmd, dir)).toBe('comps/intro.html|--fps|30|$(touch|made-by-words)|;touch|made-by-semicolon|');
    expect(existsSync(join(dir, 'made-by-words'))).toBe(false);
    expect(existsSync(join(dir, 'made-by-semicolon'))).toBe(false);
  });

  it('every lane\'s own template keeps its shape: a quoted task becomes one shell word; Pi\'s is pi -p \'<objective>\'', () => {
    expect(laneCommand(LANE_RUNNERS.pi.task!, 'say "hi" $(id)')).toBe(`pi -p 'say "hi" $(id)'`);
    for (const [id, r] of Object.entries(LANE_RUNNERS)) {
      if (!r.task) continue;
      const out = laneCommand(r.task, 'x $(id)');
      expect(out, id).not.toContain('{task}');
      expect(out, id).toContain(`'$(id)'`.slice(0, 1));
      expect(out.includes('"x $(id)"'), id).toBe(false);
    }
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
  });
});
