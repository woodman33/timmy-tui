// The browser companion's web code, built on this machine (round R4, H95). The companion's STREAMDOWN CHAT tab and the
// `timmy logs` chat mirror draw markdown with Streamdown, as the companion's page did at b69ab12, but nothing is loaded
// from a CDN: React, Streamdown 2.5.0, @streamdown/code 1.1.1 (Shiki with its JavaScript regex engine) and
// @streamdown/mermaid 1.0.2 (Mermaid) are bundled here with esbuild, split where they load parts lazily (Shiki's grammars
// and themes, Mermaid's diagrams, Streamdown's highlighted code); Streamdown's own styles.css is copied as it is; the
// Tailwind classes Streamdown emits are precompiled with tailwindcss 3.4.19 as the page configured the Play CDN (preflight
// off, darkMode 'class'); and the three fonts the page used from Google Fonts are copied from @fontsource-variable (the
// latin variable files only), each with its OFL-1.1 licence beside it. All of these are exact devDependencies: this build
// is the only place they are read, and nothing is added to what a person installs.
//
// The output, dist/companion-web/ (never committed: dist/ is ignored; package.json "files" ships dist):
//   island/companion-chat.js, island/logs-chat.js, island/chunks/*.js   the two entry modules and their shared chunks
//   styles/tailwind.css                  Tailwind 3.4.19's output for the classes Streamdown and the page use
//   styles/streamdown.css                streamdown/styles.css, verbatim
//   fonts/<family>-latin-wght-normal.woff2, fonts/<family>-LICENSE.txt
//   THIRD-PARTY-NOTICES.md               each bundled package's own licence file
//   versions.json                        the versions built, the inputs' hash, and whether the build can ship
//
// The companion and the log companion serve it at /web/... (src/companion/page.ts). The package build runs it
// (npm run build); a source checkout builds it when it is missing or stale (ensureCompanionWeb: the companion server run
// from source, and the tests that need it), one builder at a time.
//
//   node scripts/companion-web-build.mjs           build (always)
//   node scripts/companion-web-build.mjs --ship    build, then exit 1 unless it can ship (npm run build: the package build)
//   node scripts/companion-web-build.mjs --ensure  build only when missing or stale
//   node scripts/companion-web-build.mjs --check [dir]   exit 1 when the build cannot ship
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
/** Package-relative: where the build goes (dist/ ships in the package; it is never committed). */
export const WEB_DIR = join('dist', 'companion-web');
/** The two entry modules (src/companion/island). */
export const ENTRIES = Object.freeze({ 'companion-chat': 'src/companion/island/companion-chat.js', 'logs-chat': 'src/companion/island/logs-chat.js' });
/** The packages this build reads, at the exact versions package.json pins (a mismatch stops the build before it writes). */
export const PINNED = Object.freeze(['streamdown', '@streamdown/code', '@streamdown/mermaid', 'tailwindcss', 'esbuild', 'react-dom', '@fontsource-variable/outfit', '@fontsource-variable/inter', '@fontsource-variable/fira-code']);
/** The fonts the page used from Google Fonts, by the names its style sheet gives them; the latin variable file of each. */
export const FONTS = Object.freeze([
  { family: 'Outfit', pkg: '@fontsource-variable/outfit', file: 'outfit-latin-wght-normal.woff2', licence: 'outfit-LICENSE.txt' },
  { family: 'Inter', pkg: '@fontsource-variable/inter', file: 'inter-latin-wght-normal.woff2', licence: 'inter-LICENSE.txt' },
  { family: 'Fira Code', pkg: '@fontsource-variable/fira-code', file: 'fira-code-latin-wght-normal.woff2', licence: 'fira-code-LICENSE.txt' },
]);
/** What the Play CDN was told on the page at b69ab12 (`tailwind.config = { darkMode: 'class', corePlugins: { preflight: false } }`). */
export const TAILWIND_CONFIG = Object.freeze({ darkMode: 'class', corePlugins: { preflight: false } });
/** The Play CDN's own input: every layer; preflight is off, so the base layer is only Tailwind's variable defaults. */
const TAILWIND_INPUT = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

/** The installed version of a package in `root`'s node_modules, or null. */
function installed(root, name) {
  try { return readJson(join(root, 'node_modules', name, 'package.json')).version; } catch { return null; }
}

