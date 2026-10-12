#!/usr/bin/env node
// Timmy's inventory of features and dependencies (round R4, helper H106): a dated, partial, generated report.
//
//   node scripts/inventory/inventory.mjs [--date YYYY-MM-DD] [--root <dir>] [--out <dir>] [--overlay <file>] [--no-installed]
//
// Reads the repository (the files git tracks, or a walk where there is no work tree), every npm manifest and lockfile,
// the Python manifests, the container files, the registries the code keeps and the feature checklist and ledger, and
// writes three files: docs/ui-cockpit/INVENTORY.md (for people), docs/ui-cockpit/inventory/sbom.json (CycloneDX 1.5) and
// docs/ui-cockpit/inventory/features.json (the feature ledger). With --out, the three go flat into that folder instead.
// The same inputs and --date give the same bytes. It reads only: nothing is installed, fetched, run or changed, apart
// from read-only git commands. No absolute path of this computer reaches the output: a run whose output would carry one
// writes nothing and exits 3.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolutePathProblems, areaOf, byString, gitFacts, listFiles, OUTPUTS, purlConda, purlDocker, purlGeneric, purlNpm, purlPypi, readJson, readText, scrubText, sortStrings, uniq } from './lib/common.mjs';
import { PY_MODULES, readRegistries, scanEnvNames, scanJsImports, scanPrograms, scanPythonImports, scriptPrograms } from './lib/code.mjs';
import { buildLedger, generatedGap, generatedNext } from './lib/features.mjs';
import { readNpmProject } from './lib/npm.mjs';
import { excludedReason, packagingFacts, parseCompose, parseCondaExplicit, parseDockerfile, parsePyproject, parseRequirement, profileOf, readEnvLocks, splitImage } from './lib/other.mjs';

export const GENERATOR = { name: 'timmy-inventory', version: '1' };
const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------------------------------------------------- inputs

function parseArgs(argv) {
  const o = { root: resolve(HERE, '..', '..'), date: null, out: null, overlay: null, installed: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--root') o.root = resolve(val());
    else if (a === '--date') o.date = val();
    else if (a === '--out') o.out = resolve(val());
    else if (a === '--overlay') o.overlay = resolve(val());
    else if (a === '--no-installed') o.installed = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.date === null) o.date = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date) || Number.isNaN(Date.parse(`${o.date}T00:00:00Z`))) throw new Error(`--date takes YYYY-MM-DD, not ${o.date}`);
  return o;
}

/** The services the code reaches by an environment variable, checked against the names the code actually reads. */
const KNOWN_SERVICES = [
  { id: 'ollama', name: 'Ollama (a local model server)', env: ['TIMMY_AGENT_BASE_URL', 'OLLAMA_HOST', 'TIMMY_OLLAMA_URL'], endpoint: 'http://127.0.0.1:11434', local: true, area: 'Code agents (/agent)' },
  { id: 'taskforge', name: 'TaskForge API', env: ['TASKFORGE_API_URL'], area: 'Capabilities (/tools)' },
  { id: 'agentpass', name: 'AgentPass (a checkout outside this repository)', env: ['AGENTPASS_REPO_PATH'], area: 'Capabilities (/tools)' },
  { id: 'roboflow', name: 'Roboflow', env: ['ROBOFLOW_API_KEY'], endpoint: 'https://api.roboflow.com', area: 'VoxVision' },
  { id: 'composio', name: 'Composio', env: ['COMPOSIO_API_KEY'], area: 'Chat agent and its tools' },
  { id: 'trigger', name: 'Trigger.dev', env: ['TRIGGER_SECRET_KEY'], area: 'Chat agent and its tools' },
  { id: 'daytona', name: 'Daytona workspaces', env: ['DAYTONA_API_KEY'], area: 'Chat agent and its tools' },
  { id: 'edge', name: "Timmy's Cloudflare edge host (Durable Object pulse)", env: ['TIMMY_EDGE_HOST'], area: 'Cloudflare edge' },
  { id: 'listing', name: 'Card listing service', env: ['BREAK_MODE_API_BASE_URL', 'TIMMY_USERNAME'], area: 'Chat agent and its tools' },
  { id: 'timmy-cloud', name: "Timmy Cloud's backend (this repository's services/cloud)", env: ['TIMMY_CLOUD_URL', 'TIMMY_CLOUD_TOKEN'], area: 'Timmy Cloud client' },
];

const SPDX = new Set(('0BSD AFL-2.1 AGPL-3.0 AGPL-3.0-only AGPL-3.0-or-later Apache-2.0 Artistic-2.0 BlueOak-1.0.0 BSD-1-Clause BSD-2-Clause BSD-3-Clause '
  + 'BSL-1.0 CC-BY-3.0 CC-BY-4.0 CC0-1.0 EPL-1.0 EPL-2.0 GPL-2.0 GPL-2.0-only GPL-2.0-or-later GPL-3.0 GPL-3.0-only GPL-3.0-or-later ISC '
  + 'LGPL-2.1 LGPL-2.1-only LGPL-2.1-or-later LGPL-3.0 LGPL-3.0-only LGPL-3.0-or-later MIT MIT-0 MPL-1.1 MPL-2.0 OFL-1.1 Python-2.0 '
  + 'Unicode-3.0 Unicode-DFS-2016 Unlicense W3C WTFPL Zlib').split(' '));

function cdxLicenses(expr) {
  if (!expr) return undefined;
  const e = String(expr).trim();
  if (/\s(?:OR|AND|WITH)\s/.test(e)) return [{ expression: e.replace(/^\((.*)\)$/, '$1') }];
  if (SPDX.has(e)) return [{ license: { id: e } }];
  return [{ license: { name: e } }];
}

const prop = (name, value) => (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length) ? null : { name: `timmy:${name}`, value: Array.isArray(value) ? value.join('; ') : String(value) });
const props = (...ps) => { const out = ps.filter(Boolean); return out.length ? out : undefined; };

/** The CycloneDX scope and Timmy's packaging words for a locked npm package of the root project. */
function npmScope(p, bundled) {
  if (bundled) return { scope: 'required', packaging: p.dev || p.devOptional ? bundled : `installed with the package, and ${bundled}` };
  if (p.link) return { scope: 'required', packaging: 'a link to a folder in this repository' };
  if (p.dev || p.devOptional) return { scope: 'excluded', packaging: 'development only (not installed with the package)' };
  if (p.optional) return { scope: 'optional', packaging: p.os || p.cpu ? 'installed with the package where its platform matches' : 'installed with the package when it installs' };
  if (p.peer) return { scope: 'required', packaging: 'a peer dependency, installed with the package' };
  return { scope: 'required', packaging: 'installed with the package' };
}

/** Folders whose code a build bundles into files the package ships (the bundle's exact package set is in its notices). */
const BUNDLED_ROOTS = [
  ['companion/studio-canvas/src/', "bundled into Timmy Canvas's page by scripts/canvas/build.mjs (shipped as companion/studio-canvas)"],
  ['src/companion/island/', "bundled into the companion's web code by scripts/companion-web-build.mjs (shipped in dist/companion-web)"],
];

// ------------------------------------------------------------------------------------------------------------- collect

