// Timmy's inventory: npm manifests and lockfiles. Reads package.json, package-lock.json (lockfile v2/v3 "packages", or
// v1 "dependencies") and, where an installed tree is present, each installed package's own package.json for its version
// and licence. Nothing is installed, fetched or run.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDir, isLink, readJson } from './common.mjs';

/**
 * One walk of an installed tree (links inside it are not followed): the packages it holds, as lockfile keys, and the
 * WebAssembly (.wasm) and native addon (.node) files of each, by the innermost package that holds them.
 */
export function walkInstalled(root, nmRel) {
  const packages = new Set();
  const binaries = new Map();
  const ownerOf = (rel) => {
    const at = rel.lastIndexOf('node_modules/');
    if (at < 0) return null;
    const rest = rel.slice(at + 'node_modules/'.length).split('/');
    const width = rest[0]?.startsWith('@') ? 2 : 1;
    return rel.slice(0, at) + 'node_modules/' + rest.slice(0, width).join('/');
  };
  const walk = (abs, rel, depth) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === '.bin' || depth > 40) continue;
        const parent = rel.split('/').at(-1);
        const grand = rel.split('/').at(-2);
        if (parent === 'node_modules' && !e.name.startsWith('@') && !e.name.startsWith('.')) packages.add(r);
        else if (grand === 'node_modules' && parent.startsWith('@')) packages.add(r);
        walk(join(abs, e.name), r, depth + 1);
        continue;
      }
      if (e.isFile() && (e.name.endsWith('.wasm') || e.name.endsWith('.node'))) {
        const owner = ownerOf(r);
        if (!owner) continue;
        if (!binaries.has(owner)) binaries.set(owner, []);
        binaries.get(owner).push(r.slice(owner.length + 1));
      }
    }
  };
  walk(join(root, nmRel), nmRel, 0);
  return { packages, binaries };
}

const DEP_FIELDS = [
  ['dependencies', 'dependency'],
  ['devDependencies', 'devDependency'],
  ['optionalDependencies', 'optionalDependency'],
  ['peerDependencies', 'peerDependency'],
];

/** The package name a lockfile key names: the part after its last node_modules/ (a scope keeps its two parts). */
export function nameFromLockPath(key) {
  const at = key.lastIndexOf('node_modules/');
  if (at < 0) return null;
  return key.slice(at + 'node_modules/'.length);
}

/** A licence as a package.json writes it (a string, {type}, or the old "licenses" array), or null. */
export function licenseOf(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const l = pkg.license;
  if (typeof l === 'string' && l.trim()) return l.trim();
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type.trim();
  if (Array.isArray(pkg.licenses)) {
    const names = pkg.licenses.map((x) => (typeof x === 'string' ? x : x && typeof x.type === 'string' ? x.type : null)).filter(Boolean);
    if (names.length === 1) return names[0];
    if (names.length > 1) return `(${names.join(' OR ')})`;
  }
  return null;
}

/** Lockfile entries as {key, name, entry}: v2/v3 "packages", or v1's nested "dependencies" flattened to the same keys. */
function lockEntries(lock) {
  if (lock && typeof lock.packages === 'object' && lock.packages) {
    return Object.entries(lock.packages).filter(([k]) => k !== '').map(([key, entry]) => ({ key, name: entry.name ?? nameFromLockPath(key), entry }));
  }
  const out = [];
  const visit = (deps, prefix) => {
    for (const [name, e] of Object.entries(deps ?? {})) {
      const key = `${prefix}node_modules/${name}`;
      const entry = { version: e.version, resolved: e.resolved, integrity: e.integrity, dev: e.dev, optional: e.optional, dependencies: e.requires };
      out.push({ key, name, entry });
      if (e.dependencies) visit(e.dependencies, `${key}/`);
    }
  };
  visit(lock?.dependencies, '');
  return out;
}