/** Every file the build reads besides node_modules: the islands, this script, and the page files Tailwind looks through. */
function sourceFiles(root) {
  const island = join(root, 'src', 'companion', 'island');
  const files = readdirSync(island).filter((f) => f.endsWith('.js')).map((f) => join(island, f));
  files.push(fileURLToPath(import.meta.url));
  for (const f of ['src/companion/client/index.html', 'src/companion/client/companion.js']) files.push(join(root, f));
  return files.sort();
}

/** The hash of what a build is made from: its sources and every package version it reads. A different hash means stale. */
export function inputsHash(root = repository) {
  const h = createHash('sha256');
  for (const f of sourceFiles(root)) h.update(`${relative(root, f)}\0`).update(readFileSync(f)).update('\0');
  for (const name of [...PINNED, 'react', 'mermaid', 'shiki', 'marked', 'postcss']) h.update(`${name}@${installed(root, name)}\0`);
  return h.digest('hex');
}

/** What stops a build: a pinned package not installed at the version package.json gives, or react and react-dom apart. */
export function versionProblems(root = repository) {
  const manifest = readJson(join(root, 'package.json'));
  const pins = { ...manifest.dependencies, ...manifest.devDependencies };
  const problems = [];
  for (const name of PINNED) {
    const want = pins[name];
    const have = installed(root, name);
    if (!want) problems.push(`${name} is not in package.json`);
    else if (have !== want) problems.push(`${name}: package.json pins ${want}, ${have ?? 'nothing'} is installed`);
  }
  const react = installed(root, 'react');
  if (react !== installed(root, 'react-dom')) problems.push(`react ${react} and react-dom ${installed(root, 'react-dom')} must be the same version`);
  return problems;
}

/** The package a bundled file comes from: the innermost node_modules/<name> (or <@scope/name>) in its path. */
function packageDirOf(input) {
  const parts = input.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return null;
  const width = parts[at + 1]?.startsWith('@') ? 2 : 1;
  return parts.slice(0, at + 1 + width).join('/');
}

/**
 * A package that ships no licence file may state its licence in its README (fastdom 1.0.12, a dependency of Mermaid, does:
 * its "## License" section holds the MIT text and its copyright). That section, as it ships, or null.
 */
function readmeLicence(dir) {
  const readme = readdirSync(dir).find((f) => /^readme(\.(md|markdown|txt))?$/i.test(f));
  if (!readme) return null;
  const lines = readFileSync(join(dir, readme), 'utf8').split('\n');
  const at = lines.findIndex((l) => /^#{1,4}\s*licen[cs]e\s*$/i.test(l.trim()));
  if (at < 0) return null;
  const level = /^#+/.exec(lines[at].trim())[0].length;
  const end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l.trim()) && /^#+/.exec(l.trim())[0].length <= level);
  const text = lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim();
  return /permission|licen[cs]e/i.test(text) ? text : null;
}

