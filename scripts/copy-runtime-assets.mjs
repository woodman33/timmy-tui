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
