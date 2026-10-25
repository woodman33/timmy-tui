import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureConfig, framerMain, motionSource, planCommand } from '../src/framer/cli.js';

const roots: string[] = [];
function workspace() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framer-test-')); roots.push(dir); return dir; }
afterEach(() => roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('Framer CLI', () => {
  it('creates isolated OAuth config without replacing it or existing MCP config', () => {
    const dir = workspace();
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config/mcporter.json'), 'existing');
    const file = ensureConfig(dir, undefined);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.framer).toEqual({ baseUrl: 'https://mcp.framer.com/mcp', auth: 'oauth' });
    fs.writeFileSync(file, 'custom');
    expect(ensureConfig(dir, undefined)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('custom');
    expect(fs.readFileSync(path.join(dir, 'config/mcporter.json'), 'utf8')).toBe('existing');
  });
  it('fails on an absent explicit config instead of inventing one', () => {
    expect(() => ensureConfig(workspace(), 'missing.json')).toThrow();
  });
  it('keeps JS and shell metacharacters inside one JSON argument', () => {
    const dir = workspace();
    const program = 'return "$(touch unwanted); `echo no`"';
    fs.writeFileSync(path.join(dir, 'program.js'), program);
    const argv = planCommand(['exec', 'session', 'program.js'], dir);
    expect(argv.slice(0, 3)).toEqual(['call', 'framer.exec', '--args']);
    expect(JSON.parse(argv[3])).toEqual({ session: 'session', program });
    expect(argv).toContain('--no-oauth');
  });
  it('preserves nested JSON without coercing numeric strings', () => {
    const dir = workspace();
    const payload = { nested: { amount: '001', values: [null, false, 3] } };
    fs.writeFileSync(path.join(dir, 'args.json'), JSON.stringify(payload));
    expect(JSON.parse(planCommand(['call', 'future_tool', 'args.json'], dir)[3])).toEqual(payload);
  });
  it.each(['[]', 'null', '5', '"text"', '{bad'])('rejects invalid tool payload %s', input => {
    const dir = workspace(); fs.writeFileSync(path.join(dir, 'args.json'), input);
    expect(() => planCommand(['call', 'exec', 'args.json'], dir)).toThrow();
  });
  it('rejects tool selector injection and extra flags', () => {
    expect(() => planCommand(['call', 'other.exec', 'args.json'], workspace())).toThrow();
    expect(() => planCommand(['tools', '--http-url', 'https://elsewhere'], workspace())).toThrow();
  });
  it('checks readiness before publishing and does not auto-deploy staging', () => {
    const program = JSON.parse(planCommand(['publish', 'session'], workspace())[3]).program;
    expect(program.indexOf('status()')).toBeLessThan(program.indexOf('publish()'));
    expect(program).toContain('throw new Error');
    expect(program).not.toContain('deployToProduction');
  });
  it('writes an editable browser component without overwriting existing output', async () => {
    const dir = workspace();
    expect(await framerMain(['motion', 'Example.tsx'], dir)).toBe(0);
    expect(await framerMain(['motion', 'Example.tsx'], dir)).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'Example.tsx'), 'utf8')).toBe(motionSource());
    expect(motionSource()).toContain('useReducedMotion');
    expect(fs.existsSync(path.join(dir, '.timmy'))).toBe(false);
  });
  it('rejects unknown commands without creating local state', async () => {
    const dir = workspace();
    expect(await framerMain(['bad-command'], dir)).toBe(1);
    expect(fs.existsSync(path.join(dir, '.timmy'))).toBe(false);
  });
});