/** One entry per bundled package: its name, version, declared licence and the licence text it carries (null when none). */
function bundledPackages(root, metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(dir);
  }
  return [...dirs].map((dir) => {
    const pkg = readJson(join(root, dir, 'package.json'));
    const own = readdirSync(join(root, dir)).find((f) => LICENSE_FILE.test(f));
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN';
    const fromReadme = own ? null : readmeLicence(join(root, dir));
    return {
      name: pkg.name, version: pkg.version, license,
      licenseFile: own ? join(root, dir, own) : null,
      licenseText: own ? readFileSync(join(root, dir, own), 'utf8').trim() : fromReadme,
      licenseFrom: own ? own : fromReadme ? 'README' : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function notices(packages, fonts) {
  const out = [
    '# Third-party notices for the companion\'s web code',
    '',
    'island/*.js bundles the packages below (the browser companion\'s STREAMDOWN CHAT tab and the `timmy logs` chat mirror);',
    'styles/streamdown.css is streamdown\'s styles.css as it ships; styles/tailwind.css is generated by tailwindcss; the',
    'fonts in fonts/ are under the SIL Open Font License 1.1, each licence beside its font. Each section below is the',
    'package\'s own licence file, as it ships in the package.',
    '',
  ];
  for (const p of packages) {
    out.push(`## ${p.name} ${p.version}`, '', `License: ${p.license}`, '');
    if (p.licenseText && !p.licenseFile) out.push(`(From the package's ${p.licenseFrom}, its License section: the package ships no licence file.)`, '');
    out.push(p.licenseText ?? '(the package ships no licence text: see "missing" in versions.json)', '');
  }
  for (const f of fonts) out.push(`## ${f.pkg} ${f.version} (${f.family})`, '', `License: ${f.license}`, '', `The licence text is fonts/${f.licence}.`, '');
  return `${out.join('\n')}\n`;
}

/** Shiki's WebAssembly engine is left out: @streamdown/code uses Shiki's JavaScript regex engine (no WebAssembly here). */
const noWasm = {
  name: 'timmy-no-wasm',
  setup(b) {
    b.onResolve({ filter: /^(shiki\/wasm|@shikijs\/engine-oniguruma\/wasm-inlined)$/ }, (args) => ({ path: args.path, namespace: 'timmy-left-out' }));
    b.onLoad({ filter: /.*/, namespace: 'timmy-left-out' }, () => ({
      contents: 'throw new Error("Shiki\'s WebAssembly engine is not part of the companion\'s build: its code highlighting uses the JavaScript engine.");',
      loader: 'js',
    }));
  },
};

/** Every file under `dir`, as paths relative to it. */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}

/**
 * Build the companion's web code into `out` (default dist/companion-web). Stops before writing anything when a pinned
 * package is not installed at its pinned version. Returns what versions.json records.
 */
export async function buildCompanionWeb(root = repository, out = join(root, WEB_DIR)) {
  const problems = versionProblems(root);
  if (problems.length) throw new Error(`the companion's web code cannot be built here: ${problems.join('; ')}. Run npm install.`);
  const hash = inputsHash(root);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'styles'), { recursive: true });
  mkdirSync(join(out, 'fonts'), { recursive: true });
  const started = Date.now();
  const result = await build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([k, v]) => [k, join(root, v)])),
    outdir: join(out, 'island'),
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [noWasm],
  });
  const modules = join(root, 'node_modules');
  // Tailwind, as the Play CDN compiled it: every class Streamdown's code, its plugins and the page's own files carry
  const content = [
    join(modules, 'streamdown', 'dist', '*.js'),
    join(modules, '@streamdown', 'code', 'dist', '*.js'),
    join(modules, '@streamdown', 'mermaid', 'dist', '*.js'),
    join(root, 'src', 'companion', 'island', '*.js'),
    join(root, 'src', 'companion', 'client', 'index.html'),
    join(root, 'src', 'companion', 'client', 'companion.js'),
  ];
  const css = await postcss([tailwindcss({ ...TAILWIND_CONFIG, content })]).process(TAILWIND_INPUT, { from: undefined });
  writeFileSync(join(out, 'styles', 'tailwind.css'), `/* tailwindcss ${installed(root, 'tailwindcss')}, configured as the Play CDN was on the companion's page (darkMode 'class', preflight off); generated by scripts/companion-web-build.mjs */\n${css.css}`);
  copyFileSync(join(modules, 'streamdown', 'styles.css'), join(out, 'styles', 'streamdown.css'));
  const fonts = FONTS.map((f) => {
    const dir = join(modules, ...f.pkg.split('/'));
    copyFileSync(join(dir, 'files', f.file), join(out, 'fonts', f.file));
    copyFileSync(join(dir, 'LICENSE'), join(out, 'fonts', f.licence));
    const pkg = readJson(join(dir, 'package.json'));
    return { ...f, version: pkg.version, license: pkg.license };
  });
  const packages = bundledPackages(root, result.metafile);
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), notices(packages, fonts));
  const missing = [];
  for (const p of packages) if (!p.licenseText) missing.push(`${p.name} ${p.version} ships no licence text`);
  for (const f of fonts) if (f.license !== 'OFL-1.1') missing.push(`${f.pkg}: its licence is ${f.license}, not OFL-1.1`);
  const files = walk(out);
  const bytes = files.reduce((n, f) => n + statSync(join(out, f)).size, 0);
  const versions = {
    streamdown: installed(root, 'streamdown'), code: installed(root, '@streamdown/code'), mermaidPlugin: installed(root, '@streamdown/mermaid'),
    mermaid: installed(root, 'mermaid'), shiki: installed(root, 'shiki'), react: installed(root, 'react'), reactDom: installed(root, 'react-dom'),
    tailwindcss: installed(root, 'tailwindcss'), esbuild: installed(root, 'esbuild'),
  };
  const record = {
    built: new Date().toISOString(), ms: Date.now() - started, inputs: hash, versions,
    fonts: fonts.map(({ family, pkg, version, file, licence, license }) => ({ family, pkg, version, file, licence, license })),
    entries: Object.keys(ENTRIES).map((e) => `island/${e}.js`), files: files.length + 1, bytes,
    distributable: missing.length === 0, missing,
    packages: packages.map(({ licenseFile, licenseText, ...p }) => ({ ...p, licenseFile: licenseFile && licenseFile.slice(licenseFile.lastIndexOf('/') + 1) })),
  };
  writeFileSync(join(out, 'versions.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** The record of a build in `dir`, or null when there is none (or it cannot be read). */
export function builtRecord(dir = join(repository, WEB_DIR)) {
  try { return readJson(join(dir, 'versions.json')); } catch { return null; }
}

/** Whether `dir` holds a whole build made from these inputs. */
export function isFresh(root = repository, dir = join(root, WEB_DIR)) {
  const record = builtRecord(dir);
  return Boolean(record && record.inputs === inputsHash(root) && record.entries?.every((e) => existsSync(join(dir, e))));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build into `out` only when it is missing or stale (a source checkout, and the tests), one builder at a time: a lock
 * folder beside it (a lock older than ten minutes is a crashed builder's, and is taken over); the build goes into a
 * folder of its own and replaces `out` when it is whole. Resolves to { built, record }.
 */
export async function ensureCompanionWeb({ root = repository, out = join(root, WEB_DIR), waitMs = 600_000 } = {}) {
  if (isFresh(root, out)) return { built: false, record: builtRecord(out) };
  const lock = `${out}.lock`;
  mkdirSync(join(out, '..'), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 600_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error('another build of the companion\'s web code is still running; try again when it ends');
      await sleep(250);
      if (isFresh(root, out)) return { built: false, record: builtRecord(out) };
    }
  }
  try {
    if (isFresh(root, out)) return { built: false, record: builtRecord(out) };
    const tmp = `${out}.tmp-${process.pid}-${Date.now()}`;
    try {
      const record = await buildCompanionWeb(root, tmp);
      rmSync(out, { recursive: true, force: true });
      renameSync(tmp, out);
      return { built: true, record };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** What a build in `dir` lacks before it can ship in a package (empty when it can). */
export function packageCheck(dir = join(repository, WEB_DIR)) {
  const record = builtRecord(dir);
  if (!record) return [`${dir}: no build of the companion's web code here; run npm run build`];
  const absent = (record.entries ?? []).filter((e) => !existsSync(join(dir, e)));
  if (absent.length) return absent.map((e) => `${e} is missing`);
  return record.distributable === true ? [] : record.missing ?? ['the build does not say it can ship'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--check');
  if (at >= 0) {
    const missing = packageCheck(process.argv[at + 1] ? resolve(process.argv[at + 1]) : undefined);
    if (missing.length) {
      process.stderr.write(`timmy companion web: this build cannot ship in a package:\n${missing.map((m) => `  ${m}\n`).join('')}`);
      process.exit(1);
    }
    process.stdout.write('timmy companion web: the build is whole and carries every licence it needs.\n');
    process.exit(0);
  }
  const run = process.argv.includes('--ensure') ? ensureCompanionWeb().then((r) => ({ ...r.record, skipped: !r.built })) : buildCompanionWeb();
  run.then((r) => {
    process.stdout.write(`${r.skipped ? 'The companion\'s web code is up to date' : 'The companion\'s web code built'}: streamdown ${r.versions.streamdown}, react ${r.versions.react}, mermaid ${r.versions.mermaid}, shiki ${r.versions.shiki}, tailwindcss ${r.versions.tailwindcss}; ${r.files} files, ${r.bytes} bytes${r.skipped ? '' : `, ${r.ms} ms`} (${WEB_DIR})\n`);
    if (!r.distributable) process.stdout.write(`Not distributable yet (fine on this machine). Missing:\n${r.missing.map((m) => `  ${m}\n`).join('')}`);
    // the package build: a build that cannot ship stops it (a package must not carry the chat without its licences)
    if (process.argv.includes('--ship')) {
      const missing = packageCheck();
      if (missing.length) {
        process.stderr.write(`timmy companion web: this build cannot ship in a package:\n${missing.map((m) => `  ${m}\n`).join('')}`);
        process.exit(1);
      }
    }
  }).catch((error) => {
    process.stderr.write(`timmy companion web build: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
