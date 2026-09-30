import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
// @ts-expect-error the build helper is plain JavaScript, outside the tsc source graph
import { copyRuntimeAssets, RUNTIME_ASSETS } from '../scripts/copy-runtime-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'timmy-package-')); temporary.push(dir); return dir; }
function write(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('installed runtime package', () => {
  it('copies only reviewed runtime assets, retaining their exact bytes', () => {
    const output = temp();
    expect(copyRuntimeAssets(root, output)).toEqual(RUNTIME_ASSETS);
    const files = readdirSync(output, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
    expect(files).toHaveLength(13);
    for (const asset of RUNTIME_ASSETS) expect(readFileSync(join(output, asset))).toEqual(readFileSync(join(root, asset)));
  });

  it('refuses an allowlisted source that is missing or a symlink to other data', () => {
    const source = temp(), output = temp();
    for (const asset of RUNTIME_ASSETS.filter((asset: string) => asset !== 'fleet/harness-menu.mjs')) write(join(source, asset), 'synthetic source');
    expect(() => copyRuntimeAssets(source, output)).toThrow();
    expect(readdirSync(output)).toEqual([]);
    const target = join(source, 'private.txt'); write(target, 'synthetic private data');
    mkdirSync(join(source, 'fleet'));
    symlinkSync(target, join(source, 'fleet/harness-menu.mjs'));
    expect(() => copyRuntimeAssets(source, output)).toThrow('regular file');
    expect(readdirSync(output)).toEqual([]);
  });

  it('supplies the exact schema bytes at the paths requested by compiled validators', () => {
    const install = realpathSync(temp()), caller = realpathSync(temp());
    const validators = [
      ['agent-pass', 'validatePassCue', 'agent-pass'],
      ['context-cone', 'validateConeCue', 'context-cone'],
      ['dispatch', 'validatePlanCue', 'dispatch'],
      ['escrow-engine', 'validateEscrowCue', 'escrow'],
      ['tripo-adapter', 'validateMeshCue', 'mesh-asset'],
      ['usd-compiler', 'validateUsdCue', 'usd'],
    ];
    copyRuntimeAssets(root, join(install, 'dist'));
    write(join(install, 'package.json'), '{"type":"module"}');
    const probe = join(install, 'dist/src/utils/schema-probe.js');
    buildSync({
      stdin: { contents: validators.map(([module, fn]) => `import { ${fn} } from './src/utils/${module}.ts';`).join('\n') + `\nconsole.log(JSON.stringify([${validators.map(([, fn]) => `${fn}({})`).join(',')}]));`, resolveDir: root, loader: 'ts' },
      outfile: probe, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    });
    // This shim checks asset delivery only. It does not stand in for CUE's
    // schema semantics; those remain covered by the native validator suites.
    // A shell shim keeps twelve fresh Node interpreter launches out of this
    // asset-delivery control. The real compiled validators still spawn cue;
    // the shim records their requested paths and copies bytes it actually read.
    const cue = join(install, 'bin/cue'), observations = join(install, 'observed.paths');
    const captures = join(install, 'captured-schemas');
    mkdirSync(captures);
    write(cue, `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = version ]; then exit 0; fi
if [ "$#" -ne 5 ] || [ "$1" != vet ] || [ "$2" != -d ]; then exit 2; fi
schema=$4
name=\${schema##*/}
/bin/cat "$schema" > "$SCHEMA_CAPTURE_DIR/$name" || exit 1
printf '%s\\0' "$schema" >> "$SCHEMA_OBSERVATIONS"
`);
    chmodSync(cue, 0o755);
    mkdirSync(join(install, 'tmp'));
    const run = () => JSON.parse(execFileSync(process.execPath, [probe], { cwd: caller, encoding: 'utf8', timeout: 10000, env: {
      PATH: `${join(install, 'bin')}:${dirname(process.execPath)}`, HOME: caller, TMPDIR: join(install, 'tmp'), SCHEMA_OBSERVATIONS: observations, SCHEMA_CAPTURE_DIR: captures,
    } }));
    expect(run()).toEqual(validators.map(() => ({ ok: true })));
    expect(readFileSync(observations, 'utf8').split('\0').slice(0, -1)).toEqual(validators.map(([, , name]) => join(install, 'dist/schemas', `${name}.cue`)));
    expect(readdirSync(captures).sort()).toEqual(validators.map(([, , name]) => `${name}.cue`).sort());
    for (const [, , name] of validators) {
      const actual = readFileSync(join(captures, `${name}.cue`)), expected = readFileSync(join(root, 'schemas', `${name}.cue`));
      expect(actual).toEqual(expected);
      expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
    }
    // Missing delivered assets must fail in the compiled validator, rather
    // than receiving a pass merely because a cue executable exists.
    rmSync(join(install, 'dist/schemas/usd.cue'));
    const missing = run();
    expect(missing.slice(0, -1)).toEqual(validators.slice(0, -1).map(() => ({ ok: true })));
    expect(missing.at(-1)).toMatchObject({ ok: false, error_class: 'schema' });
  });

  it('forwards from compiled JavaScript without tsx or any development dependencies', () => {
    const install = temp();
    write(join(install, 'package.json'), '{"type":"module"}');
    for (const file of ['timmy.ts', 'src/receipt/schema.ts', 'src/version.ts']) {
      const compiled = transformSync(readFileSync(join(root, file), 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022' }).code;
      write(join(install, 'dist', file.replace(/\.ts$/, '.js')), compiled);
    }
    write(join(install, 'dist/src/cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)));');
    const env = { ...process.env }; delete env.TIMMY_BIN_DRY_RUN; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const out = execFileSync(process.execPath, [join(install, 'dist/timmy.js'), 'probe', '--literal', 'value with spaces'], { cwd: install, env, encoding: 'utf8', timeout: 10000 });
    expect(JSON.parse(out)).toEqual(['probe', '--literal', 'value with spaces']);
  });
});
