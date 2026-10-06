import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function write(path: string, body: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
function snapshot(root: string): Record<string, { mode: number; body: string | null }> {
  const result: Record<string, { mode: number; body: string | null }> = {};
  for (const name of readdirSync(root, { recursive: true }).map(String).sort()) {
    const path = join(root, name), stat = lstatSync(path);
    result[name] = { mode: stat.mode, body: stat.isFile() ? readFileSync(path).toString('base64') : null };
  }
  return result;
}
function installed() {
  // Node resolves cwd through filesystem aliases (for example macOS's /var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-init-package-'))); temporary.push(root);
  const packageDir = join(root, 'installed'), caller = join(root, 'caller'), home = join(root, 'home');
  for (const path of [caller, home]) mkdirSync(path);
  write(join(packageDir, 'package.json'), '{"type":"module"}');
  const module = join(packageDir, 'dist/src/utils/init.js');
  for (const name of ['init', 'timmy-home']) {
    const source = readFileSync(fileURLToPath(new URL(`../src/utils/${name}.ts`, import.meta.url)), 'utf8');
    write(join(packageDir, `dist/src/utils/${name}.js`), transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code);
  }
  const overlay = join(packageDir, 'dist/lanes/privacy/overlay.mjs');
  write(overlay, readFileSync(fileURLToPath(new URL('../lanes/privacy/overlay.mjs', import.meta.url)), 'utf8'));
  write(join(packageDir, 'dist/fleet/nodes.example.json'), '{"bundled":true}');
  write(join(caller, 'fleet/nodes.example.json'), '{"bundled":false}');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  return { root, packageDir, caller, home, module, overlay, env };
}
function run(fixture: ReturnType<typeof installed>, options: { privateDir?: string; workspace?: string; repoOverride?: string; yes?: boolean } = {}) {
  const args = ['--operator', 'sample operator', '--project', 'sample-project', '--json', ...(options.yes === false ? [] : ['--yes'])];
  const expression = options.workspace
    ? `console.log(JSON.stringify(init.applyInit({ yes: true, json: true, operator: 'sample operator', project: 'sample-project' }, process.argv[1])));`
    : `process.exitCode = await init.runInit(${JSON.stringify(args)}, { isTTY: false, log: console.log });`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `import * as init from ${JSON.stringify(pathToFileURL(fixture.module).href)}; ${expression}`, ...(options.workspace ? [options.workspace] : [])], {
    cwd: fixture.caller, env: { ...fixture.env, ...(options.privateDir ? { TIMMY_PRIVATE_DIR: options.privateDir } : {}), ...(options.repoOverride ? { TIMMY_REPO_ROOT: options.repoOverride } : {}) }, encoding: 'utf8', timeout: 10000,
  });
}

describe('compiled init from an installed package', () => {
  it.each(['caller', 'private override', 'workspace argument', 'repository override'] as const)('keeps package bytes and membership unchanged with %s paths', mode => {
    const fixture = installed(), before = snapshot(fixture.packageDir);
    const workspace = mode === 'workspace argument' || mode === 'repository override' ? join(fixture.root, 'explicit-workspace') : fixture.caller;
    mkdirSync(workspace, { recursive: true });
    const privateDir = mode === 'private override' ? join(fixture.root, 'private-override') : join(workspace, '.timmy/private');
    const retained = { unrelated: { theme: 'retained' }, commander_ws: 'ws://127.0.0.1:4310' };
    write(join(privateDir, 'config.json'), JSON.stringify(retained));
    const result = run(fixture, { ...(mode === 'private override' ? { privateDir } : {}), ...(mode === 'workspace argument' ? { workspace } : {}), ...(mode === 'repository override' ? { repoOverride: workspace } : {}) });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(snapshot(fixture.packageDir)).toEqual(before);
    const output = JSON.parse(result.stdout);
    expect(output.private_dir).toBe(privateDir);
    expect(output.home).toBe(join(fixture.home, 'timmy'));
    expect(output.store_pin).toBe(join(workspace, '.timmy/store-pin'));
    expect(readFileSync(output.store_pin, 'utf8')).toBe(join(workspace, '.timmy/receipts'));
    expect(JSON.parse(readFileSync(join(privateDir, 'config.json'), 'utf8'))).toMatchObject({ ...retained, operator_label: 'sample operator', first_project: 'sample-project' });
    expect(lstatSync(join(output.home, 'identity.seed')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(output.home, 'identity.json'), 'utf8')).operator_id).toBe(output.operator_id);
    expect(readFileSync(join(output.home, 'projects/sample-project/README.md'), 'utf8')).toContain('sample-project');
    const reader = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { readPrivateJson } from ${JSON.stringify(pathToFileURL(fixture.overlay).href)};
      console.log(JSON.stringify({ config: readPrivateJson('config.json'), fallback: readPrivateJson('fleet/nodes.json') }));
    `], {
      cwd: mode === 'workspace argument' ? workspace : fixture.caller,
      env: { ...fixture.env, ...(mode === 'private override' ? { TIMMY_PRIVATE_DIR: privateDir } : {}), ...(mode === 'repository override' ? { TIMMY_REPO_ROOT: workspace } : {}) },
      encoding: 'utf8', timeout: 10000,
    });
    expect(reader.status).toBe(0); expect(reader.stderr).toBe('');
    const observed = JSON.parse(reader.stdout);
    expect(observed.config).toMatchObject({ source: 'private', path: join(privateDir, 'config.json'), data: { operator_id: output.operator_id, operator_label: 'sample operator' } });
    expect(observed.fallback).toEqual({ source: 'template', path: join(fixture.packageDir, 'dist/fleet/nodes.example.json'), data: { bundled: true } });
    expect(snapshot(fixture.packageDir)).toEqual(before);
  });

  it('preserves an existing caller receipt pin and resolves a relative private override from the caller', () => {
    const fixture = installed(), before = snapshot(fixture.packageDir);
    const pin = join(fixture.caller, '.timmy/store-pin'), retained = `${join(fixture.root, 'existing-receipts')}\n`;
    write(pin, retained);
    const result = run(fixture, { privateDir: 'private-settings' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).private_dir).toBe(join(fixture.caller, 'private-settings'));
    expect(readFileSync(pin, 'utf8')).toBe(retained);
    expect(snapshot(fixture.packageDir)).toEqual(before);
  });

  it('writes nothing when the noninteractive caller has not requested initialization', () => {
    const fixture = installed(), before = snapshot(fixture.root);
    const result = run(fixture, { yes: false });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no TTY: nothing written');
    expect(snapshot(fixture.root)).toEqual(before);
  });
});