/** Where a dependency of the package at `fromKey` resolves, by Node's lookup: its own node_modules, then each parent's. */
function resolveFrom(fromKey, dep, keys) {
  let base = fromKey;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`;
    if (keys.has(candidate)) return candidate;
    if (!base) return null;
    const at = base.lastIndexOf('/node_modules/');
    base = at < 0 ? '' : base.slice(0, at);
  }
}

/**
 * One npm manifest and its lockfile: every locked package with its exact version and flags, the manifest's direct
 * declarations, the resolved dependency edges, which direct dependencies bring each package in, and (when `installedRoot`
 * names a folder holding an installed node_modules) the installed version and licence of each.
 */
export function readNpmProject(root, manifestRel, { readInstalled = false } = {}) {
  const dir = manifestRel.includes('/') ? manifestRel.slice(0, manifestRel.lastIndexOf('/')) : '';
  const at = (p) => (dir ? `${dir}/${p}` : p);
  const pkgRead = readJson(join(root, manifestRel));
  const pkg = pkgRead.ok ? pkgRead.value : null;
  const lockRel = ['package-lock.json', 'npm-shrinkwrap.json'].map(at).find((p) => readJson(join(root, p)).ok) ?? null;
  const lock = lockRel ? readJson(join(root, lockRel)).value : null;

  const declared = [];
  for (const [field, relation] of DEP_FIELDS) {
    for (const [name, range] of Object.entries(pkg?.[field] ?? {})) {
      const alias = typeof range === 'string' && range.startsWith('npm:') ? range.slice(4).replace(/(?!^)@[^@/]*$/, '') : null;
      declared.push({ name, range: String(range), relation, alias });
    }
  }

  const entries = lock ? lockEntries(lock) : [];
  const keys = new Set(entries.map((e) => e.key));
  const byKey = new Map(entries.map((e) => [e.key, e]));

  // Edges: every dependency each entry names, resolved by Node's lookup within the lockfile's own tree.
  const edges = new Map();
  const unresolved = [];
  for (const { key, entry } of entries) {
    const out = new Set();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(entry[field] ?? {})) {
        const to = resolveFrom(key, dep, keys);
        if (to) out.add(to);
        else if (field === 'dependencies') unresolved.push({ from: key, dep });
      }
    }
    edges.set(key, out);
  }

  // Which direct declarations bring in each locked package (by the edges above, from the root's own entries).
  const introducedBy = new Map();
  const rootDeps = new Map(); // key -> declaration
  for (const d of declared) {
    const key = `node_modules/${d.name}`;
    if (keys.has(key)) rootDeps.set(key, d);
  }
  for (const [startKey, d] of rootDeps) {
    const seen = new Set([startKey]);
    const queue = [startKey];
    while (queue.length) {
      const k = queue.shift();
      for (const n of edges.get(k) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    for (const k of seen) {
      if (!introducedBy.has(k)) introducedBy.set(k, new Set());
      introducedBy.get(k).add(d.name);
    }
  }

  // The installed tree: node_modules beside the manifest, read through a link when it is one (its target is never recorded).
  const nmRel = at('node_modules');
  const installedTree = readInstalled && isDir(join(root, nmRel)) ? { path: nmRel, link: isLink(join(root, nmRel)) } : null;

  // The installed tree's own packages and binary files, keyed as the lockfile keys them (relative to this manifest's folder).
  const walked = installedTree ? walkInstalled(join(root, dir), 'node_modules') : null;
  const packages = entries.map(({ key, name, entry }) => {
    let installed = null;
    if (installedTree) {
      const read = readJson(join(root, dir, key, 'package.json'));
      installed = read.ok ? { version: typeof read.value.version === 'string' ? read.value.version : null, license: licenseOf(read.value), name: read.value.name ?? null } : { version: null, license: null, name: null, missing: true };
    }
    const lockLicense = typeof entry.license === 'string' ? entry.license : null;
    const installedLicense = installed && !installed.missing ? installed.license : null;
    const license = installedLicense ?? lockLicense;
    const licenseSource = installedLicense ? 'installed package.json' : lockLicense ? 'lockfile' : 'unknown';
    const nested = key.split('node_modules/').length > 2;
    const direct = !nested ? declared.find((d) => d.name === nameFromLockPath(key)) ?? null : null;
    let host = null;
    try { host = entry.resolved ? new URL(entry.resolved).host : null; } catch { host = entry.resolved ? 'not a URL' : null; }
    return {
      key,
      name,
      version: typeof entry.version === 'string' ? entry.version : null,
      direct: direct ? { relation: direct.relation, range: direct.range, alias: direct.alias, declaredAs: nameFromLockPath(key) } : null,
      dev: entry.dev === true,
      optional: entry.optional === true,
      devOptional: entry.devOptional === true,
      peer: entry.peer === true,
      link: entry.link === true,
      os: Array.isArray(entry.os) ? entry.os : null,
      cpu: Array.isArray(entry.cpu) ? entry.cpu : null,
      installScript: entry.hasInstallScript === true,
      deprecated: typeof entry.deprecated === 'string' ? entry.deprecated : null,
      engines: entry.engines && typeof entry.engines === 'object' ? entry.engines : null,
      host,
      integrity: typeof entry.integrity === 'string' ? entry.integrity : null,
      license,
      licenseSource,
      licenseConflict: installedLicense && lockLicense && installedLicense !== lockLicense ? { installed: installedLicense, lockfile: lockLicense } : null,
      installed,
      binaries: walked?.binaries.get(key)?.sort() ?? [],
      introducedBy: [...(introducedBy.get(key) ?? [])].sort(),
      dependsOn: [...(edges.get(key) ?? [])].sort(),
    };
  });

  // A declaration with no locked entry (a lockfile out of step with its manifest, or no lockfile at all).
  const notLocked = declared.filter((d) => !keys.has(`node_modules/${d.name}`));
  const rootEntry = lock?.packages?.[''] ?? null;
  const lockDeclared = rootEntry ? Object.fromEntries(DEP_FIELDS.map(([f]) => [f, rootEntry[f] ?? {}])) : null;
  // The lockfile's own copy of the manifest's declarations: a range that differs means the lockfile was made from another manifest.
  const manifestLockDiffers = [];
  if (lockDeclared) {
    for (const d of declared) {
      const field = DEP_FIELDS.find(([, r]) => r === d.relation)[0];
      const inLock = lockDeclared[field]?.[d.name];
      if (inLock === undefined) manifestLockDiffers.push({ name: d.name, manifest: d.range, lockfile: null });
      else if (inLock !== d.range) manifestLockDiffers.push({ name: d.name, manifest: d.range, lockfile: inLock });
    }
    for (const [field, relation] of DEP_FIELDS) {
      for (const name of Object.keys(lockDeclared[field] ?? {})) {
        if (!declared.some((d) => d.name === name && d.relation === relation)) manifestLockDiffers.push({ name, manifest: null, lockfile: lockDeclared[field][name] });
      }
    }
  }

  return {
    manifest: manifestRel,
    lockfile: lockRel,
    lockfileVersion: lock?.lockfileVersion ?? null,
    name: pkg?.name ?? null,
    version: pkg?.version ?? null,
    private: pkg?.private === true,
    license: pkg ? licenseOf(pkg) : null,
    engines: pkg?.engines ?? null,
    manifestProblem: pkgRead.ok ? null : pkgRead.why,
    declared,
    packages,
    notLocked,
    manifestLockDiffers,
    unresolved,
    installedTree,
    // Installed packages the lockfile does not have (extraneous to this lockfile), read from the installed tree itself.
    extraneous: walked ? [...walked.packages].filter((k) => !keys.has(k) && readJson(join(root, dir, k, 'package.json')).ok).sort().map((k) => {
      const pj = readJson(join(root, dir, k, 'package.json')).value;
      return { key: k, name: pj?.name ?? nameFromLockPath(k), version: pj?.version ?? null };
    }) : [],
    binariesOutsideLock: walked ? [...walked.binaries.keys()].filter((k) => !keys.has(k)).sort() : [],
    byKey,
  };
}
