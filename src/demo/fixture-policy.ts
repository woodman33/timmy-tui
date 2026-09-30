import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Install an isolated, fully seeded demo policy; return the environment restore. */
export function installDemoPolicy(store: string): () => void {
  const inherited = process.env.TIMMY_POLICY_DIR;
  const root = resolve(store);
  const directory = join(root, '.timmy');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Prepare before selecting it: a setup failure must leave the caller's root intact.
  writeFileSync(join(directory, 'model-policy.json'), JSON.stringify({
    default: 'placeholder/auto', scopes: {},
  }, null, 2), { mode: 0o600 });
  process.env.TIMMY_POLICY_DIR = root;
  return () => {
    if (inherited === undefined) delete process.env.TIMMY_POLICY_DIR;
    else process.env.TIMMY_POLICY_DIR = inherited;
  };
}