export function collect(o) {
  const root = o.root;
  const facts = gitFacts(root);
  const { files, how } = listFiles(root, facts);
  const fileSet = new Set(files);

  // npm: the root project first, then every other manifest in the tree.
  const manifests = files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules/'));
  const rootNpm = fileSet.has('package.json') ? readNpmProject(root, 'package.json', { readInstalled: o.installed }) : null;
  const rootPkg = fileSet.has('package.json') ? readJson(join(root, 'package.json')).value ?? null : null;
  const others = [];
  const excluded = [];
  for (const m of manifests) {
    if (m === 'package.json') continue;
    const why = excludedReason(m);
    const p = readNpmProject(root, m, { readInstalled: false });
    if (why) excluded.push({ path: m, why, packages: p.packages.length, lockfile: p.lockfile, declared: p.declared.length });
    else others.push({ ...p, profile: profileOf(m) });
  }
  for (const f of files) {
    if (/(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f)) {
      const why = excludedReason(f);
      if (why) excluded.push({ path: f, why, packages: null, lockfile: f, declared: null });
      else others.push({ manifest: f, lockfile: f, profile: profileOf(f), unsupported: 'a lockfile format this pass does not read', declared: [], packages: [], notLocked: [], manifestLockDiffers: [], unresolved: [], name: null, version: null });
    }
    if (/^skills-lock\.json$|hyperframes\.lock\.json$/.test(f)) excluded.push({ path: f, why: excludedReason(f), packages: null, lockfile: null, declared: null });
  }

  // Imports, attributed to the nearest manifest folder (the project whose node_modules Node would look in first).
  const imports = scanJsImports(root, files);
  const manifestDirs = sortStrings(manifests.map((m) => (m.includes('/') ? m.slice(0, m.lastIndexOf('/')) : '')));
  const projectOf = (file) => manifestDirs.filter((d) => d === '' || file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
  const projects = new Map([['', rootNpm], ...others.filter((x) => x.manifest.endsWith('package.json')).map((x) => [x.manifest.includes('/') ? x.manifest.slice(0, x.manifest.lastIndexOf('/')) : '', x])]);
  for (const e of excluded) if (e.path.endsWith('package.json')) projects.set(e.path.slice(0, e.path.lastIndexOf('/')), { excluded: true, declared: [], packages: [] });
  const importFindings = [];
  for (const [name, u] of imports) {
    const byProject = new Map();
    for (const f of u.files) { const d = projectOf(f); if (!byProject.has(d)) byProject.set(d, []); byProject.get(d).push(f); }
    for (const [d, fs] of byProject) {
      const proj = projects.get(d);
      if (!proj || proj.excluded) continue;
      if (proj.declared.some((x) => x.name === name)) continue;
      // An outer manifest declares it (Node finds it by walking up), a lockfile has it (a transitive copy), or neither.
      const outer = [...projects.entries()].filter(([od, op]) => od !== d && (od === '' || d.startsWith(`${od}/`)) && op && !op.excluded && op.declared.some((x) => x.name === name)).map(([od]) => od || '(the root)');
      // Node's lookup from a file of this project: its own node_modules/<name> first, then (for a sub-project) the root's.
      const pool = [...(proj.packages ?? []), ...(d !== '' ? rootNpm?.packages ?? [] : [])];
      const locked = pool.find((p) => p.key === `node_modules/${name}`) ?? null;
      const elsewhere = [...projects.entries()].filter(([od, op]) => od !== d && op && !op.excluded && op.declared.some((x) => x.name === name)).map(([od]) => od || '(the root)');
      const tests = fs.every((f) => f.startsWith('tests/') || /(^|\/)test\//.test(f));
      importFindings.push({
        name, project: d || '(the root)', files: sortStrings(fs), testsOnly: tests,
        kind: outer.length ? 'declared only in an outer manifest' : locked ? 'imported, not declared (a transitive copy resolves it)' : 'named like a package, but no manifest or lockfile of this project has it',
        outer, elsewhere, lockedVersion: locked?.version ?? null,
      });
    }
  }
  importFindings.sort((a, b) => byString(a.project, b.project) || byString(a.name, b.name));

  // Usage evidence for the root's declarations that are not imported: run by a script, named in code, type definitions.
  const scriptRuns = scriptPrograms(rootPkg);
  const binOf = new Map();
  for (const p of rootNpm?.packages ?? []) {
    const e = rootNpm.byKey.get(p.key)?.entry;
    if (e?.bin && typeof e.bin === 'object') for (const b of Object.keys(e.bin)) if (!binOf.has(b)) binOf.set(b, p.name);
  }
  const ranBy = new Map();
  for (const [prog, scripts] of scriptRuns) { const pkgName = binOf.get(prog) ?? (rootNpm?.declared.some((d) => d.name === prog) ? prog : null); if (pkgName) ranBy.set(pkgName, uniq([...(ranBy.get(pkgName) ?? []), ...scripts])); }
  const codeFiles = files.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith('.agents/') && !f.startsWith('my-react-app/'));
  const texts = new Map();
  const text = (f) => { if (!texts.has(f)) texts.set(f, readText(join(root, f)) ?? ''); return texts.get(f); };
  const namedIn = (name) => codeFiles.filter((f) => { const t = text(f); return t.includes(`'${name}`) || t.includes(`"${name}`) || t.includes(`\`${name}`) || t.includes(`/${name}/`); });

  const directRows = (rootNpm?.declared ?? []).map((d) => {
    const key = `node_modules/${d.name}`;
    const p = rootNpm.packages.find((x) => x.key === key) ?? null;
    const u = imports.get(d.name);
    const ownFiles = u ? [...u.files].filter((f) => projectOf(f) === '') : [];
    const valueFiles = u ? [...u.valueFiles].filter((f) => projectOf(f) === '') : [];
    const areas = sortStrings(uniq(ownFiles.map(areaOf)));
    const bundled = BUNDLED_ROOTS.filter(([prefix]) => ownFiles.some((f) => f.startsWith(prefix))).map(([, words]) => words);
    let usage;
    if (valueFiles.length) usage = 'imported';
    else if (ownFiles.length) usage = 'imported for types only';
    else if (d.name.startsWith('@types/')) usage = `not imported: type definitions for ${d.name.slice(7).replace('__', '/')}, read by the TypeScript compiler`;
    else if (ranBy.has(d.name)) usage = `not imported: run by package.json scripts (${ranBy.get(d.name).join(', ')})`;
    else {
      const named = namedIn(d.name).filter((f) => projectOf(f) === '');
      usage = named.length ? `not imported: named in code as a string (${named.slice(0, 3).join(', ')}${named.length > 3 ? ` and ${named.length - 3} more` : ''})` : 'not imported: no evidence of use (not imported, not run by a script, not named in the code searched)';
    }
    return { ...d, locked: p, usage, areas, testsOnly: ownFiles.length > 0 && ownFiles.every((f) => f.startsWith('tests/')), bundled: bundled[0] ?? null };
  });

  // Python, containers, machine observations.
  const python = { manifests: [], conda: [], imports: [] };
  for (const f of files) {
    if (/(^|\/)requirements[^/]*\.txt$/.test(f)) {
      const t = readText(join(root, f)) ?? '';
      python.manifests.push({ file: f, kind: 'requirements', excluded: excludedReason(f), requirements: t.split('\n').map(parseRequirement).filter(Boolean) });
    } else if (/(^|\/)pyproject\.toml$/.test(f)) {
      const pp = parsePyproject(readText(join(root, f)) ?? '');
      python.manifests.push({ file: f, kind: 'pyproject', excluded: excludedReason(f), project: pp, requirements: [...pp.dependencies.map((x) => ({ ...parseRequirement(x), group: 'dependencies' })), ...Object.entries(pp.optional).flatMap(([g, xs]) => xs.map((x) => ({ ...parseRequirement(x), group: `optional: ${g}` })))].filter((r) => r.name) });
    } else if (/\.lock\.txt$|(^|\/)conda[^/]*\.txt$/.test(f)) {
      const c = parseCondaExplicit(readText(join(root, f)) ?? '');
      if (c.explicit) python.conda.push({ file: f, ...c });
    }
  }
  const pyUses = scanPythonImports(root, files);
  for (const [module, u] of pyUses) {
    const known = PY_MODULES[module] ?? null;
    const declaredIn = python.manifests.filter((m) => m.requirements.some((r) => known && known.dist.toLowerCase().split(/[ ,(]/)[0] === r.name.toLowerCase())).map((m) => m.file);
    const inConda = python.conda.filter((c) => c.packages.some((p) => p.name.toLowerCase() === module.toLowerCase() || (known && p.name.toLowerCase() === known.dist.toLowerCase()))).map((c) => c.file);
    python.imports.push({ module, dist: known?.dist ?? null, via: known?.via ?? 'unknown', note: known?.note ?? null, stub: u.stub, files: sortStrings([...u.files]), areas: sortStrings([...u.areas]), declaredIn: [...declaredIn, ...inConda] });
  }
  python.imports.sort((a, b) => byString(a.module, b.module));

  const containers = [];
  for (const f of files) {
    if (/(^|\/)Dockerfile(\.[\w-]+)?$|\.Dockerfile$|Dockerfile\.tmpl$/.test(f)) {
      const t = readText(join(root, f)) ?? '';
      const d = parseDockerfile(t);
      const builds = uniq([...t.matchAll(/docker build -t (\S+)/g)].map((m) => m[1]));
      containers.push({ file: f, excluded: excludedReason(f), template: f.endsWith('.tmpl'), ...d, builds });
    } else if (/(^|\/)docker-compose\.ya?ml$|(^|\/)compose\.ya?ml$/.test(f)) {
      containers.push({ file: f, excluded: excludedReason(f), template: false, images: parseCompose(readText(join(root, f)) ?? ''), pip: [], apt: [], builds: [] });
    }
  }

  const registries = readRegistries(root, files);
  const programs = scanPrograms(root, files);
  const envNames = scanEnvNames(root, files);
  const envLocks = readEnvLocks(root, files);
  const packaging = rootPkg ? packagingFacts(root, files, rootPkg) : { entries: [], assets: [] };

  // The overlay (hand-kept judgement) and the feature ledger.
  const overlayPath = o.overlay ?? join(root, 'docs/ui-cockpit/inventory/overlay.json');
  const overlayRead = readJson(overlayPath);
  const overlay = overlayRead.ok ? overlayRead.value : null;
  const ledger = buildLedger(root, files, facts, overlay);

  return { o, root, facts, files, how, rootNpm, rootPkg, others, excluded, imports, importFindings, directRows, python, containers, registries, programs, envNames, envLocks, packaging, overlay, overlayProblem: overlayRead.ok ? null : overlayRead.why, overlayGiven: Boolean(o.overlay), ledger };
}

// ------------------------------------------------------------------------------------------------------------- the SBOM

function uuidFrom(text) {
  const h = createHash('sha1').update(text).digest('hex');
  const v = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
  return `urn:uuid:${v}`;
}

function hashesOf(integrity) {
  if (!integrity) return undefined;
  const out = [];
  for (const part of integrity.split(/\s+/)) {
    const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(part);
    if (!m) continue;
    const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1]];
    try { out.push({ alg, content: Buffer.from(m[2], 'base64').toString('hex') }); } catch { /* not base64 */ }
  }
  return out.length ? out : undefined;
}

