// R12 (the operator's order of 2026-10-25, 03:04 PT: "spend the night coding the timmy tui into rive and tldraw"): the Timmy
// app — Timmy's main UI as a tldraw board of cards with the Rive faces — bundled on this machine exactly as Timmy Canvas is
// (./build.mjs buildCanvas: tldraw, React and tldraw's own assets in one ES module, the tldraw license verbatim and a notice for
// every bundled package beside it), from companion/timmy-app/src/app.jsx into companion/timmy-app/dist. The companion serves it
// at /app (src/companion/timmy-app.ts); `timmy app` opens it.
//
//   npm run build:app          (npm run build runs it too)
//   node scripts/canvas/build-app.mjs --check [dir]    exit 1 when the build cannot ship (prepack runs it)
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CANVAS_DIR, buildCanvas, packageCheck } from './build.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export const APP_DIR = join('companion', 'timmy-app');

/** Build the Timmy app into `out` (default companion/timmy-app/dist); the license texts are Timmy Canvas's own. */
export function buildApp(root = repository, out = join(root, APP_DIR, 'dist')) {
  return buildCanvas(root, out, { licenses: join(root, CANVAS_DIR), entry: join(root, APP_DIR, 'src', 'app.jsx'), name: 'app', title: 'the Timmy app' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--check');
  if (at >= 0) {
    const missing = packageCheck(process.argv[at + 1] ? resolve(process.argv[at + 1]) : join(repository, APP_DIR, 'dist'));
    if (missing.length) {
      process.stderr.write(`timmy app: this build cannot ship in a package. Missing:\n${missing.map((m) => `  ${m}\n`).join('')}`);
      process.exit(1);
    }
    process.stdout.write('timmy app: the build carries every license it needs.\n');
    process.exit(0);
  }
  const started = Date.now();
  buildApp().then(({ versions, packages, distributable, missing }) => {
    process.stdout.write(`Timmy app built: tldraw ${versions.tldraw}, react ${versions.react}, ${packages.length} packages, ${Date.now() - started} ms (${join(APP_DIR, 'dist')})\n`);
    if (!distributable) process.stdout.write(`Not distributable yet (fine on this machine). Missing:\n${missing.map((m) => `  ${m}\n`).join('')}`);
  }).catch((error) => {
    process.stderr.write(`timmy app build: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
