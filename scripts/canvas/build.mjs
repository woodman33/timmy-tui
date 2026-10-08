// Timmy Canvas, bundled on this machine (fourth order, step 5). The page's code
// (companion/studio-canvas/src/canvas.js), tldraw and React go into one ES module, and tldraw's own
// fonts, icons, translations and embed icons are copied beside it, so the canvas loads nothing from
// another host. tldraw and React are pinned in package.json as build-time devDependencies; this
// build is the only place they are read. Beside the code it writes the licenses that cover it: the
// tldraw license, verbatim (it asks for a copy in any distribution), and a notice for every package
// in the bundle, from that package's own license file. A build without those texts still runs on
// this machine, but it is marked not distributable, and the package check refuses it.
//
//   npm run build:canvas        (npm run build runs it too)
//   node scripts/canvas/build.mjs --check [dir]    exit 1 when the build cannot ship (prepack runs it)
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export const CANVAS_DIR = join('companion', 'studio-canvas');
/** tldraw's own assets, copied as they are from @tldraw/assets. */
export const ASSET_FOLDERS = ['fonts', 'icons', 'translations', 'embed-icons'];
/**
 * The tldraw license at its v5.5.2 tag, known by its hash: the npm package's own LICENSE.md is one
 * line pointing to it, and a package that carries tldraw must carry this text verbatim.
 */
export const TLDRAW_LICENSE_SHA256 = '9578fcddc20e404b6a29f44b6fea81d8b331698c0e7e9be34132d6f4394fa533';
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

/** The package a bundled file comes from: the innermost node_modules/<name> (or <@scope/name>) in its path. */
function packageDirOf(input) {
  const parts = input.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return null;
  const width = parts[at + 1]?.startsWith('@') ? 2 : 1;
  return parts.slice(0, at + 1 + width).join('/');
}

/** Where a license text is kept for a bundled package that ships none: `licenses/<name>.LICENSE` (a scope's slash as `__`). */
const keptLicenseName = (name) => join('licenses', `${name.replace('/', '__')}.LICENSE`);