function installedWords(p) {
  if (!p.installed) return null;
  if (p.installed.missing) return p.os || p.cpu ? `not installed here: built for ${[p.os ? `os ${p.os.join('/')}` : '', p.cpu ? `cpu ${p.cpu.join('/')}` : ''].filter(Boolean).join(', ')}` : 'not installed in the tree read';
  if (p.installed.version !== p.version) return `differs: ${p.installed.version ?? 'no version'} installed`;
  return 'the locked version is installed';
}

export function buildSbom(c) {
  const components = [];
  const deps = [];
  const rootRef = c.rootPkg?.name ?? 'repository';
  const direct = new Map((c.directRows ?? []).map((d) => [d.name, d]));

  // npm, the root project: one component per name@version (a package locked at several paths is one component).
  const byPurl = new Map();
  for (const p of c.rootNpm?.packages ?? []) {
    if (!p.version || !p.name) continue;
    const purl = purlNpm(p.name, p.version);
    if (!byPurl.has(purl)) byPurl.set(purl, []);
    byPurl.get(purl).push(p);
  }
  const refOfKey = new Map();
  for (const [purl, ps] of byPurl) for (const p of ps) refOfKey.set(p.key, purl);
  for (const [purl, ps] of [...byPurl].sort(([a], [b]) => byString(a, b))) {
    const p = ps.find((x) => x.direct) ?? ps[0];
    const d = p.direct ? direct.get(p.direct.declaredAs) : null;
    const anyRequired = ps.some((x) => !x.dev && !x.devOptional && !x.optional);
    const best = anyRequired ? ps.find((x) => !x.dev && !x.devOptional && !x.optional) : p;
    const { scope, packaging } = npmScope(best, d?.bundled ?? null);
    const introduced = sortStrings(uniq(ps.flatMap((x) => x.introducedBy)));
    const installed = installedWords(p);
    // Only what is not the default is written (the defaults are named in the metadata): a transitive package, its licence
    // from its installed package.json, installed at its locked version, from registry.npmjs.org.
    components.push({
      type: 'library',
      'bom-ref': purl,
      name: p.name,
      version: p.version,
      ...(scope === 'required' ? {} : { scope }),
      purl,
      licenses: cdxLicenses(p.license),
      hashes: hashesOf(p.integrity),
      properties: props(
        p.direct ? prop('relation', `direct ${p.direct.relation} (${p.direct.range})${p.direct.alias ? `, declared as ${p.direct.declaredAs}` : ''}`) : null,
        p.direct ? null : prop('introduced-by', introduced.length ? `${introduced.slice(0, 4).join(', ')}${introduced.length > 4 ? ` (+${introduced.length - 4})` : ''}` : 'no declared dependency reaches it'),
        prop('lock-paths', ps.length > 1 || ps[0].key !== `node_modules/${p.name}` ? ps.map((x) => x.key) : null),
        prop('lock-flags', uniq(ps.flatMap((x) => [x.dev && 'dev', x.optional && 'optional', x.devOptional && 'devOptional', x.peer && 'peer', x.link && 'link'].filter(Boolean)))),
        prop('platform', p.os || p.cpu ? [p.os ? `os=${p.os.join(',')}` : '', p.cpu ? `cpu=${p.cpu.join(',')}` : ''].filter(Boolean).join(' ') : null),
        prop('install-script', ps.some((x) => x.installScript) ? 'yes (runs at install)' : null),
        prop('binaries', uniq(ps.flatMap((x) => x.binaries)).length ? `${uniq(ps.flatMap((x) => x.binaries)).join(', ')} (in the installed tree read)` : null),
        prop('deprecated', p.deprecated),
        p.licenseSource === 'installed package.json' ? null : prop('license-source', p.license ? p.licenseSource : 'unknown: neither the installed package nor the lockfile names one'),
        prop('license-conflict', p.licenseConflict ? `installed says ${p.licenseConflict.installed}, lockfile says ${p.licenseConflict.lockfile}` : null),
        installed && installed !== 'the locked version is installed' ? prop('installed', installed) : null,
        d ? prop('usage', d.usage) : null,
        d ? prop('feature', d.areas.length ? d.areas.join(', ') : null) : null,
        d || d?.bundled ? prop('packaging', packaging) : null,
        p.host && p.host !== 'registry.npmjs.org' ? prop('registry', p.host) : null,
      ),
    });
    deps.push({ ref: purl, dependsOn: sortStrings(uniq(ps.flatMap((x) => x.dependsOn.map((k) => refOfKey.get(k)).filter(Boolean)))) });
  }
  deps.push({ ref: rootRef, dependsOn: sortStrings(uniq((c.rootNpm?.declared ?? []).map((d) => refOfKey.get(`node_modules/${d.name}`)).filter(Boolean))) });

  // npm, the other manifests: one application component each, holding its locked (or only declared) packages.
  for (const m of [...c.others].sort((a, b) => byString(a.manifest, b.manifest))) {
    const inner = [];
    if (m.packages?.length) {
      const seen = new Set();
      for (const p of [...m.packages].sort((a, b) => byString(a.key, b.key))) {
        if (!p.version || !p.name) continue;
        const purl = purlNpm(p.name, p.version);
        if (seen.has(purl)) continue;
        seen.add(purl);
        const sc = p.dev || p.devOptional ? 'excluded' : p.optional ? 'optional' : 'required';
        inner.push({ type: 'library', 'bom-ref': `${m.lockfile}#${p.name}@${p.version}`, name: p.name, version: p.version, ...(sc === 'required' ? {} : { scope: sc }), purl, licenses: cdxLicenses(p.license),
          properties: props(p.direct ? prop('relation', `direct ${p.direct.relation} (${p.direct.range})`) : null, p.license ? null : prop('license', 'unknown: the lockfile names none'), prop('platform', p.os || p.cpu ? [p.os ? `os=${p.os.join(',')}` : '', p.cpu ? `cpu=${p.cpu.join(',')}` : ''].filter(Boolean).join(' ') : null)) });
      }
    } else {
      for (const d of m.declared ?? []) inner.push({ type: 'library', 'bom-ref': `${m.manifest}#${purlNpm(d.name)}`, name: d.name, scope: d.relation === 'devDependency' ? 'excluded' : 'required', purl: purlNpm(d.name), properties: props(prop('declared-range', d.range), prop('version', 'not resolved: no lockfile')) });
    }
    components.push({
      type: 'application', 'bom-ref': `manifest:${m.manifest}`, name: m.name ?? m.manifest, ...(m.version ? { version: m.version } : {}),
      properties: props(prop('manifest', m.manifest), prop('lockfile', m.lockfile ?? 'none'), prop('profile', m.profile), prop('unsupported', m.unsupported ?? null), prop('area', areaOf(m.manifest))),
      ...(inner.length ? { components: inner } : {}),
    });
  }

  // Python: the declared manifests, the conda lock, and the modules the code imports.
  for (const m of c.python.manifests.filter((x) => !x.excluded)) {
    components.push({
      type: 'application', 'bom-ref': `manifest:${m.file}`, name: m.project?.name ?? m.file, ...(m.project?.version ? { version: m.project.version } : {}),
      properties: props(prop('manifest', m.file), prop('profile', profileOf(m.file)), prop('requires-python', m.project?.requiresPython ?? null)),
      components: m.requirements.map((r) => ({ type: 'library', 'bom-ref': `${m.file}#${purlPypi(r.name, r.exact)}${r.group ? `#${r.group}` : ''}`, name: r.name, ...(r.exact ? { version: r.exact } : {}), purl: purlPypi(r.name, r.exact), scope: r.group?.startsWith('optional') ? 'optional' : 'required', properties: props(prop('declared-range', r.spec ?? 'any version'), prop('group', r.group ?? null), prop('marker', r.marker)) })),
    });
  }
  for (const cl of c.python.conda) {
    components.push({
      type: 'application', 'bom-ref': `manifest:${cl.file}`, name: `conda environment (${cl.platform ?? 'platform unknown'})`,
      properties: props(prop('manifest', cl.file), prop('profile', 'an explicit conda environment for a spatial study (tools/spatial-volume); not in the npm package'), prop('platform', cl.platform)),
      components: cl.packages.map((p) => ({ type: 'library', 'bom-ref': `${cl.file}#${purlConda(p.name, p.version, p.channel, p.subdir)}`, name: p.name, version: p.version, purl: purlConda(p.name, p.version, p.channel, p.subdir), scope: 'required', ...(p.md5 ? { hashes: [{ alg: 'MD5', content: p.md5 }] } : {}), properties: props(prop('build', p.build)) })),
    });
  }
  for (const m of c.python.imports) {
    const host = m.via === 'host';
    const name = host ? `${m.module} (${m.dist})` : m.dist ?? m.module;
    components.push({
      type: host ? 'framework' : 'library', 'bom-ref': `python-module:${m.module}`, name, purl: host ? purlGeneric(`python-module-${m.module}`) : purlPypi(m.dist ? m.dist.split(/[ ,(]/)[0] : m.module), scope: 'optional',
      properties: props(prop('python-module', m.module), prop('source', host ? 'inside an application\'s own Python' : m.via === 'unknown' ? 'not mapped to a distribution by this pass' : m.via), prop('version', 'unknown: whatever the Python that runs it has (not pinned by a manifest here)'), prop('declared-in', m.declaredIn.length ? m.declaredIn : 'no manifest in this repository'), prop('feature', m.areas), prop('note', m.note), prop('test-stand-in', m.stub ? `${m.stub} (a FAKE used by the tests)` : null), prop('imported-by', m.files.slice(0, 8))),
    });
  }

  // Programs and applications: the registries and the programs the code starts or looks up, one component per program.
  const progs = new Map();
  const addProg = (key, base, extra) => {
    if (!progs.has(key)) progs.set(key, { name: base.name, program: base.program, sources: [], areas: new Set(), env: new Set(), setup: new Set(), observations: [], scripts: [] });
    const g = progs.get(key);
    g.sources.push(extra.source);
    if (extra.script) g.scripts.push(extra.script);
    if (extra.area) g.areas.add(extra.area);
    if (extra.env) for (const e of String(extra.env).split(/,\s*/)) if (e) g.env.add(e);
    if (extra.setup) g.setup.add(extra.setup);
  };
  // A /tools row that names no program is a surface or a tool of Timmy's own (a feature, not a dependency); a VoxVision tool
  // that needs nothing runs in Timmy's own process.
  for (const it of c.registries.items.filter((x) => x.kind !== 'service' && !(x.registry === '/tools rows' && !x.program) && !(x.registry === 'VoxVision tools' && /^nothing$/i.test(x.setup ?? '')))) {
    const key = (it.program ?? `${it.registry}:${it.id}`).toLowerCase();
    addProg(key, { name: it.program ? `${it.program}` : it.name, program: it.program }, { source: `${it.registry} (${it.file}: ${it.id}${it.name && it.name !== it.program ? `, ${it.name}` : ''})`, area: it.area, env: it.env, setup: it.setup, script: it.scriptPath ? `${it.scriptPath} (${it.scriptPresent ? 'in this repository' : 'NOT in this repository'})` : null });
  }
  for (const [name, e] of c.programs) {
    const key = name.toLowerCase();
    addProg(key, { name, program: name }, { source: `${[...e.how].sort().join(' and ')} in ${[...e.files].sort().slice(0, 4).join(', ')}${e.files.size > 4 ? ` and ${e.files.size - 4} more` : ''}`, area: [...e.areas].sort().join(', ') });
  }
  for (const l of c.envLocks) {
    for (const t of l.tools ?? []) {
      const key = t.name.toLowerCase();
      if (progs.has(key)) progs.get(key).observations.push(`${l.file}: ${l.platform ?? '?'}/${l.arch ?? '?'}, captured ${l.capturedAt ?? 'unknown'}: ${t.recorded}`);
    }
  }
  for (const [key, g] of [...progs].sort(([a], [b]) => byString(a, b))) {
    components.push({
      type: 'application', 'bom-ref': `program:${key}`, name: g.name, purl: purlGeneric(key.replace(/[^a-z0-9._+-]/g, '-')), scope: 'optional',
      properties: props(prop('declared-in', uniq(g.sources)), prop('feature', sortStrings([...g.areas])), prop('env', sortStrings([...g.env])), prop('setup', sortStrings([...g.setup]).map(scrubText)), prop('version', 'unknown: not run or probed by this pass'), prop('status', 'named in code; whether it is installed, reachable or exercised is a per-machine fact (timmy tools)'), prop('script', g.scripts), prop('recorded-observation', g.observations)),
    });
  }

  // Models named in code (never in the repository: served by a provider or a local server).
  const models = new Map();
  for (const it of c.registries.items) {
    for (const m of it.models ?? []) {
      if (!models.has(m.id)) models.set(m.id, []);
      models.get(m.id).push(`provider registry: ${it.id} (${m.use ?? 'use not named'})`);
    }
    if (it.model) { if (!models.has(it.model)) models.set(it.model, []); models.get(it.model).push(`lane ${it.id} (its UI label)`); }
  }
  const notes = readJson(join(c.root, 'src/models/notes.json'));
  if (notes.ok && notes.value && typeof notes.value === 'object') for (const id of Object.keys(notes.value)) { if (!models.has(id)) models.set(id, []); models.get(id).push('src/models/notes.json (a model note)'); }
  for (const [id, where] of [...models].sort(([a], [b]) => byString(a, b))) {
    components.push({ type: 'machine-learning-model', 'bom-ref': `model:${id}`, name: id, scope: 'optional', properties: props(prop('named-in', uniq(where)), prop('checkpoint', 'not in this repository: served by a provider or a local model server; not reconciled by this pass')) });
  }

  // Containers: base images, and the images Timmy expects a person to build.
  for (const ct of c.containers.filter((x) => !x.excluded)) {
    for (const im of ct.images) {
      if (/__\w+__/.test(im.ref)) continue;
      const s = splitImage(im.ref);
      const purl = purlDocker(s.name, s.digest ?? s.tag);
      components.push({ type: 'container', 'bom-ref': `${ct.file}#${purl}`, name: s.name, ...(s.tag || s.digest ? { version: s.digest ?? s.tag } : {}), purl, scope: 'optional',
        properties: props(prop('declared-in', ct.file), prop('stage', im.stage), prop('pinned', s.digest ? 'by digest' : s.tag && s.tag !== 'latest' ? 'by tag (a tag can move)' : 'no: latest or untagged'), prop('pip', ct.pip.map((r) => `${r.name}${r.spec ? ` ${r.spec}` : ''}`)), prop('apt', ct.apt), prop('builds', ct.builds), prop('feature', areaOf(ct.file))) });
    }
  }

  const services = [];
  for (const it of c.registries.items.filter((x) => x.kind === 'service' && x.registry !== '/tools rows')) {
    const scheme = it.classification === 'local' ? 'http' : 'https';
    services.push({ 'bom-ref': `service:${it.registry}:${it.id}`, name: it.name, ...(it.host ? { endpoints: [`${scheme}://${it.host}`] } : {}), authenticated: Boolean(it.env),
      properties: props(prop('declared-in', `${it.file} (${it.registry}: ${it.id})`), prop('env', it.env), prop('classification', it.classification ?? null), prop('services', it.services ?? null), prop('feature', it.area)) });
  }
  for (const s of KNOWN_SERVICES) {
    const seen = s.env.filter((e) => c.envNames.has(e));
    if (!seen.length) continue;
    const where = sortStrings(uniq(seen.flatMap((e) => [...c.envNames.get(e)])));
    services.push({ 'bom-ref': `service:code:${s.id}`, name: s.name, ...(s.endpoint ? { endpoints: [s.endpoint] } : {}), authenticated: !s.local,
      properties: props(prop('declared-in', where.slice(0, 6)), prop('env', seen), prop('classification', s.local ? 'local' : 'external'), prop('feature', s.area)) });
  }
  services.sort((a, b) => byString(a['bom-ref'], b['bom-ref']));

  const meta = {
    timestamp: `${c.o.date}T00:00:00Z`,
    tools: { components: [{ type: 'application', name: GENERATOR.name, version: GENERATOR.version, description: 'scripts/inventory/inventory.mjs in this repository' }] },
    component: { type: 'application', 'bom-ref': rootRef, name: c.rootPkg?.name ?? 'repository', ...(c.rootPkg?.version ? { version: c.rootPkg.version } : {}), ...(c.rootPkg?.name && c.rootPkg?.version ? { purl: purlNpm(c.rootPkg.name, c.rootPkg.version) } : {}), licenses: cdxLicenses(c.rootPkg?.license ?? null) },
    properties: props(
      prop('pass', 'first pass: partial; see INVENTORY.md for what it did not reconcile'),
      prop('source-revision', c.facts ? `${c.facts.head} (${c.facts.headDate})${c.facts.changed ? `, with ${c.facts.changed} tracked file(s) changed and not committed` : ''}${c.facts.shallow ? '; a shallow clone' : ''}` : 'not a git work tree'),
      prop('files-read', `${c.files.length} files, ${c.how}`),
      prop('installed-tree', c.rootNpm?.installedTree ? `node_modules${c.rootNpm.installedTree.link ? ' (a link to another folder; its target is not recorded)' : ''}` : 'not read'),
      prop('defaults', 'for an npm component of the root project, a property left out means: transitive; scope required; licence from its installed package.json; installed at its locked version; from registry.npmjs.org. A nested component of another project takes its licence from that project\'s lockfile; its own installed tree is not read'),
      prop('excluded', c.excluded.map((e) => `${e.path}: ${e.why}`)),
    ),
  };

  const bom = { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: '', version: 1, metadata: meta, components, services, dependencies: deps.sort((a, b) => byString(a.ref, b.ref)) };
  const clean = JSON.parse(JSON.stringify(bom));
  bom.serialNumber = uuidFrom(JSON.stringify({ ...clean, serialNumber: '' }));
  return bom;
}

/** JSON with one level per line for the outer structure and short objects kept on one line (diffs stay readable). */
export function stableJson(value) {
  const inline = (v) => JSON.stringify(v);
  const walk = (v, indent) => {
    if (v === null || typeof v !== 'object') return inline(v);
    const s = inline(v);
    if (indent.length >= 4 && (s.length <= 110 || (indent.length >= 6 && s.length <= 240))) return s;
    const pad = `${indent}  `;
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${pad}${walk(x, pad)}`).join(',\n')}\n${indent}]` : '[]';
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    return keys.length ? `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${walk(v[k], pad)}`).join(',\n')}\n${indent}}` : '{}';
  };
  return `${walk(value, '')}\n`;
}

// ------------------------------------------------------------------------------------------------------- the features

export function buildFeatures(c) {
  const entries = c.ledger.entries.map((e) => ({
    id: e.id, stage: e.stage, section: e.section, source: e.source, feature: e.feature, entry: e.entry,
    benefit: e.benefit ?? 'unknown (not assessed in this pass)',
    implemented: e.implemented, implementedRevisions: e.implementedRevisions,
    tested: e.tested, testedWithFakes: e.testedWithFakes, testFiles: e.testFiles,
    demonstrated: e.demonstrated, scripted: e.scripted, demonstratedWhere: e.demonstratedWhere, demonstrationRows: e.demonstrationRows, rowsNamed: e.rowsNamed,
    demonstrationRevisions: e.demonstrationRevisions, demonstrationProviders: e.demonstrationProviders,
    lastCodeChange: e.lastCodeChange, changedSinceDemonstration: e.changedSinceDemonstration,
    surfaces: e.surfacesJudged ?? e.surfaces, surfacesFrom: e.surfacesJudged ? 'overlay' : 'the checklist\'s words (a keyword match)',
    gap: e.gap ?? generatedGap(e), gapFrom: e.gap ? 'overlay' : 'generated from the marks and checks',
    blocker: e.blocker,
    owner: e.owner ?? 'unassigned (the lead assigns)',
    next: e.next ?? generatedNext(e), nextFrom: e.next ? 'overlay' : 'generated',
    citedPaths: e.citedPaths, missingPaths: e.missingPaths, checkedFiles: e.checkedFiles,
  }));
  return {
    schema: 'timmy.inventory-features/1',
    date: c.o.date,
    sourceRevision: c.facts ? c.facts.head : null,
    checklist: { file: 'docs/ui-cockpit/FEATURE-CHECKLIST.md', found: c.ledger.checklistFound, date: c.ledger.checklist.date, updatedAt: c.ledger.checklist.revisions.at(-1) ?? null },
    ledger: { file: 'docs/ui-cockpit/CHECKPOINTS.md', found: c.ledger.ledgerFound, rows: c.ledger.ledgerRows, lastRow: c.ledger.ledgerLast },
    sharedFiles: c.ledger.shared,
    overlay: { file: 'docs/ui-cockpit/inventory/overlay.json', found: Boolean(c.overlay), problem: c.overlayProblem, unmatchedIds: c.ledger.unmatched },
    features: entries,
  };
}

// ------------------------------------------------------------------------------------------------------- the report

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();
const cut = (s, max) => { const t = esc(s); return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')} …`; };
const code = (s) => (s ? `\`${String(s).replace(/`/g, "'")}\`` : '–');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const BLOCKER_GROUPS = [
  ['a licence or a vendor account', /licen[cs]e|Automation permission|Maxon|Adobe/i],
  ['a native application installed (or its TIMMY_* variable set)', /TIMMY_(BLENDER|AFTERFX|AERENDER|OPENSCAD|FREECADCMD|UNREAL|ILLUSTRATOR|C4DPY)|Blender|FreeCAD|OpenSCAD|After Effects|Unreal|Illustrator|Cinema 4D/i],
  ['a Python with CadQuery, OpenCV or another library', /TIMMY_CADQUERY_PYTHON|OpenCV|Python with|python3/i],
  ['a model key or a local model', /model key|TIMMY_AGENT_MODEL|Ollama|local model|local agent route/i],
  ['a service key or address', /_API_KEY|API_URL|REPO_PATH|ROBOFLOW|TASKFORGE|AGENTPASS/i],
  ['upmd or another command-line tool', /upmd|carbonyl|ffmpeg|ffprobe|zellij|tmux|codex-cli|Docker|docker/i],
  ["the operator's decision or a HOLD", /HOLD|decision|decide|the operator's (?:authori[sz]ation|approval|to give)|lifts it/i],
  ['a computer that is offline or not here', /offline|Windows|awake/i],
];

function blockerGroups(features) {
  const groups = BLOCKER_GROUPS.map(([name]) => ({ name, ids: [] }));
  const none = [];
  for (const f of features) {
    const b = f.blocker ?? '';
    if (!b || /^(–|-)$/.test(b.trim())) { none.push(f.id); continue; }
    let hit = false;
    BLOCKER_GROUPS.forEach(([, re], i) => { if (re.test(b)) { groups[i].ids.push(f.id); hit = true; } });
    if (!hit) groups.push({ name: `other: ${cut(b, 60)}`, ids: [f.id] });
  }
  return { groups: groups.filter((g) => g.ids.length), none };
}

export function buildReport(c, sbom, feats) {
  const L = [];
  const p = (...xs) => L.push(...xs);
  const rn = c.rootNpm;
  const pkgs = rn?.packages ?? [];
  const uniqueRoot = new Set(pkgs.filter((x) => x.version).map((x) => `${x.name}@${x.version}`));
  const direct = c.directRows;
  const ov = c.overlay ?? {};
  const rev = c.facts ? `the tree at \`${c.facts.head}\` (${c.facts.headDate})` : 'a folder that is not a git work tree';

  p('# Timmy inventory: features and dependencies', '');
  p(`Date: ${c.o.date}. Pass ${ov.pass ?? 1}: **partial**, generated where possible. Source: ${rev}${c.facts?.changed ? `, with ${plural(c.facts.changed, 'tracked file')} changed and not committed` : ''}${c.facts?.shallow ? ' (a shallow clone: history before its first commit is not read)' : ''}; ${plural(c.files.length, 'file')} read (${c.how}).`, '');
  p('Generated by `node scripts/inventory/inventory.mjs --date ' + c.o.date + '`: every count, table and check below comes from the files, except the', 'judgement columns (user benefit, stage, gap, owner, next task), which come from the hand-kept', '`docs/ui-cockpit/inventory/overlay.json` and say so. Machine-readable: [`inventory/sbom.json`](inventory/sbom.json) (CycloneDX 1.5)', 'and [`inventory/features.json`](inventory/features.json). There is no single completion percentage here, on purpose.', '');
  p('Words used exactly: **named in code** (the code names it; whether that path runs is not decided here); **declared** (a manifest', 'lists it); **locked** (a lockfile pins its exact version); **installed** (present in the installed tree read here, on this', 'computer only); **imported** (a static import search finds it; "not imported" is not "unused"); **implemented, tested,', 'demonstrated** (the feature checklist\'s own marks, with its evidence); **qualified** and **deployed** are claimed for nothing', 'here: no qualification record or deployment was read. Unknown stays unknown.', '');

  // Scope and what is not reconciled.
  p('## Scope of this pass', '');
  p('| Read | How | Not read |', '|---|---|---|');
  p(`| npm: \`package.json\`, \`package-lock.json\` (lockfile v${rn?.lockfileVersion ?? '?'}) | every locked package with its exact version, flags, platform, install script, licence; the dependency edges by Node's lookup | the registry (nothing fetched) |`);
  p(`| the installed tree (\`node_modules\`) | each installed package's own \`package.json\`: version and licence${rn?.installedTree?.link ? '; here it is a link to another checkout\'s tree, so it shows that tree, not one installed for this revision' : ''} | ${rn?.installedTree ? 'files inside packages (native binaries, WebAssembly)' : 'not present or not asked for'} |`);
  p(`| ${plural(c.others.length + c.excluded.length, 'other manifest or lockfile', 'other manifests and lockfiles')} | each sub-project's declarations and lockfile; the ${c.excluded.length} that are not product dependencies counted apart, with why | pnpm and yarn lockfiles (listed, not parsed) |`);
  p('| Python | `requirements*.txt`, `pyproject.toml`, an explicit conda lock, the `import` lines of every tracked `.py` file | which Python runs each worker on a machine, and its versions |');
  p('| programs, apps and services | the registries the code keeps (native apps, code agents, lanes, providers, vision adapters, VoxVision, MCP routes, `/tools` rows), programs started or looked up by name, environment variable names | whether any is installed, reachable or exercised on a machine (`timmy tools` says that, per machine) |');
  p('| containers | `FROM`, `pip`/`uv` and `apt-get` lines of the Dockerfiles and compose files | the images themselves |');
  p(`| features | \`FEATURE-CHECKLIST.md\` (dated ${c.ledger.checklist.date ?? 'unknown'}, last updated at ${code(c.ledger.checklist.revisions.at(-1))}), \`CHECKPOINTS.md\` (${plural(c.ledger.ledgerRows, 'ledger row')}, the last row ${c.ledger.ledgerLast ?? '–'}), the cited files, git history | the operator's private register and evidence folders |`, '');

  p('### What this pass did not reconcile, and how the next pass would', '');
  const nr = ov.notReconciled ?? [];
  if (!nr.length) p('- The overlay names nothing here (it was not found or is empty).');
  for (const x of nr) p(`- **${esc(x.what)}.** ${esc(x.why)} Next pass: ${esc(x.next)}`);
  p('');

  // Counts.
  const progComps = sbom.components.filter((x) => x['bom-ref'].startsWith('program:'));
  const modelComps = sbom.components.filter((x) => x.type === 'machine-learning-model');
  const pyMods = c.python.imports;
  const subLocked = c.others.reduce((n, m) => n + (m.packages?.length ?? 0), 0);
  p('## Counts', '');
  p('| Category | Count | Against what scope |', '|---|---|---|');
  p(`| npm packages locked by \`package-lock.json\` | ${pkgs.length} entries, ${uniqueRoot.size} distinct name@version | the root lockfile, every entry |`);
  p(`| … declared directly in \`package.json\` | ${direct.length} (${direct.filter((d) => d.relation === 'dependency').length} dependencies, ${direct.filter((d) => d.relation === 'devDependency').length} devDependencies, ${direct.filter((d) => d.relation === 'optionalDependency').length} optional, ${direct.filter((d) => d.relation === 'peerDependency').length} peer) | the root manifest |`);
  const runtime = pkgs.filter((x) => !x.dev && !x.devOptional);
  p(`| … needed at run time (not dev) | ${runtime.length} entries (${runtime.filter((x) => x.optional).length} of them optional, ${runtime.filter((x) => x.os || x.cpu).length} platform-specific) | lockfile flags |`);
  p(`| … development only | ${pkgs.filter((x) => x.dev || x.devOptional).length} entries | lockfile flags (\`dev\`, \`devOptional\`) |`);
  p(`| … with an install script | ${pkgs.filter((x) => x.installScript).length} | lockfile \`hasInstallScript\` |`);
  p(`| … licence known | ${pkgs.filter((x) => x.license).length} (${pkgs.filter((x) => x.licenseSource === 'installed package.json').length} from the installed package, ${pkgs.filter((x) => x.licenseSource === 'lockfile').length} from the lockfile); unknown: ${pkgs.filter((x) => !x.license).length} | each entry |`);
  if (rn?.installedTree) p(`| … installed version as locked | ${pkgs.filter((x) => x.installed && !x.installed.missing && x.installed.version === x.version).length}; differs: ${pkgs.filter((x) => x.installed && !x.installed.missing && x.installed.version !== x.version).length}; not installed: ${pkgs.filter((x) => x.installed?.missing).length} (${pkgs.filter((x) => x.installed?.missing && (x.os || x.cpu)).length} built for another platform) | the installed tree read here |`);
  if (rn?.installedTree) p(`| … with WebAssembly or native addon files installed | ${pkgs.filter((x) => x.binaries.length).length} packages (${pkgs.reduce((n, x) => n + x.binaries.filter((b) => b.endsWith('.wasm')).length, 0)} .wasm, ${pkgs.reduce((n, x) => n + x.binaries.filter((b) => b.endsWith('.node')).length, 0)} .node files) | the installed tree read here (a binary named otherwise, such as esbuild's, shows only through its platform fields) |`);
  if (rn?.installedTree) p(`| … installed but not in the lockfile | ${rn.extraneous.length} | the installed tree read here |`);
  p(`| other npm projects | ${c.others.length} (${subLocked} locked entries) | every other \`package.json\` and lockfile, minus the excluded |`);
  p(`| excluded manifests and lockfiles | ${c.excluded.length} | skill material, a demo scaffold, fixtures, template content |`);
  p(`| Python modules imported (not the standard library, not this repository's own) | ${pyMods.length} (${pyMods.filter((m) => m.via === 'host').length} live only inside an application's Python) | every tracked \`.py\` file |`);
  p(`| Python manifests | ${c.python.manifests.length} (${c.python.manifests.reduce((n, m) => n + m.requirements.length, 0)} requirements), ${c.python.conda.length} explicit conda lock (${c.python.conda.reduce((n, x) => n + x.packages.length, 0)} packages) | requirements, pyproject, conda |`);
  p(`| programs and applications named in code | ${progComps.length} | the registries and the programs started or looked up by name (tests excluded) |`);
  p(`| services named in code | ${sbom.services.length} | provider and lane registries, and environment variables the code reads |`);
  p(`| models named in code | ${modelComps.length} | provider and lane registries, \`src/models/notes.json\` |`);
  p(`| container images | ${sbom.components.filter((x) => x.type === 'container').length} | Dockerfiles and compose files |`);
  p(`| features in the ledger below | ${feats.features.length} (${feats.features.filter((f) => f.source.startsWith('docs/ui-cockpit/FEATURE')).length} checklist rows, ${feats.features.filter((f) => !f.source.startsWith('docs/ui-cockpit/FEATURE')).length} added by the overlay) | one row per user-facing feature or integration |`, '');

  // Findings.
  p('## Findings to act on', '');
  p('Each is a fact from the files, with the decision it needs. Nothing was removed or changed by this pass.', '');
  const phantom = c.importFindings.filter((f) => f.kind.startsWith('imported, not declared'));
  p(`### Imported but not declared (${phantom.length})`, '');
  p('The code imports these, and only a transitive copy (another package\'s dependency) makes them resolve: an update of that other', 'package can remove or change them. Declare each where it is imported, or stop importing it.', '');
  if (phantom.length) {
    p('| Package | Imported in project | Resolves to (locked) | Files | Tests only |', '|---|---|---|---|---|');
    for (const f of phantom) p(`| ${code(f.name)} | ${esc(f.project)} | ${f.lockedVersion ?? '–'} | ${cut(f.files.slice(0, 4).join(', ') + (f.files.length > 4 ? ` and ${f.files.length - 4} more` : ''), 160)} | ${f.testsOnly ? 'yes' : 'no'} |`);
    p('');
  }
  const outer = c.importFindings.filter((f) => f.kind.startsWith('declared only in an outer'));
  if (outer.length) {
    p(`### Declared only in an outer manifest (${outer.length})`, '');
    p('| Package | Imported in project | Declared in | Files |', '|---|---|---|---|');
    for (const f of outer) p(`| ${code(f.name)} | ${esc(f.project)} | ${esc(f.outer.join(', '))} | ${cut(f.files.slice(0, 3).join(', '), 120)} |`);
    p('');
  }
  const noise = c.importFindings.filter((f) => f.kind.startsWith('named like a package'));
  if (noise.length) {
    p(`Not counted as dependencies: ${plural(noise.length, 'import-like string')} that no manifest or lockfile of its project has; each sits in test data or in code written for another place:`, '');
    for (const f of noise) p(`- ${code(f.name)} in ${f.files.slice(0, 3).map(code).join(', ')} (${f.project === '(the root)' ? 'the root project' : `the ${f.project} project`})${f.elsewhere.length ? `; declared by ${f.elsewhere.map(code).join(', ')}, a project it does not resolve from` : ''}.`);
    p('');
  }

  const notImported = direct.filter((d) => d.usage.startsWith('not imported'));
  p(`### Declared directly but not imported (${notImported.length})`, '');
  p('"Not imported" is not "unused": a package can be run by a script, read as files, or give types. Only the last group has no', 'evidence of use in the code searched; each is a candidate for review, not for removal.', '');
  p('| Package | Declared as | Evidence of use |', '|---|---|---|');
  for (const d of [...notImported].sort((a, b) => Number(b.usage.includes('no evidence')) - Number(a.usage.includes('no evidence')) || byString(a.name, b.name))) p(`| ${code(d.name)} | ${d.relation} ${code(d.range)} | ${d.usage.includes('no evidence') ? '**none found**: ' : ''}${cut(d.usage.replace(/^not imported: ?/, '').replace(/^no evidence of use /, ''), 150)} |`);
  p('');

  const unknownLic = pkgs.filter((x) => !x.license);
  p(`### Licence unknown (${unknownLic.length}) and licences by kind`, '');
  if (unknownLic.length) p(`Neither the installed package nor the lockfile names a licence for: ${unknownLic.map((x) => `${code(`${x.name}@${x.version}`)}${x.direct ? ' (direct)' : ''}`).join(', ')}. The next pass reads each one\'s licence file or repository.`, '');
  const licCount = new Map();
  for (const x of pkgs) { const k = x.license ?? 'unknown'; licCount.set(k, (licCount.get(k) ?? 0) + 1); }
  p('| Licence (as declared) | Entries |', '|---|---|');
  for (const [k, n] of [...licCount].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))) p(`| ${code(k)} | ${n} |`);
  p('');

  const scripts = [...new Map(pkgs.filter((x) => x.installScript).map((x) => [`${x.name}@${x.version}`, x])).values()];
  const bins = [...new Map(pkgs.filter((x) => x.binaries.length).map((x) => [`${x.name}@${x.version}`, x])).values()];
  if (rn?.installedTree) {
    p('### WebAssembly and native addons in the installed tree', '');
    p('Files ending .wasm or .node inside each installed package (the tree read here, which is this computer\'s: a platform package for', 'another system is not installed here and is counted under "not installed"). These run inside Timmy\'s process or its pages.', '');
    p('| Package | Files | Declared directly | Scope |', '|---|---|---|---|');
    for (const x of bins.sort((a, b) => byString(a.name, b.name))) p(`| ${code(`${x.name}@${x.version}`)} | ${cut(x.binaries.join(', '), 200)} | ${x.direct ? 'yes' : `no (through ${x.introducedBy.slice(0, 3).join(', ') || '–'})`} | ${npmScope(x, null).scope} |`);
    p('');
    if (rn.extraneous.length) p(`Installed but not in the lockfile: ${rn.extraneous.map((x) => code(`${x.name}@${x.version ?? '?'}`)).join(', ')}.`, '');
  }
  const deprecated = pkgs.filter((x) => x.deprecated);
  p('### Install scripts, deprecations, engines', '');
  p(`- Install scripts (they run code at \`npm install\`): ${scripts.map((x) => code(`${x.name}@${x.version}`)).join(', ') || 'none'}. The root \`allowScripts\` lists ${code(JSON.stringify(c.rootPkg?.allowScripts ?? []))}.`);
  p(`- Deprecated by their authors: ${deprecated.map((x) => `${code(`${x.name}@${x.version}`)} ("${cut(x.deprecated, 90)}")`).join('; ') || 'none'}.`);
  const engineClash = pkgs.filter((x) => x.engines?.node && /(>=?\s*2[5-9]|>=?\s*[3-9]\d)/.test(String(x.engines.node)));
  p(`- \`package.json\` asks Node ${code(c.rootPkg?.engines?.node ?? 'unknown')}. Locked packages asking for a newer Node than 24: ${engineClash.map((x) => `${code(`${x.name}@${x.version}`)} (${code(x.engines.node)})`).join(', ') || 'none in the lockfile'}. The checklist records the open decision on \`@opentui/core\`: a registry install takes a newer 0.5.x than the lockfile's, and 0.5.17 declares node >= 26.4.`);
  p(`- Declarations without a locked entry: ${rn?.notLocked.length ? rn.notLocked.map((d) => code(d.name)).join(', ') : 'none'}; the lockfile's copy of the manifest's declarations ${rn?.manifestLockDiffers.length ? `differs for ${rn.manifestLockDiffers.map((d) => code(d.name)).join(', ')}` : 'matches it'}.`);
  p('');

  // Conflicting inventories (hand-noted in the overlay, checked here where a file can show it).
  p('### Inventories that disagree', '');
  const conflicts = ov.conflicts ?? [];
  if (!conflicts.length) p('- None noted in the overlay.');
  for (const x of conflicts) {
    const present = (x.code ?? []).map((pth) => `${code(pth)} ${c.files.some((f) => f === pth || f.startsWith(`${pth.replace(/\/$/, '')}/`)) ? 'is here' : 'is NOT here'}`);
    p(`- **${esc(x.what)}.** ${esc(x.says)}${present.length ? ` Checked now: ${present.join(', ')}.` : ''} ${esc(x.resolution ?? '')}`.trim());
  }
  const changedSince = feats.features.filter((f) => f.changedSinceDemonstration.startsWith('yes'));
  p(`- **Demonstrations older than the code.** ${plural(changedSince.length, 'feature')} marked demonstrated (or partly) cite code that changed after every revision their demonstration names (git ancestry, below). The demonstration stands as a record of that revision; it is not evidence about the current one.`);
  p('');

  // Features.
  p('## Features', '');
  p('One row per user-facing feature or integration: the checklist\'s rows as of its last update, plus rows the overlay adds for', 'what was built since. The marks are the checklist\'s; the checks are this pass\'s. **Code since** compares the newest commit that', `touched the feature's own cited code files (files cited by more than six features, such as ${feats.sharedFiles.map(code).join(', ')}, are left`, 'out of that check when the feature cites others) with the revisions its demonstration names, by git ancestry. **Where** is the', 'ledger row\'s place (the operator\'s Mac unless it says otherwise); **with** names the programs and models the checklist\'s words name.', '');

  // Stages.
  p('### Stages, remaining work and its assumptions', '');
  p('The overlay groups features into stages. Ranges are estimates from this repository\'s own pace, with their assumptions; they', 'are not measurements.', '');
  for (const st of ov.stages ?? []) {
    const inStage = feats.features.filter((f) => f.stage === st.id);
    p(`#### ${esc(st.title)} (${plural(inStage.length, 'feature')} in the ledger)`, '');
    if (st.what) p(esc(st.what), '');
    for (const it of st.remaining ?? []) p(`- ${esc(it)}`);
    if (st.remaining?.length) p('');
    if (st.range) p(`Range: **${esc(st.range)}**.${st.assumptions?.length ? ' Assumptions:' : ''}`);
    for (const a of st.assumptions ?? []) p(`- ${esc(a)}`);
    p('');
  }
  if (!(ov.stages ?? []).length) p('The overlay gives no stages.', '');

  // Common blockers.
  const bg = blockerGroups(feats.features);
  p('### Common blockers', '');
  p('Grouped by the words of each row\'s Blocker cell (a keyword match; a row can be in more than one group).', '');
  p('| Blocker | Features |', '|---|---|');
  for (const g of bg.groups) p(`| ${esc(g.name)} | ${g.ids.length}: ${cut(g.ids.join(', '), 600)} |`);
  p(`| none named | ${bg.none.length} |`, '');

  // Ledger by section.
  const sections = uniq(feats.features.map((f) => f.section));
  for (const s of sections) {
    const rows = feats.features.filter((f) => f.section === s);
    p(`### ${esc(s)}`, '');
    p('| Feature | Entry | Built · Tested | Demonstrated (where · with · rows · revisions) | Code since | Gap | Blocker | Stage · Owner · Next |', '|---|---|---|---|---|---|---|---|');
    for (const f of rows) {
      const demo = f.demonstrated === 'no' ? 'no' : `${f.demonstrated}${f.scripted ? ', scripted' : ''} · ${f.demonstratedWhere.join(', ') || 'where unknown'}${f.demonstrationProviders.length ? ` · ${f.demonstrationProviders.slice(0, 4).join(', ')}` : ''}${f.demonstrationRows.length ? ` · rows ${f.demonstrationRows.join(', ')}` : ''}${f.demonstrationRevisions.length ? ` · ${f.demonstrationRevisions.map((r) => `${r.rev}${r.date ? ` (${r.date.slice(5)})` : ''}`).join(', ')}` : ''}`;
      const since = f.changedSinceDemonstration.startsWith('yes') ? `changed: ${f.lastCodeChange.rev} (${f.lastCodeChange.date.slice(5)})${f.lastCodeChange.of === 'shared files only' ? ', shared files' : ''}` : f.changedSinceDemonstration.startsWith('no:') ? 'inside the demo' : f.changedSinceDemonstration === 'not demonstrated' ? '–' : 'unknown';
      const tested = `${f.tested}${f.testedWithFakes ? ' (fakes)' : ''}`;
      const name = `**${cut(f.feature, 110)}**${f.benefit && !f.benefit.startsWith('unknown') ? ` Benefit: ${cut(f.benefit, 120)}` : ''} <sub>${f.id}</sub>`;
      p(`| ${name} | ${code(f.entry)} | ${f.implemented} · ${tested} | ${cut(demo, 220)} | ${since} | ${cut(f.gap, 160)}${f.gapFrom === 'overlay' ? '' : ' <sub>(generated)</sub>'} | ${cut(f.blocker, 140)} | ${esc(f.stage)} · ${f.owner.startsWith('unassigned') ? 'unassigned' : cut(f.owner, 60)} · ${cut(f.next, 120)}${f.nextFrom === 'overlay' ? '' : ' <sub>(generated)</sub>'} |`);
    }
    p('');
  }
  if (feats.overlay.unmatchedIds.length) p(`Overlay entries that match no feature (stale ids, to correct): ${feats.overlay.unmatchedIds.map(code).join(', ')}.`, '');

  // Dependencies.
  p('## Dependencies', '');
  p(`### npm: what \`package.json\` declares (${direct.length})`, '');
  p('| Package | Declared | Locked | Installed here | Licence | Scope · packaging | Used by (code area) |', '|---|---|---|---|---|---|---|');
  for (const d of [...direct].sort((a, b) => byString(a.relation, b.relation) || byString(a.name, b.name))) {
    const l = d.locked;
    const scope = l ? npmScope(l, d.bundled) : null;
    const devButRuntime = d.relation === 'devDependency' && l && !l.dev && !l.devOptional && !d.bundled;
    const used = d.areas.length ? d.areas.join(', ') : d.usage;
    p(`| ${code(d.name)}${d.alias ? ` (npm alias of ${code(d.alias)})` : ''} | ${d.relation} ${code(d.range)} | ${l?.version ?? 'not locked'} | ${l ? esc(installedWords(l) ?? 'not read') : '–'} | ${esc(l?.license ?? 'unknown')}${l?.licenseSource === 'lockfile' ? ' (lockfile)' : ''} | ${scope ? `${scope.scope} · ${cut(scope.packaging, 90)}${devButRuntime ? ' (declared for development, but a run-time package also needs it, so the lockfile installs it with the package)' : ''}` : '–'} | ${cut(used, 150)}${d.testsOnly && used !== 'Tests only' ? ' (tests only)' : ''} |`);
  }
  p('');
  p(`The ${pkgs.length - direct.length} transitive entries are in \`sbom.json\`, each with the direct dependencies that bring it in and its resolved edges.`, '');

  p(`### npm: the other projects in this repository (${c.others.length})`, '');
  p('| Manifest | Lockfile | Declared | Locked entries | What it is |', '|---|---|---|---|---|');
  for (const m of [...c.others].sort((a, b) => byString(a.manifest, b.manifest))) p(`| ${code(m.manifest)} | ${m.lockfile ? code(m.lockfile) : 'none: versions not resolved'} | ${m.declared?.length ? `${m.declared.length}: ${cut(m.declared.map((d) => d.name).join(', '), 120)}` : 'none'} | ${m.packages?.length ?? 0} | ${esc(m.unsupported ?? m.profile)} |`);
  p('');
  p(`### Excluded from product dependencies (${c.excluded.length})`, '');
  p('| File | Why | Packages |', '|---|---|---|');
  for (const e of [...c.excluded].sort((a, b) => byString(a.path, b.path))) p(`| ${code(e.path)} | ${esc(e.why)} | ${e.packages ?? 'not parsed'} |`);
  p('');

  p(`### Python (${pyMods.length} modules imported)`, '');
  p('| Module | Distribution | From | Declared in | Used by | Test stand-in |', '|---|---|---|---|---|---|');
  for (const m of pyMods) p(`| ${code(m.module)} | ${esc(m.dist ?? 'not mapped')} | ${esc(m.via === 'host' ? `an application's own Python${m.note ? `: ${m.note}` : ''}` : m.via)}${m.note && m.via !== 'host' ? ` (${esc(m.note)})` : ''} | ${m.declaredIn.length ? m.declaredIn.map(code).join(', ') : 'no manifest here'} | ${cut(m.areas.join(', '), 120)} | ${m.stub ? code(m.stub) : '–'} |`);
  p('');
  for (const m of c.python.manifests) p(`- ${code(m.file)}${m.excluded ? ` (excluded: ${esc(m.excluded)})` : ''}: ${m.requirements.map((r) => `${r.name}${r.spec ? ` ${r.spec}` : ''}`).join(', ') || 'no requirements'}${m.project?.requiresPython ? `; Python ${m.project.requiresPython}` : ''}. Versions are ranges: nothing locks them.`);
  for (const cl of c.python.conda) p(`- ${code(cl.file)}: an explicit conda lock for ${cl.platform ?? 'an unnamed platform'}, ${cl.packages.length} packages with exact versions and md5 sums (in \`sbom.json\`).`);
  p('');

  p(`### Programs and applications named in code (${progComps.length})`, '');
  p('Version unknown for every row: this pass runs nothing. A recorded observation is what one machine had on its date (an', 'engine lane\'s `env-lock.json`), not what any machine has now.', '');
  p('| Program | Named by | Variable | Setup step | Recorded observation |', '|---|---|---|---|---|');
  for (const x of progComps) {
    const get = (n) => x.properties?.find((q) => q.name === `timmy:${n}`)?.value ?? '';
    p(`| ${code(x.name)} | ${cut(get('declared-in'), 170)} | ${cut(get('env'), 60) || '–'} | ${cut(get('setup'), 100) || '–'} | ${cut(get('recorded-observation'), 120) || '–'} |`);
  }
  p('');

  p(`### Services (${sbom.services.length}) and models (${modelComps.length}) named in code`, '');
  p('| Service | Endpoint | Variables | Kind | Named in |', '|---|---|---|---|---|');
  for (const s of sbom.services) {
    const get = (n) => s.properties?.find((q) => q.name === `timmy:${n}`)?.value ?? '';
    p(`| ${esc(s.name)} | ${s.endpoints ? esc(s.endpoints.join(', ')) : '–'} | ${cut(get('env'), 70) || '–'} | ${esc(get('classification') || 'not classified')} | ${cut(get('declared-in'), 120)} |`);
  }
  p('');
  p('| Model | Named in | Checkpoint |', '|---|---|---|');
  for (const m of modelComps) p(`| ${code(m.name)} | ${cut(m.properties?.find((q) => q.name === 'timmy:named-in')?.value, 120)} | not in this repository; not reconciled |`);
  p('');

  const cont = sbom.components.filter((x) => x.type === 'container');
  p(`### Containers (${cont.length} images)`, '');
  p('| Image | Version | Pinned | Declared in | Installs |', '|---|---|---|---|---|');
  for (const x of cont) {
    const get = (n) => x.properties?.find((q) => q.name === `timmy:${n}`)?.value ?? '';
    p(`| ${code(x.name)} | ${esc(x.version ?? '–')} | ${esc(get('pinned'))} | ${code(get('declared-in'))} | ${cut([get('pip') && `pip: ${get('pip')}`, get('apt') && `apt: ${get('apt')}`, get('builds') && `builds: ${get('builds')}`].filter(Boolean).join('; '), 140) || '–'} |`);
  }
  p('');

  p('### Machine observations kept in the repository', '');
  p('The engine lanes\' `env-lock.json` files record what one machine had when each was captured. They are history: an', '"installed: true" there is not copied into this inventory as a current fact.', '');
  p('| File | Captured | Platform | Its own "installed" flag | Tools as recorded |', '|---|---|---|---|---|');
  for (const l of c.envLocks) p(`| ${code(l.file)} | ${l.capturedAt ?? 'unknown'} | ${esc(`${l.platform ?? '?'} ${l.arch ?? ''}`.trim())} | ${l.installedFlag === null ? 'none' : String(l.installedFlag)} | ${cut((l.tools ?? []).map((t) => `${t.name}: ${t.recorded}`).join('; '), 160)} |`);
  p('');

  p('### Packaging: what the npm package carries', '');
  const pk = c.packaging;
  const emptyEntries = pk.entries.filter((e) => !e.built && e.trackedFiles === 0);
  p(`\`package.json\` "files" has ${pk.entries.length} entries; ${pk.entries.filter((e) => e.built).length} name built output (\`dist\`), present only after \`npm run build\`. ${emptyEntries.length ? `Entries that match no file in the tree read (npm pack leaves a missing entry out without a word): ${emptyEntries.map((e) => code(e.entry)).join(', ')}.` : 'Every other entry matches files in the tree read.'}`, '');
  const outside = pk.assets.filter((a) => a.inPackage !== 'yes');
  p(`Repository paths the source names at run time: ${pk.assets.length}; inside the package: ${pk.assets.length - outside.length}; only in a checkout, or only in part: ${outside.length}.`, '');
  if (outside.length) {
    p('| Path | In the package | Named by |', '|---|---|---|');
    for (const a of outside) p(`| ${code(a.path)} | ${esc(a.inPackage)} | ${cut(a.namedBy.join(', '), 140)} |`);
    p('');
  }
  const adapters = c.registries.items.filter((x) => x.registry === 'vision adapters' && x.scriptPath);
  const absent = adapters.filter((x) => !x.scriptPresent);
  const byScript = new Map();
  for (const x of absent) { if (!byScript.has(x.scriptPath)) byScript.set(x.scriptPath, []); byScript.get(x.scriptPath).push(x.id); }
  if (adapters.length) p(`Vision adapters (\`timmy vision integrations list\`): ${adapters.length} in the registry, ${absent.length} of them name a script that is not in this repository (${[...byScript].map(([path, ids]) => `${code(path)} for ${ids.join(', ')}`).join('; ') || 'none'}); a machine reports such an adapter as found only where those files exist outside the repository.`, '');
  if (c.registries.problems.length) {
    p('### Registries that could not be read', '');
    for (const x of c.registries.problems) p(`- ${code(x.file)} ${esc(x.what)}: ${esc(x.why)}`);
    p('');
  }
  if (c.overlayProblem && c.overlayGiven) p(`The overlay could not be read: ${esc(c.overlayProblem)}.`, '');
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// --------------------------------------------------------------------------------------------------------------- main

export function generate(o) {
  const c = collect(o);
  const sbom = buildSbom(c);
  const feats = buildFeatures(c);
  const report = buildReport(c, sbom, feats);
  const out = { 'INVENTORY.md': report, 'sbom.json': stableJson(sbom), 'features.json': stableJson(feats) };
  const problems = Object.entries(out).flatMap(([name, text]) => absolutePathProblems(text, o.root).map((p) => `${name}: ${p}`));
  return { c, sbom, feats, out, problems };
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`inventory: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  if (o.help) { process.stdout.write('node scripts/inventory/inventory.mjs [--date YYYY-MM-DD] [--root <dir>] [--out <dir>] [--overlay <file>] [--no-installed]\n'); return; }
  if (o.overlay && !isAbsolute(o.overlay)) o.overlay = resolve(o.overlay);
  const { c, sbom, feats, out, problems } = generate(o);
  if (problems.length) {
    process.stderr.write(`inventory: nothing written: the output would carry a local path:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    process.exit(3);
  }
  const targets = o.out
    ? { 'INVENTORY.md': join(o.out, 'INVENTORY.md'), 'sbom.json': join(o.out, 'sbom.json'), 'features.json': join(o.out, 'features.json') }
    : { 'INVENTORY.md': join(o.root, OUTPUTS[0]), 'sbom.json': join(o.root, OUTPUTS[1]), 'features.json': join(o.root, OUTPUTS[2]) };
  for (const [name, path] of Object.entries(targets)) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, out[name]);
    renameSync(tmp, path);
  }
  const pk = c.rootNpm?.packages ?? [];
  process.stdout.write(`inventory ${o.date}: ${pk.length} locked npm entries, ${c.others.length} other npm projects, ${c.python.imports.length} Python modules, ${sbom.components.length} SBOM components, ${sbom.services.length} services, ${feats.features.length} features; written ${o.out ? 'to the --out folder' : 'under docs/ui-cockpit'}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
