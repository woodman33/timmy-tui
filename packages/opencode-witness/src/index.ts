// The OpenCode-facing module. OpenCode 1.18.31 loads a plugin as a module whose function exports are
// Plugins: (input: PluginInput, options?) => Promise<Hooks>. Typed structurally on purpose — this package
// does not depend on @opencode-ai/plugin, so it installs, type-checks and tests with no network.
import { createWitness, type WitnessHooks } from './witness.js';

export const id = 'timmy-opencode-witness';

export type WitnessPluginInput = { directory: string; worktree: string };

export const TimmyOpenCodeWitness = async (_input: WitnessPluginInput): Promise<WitnessHooks> =>
  createWitness({ env: process.env });

export default { id, server: TimmyOpenCodeWitness };
