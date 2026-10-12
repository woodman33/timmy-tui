// Timmy's inventory: what the code itself names. A static search, never a run: JS/TS imports of npm packages, Python
// imports, programs started or looked up by name, and the registries the brief names (native apps, code agents, lanes,
// providers, vision adapters, VoxVision tools, MCP routes, /tools rows). A name found here is "named in code"; whether
// that code path runs is not decided here.
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { areaOf, readText, scrubText, sortStrings, uniq } from './common.mjs';
import { constLiteral, returnedLiteral } from './literal.mjs';

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Comments out of JS/TS text: block comments, and lines that are only a // comment. Strings are left as they are. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
}

/** The package a bare specifier names (`a/b` → `a`, `@s/a/b` → `@s/a`); null for relative, absolute, builtin or URL ones. */
export function packageOfSpecifier(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  if (BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]) || spec.startsWith('node:') || spec.startsWith('bun:')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    if (spec.startsWith('npm:')) return packageOfSpecifier(spec.slice(4).replace(/(?!^)@[^@/]*$/, ''));
    return null; // https:, jsr:, data:, virtual: …
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) ? name : null;
}

const IMPORT_RES = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\brequire\.resolve\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\bimport\.meta\.resolve\s*\(\s*['"]([^'"\n]+)['"]/g,
  // a createRequire()'d resolve of a package's own package.json (how Timmy finds a package's files on disk)
  /\.resolve\s*\(\s*['"]((?:@[\w.-]+\/)?[\w.-]+\/package\.json)['"]/g,
];

/** Every bare import of a package in the JS/TS files: name → { files, areas, typeOnly }. */
export function scanJsImports(root, files) {
  const uses = new Map();
  for (const f of files) {
    if (!JS_EXT.test(f) || f.endsWith('.d.ts')) continue;
    const text = readText(join(root, f));
    if (text === null || text.length > 4 * 1024 * 1024) continue;
    const code = stripComments(text);
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        const name = packageOfSpecifier(m[1]);
        if (!name) continue;
        const typeOnly = /^\s*(?:import|export)\s+type\b/.test(m[0]);
        if (!uses.has(name)) uses.set(name, { files: new Set(), areas: new Set(), valueFiles: new Set() });
        const u = uses.get(name);
        u.files.add(f);
        u.areas.add(areaOf(f));
        if (!typeOnly) u.valueFiles.add(f);
      }
    }
  }
  return uses;
}

