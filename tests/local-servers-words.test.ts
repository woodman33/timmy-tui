// R4 (H87): the local servers' start words say what happened. `timmy logs` said "(it was opened for you)" even when
// TIMMY_LOGS_OPEN=0 opened nothing; the browser companion's log line said "(127.0.0.1 only)" when it was started with --lan.
//
// `timmy logs` runs as a real child process (the CLI, tsx) with a Timmy home of its own; the browser opener is a FAKE (a stub
// named like this platform's opener, on PATH, that records what it was given) or absent (a PATH without one).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { showCompanionQR } from '../src/companion/qr.js';

/** This checkout's tsx loader, by its path (the child runs in a folder of its own, with no node_modules). */
const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** Runs `timmy logs` until it has printed its two lines; returns them and what the FAKE opener was given. */
async function timmyLogs(opener: 'off' | 'fake' | 'none'): Promise<{ out: string; given: string | null }> {
  const dir = temp('timmy-logswords-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const given = join(dir, 'given.txt');
  const name = process.platform === 'darwin' ? 'open' : 'xdg-open';
  if (opener === 'fake') {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${given}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // 'none': only the (empty) FAKE folder on PATH, so there is no opener at all (node runs by its own path); otherwise the FAKE first
  const path = opener === 'none' ? bin : `${bin}:${process.env.PATH}`;
  const child = spawn(process.execPath, ['--import', LOADER, resolve('src/cli.ts'), 'logs', '--port', String(await freePort())], {
    cwd: dir, env: { ...process.env, PATH: path, HOME: join(dir, 'home'), TIMMY_HOME: join(dir, 'home', 'timmy'), TIMMY_LOGS_OPEN: opener === 'off' ? '0' : '', NO_COLOR: '1' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  try {
    for (let i = 0; i < 400 && !/Ctrl-C stops it/.test(out) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; opener === 'fake' && i < 40 && !existsSync(given); i++) await new Promise((r) => setTimeout(r, 50));
    return { out, given: existsSync(given) ? readFileSync(given, 'utf8') : null };
  } finally {
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once('close', r));
    child.kill('SIGTERM');
    await closed;
  }
}

describe('`timmy logs` says what opening its page did (R4 H87)', () => {
  it('TIMMY_LOGS_OPEN=0: it says the page was not opened', async () => {
    const { out } = await timmyLogs('off');
    expect(out).toContain('it was not opened (TIMMY_LOGS_OPEN=0): open it yourself.');
    expect(out).not.toMatch(/opened for you|handed to your browser/);
  }, 60_000);
  it('with a browser opener (FAKE): it says the page was handed to the browser, through a private launch page (never the token on a command line)', async () => {
    const { out, given } = await timmyLogs('fake');
    expect(out).toContain('it was handed to your browser (through a private launch page that keeps the token off command lines).');
    const token = /#t=([0-9a-f]{64})/.exec(out)?.[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(given).not.toBeNull();
    expect(String(given).includes(token)).toBe(false);
  }, 60_000);
  it('with no browser opener here: it says it could not open the page', async () => {
    const { out } = await timmyLogs('none');
    expect(out).toContain('it could not be opened here (no browser opener, or the private launch page could not be written): open it yourself.');
  }, 60_000);
});

describe('the browser companion\'s log line says where it listens (R4 H87)', () => {
  it('127.0.0.1 only without --lan; every network address of this computer with --lan', () => {
    const cwd = process.cwd();
    const dir = temp('timmy-companionwords-');
    process.chdir(dir);
    process.env.TIMMY_TUI_ACTIVE = 'true';
    try {
      showCompanionQR({ url: `http://127.0.0.1:3001/#t=${'ab'.repeat(32)}`, lanUrls: [], host: '127.0.0.1' });
      showCompanionQR({ url: `http://127.0.0.1:3002/#t=${'ab'.repeat(32)}`, lanUrls: [], host: '0.0.0.0' });
    } finally {
      delete process.env.TIMMY_TUI_ACTIVE;
      process.chdir(cwd);
    }
    const lines = readFileSync(join(dir, 'logs', 'companion.log'), 'utf8').split('\n').filter((l) => l.includes('[Browser companion] On this computer'));
    expect(lines[0]).toContain('http://127.0.0.1:3001/ (127.0.0.1 only)');
    expect(lines[1]).toContain('http://127.0.0.1:3002/ (listening on every network address of this computer (--lan))');
    expect(lines.join('\n')).not.toContain('ab'.repeat(32));
  });
});
