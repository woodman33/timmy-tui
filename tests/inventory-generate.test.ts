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
 * FAKE pieces, labelled: the FIXTURE tree is invented (its packages, its installed tree, its checklist, ledger and overlay
 * all say FIXTURE); no registry, network or git history is involved for it. The repository run reads this checkout as it is.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'inventory', 'inventory.mjs');
const made: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const put = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

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
    "import leftPad from 'left-pad';",
    "import { thing } from '@fx/scoped/deep/path.js';",
    "import real from 'aliased';",
    "import inner from 'inner-dep';",
    "import { readFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "const generated = \"import nope from 'not-a-package-anywhere'\";",
    "spawnSync('fixture-tool', ['--version']);",
    'export const key = process.env.FIXTURE_API_KEY;',
    'export default [leftPad, thing, real, inner, readFileSync, generated];',
    '',
  ].join('\n'));
  put(root, 'tests/a.test.ts', "// FIXTURE test\nimport leftPad from 'left-pad';\nexport const t = leftPad;\n");
  put(root, 'workers/run.py', '# FIXTURE worker\nimport json\nimport numpy\nimport cv2\nimport run_helper\n');
  put(root, 'workers/run_helper.py', '# FIXTURE helper\n');
  put(root, 'requirements.txt', '# FIXTURE requirements\nnumpy==1.26.4\nopencv-python-headless>=4.9 ; python_version >= "3.10"\n-r other.txt\n');
  put(root, 'workers/Dockerfile', 'FROM python:3.12-slim\nRUN pip install --no-cache-dir rich==13.7.1 \\\n    textual\nRUN apt-get update && apt-get install -y --no-install-recommends git\n');
  put(root, 'lanes/x/package.json', json({ name: 'fixture-lane', private: true, dependencies: { 'lane-dep': '^2.0.0' } }));
  put(root, 'lanes/x/package-lock.json', json({ name: 'fixture-lane', lockfileVersion: 3, packages: { '': { name: 'fixture-lane', dependencies: { 'lane-dep': '^2.0.0' } }, 'node_modules/lane-dep': { version: '2.1.0', license: 'MIT' } } }));
  put(root, 'lanes/x/index.mjs', "// FIXTURE lane\nimport laneDep from 'lane-dep';\nexport default laneDep;\n");
  put(root, '.agents/skills/demo/package.json', json({ name: 'fixture-skill-example', dependencies: { 'skill-only': '1.0.0' } }));

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
  }));
}

interface Component { 'bom-ref': string; type: string; name: string; version?: string; scope?: string; purl?: string; licenses?: Array<{ license?: { id?: string; name?: string }; expression?: string }>; properties?: Array<{ name: string; value: string }>; components?: Component[] }
interface Bom { bomFormat: string; specVersion: string; serialNumber: string; version: number; metadata: { timestamp: string; component: Component; properties?: Array<{ name: string; value: string }> }; components: Component[]; services: Array<{ name: string }>; dependencies: Array<{ ref: string; dependsOn: string[] }> }

const read = (dir: string, f: string): string => readFileSync(join(dir, f), 'utf8');
const prop = (c: Component | undefined, name: string): string | undefined => c?.properties?.find((p) => p.name === `timmy:${name}`)?.value;
const outputs = (dir: string): Record<string, string> => Object.fromEntries(['INVENTORY.md', 'sbom.json', 'features.json'].map((f) => [f, read(dir, f)]));

/** Every absolute local path this computer could leak, and the home-style patterns, as the generator's own guard knows them. */
function leaks(text: string, extra: string[]): string[] {
  const out: string[] = [];
  const literal = new Set([homedir(), tmpdir(), realpathSync(tmpdir()), ...extra].filter((p) => p.length > 1));
  for (const p of literal) if (text.includes(p)) out.push(`the local path ${p}`);
  for (const re of [/\/Users\/[A-Za-z0-9._-]+/, /\/home\/[A-Za-z0-9._-]+/, /[A-Za-z]:\\Users\\/]) { const m = re.exec(text); if (m) out.push(m[0]); }
  return out;
}

describe('the inventory generator on a FIXTURE tree', () => {
  const root = temp('inv-fixture-');
  makeFixture(root);
  const outA = temp('inv-out-a-');
  const outB = temp('inv-out-b-');
  const a = run(['--root', root, '--date', '2026-10-01', '--out', outA]);
  const b = run(['--root', root, '--date', '2026-10-01', '--out', outB]);

  it('runs, writes its three files and says what it counted', () => {
    expect(a.stderr).toBe('');
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('inventory 2026-10-01: 10 locked npm entries');
    expect(readdirSync(outA).sort()).toEqual(['INVENTORY.md', 'features.json', 'sbom.json']);
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

  it('writes no absolute local path, and the same bytes for the same inputs and date', () => {
    const one = outputs(outA);
    const two = outputs(outB);
    expect(b.status).toBe(0);
    for (const [name, text] of Object.entries(one)) {
      expect(leaks(text, [root, realpathSync(root), outA]), name).toEqual([]);
      expect(two[name], name).toBe(text);
    }
  });

  it('writes nothing and exits 3 when its output would carry a local path (a negative control)', () => {
    const leaky = temp('inv-leaky-');
    makeFixture(leaky, { leak: true });
    const out = temp('inv-out-leaky-');
    const r = run(['--root', leaky, '--date', '2026-10-01', '--out', out]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('nothing written: the output would carry a local path');
    expect(r.stderr).not.toContain(leaky); // the refusal names what kind of path, never the path
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses a malformed date and an unknown argument before reading anything', () => {
    const r1 = run(['--root', root, '--date', '11/10/2026', '--out', temp('inv-out-bad-')]);
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain('--date takes YYYY-MM-DD');
    const r2 = run(['--surprise']);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain('unknown argument --surprise');
  });
});

describe('the inventory generator on this repository', () => {
  const outA = temp('inv-repo-a-');
  const outB = temp('inv-repo-b-');
  const a = run(['--date', '2026-10-11', '--out', outA]);
  const b = run(['--date', '2026-10-11', '--out', outB]);

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
