// Non-TypeScript runtime dependencies that tsc does not emit. Keep this list
// explicit: runtime directories also contain local state and must not be copied.
import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNTIME_ASSETS = Object.freeze([
  'lanes/privacy/overlay.mjs',
  'lanes/privacy/scan.mjs',
  'lanes/privacy/patterns.json',
  'lanes/privacy/fixtures/must-fail.txt',
  'lanes/cockpit/cockpit.mjs',
  'lanes/cockpit/hands.example.json',
  'fleet/harness-menu.mjs',
  'schemas/agent-pass.cue',
  'schemas/context-cone.cue',
  'schemas/dispatch.cue',
  'schemas/escrow.cue',
  'schemas/mesh-asset.cue',
  'schemas/usd.cue',
  'lanes/recipes/enclosure-tray/recipe.json',
  'lanes/recipes/enclosure-tray/build.py',
  // R4 (H87): the pages the browser companion and `timmy logs` serve beside their code (COMPANION_RUNTIME_FILES in
  // src/companion/server.ts, LOGS_RUNTIME_FILES in src/utils/logserver.ts; tests/runtime-pages.test.ts keeps them here).
  // r23: without them the installed companion answered GET / with ENOENT and its path, and GET /chat crashed `timmy logs`.
  'src/companion/client/index.html',
  // R4 (H92): the companion page's own style sheet and script (they were inline, or from public CDNs). R4 (H97): its
  // markdown.js and chat.js, which H95's page replaced, are no longer shipped.
  'src/companion/client/companion.css',
  'src/companion/client/companion.js',
  // R6 lead: the tab panels' page code (the registry and each panel's own file; src/companion/panels.ts serves their data)
  'src/companion/client/panels.js',
  'src/companion/client/panel-studio.js',
  'src/companion/client/panel-vox.js',
  'src/companion/client/panel-tools.js',
  // R6 (H144): the Workflows tab's run detail (its source, changes, outputs and receipts)
  'src/companion/client/panel-run.js',
  // R7 (H153): tab 6's meshes and the view you can turn
  'src/companion/client/panel-create.js',
  // R8 (H155): tab 7's panes, read-only
  'src/companion/client/panel-control.js',
  // R10 CHAT (H171): the shell's left menu and the Chat composition
  'src/companion/client/chat-shell.js',
  'src/companion/client/chat-shell.css',
  'src/utils/chatpage.html',
  // R5: the OpenRouter catalog snapshot (dated), so an installed Timmy can say what a chat model costs before any
  // `timmy models --refresh` (src/models/registry.ts reads the Timmy home's fetched catalog first).
  'src/models/cache.json',
]);
const repository = fileURLToPath(new URL('../', import.meta.url));

export function copyRuntimeAssets(sourceRoot = repository, outputRoot = join(sourceRoot, 'dist')) {
  // Validate the complete allowlist before copying anything. Symlinks may point
  // to private data and are not distributable runtime source files.
  for (const asset of RUNTIME_ASSETS) {
    if (!lstatSync(join(sourceRoot, asset)).isFile()) throw new Error(`runtime asset must be a regular file: ${asset}`);
  }
  for (const asset of RUNTIME_ASSETS) {
    const output = join(outputRoot, asset);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(sourceRoot, asset), output);
  }
  return [...RUNTIME_ASSETS];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`copied ${copyRuntimeAssets().length} runtime assets`);
}
