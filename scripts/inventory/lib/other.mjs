// Timmy's inventory: the manifests that are not npm's (Python requirements and pyproject, a conda explicit lock,
// container files), the engine lanes' recorded machine observations, the npm package's "files" list and the runtime
// assets the code names. Everything is read; nothing is resolved against a registry.
import { join } from 'node:path';
import { readJson, readText, scrubText, sortStrings, uniq } from './common.mjs';

/** A requirement line ("name[extra]==1.2; marker") as { name, spec, exact }; null for options, includes and blanks. */
export function parseRequirement(line) {
  const t = line.replace(/\s+#.*$/, '').trim();
  if (!t || t.startsWith('#') || t.startsWith('-')) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([^;]*?)\s*(?:;\s*(.*))?$/.exec(t);
  if (!m) return null;
  const spec = m[3].trim() || null;
  const exact = spec && /^===?\s*([^\s,*]+)$/.exec(spec);
  return { name: m[1], extras: m[2] ?? null, spec, exact: exact ? exact[1] : null, marker: m[4] ?? null };
}

/** The parts of a pyproject.toml the inventory needs: [project] dependencies, optional dependencies, build requires. */
export function parsePyproject(text) {
  const out = { name: null, version: null, requiresPython: null, license: null, dependencies: [], optional: {}, build: [] };
  let table = '';
  const lines = text.split('\n');
  const strings = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+#.*$/, '');
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (h) { table = h[1].trim(); continue; }
    const kv = /^\s*([\w.-]+|"[^"]+")\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    let value = kv[2];
    if (value.trim().startsWith('[') && !value.includes(']')) {
      while (i + 1 < lines.length && !value.includes(']')) value += `\n${lines[++i].replace(/\s+#.*$/, '')}`;
    }
    if (table === 'project') {
      if (key === 'name') out.name = strings(value)[0] ?? null;
      else if (key === 'version') out.version = strings(value)[0] ?? null;
      else if (key === 'requires-python') out.requiresPython = strings(value)[0] ?? null;
      else if (key === 'license') out.license = (/text\s*=\s*"([^"]+)"/.exec(value) ?? [null, strings(value)[0] ?? null])[1];
      else if (key === 'dependencies') out.dependencies = strings(value);
    } else if (table === 'project.optional-dependencies') {
      out.optional[key] = strings(value);
    } else if (table === 'build-system' && key === 'requires') {
      out.build = strings(value);
    }
  }
  return out;
}

/** A conda explicit lock ("@EXPLICIT" and package URLs): its platform and each package's name, version, build, channel. */
export function parseCondaExplicit(text) {
  const platform = /^#\s*platform:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const packages = [];
  for (const line of text.split('\n')) {
    const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/([^/#]+?)\.(conda|tar\.bz2)(?:#([0-9a-f]+))?\s*$/.exec(line.trim());
    if (!m) continue;
    const parts = m[3].split('-');
    if (parts.length < 3) continue;
    const build = parts.pop();
    const version = parts.pop();
    packages.push({ name: parts.join('-'), version, build, channel: m[1], subdir: m[2], md5: m[5] ?? null });
  }
  return { explicit: /^@EXPLICIT\s*$/m.test(text), platform, packages };
}

/** A Dockerfile's base images, and what its RUN lines install with pip, uv and apt-get (continuations joined). */
export function parseDockerfile(text) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  const images = [];
  const pip = [];
  const apt = [];
  for (const line of joined.split('\n')) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) { images.push({ ref: from[1], stage: from[2] ?? null }); continue; }
    if (!/^\s*RUN\b/i.test(line)) continue;
    for (const cmd of line.replace(/^\s*RUN\s+/i, '').split(/&&|;/)) {
      const words = cmd.trim().split(/\s+/);
      const pi = words.findIndex((w, k) => w === 'install' && (words[k - 1] === 'pip' || words[k - 1] === 'pip3' || (words[k - 1] === 'pip' && words[k - 2] === 'uv')));
      if (pi >= 0) {
        for (const w of words.slice(pi + 1)) {
          if (w.startsWith('-') || w === '\\') continue;
          const r = parseRequirement(w);
          if (r) pip.push(r);
        }
        continue;
      }
      const ai = words.findIndex((w, k) => w === 'install' && (words[k - 1] === 'apt-get' || words[k - 1] === 'apt'));
      if (ai >= 0) for (const w of words.slice(ai + 1)) if (!w.startsWith('-') && /^[a-z0-9][a-z0-9.+-]*$/.test(w)) apt.push(w);
    }
  }
  return { images, pip, apt: uniq(apt) };
}

/** docker-compose image lines. */
export function parseCompose(text) {
  return [...text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)].map((m) => ({ ref: m[1], stage: null }));
}