/** One entry per bundled package: its name, version, declared license and the license file it carries. */
function bundledPackages(root, metafile, licenses) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(dir);
  }
  return [...dirs].map((dir) => {
    const pkg = readJson(join(root, dir, 'package.json'));
    const own = readdirSync(join(root, dir)).find((f) => LICENSE_FILE.test(f));
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN';
    const kept = join(licenses, keptLicenseName(pkg.name));
    const licenseFile = own ? join(root, dir, own) : existsSync(kept) ? kept : null;
    return { name: pkg.name, version: pkg.version, license, licenseFile, fromRepository: !own && licenseFile !== null, dir };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function notices(root, packages) {
  const out = [
    '# Third-party notices for Timmy Canvas',
    '',
    'Timmy Canvas (dist/canvas.js and dist/canvas.css) bundles the packages below. Each section is the',
    "package's own license file, as it ships in the package. tldraw's packages point to the tldraw",
    'license, whose full text is LICENSE-tldraw.md beside this file.',
    '',
  ];
  for (const p of packages) {
    out.push(`## ${p.name} ${p.version}`, '', `License: ${p.license}`, '');
    if (p.fromRepository) out.push("(The package ships no license file; this one is from the package's repository.)", '');
    out.push(p.licenseFile ? readFileSync(p.licenseFile, 'utf8').trim() : '(no license text found: see "missing" in versions.json)', '');
  }
  return `${out.join('\n')}\n`;
}

/**
 * Build Timmy Canvas into `out` (default companion/studio-canvas/dist). Stops before writing anything
 * when the installed tldraw is not the one Timmy pins, or React and react-dom differ (React refuses
 * to run that way). License texts are read from `licenses` (default companion/studio-canvas): the
 * verbatim tldraw license as LICENSE-tldraw.md, and licenses/<name>.LICENSE for a bundled package
 * that ships none. Without them the build is not distributable, and `missing` says why. The license
 * key is never read here: the server hands it to the page at run time.
 */
export async function buildCanvas(root = repository, out = join(root, CANVAS_DIR, 'dist'), { licenses = join(root, CANVAS_DIR) } = {}) {
  const modules = join(root, 'node_modules');
  const versions = {
    tldraw: readJson(join(modules, 'tldraw', 'package.json')).version,
    assets: readJson(join(modules, '@tldraw', 'assets', 'package.json')).version,
    react: readJson(join(modules, 'react', 'package.json')).version,
    reactDom: readJson(join(modules, 'react-dom', 'package.json')).version,
  };
  const pinned = /export const TLDRAW_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'src', 'studio', 'config.ts'), 'utf8'))?.[1];
  if (versions.tldraw !== pinned || versions.assets !== pinned) {
    throw new Error(`Timmy pins tldraw ${pinned}, but tldraw ${versions.tldraw} and @tldraw/assets ${versions.assets} are installed. Run npm install.`);
  }
  if (versions.react !== versions.reactDom) {
    throw new Error(`react ${versions.react} and react-dom ${versions.reactDom} must be the same version for the canvas.`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: { canvas: join(root, CANVAS_DIR, 'src', 'canvas.js') },
    outdir: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'error',
    // React's production build. tldraw still treats http://127.0.0.1 as development (no tracking,
    // every feature), by its own check of the page's address.
    define: { 'process.env.NODE_ENV': '"production"', __TLDRAW_VERSION__: JSON.stringify(versions.tldraw) },
  });
  for (const folder of ASSET_FOLDERS) cpSync(join(modules, '@tldraw', 'assets', folder), join(out, 'assets', folder), { recursive: true });
  const packages = bundledPackages(root, result.metafile, licenses);
  const missing = [];
  const tldrawLicense = join(licenses, 'LICENSE-tldraw.md');
  if (!existsSync(tldrawLicense)) missing.push('LICENSE-tldraw.md: the tldraw license, verbatim from the v5.5.2 tag (it asks for a copy in any distribution)');
  else if (sha256(tldrawLicense) !== TLDRAW_LICENSE_SHA256) missing.push(`LICENSE-tldraw.md: not the verbatim v5.5.2 text (sha256 must be ${TLDRAW_LICENSE_SHA256})`);
  else cpSync(tldrawLicense, join(out, 'LICENSE-tldraw.md'));
  for (const p of packages) {
    if (p.licenseFile === null) missing.push(`${keptLicenseName(p.name)}: ${p.name} ${p.version} ships no license file; its repository's, verbatim`);
  }
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), notices(root, packages));
  const listed = packages.map(({ dir, licenseFile, ...p }) => ({ ...p, licenseFile: licenseFile && licenseFile.slice(licenseFile.lastIndexOf('/') + 1) }));
  const distributable = missing.length === 0;
  writeFileSync(join(out, 'versions.json'), `${JSON.stringify({ ...versions, distributable, missing, packages: listed }, null, 2)}\n`);
  return { versions, packages: listed, distributable, missing };
}

/** What a built canvas in `dir` lacks before it can ship in a package (empty when it can). */
export function packageCheck(dir = join(repository, CANVAS_DIR, 'dist')) {
  const file = join(dir, 'versions.json');
  if (!existsSync(file)) return [`${file}: no canvas build here; run npm run build:canvas`];
  const built = readJson(file);
  return built.distributable === true ? [] : built.missing ?? ['the build does not say it is distributable'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--check');
  if (at >= 0) {
    const missing = packageCheck(process.argv[at + 1] ? resolve(process.argv[at + 1]) : undefined);
    if (missing.length) {
      process.stderr.write(`timmy canvas: this build cannot ship in a package. Missing:\n${missing.map((m) => `  ${m}\n`).join('')}`);
      process.exit(1);
    }
    process.stdout.write('timmy canvas: the build carries every license it needs.\n');
    process.exit(0);
  }
  const started = Date.now();
  buildCanvas().then(({ versions, packages, distributable, missing }) => {
    process.stdout.write(`Timmy Canvas built: tldraw ${versions.tldraw}, react ${versions.react}, ${packages.length} packages, ${Date.now() - started} ms (${join(CANVAS_DIR, 'dist')})\n`);
    if (!distributable) process.stdout.write(`Not distributable yet (fine on this machine). Missing:\n${missing.map((m) => `  ${m}\n`).join('')}`);
  }).catch((error) => {
    process.stderr.write(`timmy canvas build: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