/** Packages a package.json script runs by its program name (vitest, tsc, vite, wrangler, tsx …): name → [script names]. */
export function scriptPrograms(pkg) {
  const out = new Map();
  for (const [script, cmd] of Object.entries(pkg?.scripts ?? {})) {
    for (const part of String(cmd).split(/&&|\|\||;|\|/)) {
      const words = part.trim().split(/\s+/);
      let w = words[0] === 'npx' ? words.find((x, i) => i > 0 && !x.startsWith('-')) : words[0];
      if (!w || /[=/]/.test(w) || w === 'node' || w === 'npm') continue;
      w = w.replace(/@[^@]*$/, '');
      if (!out.has(w)) out.set(w, []);
      out.get(w).push(script);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ Python

/** Python's standard library (3.13's sys.stdlib_module_names, plus modules removed in 3.12 and 3.13), top level only. */
const PY_STDLIB = new Set(('__future__ abc aifc antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii '
  + 'bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent '
  + 'configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils '
  + 'doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath '
  + 'getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress '
  + 'itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt '
  + 'multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools '
  + 'pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat '
  + 'queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site '
  + 'smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep '
  + 'struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time '
  + 'timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu '
  + 'uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo').split(' '));

/**
 * A Python module's distribution (what a person installs) and where it comes from. "host" modules exist only inside an
 * application's own Python (Blender's bpy, Cinema 4D's c4d, FreeCAD, Houdini's hou, Unreal, Reallusion's RLPy).
 */
export const PY_MODULES = {
  OCP: { dist: 'cadquery-ocp', via: 'pypi', note: 'OpenCascade bindings, installed with CadQuery (TIMMY_CADQUERY_PYTHON)' },
  cadquery: { dist: 'cadquery', via: 'pypi', note: 'TIMMY_CADQUERY_PYTHON' },
  open3d: { dist: 'open3d', via: 'pypi', note: 'the recipe\'s Python (TIMMY_CADQUERY_PYTHON)' },
  cv2: { dist: 'opencv-python-headless (or opencv-python)', via: 'pypi', note: 'the Look worker (TIMMY_VISION_PYTHON or python3)' },
  numpy: { dist: 'numpy', via: 'pypi' },
  scipy: { dist: 'scipy', via: 'pypi' },
  trimesh: { dist: 'trimesh', via: 'pypi' },
  zstandard: { dist: 'zstandard', via: 'pypi' },
  mcap: { dist: 'mcap', via: 'pypi' },
  msgspec: { dist: 'msgspec', via: 'pypi' },
  jsonschema: { dist: 'jsonschema', via: 'pypi' },
  openai: { dist: 'openai', via: 'pypi' },
  litellm: { dist: 'litellm', via: 'pypi' },
  openhands: { dist: 'openhands-sdk, openhands-tools', via: 'pypi', note: 'inside the OpenHands worker image (workers/openhands/Dockerfile)' },
  rerun: { dist: 'rerun-sdk', via: 'pypi' },
  viser: { dist: 'viser', via: 'pypi' },
  fiftyone: { dist: 'fiftyone', via: 'pypi' },
  roboflow: { dist: 'roboflow', via: 'pypi', note: 'the project\'s Roboflow venv (.timmy/venv-roboflow)' },
  inference_sdk: { dist: 'inference-sdk', via: 'pypi', note: 'the project\'s Roboflow venv (.timmy/venv-roboflow)' },
  textual: { dist: 'textual', via: 'pypi' },
  rich: { dist: 'rich', via: 'pypi' },
  pydantic: { dist: 'pydantic', via: 'pypi' },
  pyee: { dist: 'pyee', via: 'pypi' },
  dotenv: { dist: 'python-dotenv', via: 'pypi' },
  docker: { dist: 'docker', via: 'pypi' },
  qrcode: { dist: 'qrcode', via: 'pypi' },
  PIL: { dist: 'pillow', via: 'pypi' },
  yaml: { dist: 'PyYAML', via: 'pypi' },
  pxr: { dist: 'usd-core (or an application\'s own USD)', via: 'pypi' },
  openvdb: { dist: 'openvdb (Python bindings)', via: 'conda', note: 'tools/spatial-volume/environment-osx-arm64.lock.txt' },
  bpy: { dist: "Blender's own Python", via: 'host', note: 'Blender (TIMMY_BLENDER)' },
  mathutils: { dist: "Blender's own Python", via: 'host', note: 'Blender (TIMMY_BLENDER)' },
  c4d: { dist: "Cinema 4D's c4dpy", via: 'host', note: 'Cinema 4D (TIMMY_C4DPY)' },
  FreeCAD: { dist: "FreeCAD's own Python", via: 'host', note: 'FreeCAD (TIMMY_FREECADCMD)' },
  Part: { dist: "FreeCAD's own Python", via: 'host', note: 'FreeCAD (TIMMY_FREECADCMD)' },
  Mesh: { dist: "FreeCAD's own Python", via: 'host', note: 'FreeCAD (TIMMY_FREECADCMD)' },
  hou: { dist: "Houdini's hython", via: 'host', note: 'Houdini (licence needed)' },
  unreal: { dist: "Unreal Editor's own Python", via: 'host', note: 'Unreal Engine 5 (TIMMY_UNREAL)' },
  RLPy: { dist: "Reallusion iClone / Character Creator's own Python", via: 'host', note: 'Windows only' },
};

/** Every top-level Python import that is neither the standard library nor a module of this repository. */
export function scanPythonImports(root, files) {
  const local = new Set();
  for (const f of files) {
    if (f.endsWith('.py')) local.add(f.slice(f.lastIndexOf('/') + 1, -3));
    if (f.endsWith('/__init__.py')) { const d = f.slice(0, -'/__init__.py'.length); local.add(d.slice(d.lastIndexOf('/') + 1)); }
  }
  const uses = new Map();
  for (const f of files) {
    if (!f.endsWith('.py')) continue;
    const text = readText(join(root, f));
    if (text === null) continue;
    for (const line of text.split('\n')) {
      let mods = [];
      const a = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*(?:#.*)?$/.exec(line);
      const b = /^\s*from\s+([\w.]+)\s+import\b/.exec(line);
      if (a) mods = a[1].split(',').map((x) => x.trim().split(/\s+/)[0]);
      else if (b) mods = [b[1]];
      for (const m of mods) {
        const top = m.split('.')[0];
        if (!top || PY_STDLIB.has(top) || local.has(top)) continue;
        if (!uses.has(top)) uses.set(top, { files: new Set(), areas: new Set() });
        uses.get(top).files.add(f);
        uses.get(top).areas.add(areaOf(f));
      }
    }
  }
  return uses;
}

// ----------------------------------------------------------------------------------------------------------- programs

const PROGRAM_RES = [
  [/\bonPath\(\s*['"]([\w.+-]+)['"]/g, 'looked up on PATH'],
  [/\bprogramOnPath\(\s*['"]([\w.+-]+)['"]/g, 'looked up on PATH'],
  [/\bwhich\(\s*['"]([\w.+-]+)['"]/g, 'looked up on PATH'],
  [/\b(?:spawn|spawnSync|execFile|execFileSync|execa|execaSync|runProgram|safeExecFile)\(\s*['"]([\w.+-]+)['"]/g, 'started by name'],
  [/\bsearchPath\(\s*['"]([\w.+-]+)['"]/g, 'looked up on PATH'],
  [/\bexecSync\(\s*['"`]([\w.+-]+)\s/g, 'started through a shell'],
];
const NOT_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'cmd', 'env', 'true', 'false', 'echo', 'printf', 'cat', 'ls', 'test', 'kill', 'sleep', 'ps', 'id', 'uname', 'which', 'command', 'x', 'cmd.exe']);

/** Programs the code starts or looks up by name, outside tests: name → { how, files, areas }. */
export function scanPrograms(root, files) {
  const out = new Map();
  for (const f of files) {
    if (!JS_EXT.test(f) || f.endsWith('.d.ts') || f.startsWith('tests/') || f.startsWith('.agents/') || f.startsWith('my-react-app/')) continue;
    const text = readText(join(root, f));
    if (text === null) continue;
    const code = stripComments(text);
    for (const [re, how] of PROGRAM_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        const name = m[1];
        if (NOT_PROGRAMS.has(name) || name.length < 2) continue;
        if (!out.has(name)) out.set(name, { how: new Set(), files: new Set(), areas: new Set() });
        const e = out.get(name);
        e.how.add(how); e.files.add(f); e.areas.add(areaOf(f));
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------------------- registries

const str = (v) => (typeof v === 'string' ? v : null);

/**
 * The registries the code keeps, each read from its literal. A registry that cannot be read is reported with why
 * (unknown), never left out silently.
 */
export function readRegistries(root, files) {
  const has = new Set(files);
  const out = { items: [], problems: [] };
  const src = (file) => (has.has(file) ? readText(join(root, file)) : null);
  const note = (file, what, why) => out.problems.push({ file, what, why });
  const push = (item) => out.items.push(item);

  // Native apps (/c4d, /ae, /blender, /scad, /freecad, /unreal, /illustrator).
  {
    const file = 'src/native/index.ts';
    const s = src(file);
    if (s === null) note(file, 'NATIVE_APPS', 'not in this tree');
    else {
      const r = constLiteral(s, 'NATIVE_APPS');
      if (!r.ok) note(file, 'NATIVE_APPS', r.why);
      else for (const [id, v] of Object.entries(r.value)) {
        push({ registry: 'native apps', file, id, name: str(v.name) ?? id, kind: 'application', program: str(v.program), env: str(v.envVar), setup: str(v.setup), area: 'Native apps' });
      }
    }
  }

  // Code agents (/agent).
  {
    const file = 'src/code-agents/index.ts';
    const s = src(file);
    if (s === null) note(file, 'AGENTS', 'not in this tree');
    else {
      const r = constLiteral(s, 'AGENTS');
      if (!r.ok) note(file, 'AGENTS', r.why);
      else for (const [id, v] of Object.entries(r.value)) {
        push({ registry: 'code agents', file, id, name: str(v.title) ?? id, kind: 'application', program: str(v.bin), env: [str(v.binEnv), str(v.modelEnv)].filter(Boolean).join(', ') || null, setup: null, area: 'Code agents (/agent)' });
      }
    }
  }

  // Lanes (the monitor's agent lanes and API lanes).
  {
    const file = 'src/agent/lanes.ts';
    const s = src(file);
    if (s === null) note(file, 'LANE_RUNNERS', 'not in this tree');
    else {
      const r = constLiteral(s, 'LANE_RUNNERS');
      if (!r.ok) note(file, 'LANE_RUNNERS', r.why);
      else for (const [id, v] of Object.entries(r.value)) {
        const api = Boolean(str(v.key));
        const url = /https?:\/\/([^/\s"'$]+)/.exec(str(v.task) ?? '');
        const host = url ? url[1] : null;
        const local = host ? /^(localhost|127\.0\.0\.1)(:|$)/.test(host) : false;
        push({ registry: 'lanes', file, id, name: str(v.label) ?? id, kind: api ? 'service' : 'application', program: api ? null : str(v.cmd), env: str(v.key), setup: str(v.install), model: str(v.model), area: 'Monitor lanes (timmy watch --lanes)', ...(api ? { host, classification: local ? 'local' : 'external' } : {}) });
      }
    }
  }

  // Model and media providers (the provider registry).
  {
    const file = 'src/agent/provider-registry.ts';
    const s = src(file);
    if (s === null) note(file, 'PROVIDER_REGISTRY', 'not in this tree');
    else {
      const r = constLiteral(s, 'PROVIDER_REGISTRY');
      if (!r.ok) note(file, 'PROVIDER_REGISTRY', r.why);
      else for (const v of r.value) {
        if (!v || typeof v !== 'object') continue;
        const envs = Array.isArray(v.env) ? v.env : Array.isArray(v.envVars) ? v.envVars : [];
        let host = null;
        try { host = str(v.baseUrl) ? new URL(v.baseUrl).host : null; } catch { host = null; }
        push({
          registry: 'providers', file, id: str(v.id) ?? '?', name: str(v.label) ?? str(v.name) ?? str(v.id) ?? '?', kind: 'service',
          classification: str(v.classification), host, env: envs.map((e) => str(e?.name)).filter(Boolean).join(', ') || null,
          models: [
            ...(Array.isArray(v.models) ? v.models.map((m) => ({ id: str(m?.id), use: str(m?.use), label: str(m?.label) })).filter((m) => m.id) : []),
            ...(str(v.defaultModel) && !(Array.isArray(v.models) && v.models.some((m) => m?.id === v.defaultModel)) ? [{ id: v.defaultModel, use: 'default', label: 'the provider entry\'s default model' }] : []),
          ],
          services: Array.isArray(v.services) ? v.services.filter((x) => typeof x === 'string') : [],
          area: 'Chat agent and its tools',
        });
      }
    }
  }

  // Vision adapters (timmy vision integrations).
  {
    const file = 'src/vision/integrations/registry.ts';
    const s = src(file);
    if (s === null) note(file, 'integrationDefinitions', 'not in this tree');
    else {
      const r = returnedLiteral(s, 'integrationDefinitions');
      if (!r.ok) note(file, 'integrationDefinitions', r.why);
      else for (const v of r.value) {
        if (!v || typeof v !== 'object') continue;
        push({ registry: 'vision adapters', file, id: str(v.id) ?? '?', name: str(v.name) ?? '?', kind: 'library', program: null, env: null, setup: 'timmy vision integrations list', runtime: str(v.executionKind), area: 'Vision (/observe, Look, adapters)' });
      }
    }
  }

  // VoxVision's tools (the table at the head of src/vox/tools.ts) and its later viewer layers.
  {
    const file = 'src/vox/tools.ts';
    const s = src(file);
    if (s === null) note(file, 'tools table', 'not in this tree');
    else {
      const head = s.slice(0, s.indexOf('*/') > 0 ? s.indexOf('*/') : 0).split('\n');
      const start = head.findIndex((l) => /^\s*\*\s+tool\s{2,}reads\s{2,}runs\s{2,}needs\s*$/.test(l));
      if (start < 0) note(file, 'tools table', 'the header table (tool, reads, runs, needs) was not found');
      else for (const line of head.slice(start + 1)) {
        const cells = line.replace(/^\s*\*\s+/, '').split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
        if (cells.length < 4) break;
        push({ registry: 'VoxVision tools', file, id: cells[0], name: `VoxVision ${cells[0]}: ${cells[1]}`, kind: 'application', program: null, env: null, setup: cells[3], runs: cells[2], area: 'VoxVision' });
      }
    }
    const lfile = 'src/vox/layers.ts';
    const l = src(lfile);
    if (l !== null) {
      const r = constLiteral(l, 'LATER_LAYERS');
      if (!r.ok) note(lfile, 'LATER_LAYERS', r.why);
      else for (const v of r.value) {
        if (!v || typeof v !== 'object') continue;
        push({ registry: 'VoxVision viewer layers', file: lfile, id: str(v.tool) ?? str(v.id) ?? '?', name: str(v.name) ?? str(v.tool) ?? '?', kind: 'library', program: null, env: null, setup: str(v.setup), area: 'VoxVision' });
      }
      const rr = /RERUN_SETUP\s*=\s*"([^"]+)"/.exec(l);
      push({ registry: 'VoxVision viewer layers', file: lfile, id: 'rerun', name: "Rerun's viewer (/vox view)", kind: 'application', program: 'rerun', env: 'TIMMY_RERUN', setup: rr ? rr[1] : null, area: 'VoxVision' });
    }
  }

  // MCP-to-CLI routes (/mcp).
  {
    const file = 'src/connectors/mcp-cli.ts';
    const s = src(file);
    if (s === null) note(file, 'mcpRoutes', 'not in this tree');
    else {
      const seen = new Set();
      const re = /\{\s*id:\s*'([\w-]+)',\s*label:\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(s))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        push({ registry: 'MCP routes', file, id: m[1], name: m[2], kind: 'library', program: m[1] === 'mcporter' ? 'mcporter' : null, env: 'TIMMY_MCP_HOME', setup: null, area: 'MCP (/mcp)' });
      }
      if (!seen.size) note(file, 'mcpRoutes', 'no route literal ({ id, label }) was found');
    }
  }

  // /tools rows (src/capabilities/index.ts): each row's id and name, the program it looks for, the keys it reads.
  {
    const file = 'src/capabilities/index.ts';
    const s = src(file);
    if (s === null) note(file, 'capability rows', 'not in this tree');
    else {
      const rows = new Map();
      const prog = /\bprogram\(\s*'([\w-]+)',\s*'(\w+)',\s*'([^']+)',\s*'([^']+)'/g;
      let m;
      while ((m = prog.exec(s))) rows.set(m[1], { id: m[1], kind: m[2], name: m[3], program: m[4] });
      const add = /\{\s*id:\s*'([\w-]+)',\s*kind:\s*'(\w+)',\s*name:\s*'([^']+)'/g;
      while ((m = add.exec(s))) if (!rows.has(m[1])) rows.set(m[1], { id: m[1], kind: m[2], name: m[3], program: null });
      for (const r of rows.values()) push({ registry: '/tools rows', file, id: r.id, name: r.name, kind: r.kind === 'model' ? 'service' : 'application', program: r.program, env: null, setup: null, rowKind: r.kind, area: 'Capabilities (/tools)' });
      out.toolsEnv = sortStrings(uniq([...s.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((x) => x[1])));
    }
  }

  for (const it of out.items) {
    for (const k of ['setup', 'name', 'runs']) if (it[k]) it[k] = scrubText(it[k]);
  }
  return out;
}

/** Environment variable names the code reads (process.env.X, env.X, env['X']), outside tests: name → files. */
export function scanEnvNames(root, files) {
  const out = new Map();
  for (const f of files) {
    if (!JS_EXT.test(f) || f.endsWith('.d.ts') || f.startsWith('tests/') || f.startsWith('.agents/') || f.startsWith('my-react-app/')) continue;
    const text = readText(join(root, f));
    if (text === null) continue;
    const code = stripComments(text);
    for (const m of code.matchAll(/\b(?:process\.env|env)(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\])/g)) {
      const name = m[1] ?? m[2];
      if (!out.has(name)) out.set(name, new Set());
      out.get(name).add(f);
    }
  }
  return out;
}
