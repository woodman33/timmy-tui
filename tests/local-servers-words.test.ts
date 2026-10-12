// R4 (H87): the local servers' start words say what happened. `timmy logs` said "(it was opened for you)" even when
// TIMMY_LOGS_OPEN=0 opened nothing; the browser companion's log line said "(127.0.0.1 only)" when it was started with --lan.
//
// `timmy logs` runs as a real child process (the CLI, tsx) with a Timmy home of its own; the browser opener is a FAKE (a stub
// named like this platform's opener, on PATH, that records what it was given) or absent (a PATH without one).
//
// R4 (H104): each run left two timmy-open-* folders in the system's temporary folder. The child writes a private launch page
// for the opener (src/utils/launch-page.ts) and removes it a minute later or when it exits; stopped by a signal, `timmy logs`
// runs no exit handler (it has none for SIGTERM or SIGINT), so its pages stayed. The child now gets a temporary folder of its
// own (TMPDIR) inside this test's folder: what it leaves is found there, checked to be its own launch pages (each names its
// port), removed, and none is left there or in this process's temporary folder.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The launch-page folders (timmy-open-*) in `dir` whose page sends the browser to 127.0.0.1:<port>. */
function launchPagesFor(dir: string, port: number): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith('timmy-open-')); } catch { return []; }
  return names.filter((n) => {
    try { return readFileSync(join(dir, n, 'open.html'), 'utf8').includes(`http://127.0.0.1:${port}/`); } catch { return false; }
  }).map((n) => join(dir, n));
}

/**
 * Runs `timmy logs` until it has printed its two lines; returns them, what the FAKE opener was given, and the launch pages the
 * child left (`left`: found in its own temporary folder after it stopped, each its own, then removed).
 */
async function timmyLogs(opener: 'off' | 'fake' | 'none'): Promise<{ out: string; given: string | null; left: number; port: number; tmp: string }> {
  const dir = temp('timmy-logswords-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // R4 (H104): the child's own temporary folder, where its launch pages are written
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  const given = join(dir, 'given.txt');
  const name = process.platform === 'darwin' ? 'open' : 'xdg-open';
  if (opener === 'fake') {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${given}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // 'none': only the (empty) FAKE folder on PATH, so there is no opener at all (node runs by its own path); otherwise the FAKE first
  const path = opener === 'none' ? bin : `${bin}:${process.env.PATH}`;
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', LOADER, resolve('src/cli.ts'), 'logs', '--port', String(port)], {
    cwd: dir, env: { ...process.env, PATH: path, HOME: join(dir, 'home'), TIMMY_HOME: join(dir, 'home', 'timmy'), TIMMY_LOGS_OPEN: opener === 'off' ? '0' : '', NO_COLOR: '1', TMPDIR: tmp },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  try {
    for (let i = 0; i < 400 && !/Ctrl-C stops it/.test(out) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; opener === 'fake' && i < 40 && !existsSync(given); i++) await new Promise((r) => setTimeout(r, 50));
    return { out, given: existsSync(given) ? readFileSync(given, 'utf8') : null, left: 0, port, tmp };
  } finally {
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once('close', r));
    child.kill('SIGTERM');
    await closed;
  }
}

/** timmyLogs, then exactly the launch pages its child left (each names its port) removed; `left` counts them. */
async function timmyLogsClean(opener: 'off' | 'fake' | 'none'): Promise<Awaited<ReturnType<typeof timmyLogs>>> {
  const r = await timmyLogs(opener);
  const own = launchPagesFor(r.tmp, r.port);
  // every launch page the child left in its temporary folder is its own (names its port); tsx keeps its cache there too
  expect(readdirSync(r.tmp).filter((n) => n.startsWith('timmy-open-')).map((n) => join(r.tmp, n)).sort()).toEqual([...own].sort());
  for (const d of own) rmSync(d, { recursive: true, force: true });
  return { ...r, left: own.length };
}

/** R4 (H104): no launch page of this child is left, in its own temporary folder or in this process's. */
const noneLeft = (r: { port: number; tmp: string }): void => {
  expect(launchPagesFor(r.tmp, r.port)).toEqual([]);
  expect(launchPagesFor(tmpdir(), r.port)).toEqual([]);
};

describe('`timmy logs` says what opening its page did (R4 H87)', () => {
  it('TIMMY_LOGS_OPEN=0: it says the page was not opened', async () => {
    const r = await timmyLogsClean('off');
    expect(r.out).toContain('it was not opened (TIMMY_LOGS_OPEN=0): open it yourself.');
    expect(r.out).not.toMatch(/opened for you|handed to your browser/);
    // nothing was opened, so no launch page was written
    expect(r.left).toBe(0);
    noneLeft(r);
  }, 60_000);
  it('with a browser opener (FAKE): it says the page was handed to the browser, through a private launch page (never the token on a command line)', async () => {
    const r = await timmyLogsClean('fake');
    expect(r.out).toContain('it was handed to your browser (through a private launch page that keeps the token off command lines).');
    const token = /#t=([0-9a-f]{64})/.exec(r.out)?.[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.given).not.toBeNull();
    expect(String(r.given).includes(token)).toBe(false);
    // R4 (H104): the launch page the FAKE opener was given is the one the child left (stopped by SIGTERM, it removes none);
    // removed here, so none is left
    expect(String(r.given)).toMatch(/^file:\/\/.*\/timmy-open-[^/]+\/open\.html$/);
    expect(r.left).toBeLessThanOrEqual(1);
    noneLeft(r);
  }, 60_000);
  it('with no browser opener here: it says it could not open the page', async () => {
    const r = await timmyLogsClean('none');
    expect(r.out).toContain('it could not be opened here (no browser opener, or the private launch page could not be written): open it yourself.');
    expect(r.left).toBeLessThanOrEqual(1);
    noneLeft(r);
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
