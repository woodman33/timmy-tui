// Non-TypeScript runtime dependencies that tsc does not emit. Keep this list
// explicit: runtime directories also contain local state and must not be copied.
import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNTIME_ASSETS = Object.freeze([
  // A package declaration silently omits nonexistent files. Fail the build if a
  // vision execution asset is missing, before copying any runtime assets.
  'scripts/vision-bridge.py',
  'scripts/roboflow-bridge.py',
  'workers/look/look.py',
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
  // R11 round 4 (H171): the journey's shell (the three screens, window.TimmyShell)
  'src/companion/client/shell.js',
  // R11 round 4 (H171, step 3): the T mark's Rive source (a proposed mark; the .riv is placed beside them when built)
  'src/companion/assets/mark/scene.rml',
  'src/companion/assets/mark/rive.yaml',
  'src/companion/assets/mark/README.md',
  // R11 round 4 (H170): the Connections screen (src/companion/connections.ts serves its data)
  'src/companion/client/screen-connections.js',
  'src/companion/client/screen-connections.css',
  // R11 round 4 (H173): the account screen (Clerk, verified by the companion), its sheet, and the OAuth callback's token keeper
  'src/companion/client/account.js',
  'src/companion/client/account.css',
  'src/companion/client/account-callback.js',
  // R11 round 5 (H174): the Rive components' bindings, their sheet, the Inspect animation view, and each component's editable
  // source (src/companion/assets/rive/<component>/: scene.rml, rive.yaml, README.md; a .riv beside them only when received)
  'src/companion/client/rive-bindings.js',
  'src/companion/client/rive-components.css',
  'src/companion/client/screen-inspect-animation.js',
  'src/companion/assets/rive/welcome/scene.rml',
  'src/companion/assets/rive/welcome/rive.yaml',
  'src/companion/assets/rive/welcome/README.md',
  'src/companion/assets/rive/connection/scene.rml',
  'src/companion/assets/rive/connection/rive.yaml',
  'src/companion/assets/rive/connection/README.md',
  'src/companion/assets/rive/activity/scene.rml',
  'src/companion/assets/rive/activity/rive.yaml',
  'src/companion/assets/rive/activity/README.md',
  // R11 round 5 (H174): the operator's native Rive UI asset (one state machine TimmyUI on three artboards) and its editable
  // source beside it, the font with its license (OFL)
  'src/companion/assets/rive/timmy-ui/timmy-ui.riv',
  'src/companion/assets/rive/timmy-ui/scene.rml',
  'src/companion/assets/rive/timmy-ui/rive.yaml',
  'src/companion/assets/rive/timmy-ui/create-controls.py',
  'src/companion/assets/rive/timmy-ui/README.md',
  'src/companion/assets/rive/timmy-ui/Montserrat.ttf',
  'src/companion/assets/rive/timmy-ui/OFL.txt',
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
