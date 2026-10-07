// The PTY tests drive Timmy as a person at a terminal would. A CI runner's own variables (CI=true and the
// like) must not reach the program under test: with them Timmy rightly runs in its CI mode (no live input
// row), which the tests check separately. Found when the gate job ran the new PTY tests on GitHub Actions.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CI_VARS } from '../../src/term/capabilities.js';

export function withoutCI(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const k of CI_VARS) delete copy[k];
  return copy;
}

// Fourth order, step 1: nor may the runner's own folders. XDG_CONFIG_HOME and its kin point Timmy's config
// store (and others) at the runner's folders, shared by every test on the machine.
const XDG_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

export function withoutRunner(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = withoutCI(env);
  for (const k of XDG_VARS) delete copy[k];
  return copy;
}

/** A terminal's environment with a home, Timmy home and store of its own inside `dir`. */
export function ptyEnv(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return { ...withoutRunner(process.env), HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_STORE: join(dir, 'store') };
}
