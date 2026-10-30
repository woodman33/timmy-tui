/**
 * R13: the names of Timmy Animate's agent and MCP tools (src/agent/animate-tools.ts), with no import of their engine, so
 * the capability ladder (src/capabilities/index.ts) can name its row's tools cheaply. tests/miniapps-commands.test.ts pins
 * that these are exactly the tools' names.
 */
export const ANIMATE_TOOL_NAMES: readonly string[] = Object.freeze([
  'catalog', 'template', 'recipe', 'svg', 'lottie', 'after_effects', 'xstate', 'state_preview', 'path_preset', 'layer', 'motion_react', 'export',
].map((s) => `timmy_animate_${s}`));
