// The PTY tests drive Timmy as a person at a terminal would. A CI runner's own variables (CI=true and the
// like) must not reach the program under test: with them Timmy rightly runs in its CI mode (no live input
// row), which the tests check separately. Found when the gate job ran the new PTY tests on GitHub Actions.
import { CI_VARS } from '../../src/term/capabilities.js';

export function withoutCI(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const k of CI_VARS) delete copy[k];
  return copy;
}
