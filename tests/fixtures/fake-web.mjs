#!/usr/bin/env node
// A FAKE for tests/board-live-token.test.ts (review M4). It stands in for tmux, zellij, sh and carbonyl, chosen by
// its first argument; it is none of them. Each one appends a JSON line to FAKE_WEB_LOG with the arguments it was
// started with and its environment, then does the one thing the test needs from the real program:
//   tmux      display-popup [options] <command...>: runs the command and waits for it, as the popup does
//   zellij    run [options] -- <command...>: starts the command on its own and returns at once, as zellij run does
//   sh        runs /bin/sh with the same arguments
//   carbonyl  the browser. While it runs it records `ps` (every process's command line on this machine), then
//             opens its address as a browser would: a file:// page's own script is run (node:vm) to see where it
//             sends the browser; there it asks for the page (GET /, no Origin: a navigation) and then, with the
//             t= token from the fragment as a Bearer header, for /state, as the live board's own script does.
//             With FAKE_CARBONYL_CHROMIUM=<path> it drives that real headless Chromium (Playwright) instead.
// It never writes the token it may hold: it records a sha256 of the address it was sent to.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const [role, ...args] = process.argv.slice(2);
const log = (record) => appendFileSync(process.env.FAKE_WEB_LOG, `${JSON.stringify({ role, pid: process.pid, ...record })}\n`);
log({ argv: args, env: { ...process.env } });

const run = (cmd, rest) => {
  const r = spawnSync(cmd, rest, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
};

if (role === 'tmux') {
  // display-popup's options, as tmux 3.3 reads them; the first other word starts the command.
  const valued = new Set(['-b', '-c', '-d', '-e', '-h', '-s', '-S', '-t', '-T', '-w', '-x', '-y']);
  let i = args[0] === 'display-popup' ? 1 : 0;
  while (i < args.length && args[i].startsWith('-')) i += valued.has(args[i]) ? 2 : 1;
  run(args[i], args.slice(i + 1).map((a) => (a.endsWith('\\;') ? `${a.slice(0, -2)};` : a)));
} else if (role === 'zellij') {
  const at = args.indexOf('--');
  const child = spawn(args[at + 1], args.slice(at + 2), { detached: true, stdio: 'ignore' });
  child.unref();
  process.exit(0);
} else if (role === 'sh') {
  run('/bin/sh', args);
} else if (role === 'carbonyl') {
  await browse(args[0]);
} else {
  process.exit(2);
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: u.host, ...headers }, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function browse(address) {
  const ps = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '';
  const record = { ps };
  if (address.startsWith('file:')) {
    const file = fileURLToPath(address);
    record.fileMode = statSync(file).mode & 0o777;
    record.dirMode = statSync(dirname(file)).mode & 0o777;
  }
  if (process.env.FAKE_CARBONYL_CHROMIUM) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.FAKE_CARBONYL_CHROMIUM });
    try {
      const page = await browser.newPage();
      await page.goto(address);
      await page.waitForFunction(() => (document.getElementById('status')?.textContent ?? '').startsWith('live'), undefined, { timeout: 20_000 });
      record.chromium = { url: page.url(), project: await page.textContent('#project'), status: await page.textContent('#status') };
    } finally {
      await browser.close();
    }
    log({ done: true, ...record });
    return;
  }
  // The address the browser ends up at: the address itself, or where a file:// page's script sends it.
  let target = address;
  if (address.startsWith('file:')) {
    const html = readFileSync(fileURLToPath(address), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    let sent = null;
    runInNewContext(script, { location: { replace: (u) => { sent = String(u); }, assign: (u) => { sent = String(u); } } });
    target = sent ?? '';
  }
  record.targetSha256 = createHash('sha256').update(target).digest('hex');
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(target)) {
    record.page = (await get(target, {})).status;
    const token = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(new URL(target).hash)?.[1] ?? '';
    const state = await get(new URL('/state', target).href, { Authorization: `Bearer ${token}` });
    record.state = state.status;
    record.project = state.status === 200 ? JSON.parse(state.body).project : null;
  }
  log({ done: true, ...record });
}
