/**
 * Round R4 (helper H106): the inventory generator, scripts/inventory/inventory.mjs, run as a real child process (node), on
 * a FIXTURE tree made here in a temporary folder and on this repository itself.
 *
 * What it shows: the output is valid JSON in CycloneDX 1.5's shape; every lockfile package is a component with its exact
 * version (the root's, and every other non-excluded project's, nested); no absolute local path is in any output, and a run
 * whose output would carry one writes nothing and exits 3 (a negative control); the same inputs and --date give the same
 * bytes twice. On the FIXTURE, the reconciliation itself: a declared package never imported, an import resolved only by a
 * transitive copy, an npm alias, a nested copy, a platform package not installed, an installed version that differs, the
 * licence's source, Python imports against a requirements file, a container's pins, excluded skill material, and the
 * feature ledger joined with an overlay (an unmatched overlay id and a cited file that is missing are both reported).
 *
 * Round R4 (H106, second part): the capability matrix (capabilities.json, CAPABILITY-MATRIX.md). Every row has every
 * column; each status is one of the allowed levels; a capability with no operation path is flagged, as is one whose only
 * path exits 69 and one that names a path the code does not have; the paths `timmy act` derives, refuses or cannot run;
 * a rehearsal's fact and its open defect; acceptance only as the operator recorded it; no local path; the same bytes twice.
 *
 * FAKE pieces, labelled: the FIXTURE tree is invented (its packages, its installed tree, its checklist, ledger and overlay,
 * its REPL commands, CLI, `timmy act`, rehearsal and acceptance all say FIXTURE); no registry, network or git history is
 * involved for it. The repository run reads this checkout as it is.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { namesLocalPath } from '../scripts/inventory/lib/common.mjs';
import { runAsync } from './helpers/run-async.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'inventory', 'inventory.mjs');
const made: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

type Ran = { status: number | null; stdout: string; stderr: string };
/**
 * The generator as a child process, awaited (R5 lead: it was spawnSync, and these files' four runs at collection held a
 * test worker's event loop for 70.6 s in the gate on a77d80d, its heartbeat says, and vitest then reports "Timeout calling
 * onTaskUpdate" though every test passed). Each run is awaited in a hook or a test with its own time limit.
 */