/** An image reference split into name and tag (a digest kept as the version when there is one). */
export function splitImage(ref) {
  const at = ref.indexOf('@');
  const digest = at >= 0 ? ref.slice(at + 1) : null;
  const base = at >= 0 ? ref.slice(0, at) : ref;
  const colon = base.lastIndexOf(':');
  const slash = base.lastIndexOf('/');
  const tag = colon > slash ? base.slice(colon + 1) : null;
  const name = colon > slash ? base.slice(0, colon) : base;
  return { name: name.replace(/^docker\.io\//, '').replace(/^library\//, ''), tag, digest };
}

/**
 * The engine lanes' environment locks (lanes/engines/<engine>/env-lock.json): what one machine had when it was captured.
 * Kept as a dated observation of that machine, never as what is installed now; no path is copied.
 */
export function readEnvLocks(root, files) {
  const out = [];
  for (const f of files.filter((x) => /^lanes\/engines\/[^/]+\/env-lock\.json$/.test(x))) {
    const r = readJson(join(root, f));
    if (!r.ok) { out.push({ file: f, problem: r.why }); continue; }
    const v = r.value;
    const tools = Object.entries(v.tools ?? {}).map(([name, t]) => ({
      name,
      recorded: t === null ? 'not found when captured' : typeof t?.version === 'string' ? `version ${t.version}` : t && 'note' in t ? 'authored (not measured)' : 'found; version not recorded',
    }));
    out.push({ file: f, engine: v.engine ?? f.split('/')[2], capturedAt: typeof v.captured_at === 'string' ? v.captured_at.slice(0, 10) : null, platform: v.os?.platform ?? null, arch: v.arch ?? null, installedFlag: v.installed ?? null, tools });
  }
  return out;
}

/**
 * The npm package's "files" list against the tree, and the runtime assets the code names by a repository path: whether
 * each is inside the package (a "files" entry covers it) or only in a checkout.
 */
export function packagingFacts(root, files, pkg) {
  const list = Array.isArray(pkg?.files) ? pkg.files : [];
  const covered = (p) => list.some((e) => p === e || p.startsWith(`${e.replace(/\/$/, '')}/`));
  const entries = list.map((e) => {
    const under = files.filter((f) => f === e || f.startsWith(`${e.replace(/\/$/, '')}/`)).length;
    return { entry: e, trackedFiles: under, built: e === 'dist' || e.startsWith('dist/') };
  });
  const refs = new Map();
  const re = /['"`]((?:workers|templates|lanes|scripts|tools|assets|companion|deploy|examples|studio)\/[\w./@+-]+?)['"`]/g;
  for (const f of files) {
    if (!/^src\/.*\.(?:[cm]?[jt]sx?)$/.test(f) || f.endsWith('.d.ts')) continue;
    const text = readText(join(root, f));
    if (text === null) continue;
    for (const m of text.matchAll(re)) {
      const p = m[1].replace(/\/$/, '');
      if (!files.some((x) => x === p || x.startsWith(`${p}/`))) continue; // not a path of this tree
      if (!refs.has(p)) refs.set(p, new Set());
      refs.get(p).add(f);
    }
  }
  const assets = sortStrings([...refs.keys()]).map((p) => {
    const under = list.filter((e) => e.startsWith(`${p}/`));
    return { path: p, inPackage: covered(p) ? 'yes' : under.length ? `partly (${under.join(', ')})` : 'no', namedBy: sortStrings([...refs.get(p)]) };
  });
  return { entries, assets };
}

/**
 * Manifests and lockfiles that are in the repository but are not Timmy's product dependencies, with why. Their packages
 * are listed by count only.
 */
export const EXCLUDED_RULES = [
  [/^\.agents\//, 'agent skill material (an example of a skill, not Timmy code)'],
  [/^my-react-app\//, 'a Vite React template app kept in the repository (a demo scaffold, not part of Timmy)'],
  [/^tests\/fixtures\//, 'a test fixture'],
  [/^templates\//, "starter template content: its dependencies belong to a project made from it, not to Timmy"],
  [/^skills-lock\.json$/, "the agent skills' own lock (skill material)"],
  [/hyperframes\.lock\.json$/, "a render project's file hashes (content, not dependencies)"],
];

export function excludedReason(path) {
  for (const [re, why] of EXCLUDED_RULES) if (re.test(path)) return why;
  return null;
}

/** What each other manifest is: how its dependencies relate to the timmy-tui package. */
export const PROFILE_RULES = [
  [/^workers\/ai-proxy\//, 'deployed separately (a Cloudflare Worker); not in the npm package'],
  [/^r2-worker\//, 'deployed separately (a Cloudflare Worker); not in the npm package'],
  [/^vault-custody\//, 'a separate project in this repository (Vault Custody); not in the npm package'],
  [/^companion\/slate3d\//, 'a companion sub-app built on its own; not in the npm package'],
  [/^lanes\//, 'a lane with dependencies of its own, installed only where that lane is used; not in the npm package'],
  [/^packages\//, 'a plugin package in this repository (its source compiles with the root tsconfig); not in the npm package'],
  [/^founder-terminal\//, 'a separate Python application (Founder Terminal); not in the npm package'],
  [/^services\//, 'a service in this repository; not in the npm package'],
];

export function profileOf(path) {
  for (const [re, why] of PROFILE_RULES) if (re.test(path)) return why;
  return 'in this repository; its relation to the package is not classified';
}

export const scrubAll = (xs) => xs.map((x) => scrubText(x));
