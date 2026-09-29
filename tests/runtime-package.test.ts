import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
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
    expect(files).toHaveLength(7);
    for (const asset of RUNTIME_ASSETS) expect(readFileSync(join(output, asset))).toEqual(readFileSync(join(root, asset)));
  });

  it('refuses an allowlisted source that is missing or a symlink to other data', () => {
    const source = temp(), output = temp();
    for (const asset of RUNTIME_ASSETS.slice(0, -1)) write(join(source, asset), 'synthetic source');
    expect(() => copyRuntimeAssets(source, output)).toThrow();
    expect(readdirSync(output)).toEqual([]);
    const target = join(source, 'private.txt'); write(target, 'synthetic private data');
    mkdirSync(join(source, 'fleet'));
    symlinkSync(target, join(source, 'fleet/harness-menu.mjs'));
    expect(() => copyRuntimeAssets(source, output)).toThrow('regular file');
    expect(readdirSync(output)).toEqual([]);
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