async function run(args: string[]): Promise<Ran> {
  const r = await runAsync(process.execPath, [SCRIPT, ...args], { timeout: 120_000, env: { ...process.env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const RUNS_MS = 260_000;

const put = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
/**
 * An import line for a FIXTURE file, built here so that this test's own text holds no literal import of a FIXTURE package
 * (the generator, run on this repository, reads this file too).
 */
const importLine = (what: string, from: string): string => `import ${what} from '${from}';`;

/** The FIXTURE tree: an app with an installed tree, a lane, skill material, Python, a container, and its feature documents. */
function makeFixture(root: string, o: { leak?: boolean } = {}): void {
  const integrity = `sha512-${createHash('sha512').update('FIXTURE left-pad').digest('base64')}`;
  const manifest = {
    name: 'fixture-app', version: '1.0.0', license: 'MIT', description: 'FIXTURE',
    dependencies: { 'left-pad': '^1.3.0', '@fx/scoped': '2.0.0', 'never-used': '^1.0.0', aliased: 'npm:real-name@^3.0.0' },
    devDependencies: { 'dev-tool': '^0.1.0', '@types/left-pad': '^1.0.0' },
    optionalDependencies: { 'opt-mac': '1.0.0' },
    scripts: { build: 'dev-tool build' },
    files: ['dist', 'workers/run.py', 'missing-entry'],
  };
  put(root, 'package.json', json(manifest));
  const { name: _n, version: _v, description: _d, scripts: _s, files: _f, ...decl } = manifest;
  put(root, 'package-lock.json', json({
    name: 'fixture-app', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'fixture-app', version: '1.0.0', ...decl },
      'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity, license: 'WTFPL' },
      'node_modules/@fx/scoped': { version: '2.0.0', license: 'MIT', dependencies: { 'inner-dep': '^1.0.0' } },
      'node_modules/@fx/scoped/node_modules/inner-dep': { version: '1.1.0', license: 'ISC' },
      'node_modules/inner-dep': { version: '0.9.0', license: 'ISC', dev: true },
      'node_modules/never-used': { version: '1.0.0' },
      'node_modules/aliased': { name: 'real-name', version: '3.1.0', license: 'Apache-2.0', dependencies: { 'transitive-only': '^4.0.0' } },
      'node_modules/transitive-only': { version: '4.5.6', license: '(MIT OR Apache-2.0)' },
      'node_modules/dev-tool': { version: '0.1.2', dev: true, license: 'MIT', bin: { 'dev-tool': 'cli.js' } },
      'node_modules/@types/left-pad': { version: '1.2.0', dev: true, license: 'MIT' },
      'node_modules/opt-mac': { version: '1.0.0', optional: true, os: ['darwin'], cpu: ['arm64'], license: 'MIT', hasInstallScript: true },
    },
  }));
  // The installed tree: never-used names its licence only here; dev-tool is installed at another version; opt-mac is absent.
  put(root, 'node_modules/left-pad/package.json', json({ name: 'left-pad', version: '1.3.0', license: 'WTFPL' }));
  put(root, 'node_modules/@fx/scoped/package.json', json({ name: '@fx/scoped', version: '2.0.0', license: 'MIT' }));
  put(root, 'node_modules/@fx/scoped/node_modules/inner-dep/package.json', json({ name: 'inner-dep', version: '1.1.0', license: 'ISC' }));
  put(root, 'node_modules/inner-dep/package.json', json({ name: 'inner-dep', version: '0.9.0', license: 'ISC' }));
  put(root, 'node_modules/never-used/package.json', json({ name: 'never-used', version: '1.0.0', license: 'BSD-2-Clause' }));
  put(root, 'node_modules/aliased/package.json', json({ name: 'real-name', version: '3.1.0', license: 'Apache-2.0' }));
  put(root, 'node_modules/transitive-only/package.json', json({ name: 'transitive-only', version: '4.5.6', license: '(MIT OR Apache-2.0)' }));
  put(root, 'node_modules/dev-tool/package.json', json({ name: 'dev-tool', version: '0.1.3', license: 'MIT' }));
  put(root, 'node_modules/@types/left-pad/package.json', json({ name: '@types/left-pad', version: '1.2.0', license: 'MIT' }));
  put(root, 'node_modules/left-pad/lib/pad.wasm', 'FIXTURE, not WebAssembly\n');
  put(root, 'node_modules/stray/package.json', json({ name: 'stray', version: '0.0.1', description: 'FIXTURE: installed, in no lockfile' }));

  put(root, 'src/index.ts', [
    '// FIXTURE source',
    importLine('leftPad', 'left-pad'),
    importLine('{ thing }', '@fx/scoped/deep/path.js'),
    importLine('real', 'aliased'),
    importLine('inner', 'inner-dep'),
    importLine('{ readFileSync }', 'node:fs'),
    importLine('{ spawnSync }', 'node:child_process'),
    `const generated = ${JSON.stringify(importLine('nope', 'not-a-package-anywhere'))};`,
    "spawnSync('fixture-tool', ['--version']);",
    'export const key = process.env.FIXTURE_API_KEY;',
    'export default [leftPad, thing, real, inner, readFileSync, generated];',
    '',
  ].join('\n'));
  put(root, 'tests/a.test.ts', `// FIXTURE test\n${importLine('leftPad', 'left-pad')}\nexport const t = leftPad;\n`);
  put(root, 'workers/run.py', '# FIXTURE worker\nimport json\nimport numpy\nimport cv2\nimport run_helper\n');
  put(root, 'workers/run_helper.py', '# FIXTURE helper\n');
  put(root, 'requirements.txt', '# FIXTURE requirements\nnumpy==1.26.4\nopencv-python-headless>=4.9 ; python_version >= "3.10"\n-r other.txt\n');
  put(root, 'workers/Dockerfile', 'FROM python:3.12-slim\nRUN pip install --no-cache-dir rich==13.7.1 \\\n    textual\nRUN apt-get update && apt-get install -y --no-install-recommends git\n');
  put(root, 'lanes/x/package.json', json({ name: 'fixture-lane', private: true, dependencies: { 'lane-dep': '^2.0.0' } }));
  put(root, 'lanes/x/package-lock.json', json({ name: 'fixture-lane', lockfileVersion: 3, packages: { '': { name: 'fixture-lane', dependencies: { 'lane-dep': '^2.0.0' } }, 'node_modules/lane-dep': { version: '2.1.0', license: 'MIT' } } }));
  put(root, 'lanes/x/index.mjs', `// FIXTURE lane\n${importLine('laneDep', 'lane-dep')}\nexport default laneDep;\n`);
  put(root, '.agents/skills/demo/package.json', json({ name: 'fixture-skill-example', dependencies: { 'skill-only': '1.0.0' } }));
  // The control paths the matrix reads (FIXTURE): REPL commands, the CLI with one verb that exits 69, and `timmy act`.
  put(root, 'src/repl/commands.ts', [
    '// FIXTURE REPL commands',
    'export const COMMANDS = [',
    "  { name: 'hello', group: 'work', description: 'FIXTURE: say hello', run: inWorkspace((w, a) => w.hello(a)) },",
    "  { name: 'wave', group: 'work', description: 'FIXTURE: wave at a person', run: inWorkspace((w, a) => w.wave(a)) },",
    "  { name: 'setup', group: 'setup', description: 'FIXTURE: the setup', run: (a, ctx) => ctx.setup?.(a) },",
    '];',
    '',
  ].join('\n'));
  put(root, 'src/ops/act.ts', [
    '// FIXTURE timmy act',
    'export function needsPerson(line: string): string | undefined {',
    "  const [word] = line.slice(1).split(' ');",
    '  switch (word) {',
    "    case 'wave': return '/wave needs a person (FIXTURE)';",
    '    default: return undefined;',
    '  }',
    '}',
    'export function act(ws: unknown, glyphs: unknown): unknown {',
    '  const ctx: ReplContext = {',
    '    print: (segs: unknown) => segs,',
    '    glyphs,',
    '    workspace: ws,',
    '  };',
    '  return ctx;',
    '}',
    '',
  ].join('\n'));
  put(root, 'src/cli.ts', [
    '// FIXTURE CLI',
    'const command = process.argv[2];',
    "if (command === 'act') { await import('./ops/act.js'); }",
    "if (command === 'hello') { await import('./hello/cli.js'); }",
    "if (command === 'later') { await import('./later/cli.js'); }",
    'function printHelp(): void {',
    '  console.log(`Commands:',
    '  act "<slash command>"   FIXTURE: one REPL command, headlessly',
    '  hello                   FIXTURE: say hello',
    '  later                   FIXTURE: being built; exits 69 until it is',
    'Options:',
    '  --help`);',
    '}',
    'printHelp();',
    '',
  ].join('\n'));
  put(root, 'src/hello/cli.ts', '// FIXTURE hello\nexport const hello = 1;\n');
  put(root, 'src/later/cli.ts', '// FIXTURE: not built in this revision\nexport function run(): number { return 69; }\n');

  const leak = o.leak ? ` (kept at ${join(root, 'private', 'notes.txt')})` : '';
  put(root, 'docs/ui-cockpit/FEATURE-CHECKLIST.md', [
    '# FIXTURE feature checklist',
    '',
    'Date: 2026-10-01. FIXTURE, drafted at `abc1234`.',
    '',
    '## 1. Fixture features',
    '',
    '| Feature | Planned | Implemented | Tested | Demonstrated | Blocker / user action | Evidence |',
    '|---|---|---|---|---|---|---|',
    '| `/hello` says hello | ✓ | ✓ (`abc1234`) | ✓ fakes (a FAKE greeter) | ✓ scripted, row 2 (`abc1234`) | – | `src/index.ts`; `tests/a.test.ts` |',
    `| \`/missing\` names a file that is gone | – | – | – | – | a licence${leak} | \`src/missing.ts\` |`,
    '',
  ].join('\n'));
  put(root, 'docs/ui-cockpit/CHECKPOINTS.md', [
    '# FIXTURE ledger',
    '',
    '| # | Step | Status | Evidence |',
    '|---|---|---|---|',
    '| 1 | FIXTURE: the first step | done | FIXTURE |',
    "| 2 | FIXTURE r1 on the operator's Mac (at `abc1234`), scripted | done | FIXTURE |",
    '',
  ].join('\n'));
  put(root, 'docs/ui-cockpit/inventory/overlay.json', json({
    schema: 'timmy.inventory-overlay/1', pass: 1,
    stages: [{ id: 'preview', title: 'FIXTURE preview', remaining: ['FIXTURE item'], range: 'FIXTURE range', assumptions: ['FIXTURE assumption'] }],
    features: { '1-hello-says-hello': { benefit: 'FIXTURE benefit', owner: 'FIXTURE owner', next: 'FIXTURE next' }, 'no-such-feature': { benefit: 'FIXTURE stale' } },
    added: [{ id: 'fixture-added', entry: '/fixture', feature: 'FIXTURE added feature', implemented: '✓ (`src/index.ts`)', tested: '–', demonstrated: '–', blocker: '–', evidence: '`src/index.ts`', benefit: 'FIXTURE added benefit', stage: 'preview' }],
    conflicts: [{ what: 'FIXTURE conflict', says: 'FIXTURE says', code: ['src/index.ts', 'src/gone.ts'], resolution: 'FIXTURE resolution' }],
    notReconciled: [{ what: 'FIXTURE gap', why: 'FIXTURE why', next: 'FIXTURE next pass' }],
    capabilities: [
      { id: 'fx-hello', screen: 'Chat', feature: 'FIXTURE: say hello', renderers: ['FIXTURE renderer'], inputs: 'FIXTURE in', outputs: 'FIXTURE out', features: ['1-hello-says-hello'], paths: { repl: ['hello'], cli: ['hello'] }, owner: 'FIXTURE owner', weight: 1 },
      { id: 'fx-nothing', screen: 'REA', feature: 'FIXTURE: read about only', researched: { says: 'FIXTURE: researched only' } },
      { id: 'fx-later', screen: 'Files', feature: 'FIXTURE: advertised, not built', paths: { repl: ['nosuch'], cli: ['later'] }, code: ['src/later/cli.ts'] },
      { id: 'fx-setup', screen: 'Connections', feature: 'FIXTURE: the setup', paths: { repl: ['setup'] }, code: ['src/index.ts'], tests: ['tests/a.test.ts'] },
      { id: 'fx-wave', screen: 'Nowhere', feature: 'FIXTURE: a screen that is not one', paths: { repl: ['wave'] }, code: ['src/index.ts'] },
    ],
    rehearsals: [{
      id: 'r1', revision: 'abc1234', date: '2026-10-01', where: 'FIXTURE Mac', how: 'FIXTURE, scripted', source: 'FIXTURE report',
      facts: [{ step: 'U1', ran: 'FIXTURE: /hello typed', caps: { 'fx-hello': 'both' }, defects: ['D1'] }],
      notRun: ['FIXTURE: /wave'], defects: { D1: { says: 'FIXTURE defect', state: 'open', owner: 'FIXTURE owner' } },
    }],
    suites: [{ revision: 'abc1234', kind: 'full suite', result: 'FIXTURE: passed', source: 'FIXTURE' }],
    screens: [{ name: 'Chat', group: 'Create', notBuilt: ['FIXTURE: not built'] }],
    acceptance: [
      { capability: 'fx-hello', by: 'operator', date: '2026-10-01', source: 'FIXTURE note (not a real acceptance)', visual: 'accepted (FIXTURE)' },
      { capability: 'fx-setup', visual: 'accepted' },
    ],
  }));
}

interface Component { 'bom-ref': string; type: string; name: string; version?: string; scope?: string; purl?: string; licenses?: Array<{ license?: { id?: string; name?: string }; expression?: string }>; properties?: Array<{ name: string; value: string }>; components?: Component[] }
interface Bom { bomFormat: string; specVersion: string; serialNumber: string; version: number; metadata: { timestamp: string; component: Component; properties?: Array<{ name: string; value: string }> }; components: Component[]; services: Array<{ name: string }>; dependencies: Array<{ ref: string; dependsOn: string[] }> }

const read = (dir: string, f: string): string => readFileSync(join(dir, f), 'utf8');
const prop = (c: Component | undefined, name: string): string | undefined => c?.properties?.find((p) => p.name === `timmy:${name}`)?.value;
const OUT_FILES = ['CAPABILITY-MATRIX.md', 'INVENTORY.md', 'capabilities.json', 'features.json', 'sbom.json'];
const outputs = (dir: string): Record<string, string> => Object.fromEntries(OUT_FILES.map((f) => [f, read(dir, f)]));

/** The matrix's row, as capabilities.json writes it. */
interface Level { level: string; revision: string | null; evidence: string; run?: string; tests?: Array<{ file: string }> }
interface Path { path: string; from: string; words: string; stub?: boolean; note?: string }
interface Row {
  id: string; screen: string; feature: string; provider: string[]; controlPaths: Record<string, Path[]>; operationPath: boolean;
  notPaths: string[]; namedNotFound: string[]; renderers: string[]; inputs: string; outputs: string; backend: Level; ui: Level;
  evidenceRevision: { backend: string | null; ui: string | null; codeSinceLive: unknown }; visualAcceptance: string; usabilityAcceptance: string;
  acceptanceSource?: string; defects: Array<{ id: string; says: string; state: string; owner: string | null }>; blocker: string; owner: string; flags: string[];
}
interface Matrix { schema: string; levels: string[]; pathKinds: string[]; screens: Array<{ name: string }>; counts: { capabilities: number; withoutPath: number; accepted: number }; gaps: { top: string[] }; rows: Row[]; problems: string[] }
const COLUMNS = ['id', 'screen', 'feature', 'provider', 'controlPaths', 'operationPath', 'notPaths', 'namedNotFound', 'renderers', 'inputs', 'outputs',
  'backend', 'ui', 'evidenceRevision', 'visualAcceptance', 'usabilityAcceptance', 'defects', 'blocker', 'owner', 'flags'];
const LEVELS = ['researched', 'designed', 'implemented', 'tested here', 'live-qualified on the Mac'];
const SCREENS = ['Chat', 'Studio', 'VoxVision', '3D Create', 'Motion', 'Workflows', 'Control Room', "God's Eye View", 'REA', 'All tools', 'Connections', 'Files'];

/** Every row has every column; each status is an allowed level with its evidence; a row with no operation path says so. */
function checkRows(m: Matrix): void {
  expect(m.schema).toBe('timmy.capability-matrix/1');
  expect(m.levels).toEqual(LEVELS);
  for (const r of m.rows) {
    for (const c of COLUMNS) expect(r, `${r.id} ${c}`).toHaveProperty(c);
    for (const k of m.pathKinds) expect(Array.isArray(r.controlPaths[k]), `${r.id} ${k}`).toBe(true);
    for (const s of [r.backend, r.ui]) {
      expect(LEVELS, r.id).toContain(s.level);
      expect(typeof s.evidence, r.id).toBe('string');
      expect(s.evidence.length, r.id).toBeGreaterThan(0);
    }
    if (r.backend.level === 'tested here') expect(r.backend.tests?.length, r.id).toBeGreaterThan(0); // "tested here" names the test file
    if (r.backend.level === 'live-qualified on the Mac') expect(r.backend.run, r.id).toBeTruthy(); // and live names the run
    expect(r.operationPath, r.id).toBe(m.pathKinds.some((k) => r.controlPaths[k].some((p) => !p.stub)));
    if (!r.operationPath) expect(r.flags, r.id).toContain('no operation path');
    expect(typeof r.visualAcceptance).toBe('string');
    expect(typeof r.usabilityAcceptance).toBe('string');
  }
}

/**
 * Every absolute local path this computer could leak, and the home-style patterns. This run's own folders (each one this file
 * made with mkdtemp, real path too) and each `extra` path count anywhere in the text. The temporary folder and the home folder
 * themselves count as the generator's guard counts them (namesLocalPath; the rule is written out here, not imported, so this
 * check stays independent of it): a folder of one segment, as /tmp, only as the start of a longer path, so /tmp/<anything>
 * is a leak and a checklist row's words "a patch file under /tmp" are not (R5 H130: this check took those words, unchanged
 * since 537e898, for a leak wherever the temporary folder is /tmp); a longer folder anywhere.
 */
function leaks(text: string, extra: string[]): string[] {
  const out: string[] = [];
  const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  for (const p of new Set([...made, ...made.map(real), ...extra].filter((x) => x.length > 1))) if (text.includes(p)) out.push(`the local path ${p}`);
  for (const p of new Set([homedir(), tmpdir(), real(tmpdir())].filter((x) => x.length > 1))) {
    if (/^\/[^/]+$/.test(p) ? text.includes(`${p}/`) : text.includes(p)) out.push(`the local path ${p}`);
  }
  for (const re of [/\/Users\/[A-Za-z0-9._-]+/, /\/home\/[A-Za-z0-9._-]+/, /[A-Za-z]:\\Users\\/]) { const m = re.exec(text); if (m) out.push(m[0]); }
  return out;
}

describe('the inventory generator on a FIXTURE tree', () => {
  const root = temp('inv-fixture-');
  makeFixture(root);
  const outA = temp('inv-out-a-');
  const outB = temp('inv-out-b-');
  let a: Ran;
  let b: Ran;
  beforeAll(async () => {
    a = await run(['--root', root, '--date', '2026-10-01', '--out', outA]);
    b = await run(['--root', root, '--date', '2026-10-01', '--out', outB]);
  }, RUNS_MS);

  it('runs, writes its five files and says what it counted', () => {
    expect(a.stderr).toBe('');
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('inventory 2026-10-01: 10 locked npm entries');
    expect(readdirSync(outA).sort()).toEqual(OUT_FILES);
    expect(a.stdout).toContain('5 capabilities (2 without an operation path)');
  });

  it('writes valid CycloneDX 1.5 JSON with the given date', () => {
    const bom = JSON.parse(read(outA, 'sbom.json')) as Bom;
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.specVersion).toBe('1.5');
    expect(bom.version).toBe(1);
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(bom.metadata.timestamp).toBe('2026-10-01T00:00:00Z');
    expect(bom.metadata.component.name).toBe('fixture-app');
    for (const c of bom.components) {
      expect(typeof c['bom-ref']).toBe('string');
      expect(['library', 'application', 'framework', 'container', 'machine-learning-model']).toContain(c.type);
      if (c.scope) expect(['required', 'optional', 'excluded']).toContain(c.scope);
    }
    expect(new Set(bom.components.map((c) => c['bom-ref'])).size).toBe(bom.components.length);
  });

  it('has every lockfile package with its exact version, the alias under its real name and the nested copy apart', () => {
    const bom = JSON.parse(read(outA, 'sbom.json')) as Bom;
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { name?: string; version: string }> };
    const have = new Set(bom.components.filter((c) => c.purl?.startsWith('pkg:npm/')).map((c) => `${c.name}@${c.version}`));
    for (const [key, e] of Object.entries(lock.packages)) {
      if (!key) continue;
      const name = e.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      expect(have, `${key}`).toContain(`${name}@${e.version}`);
    }
    const byRef = (ref: string): Component | undefined => bom.components.find((c) => c['bom-ref'] === ref);
    const real = byRef('pkg:npm/real-name@3.1.0');
    expect(prop(real, 'relation')).toBe('direct dependency (npm:real-name@^3.0.0), declared as aliased');
    expect(prop(byRef('pkg:npm/transitive-only@4.5.6'), 'introduced-by')).toBe('aliased');
    expect(byRef('pkg:npm/transitive-only@4.5.6')?.licenses).toEqual([{ expression: 'MIT OR Apache-2.0' }]);
    expect(prop(byRef('pkg:npm/inner-dep@1.1.0'), 'lock-paths')).toBe('node_modules/@fx/scoped/node_modules/inner-dep');
    expect(byRef('pkg:npm/%40fx/scoped@2.0.0')).toBeDefined();
    // The lane's own lockfile, nested under its manifest.
    const lane = bom.components.find((c) => c['bom-ref'] === 'manifest:lanes/x/package.json');
    expect(lane?.components?.map((c) => `${c.name}@${c.version}`)).toEqual(['lane-dep@2.1.0']);
  });

  it('reconciles the installed tree, the licences and the scopes', () => {
    const bom = JSON.parse(read(outA, 'sbom.json')) as Bom;
    const byRef = (ref: string): Component | undefined => bom.components.find((c) => c['bom-ref'] === ref);
    const opt = byRef('pkg:npm/opt-mac@1.0.0');
    expect(opt?.scope).toBe('optional');
    expect(prop(opt, 'installed')).toBe('not installed here: built for os darwin, cpu arm64');
    expect(prop(opt, 'install-script')).toBe('yes (runs at install)');
    expect(prop(opt, 'license-source')).toBe('lockfile');
    const dev = byRef('pkg:npm/dev-tool@0.1.2');
    expect(dev?.scope).toBe('excluded');
    expect(prop(dev, 'installed')).toBe('differs: 0.1.3 installed');
    expect(prop(dev, 'usage')).toBe('not imported: run by package.json scripts (build)');
    const never = byRef('pkg:npm/never-used@1.0.0');
    expect(never?.licenses).toEqual([{ license: { id: 'BSD-2-Clause' } }]); // from the installed package.json; the lockfile names none
    expect(prop(never, 'license-source')).toBeUndefined(); // the default: the installed package.json
    expect(prop(never, 'usage')).toBe('not imported: no evidence of use (not imported, not run by a script, not named in the code searched)');
    expect(prop(byRef('pkg:npm/%40types/left-pad@1.2.0'), 'usage')).toBe('not imported: type definitions for left-pad, read by the TypeScript compiler');
    expect(prop(byRef('pkg:npm/left-pad@1.3.0'), 'feature')).toBe('Core (other src/), Tests only');
    expect(prop(byRef('pkg:npm/left-pad@1.3.0'), 'binaries')).toBe('lib/pad.wasm (in the installed tree read)');
    const md = read(outA, 'INVENTORY.md');
    expect(md).toContain('Installed but not in the lockfile: `stray@0.0.1`.');
    expect(md).toContain('| … installed but not in the lockfile | 1 |');
  });

  it('names Python modules, containers, programs and services, and leaves excluded skill material out', () => {
    const bom = JSON.parse(read(outA, 'sbom.json')) as Bom;
    const req = bom.components.find((c) => c['bom-ref'] === 'manifest:requirements.txt');
    expect(req?.components?.find((c) => c.name === 'numpy')).toMatchObject({ version: '1.26.4', purl: 'pkg:pypi/numpy@1.26.4' });
    expect(prop(req?.components?.find((c) => c.name === 'opencv-python-headless'), 'declared-range')).toBe('>=4.9');
    expect(prop(bom.components.find((c) => c['bom-ref'] === 'python-module:numpy'), 'declared-in')).toBe('requirements.txt');
    expect(prop(bom.components.find((c) => c['bom-ref'] === 'python-module:cv2'), 'declared-in')).toBe('requirements.txt');
    expect(bom.components.find((c) => c['bom-ref'] === 'python-module:run_helper')).toBeUndefined(); // the repository's own module
    const image = bom.components.find((c) => c.type === 'container');
    expect(image).toMatchObject({ name: 'python', version: '3.12-slim', purl: 'pkg:docker/python@3.12-slim' });
    expect(prop(image, 'pip')).toBe('rich ==13.7.1; textual');
    expect(prop(image, 'apt')).toBe('git');
    expect(prop(bom.components.find((c) => c['bom-ref'] === 'program:fixture-tool'), 'declared-in')).toBe('started by name in src/index.ts');
    expect(bom.components.some((c) => c.name === 'skill-only' || c.name === 'fixture-skill-example')).toBe(false);
    expect(prop({ 'bom-ref': 'meta', type: 'application', name: 'meta', properties: bom.metadata.properties }, 'excluded')).toContain('.agents/skills/demo/package.json: agent skill material');
  });

  it('builds the feature ledger from the checklist, the ledger and the overlay, and says what does not match', () => {
    const f = JSON.parse(read(outA, 'features.json')) as { features: Array<Record<string, unknown>>; overlay: { unmatchedIds: string[] }; ledger: { rows: number } };
    expect(f.ledger.rows).toBe(2);
    const hello = f.features.find((x) => x.id === '1-hello-says-hello');
    expect(hello).toMatchObject({
      entry: '/hello', implemented: 'yes', tested: 'yes', testedWithFakes: true, demonstrated: 'yes', scripted: true,
      demonstrationRows: [2], demonstratedWhere: ["macOS (the operator's Mac)"], benefit: 'FIXTURE benefit', owner: 'FIXTURE owner', next: 'FIXTURE next',
      changedSinceDemonstration: 'unknown (no git history read)', missingPaths: [],
    });
    const missing = f.features.find((x) => x.id === '1-missing-names-a-file-that-is-gone');
    expect(missing).toMatchObject({ implemented: 'no', missingPaths: ['src/missing.ts'], owner: 'unassigned (the lead assigns)', nextFrom: 'generated' });
    expect(f.features.find((x) => x.id === 'fixture-added')).toMatchObject({ entry: '/fixture', benefit: 'FIXTURE added benefit', stage: 'preview' });
    expect(f.overlay.unmatchedIds).toEqual(['no-such-feature']);
    const md = read(outA, 'INVENTORY.md');
    expect(md).toContain('Date: 2026-10-01. Pass 1: **partial**');
    expect(md).toContain('`src/index.ts` is here, `src/gone.ts` is NOT here');
    expect(md).toContain('Overlay entries that match no feature (stale ids, to correct): `no-such-feature`.');
    expect(md).toMatch(/### Imported but not declared \(1\)[\s\S]*`inner-dep` \| \(the root\) \| 0\.9\.0/);
    expect(md).toContain('`not-a-package-anywhere` in `src/index.ts` (the root project)');
    expect(md).toMatch(/\| `never-used` \| dependency `\^1\.0\.0` \| \*\*none found\*\*/);
    expect(md).toContain('Entries that match no file in the tree read (npm pack leaves a missing entry out without a word): `missing-entry`.');
  });

  it('writes the capability matrix: every row has every column, each status an allowed level with its evidence', () => {
    const m = JSON.parse(read(outA, 'capabilities.json')) as Matrix;
    checkRows(m);
    expect(m.rows.map((r) => r.id).sort()).toEqual(['fx-hello', 'fx-later', 'fx-nothing', 'fx-setup', 'fx-wave']);
    expect(m.counts).toMatchObject({ capabilities: 5, withoutPath: 2, accepted: 1 });
    expect(m.screens.map((x) => x.name)).toEqual(SCREENS);
    expect(m.problems).toContain('fx-wave: screen "Nowhere" is not one of the operator\'s screens');
    const md = read(outA, 'CAPABILITY-MATRIX.md');
    expect(md.startsWith('# Timmy capability matrix\n')).toBe(true);
    // normal readers get the short summary first, the full rows after it
    expect(md.indexOf('## Summary')).toBeGreaterThan(0);
    expect(md.indexOf('## Summary')).toBeLessThan(md.indexOf('## Every capability'));
  });

  it('flags a capability with no operation path, one whose only path exits 69, and a path the code does not have', () => {
    const m = JSON.parse(read(outA, 'capabilities.json')) as Matrix;
    const nothing = m.rows.find((r) => r.id === 'fx-nothing')!;
    expect(nothing.operationPath).toBe(false);
    expect(nothing.flags).toContain('no operation path');
    expect(nothing.backend).toMatchObject({ level: 'researched', evidence: 'FIXTURE: researched only' });
    const later = m.rows.find((r) => r.id === 'fx-later')!;
    expect(later.controlPaths.cli).toEqual([expect.objectContaining({ path: 'timmy later', stub: true })]);
    expect(later.operationPath).toBe(false); // a verb that exits 69 is not an operation path
    expect(later.flags).toEqual(expect.arrayContaining(['no operation path', 'a control path exits 69 (not built)', 'a named path is not in the code']));
    expect(later.namedNotFound).toEqual(['REPL /nosuch']);
    expect(m.gaps.top.slice(0, 2).sort()).toEqual(['fx-later', 'fx-nothing']);
    const md = read(outA, 'CAPABILITY-MATRIX.md');
    expect(md).toMatch(/\| REA \| \[FIXTURE\]\(#fx-nothing\) \| \*\*none\*\* \|/);
    expect(md).toContain('`timmy later` (exits 69: not built)');
  });

  it('derives the headless path, and says which `timmy act` refuses or cannot run', () => {
    const m = JSON.parse(read(outA, 'capabilities.json')) as Matrix;
    const hello = m.rows.find((r) => r.id === 'fx-hello')!;
    expect(hello.controlPaths.repl.map((p) => p.path)).toEqual(['/hello']);
    expect(hello.controlPaths.cli.map((p) => p.path)).toEqual(["timmy act '/hello'", 'timmy hello']);
    const wave = m.rows.find((r) => r.id === 'fx-wave')!;
    expect(wave.notPaths).toEqual(['timmy act refuses /wave: /wave needs a person (FIXTURE)']);
    const setup = m.rows.find((r) => r.id === 'fx-setup')!;
    expect(setup.controlPaths.cli).toEqual([]);
    expect(setup.notPaths[0]).toContain("timmy act cannot run /setup: its run needs the REPL's setup");
    expect(setup.backend.level).toBe('tested here');
    expect(setup.backend.tests?.map((t) => t.file)).toEqual(['tests/a.test.ts']);
  });

  it('takes a rehearsal\'s fact as live evidence with its open defect, and acceptance only as the operator recorded it', () => {
    const m = JSON.parse(read(outA, 'capabilities.json')) as Matrix;
    const hello = m.rows.find((r) => r.id === 'fx-hello')!;
    expect(hello.backend).toMatchObject({ level: 'live-qualified on the Mac', revision: 'abc1234', run: 'r1', evidence: 'r1 U1: FIXTURE: /hello typed' });
    expect(hello.defects).toEqual([{ id: 'r1 D1', says: 'FIXTURE defect', state: 'open', owner: 'FIXTURE owner' }]);
    expect(hello.flags).toContain('an open defect a Mac run found');
    expect(hello.visualAcceptance).toBe('accepted (FIXTURE)');
    expect(hello.usabilityAcceptance).toBe('not reviewed');
    expect(hello.acceptanceSource).toBe('FIXTURE note (not a real acceptance) (2026-10-01)');
    // an entry without the operator, a date and a source is not acceptance
    const setup = m.rows.find((r) => r.id === 'fx-setup')!;
    expect(setup.visualAcceptance).toBe('not reviewed');
    expect(m.problems.some((p) => p.startsWith('an acceptance entry without by: operator'))).toBe(true);
  });

  it('writes no absolute local path, and the same bytes for the same inputs and date', () => {
    const one = outputs(outA);
    const two = outputs(outB);
    expect(b.status).toBe(0);
    for (const [name, text] of Object.entries(one)) {
      expect(leaks(text, [root, realpathSync(root), outA]), name).toEqual([]);
      expect(two[name], name).toBe(text);
    }
  });

  it('writes nothing and exits 3 when its output would carry a local path (a negative control)', async () => {
    const leaky = temp('inv-leaky-');
    makeFixture(leaky, { leak: true });
    const out = temp('inv-out-leaky-');
    const r = await run(['--root', leaky, '--date', '2026-10-01', '--out', out]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('nothing written: the output would carry a local path');
    expect(r.stderr).not.toContain(leaky); // the refusal names what kind of path, never the path
    expect(readdirSync(out)).toEqual([]);
  }, 130_000);

  it('refuses a malformed date and an unknown argument before reading anything', async () => {
    const r1 = await run(['--root', root, '--date', '11/10/2026', '--out', temp('inv-out-bad-')]);
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain('--date takes YYYY-MM-DD');
    const r2 = await run(['--surprise']);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain('unknown argument --surprise');
  }, 250_000);
});

describe('the inventory generator on this repository', () => {
  const outA = temp('inv-repo-a-');
  const outB = temp('inv-repo-b-');
  let a: Ran;
  let b: Ran;
  beforeAll(async () => {
    a = await run(['--date', '2026-10-11', '--out', outA]);
    b = await run(['--date', '2026-10-11', '--out', outB]);
  }, RUNS_MS);

  it('runs and writes valid CycloneDX JSON and a features file', () => {
    expect(a.stderr).toBe('');
    expect(a.status).toBe(0);
    const bom = JSON.parse(read(outA, 'sbom.json')) as Bom;
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.specVersion).toBe('1.5');
    expect(bom.metadata.component.name).toBe('timmy-tui');
    const f = JSON.parse(read(outA, 'features.json')) as { features: Array<{ source: string }> };
    // one feature per checklist row (7 cells, under a numbered section)
    const rows = readFileSync(join(REPO, 'docs/ui-cockpit/FEATURE-CHECKLIST.md'), 'utf8').split('\n')
      .filter((l) => l.startsWith('|') && !/^\|\s*-{3}/.test(l) && !/^\|\s*Feature\s*\|/.test(l) && l.replace(/\\\|/g, '').split('|').length - 2 >= 7).length;
    expect(f.features.filter((x) => x.source === 'docs/ui-cockpit/FEATURE-CHECKLIST.md').length).toBe(rows);
  });

  it('has every package of every lockfile it does not exclude, with its exact version', () => {
    const bom = JSON.parse(read(outA, 'sbom.json')) as Bom;
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as { packages: Record<string, { name?: string; version?: string }> };
    const have = new Set(bom.components.filter((c) => c.purl?.startsWith('pkg:npm/')).map((c) => `${c.name}@${c.version}`));
    let n = 0;
    for (const [key, e] of Object.entries(lock.packages)) {
      if (!key || !e.version) continue;
      const name = e.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      expect(have, key).toContain(`${name}@${e.version}`);
      n++;
    }
    expect(n).toBeGreaterThan(900);
    for (const app of bom.components.filter((c) => c['bom-ref'].startsWith('manifest:') && c['bom-ref'].endsWith('package.json'))) {
      const lockfile = prop(app, 'lockfile');
      if (!lockfile || lockfile === 'none') continue;
      const sub = JSON.parse(readFileSync(join(REPO, lockfile), 'utf8')) as { packages: Record<string, { name?: string; version?: string }> };
      const nested = new Set((app.components ?? []).map((c) => `${c.name}@${c.version}`));
      for (const [key, e] of Object.entries(sub.packages)) {
        if (!key || !e.version) continue;
        expect(nested, `${lockfile} ${key}`).toContain(`${e.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${e.version}`);
      }
    }
  });

  it('writes the capability matrix: every row has every column, an allowed level, a screen of the operator\'s', () => {
    const m = JSON.parse(read(outA, 'capabilities.json')) as Matrix;
    checkRows(m);
    expect(m.rows.length).toBeGreaterThan(50);
    for (const r of m.rows) expect(SCREENS, r.id).toContain(r.screen);
    // visual and usability acceptance are the operator's alone: as many as the overlay records with by: operator
    const overlay = JSON.parse(readFileSync(join(REPO, 'docs/ui-cockpit/inventory/overlay.json'), 'utf8')) as { acceptance?: Array<{ by?: string; capability?: string }> };
    const recorded = new Set((overlay.acceptance ?? []).filter((x) => x.by === 'operator').map((x) => x.capability));
    for (const r of m.rows) if (!recorded.has(r.id)) expect([r.visualAcceptance, r.usabilityAcceptance], r.id).toEqual(['not reviewed', 'not reviewed']);
    expect(m.gaps.top.length).toBeLessThanOrEqual(10);
  });

  it('writes no absolute local path, and the same bytes twice', () => {
    expect(b.status).toBe(0);
    const one = outputs(outA);
    const two = outputs(outB);
    let target: string[] = [];
    try { target = [realpathSync(join(REPO, 'node_modules'))]; } catch { target = []; }
    for (const [name, text] of Object.entries(one)) {
      expect(leaks(text, [REPO.replace(/\/$/, ''), realpathSync(REPO), outA, ...target]), name).toEqual([]);
      expect(two[name], name).toBe(text);
    }
  });
});

describe('this file\'s own check for a leaked local path (a negative control, R5 H130)', () => {
  it('passes words that name the temporary folder, and fails a real temporary path: this run\'s own folder, a file in it, any path under the temporary folder', () => {
    const words = (folder: string): string => `Codex wrote a patch file under ${folder}, which its sandbox then allowed; a ${folder} write refused`;
    expect(leaks(words('/tmp'), [])).toEqual([]);
    if (/^\/[^/]+$/.test(tmpdir())) expect(leaks(words(tmpdir()), [])).toEqual([]);
    const mine = temp('inv-leak-control-');
    expect(leaks(`kept in ${mine}`, [])).toContain(`the local path ${mine}`);
    expect(leaks(`kept in ${join(mine, 'notes.txt')}`, [])).toContain(`the local path ${mine}`);
    // a temporary path this run did not make: still a leak (the temporary folder followed by a path)
    expect(leaks(`kept in ${join(tmpdir(), 'inv-elsewhere-0', 'notes.txt')}`, [])).toContain(`the local path ${tmpdir()}`);
    expect(leaks(`kept in ${join(realpathSync(tmpdir()), 'inv-elsewhere-0')}`, [])).toContain(`the local path ${realpathSync(tmpdir())}`);
  });
});

describe('the output guard\'s local paths', () => {
  it('takes a one-segment system folder only as the start of a path, and any longer path anywhere', () => {
    expect(namesLocalPath('Codex wrote a patch file under /tmp, which its sandbox allowed', '/tmp')).toBe(false);
    expect(namesLocalPath('kept in /tmp/inv-fixture-x/notes.txt', '/tmp')).toBe(true);
    expect(namesLocalPath('the home folder is /root here', '/root')).toBe(false);
    expect(namesLocalPath('a key in /root/.ssh', '/root')).toBe(true);
    expect(namesLocalPath('read from /srv/checkout/src', '/srv/checkout')).toBe(true);
  });
});
