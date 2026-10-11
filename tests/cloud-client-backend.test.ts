/**
 * Round R4 (helper H93): Timmy Cloud's client (src/cloud) against a REAL backend process (services/cloud/main.ts, started as
 * its own process) whose provider is the SIMULATED one (in this process: nothing real is bought, registered or set up), over
 * real HTTP on 127.0.0.1, with orders made through the backend's own API. `timmy cloud use` and `timmy cloud status` run as
 * the real CLI's processes (src/cli.ts through tsx), with their own HOME and Timmy home in a temporary folder.
 *
 * What it shows: the new read-only operator route GET /v1/operator/orders (every customer's orders, each step's state, time
 * and words, and the resources; the operator's token only; GET only); a token file looser than 0600, a link, an empty file
 * and plain http to another host refused; the answer kept in <Timmy home>/cloud/overview.json (0600, in a 0700 folder) with
 * when it was read; a read that fails (a refused token, a backend that is gone) keeps the previous answer and records the
 * attempt; and the operator's token in no printed word, no JSON and no file but its own. Tokens are made at run time.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agencyCredential, http, newCustomer, spawnBackend, tempDir, type SpawnedBackend } from '../services/cloud/test-support.js';
import { SimulatedProvider } from '../services/cloud/simulated-provider.js';
import { newToken } from '../services/cloud/redaction.js';
import { getJson } from '../src/cloud/read.js';
import { checkBackendUrl, readTokenFile, redactToken } from '../src/cloud/token.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { glyphSet } from '../src/term/glyphs.js';

const REPO = path.resolve(__dirname, '..');
const LOADER = createRequire(import.meta.url).resolve('tsx');
const CLI = path.join(REPO, 'src', 'cli.ts');
const DOMAIN_ITEM = 'sim-domain-com-1y';

let sim: SimulatedProvider;
let backend: SpawnedBackend & { listening: boolean };
let base: string;
let home: string;
let account: string;
let operatorToken: string;
let tokenFile: string;
const credential = agencyCredential();
const dirs: string[] = [];
const outputs: string[] = [];

/** `timmy cloud …` as the real CLI's process, with this test's HOME and Timmy home. */
function cloud(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: account, TIMMY_HOME: home, NO_COLOR: '1' };
    delete env.NODE_PATH;
    const child = spawn(process.execPath, ['--import', LOADER, CLI, 'cloud', ...args], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('close', (code) => { outputs.push(stdout, stderr); resolve({ code, stdout, stderr }); });
  });
}
const lastJson = (out: string): Record<string, any> => JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, any>;
const op = (method: string, route: string, body?: unknown) => http(backend.url, method, route, { token: operatorToken, body });
/** Every file under a folder (path and text), links not followed. */
function files(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      const st = fs.lstatSync(f);
      if (st.isDirectory()) walk(f); else if (st.isFile()) out.push({ file: f, text: fs.readFileSync(f, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  base = fs.realpathSync(tempDir('h93-cloud-client-'));
  dirs.push(base);
  home = path.join(base, 'account', 'timmy');
  account = path.join(base, 'account');
  fs.mkdirSync(home, { recursive: true });
  // the SIMULATED provider (this process) and the backend (its own process), on a fresh data folder
  sim = new SimulatedProvider({ credential });
  await sim.start();
  const dataDir = path.join(base, 'backend-data');
  operatorToken = newToken();
  backend = await spawnBackend({ dataDir, providerUrl: sim.url, credential, operatorToken });
  expect(backend.listening, backend.stderr()).toBe(true);
  // orders through the backend's API: one waits for the operator, one bought and done
  const c = await newCustomer({ url: backend.url, op }, { per_order_cents: 5000, monthly_cents: 9000 });
  expect((await c.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'waits.example' }, 'k1')).status).toBe(201);
  const done = await c.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'bought.example' }, 'k2');
  expect((await op('POST', `/v1/operator/orders/${done.json.order.order_id}/approve`)).json.order.summary).toMatch(/^Done/);
  // the operator's token, in a file of the operator's alone (0600), outside Timmy home
  tokenFile = path.join(account, '.config', 'timmy-cloud', 'operator.token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, `${operatorToken}\n`, { mode: 0o600 });
}, 120_000);

afterAll(async () => {
  if (backend?.child.exitCode === null) { backend.child.kill('SIGTERM'); await backend.exited; }
  await sim?.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('the backend\'s read-only operator route GET /v1/operator/orders', () => {
  it('answers every customer\'s orders with each step\'s state, time and words, and the resources; the operator\'s token only; GET only', async () => {
    const r = await op('GET', '/v1/operator/orders');
    expect(r.status, r.text).toBe(200);
    expect(r.json.orders).toHaveLength(2);
    for (const o of r.json.orders) {
      expect(o.customer_id).toMatch(/^cus_/);
      expect(Object.keys(o.steps)).toEqual(['quote', 'approval', 'payment', 'acceptance', 'provisioning', 'dns', 'certificate', 'health']);
      for (const st of Object.values(o.steps) as Array<Record<string, unknown>>) {
        expect(typeof st.state).toBe('string');
        expect(typeof st.at).toBe('string');
        expect(typeof st.words).toBe('string');
      }
    }
    // newest first; the one waiting says so, step by step
    expect(r.json.orders.map((o: any) => o.request.domain)).toEqual(['bought.example', 'waits.example']);
    expect(r.json.orders[1].steps.approval.state).toBe('waiting');
    expect(r.json.orders[1].summary).toBe('Waits for the operator\'s approval (quote $12.00 USD).');
    expect(r.json.resources).toEqual([expect.objectContaining({ kind: 'domain', name: 'bought.example', state: 'active', customer_id: expect.stringMatching(/^cus_/) })]);
    // the same views the customer's own route answers (orderView), with the customer named
    const { customer_id: _c, ...asCustomerSees } = r.json.orders[0];
    const own = (await op('GET', `/v1/operator/orders/${r.json.orders[0].order_id}`)).json.order;
    expect(asCustomerSees).toEqual(own);
    expect((await http(backend.url, 'GET', '/v1/operator/orders')).status).toBe(401);
    expect((await http(backend.url, 'GET', '/v1/operator/orders', { token: newToken() })).status).toBe(401);
    expect((await op('POST', '/v1/operator/orders')).status).toBe(405);
  });
});

describe('timmy cloud use: the backend\'s address and the token file\'s path, never the token', () => {
  it('refuses a token file others can read, a link, an empty file, a missing one and plain http to another host; nothing is written', async () => {
    const loose = path.join(account, 'loose.token');
    fs.writeFileSync(loose, `${operatorToken}\n`, { mode: 0o644 });
    fs.chmodSync(loose, 0o644);
    const r = await cloud(['use', backend.url, '--token-file', loose, '--json']);
    expect(r.code).toBe(1);
    expect(lastJson(r.stdout).error).toBe('not set up: the token file ~/loose.token can be read or changed by others (mode 644): the client reads the operator\'s token only from a file its owner alone can read (chmod 600 ~/loose.token)');
    const link = path.join(account, 'link.token');
    fs.symlinkSync(tokenFile, link);
    expect(lastJson((await cloud(['use', backend.url, '--token-file', link, '--json'])).stdout).error).toMatch(/^not set up: the token file ~\/link\.token is a symbolic link: name the file itself/);
    // in this process too (its HOME this test's account): the words name the file by its path, never its contents
    vi.stubEnv('HOME', account);
    try {
      const empty = path.join(account, 'empty.token');
      fs.writeFileSync(empty, '', { mode: 0o600 });
      expect(readTokenFile(empty)).toEqual({ ok: false, why: 'the token file ~/empty.token is empty' });
      expect(readTokenFile(path.join(account, 'none.token'))).toEqual({ ok: false, why: 'the token file ~/none.token does not exist' });
      const words = readTokenFile(loose);
      expect(words).toEqual({ ok: false, why: expect.stringMatching(/^the token file ~\/loose\.token can be read or changed by others \(mode 644\)/) });
      expect(JSON.stringify(words)).not.toContain(operatorToken);
    } finally { vi.unstubAllEnvs(); }
    // 192.0.2.10: a documentation address (TEST-NET-1, RFC 5737), never contacted; cloud.example: a reserved name
    expect(checkBackendUrl('http://192.0.2.10:8791')).toEqual({ why: 'http:// sends the operator\'s token unencrypted: it is allowed only to this computer (127.0.0.1, ::1, localhost); use https:// for 192.0.2.10' });
    // an address with a user name and password in it, built here (as a literal it reads as an email address to the privacy scan)
    const withUser = new URL('https://cloud.example/x');
    withUser.username = 'user';
    withUser.password = 'pw';
    expect(checkBackendUrl(withUser.href)).toMatchObject({ why: expect.stringMatching(/user name or password/) });
    expect(checkBackendUrl('https://cloud.example/api/')).toEqual({ url: 'https://cloud.example/api' });
    expect(checkBackendUrl('http://[::1]:8791')).toEqual({ url: 'http://[::1]:8791' });
    expect(fs.existsSync(path.join(home, 'cloud', 'config.json'))).toBe(false);
  }, 60_000);

  it('records the address and the 0600 file\'s path (0600 itself, in a 0700 folder), contacts nothing, and prints no token', async () => {
    const before = sim.received.length;
    const r = await cloud(['use', backend.url, '--token-file', tokenFile, '--json']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const j = lastJson(r.stdout);
    expect(j).toMatchObject({ ok: true, verb: 'use', backend: backend.url, token_file: '~/.config/timmy-cloud/operator.token' });
    expect(j.words).toMatch(/never copied or printed .* Nothing was contacted\.$/);
    const config = path.join(home, 'cloud', 'config.json');
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(config)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toMatchObject({ schema: 'timmy.cloud.client/1', url: backend.url, token_file: tokenFile });
    expect(sim.received.length).toBe(before);
  }, 60_000);

  it('/cloud in the REPL reads the backend as timmy cloud status does, in the same words, and keeps the answer', async () => {
    vi.stubEnv('HOME', account);
    vi.stubEnv('TIMMY_HOME', home);
    try {
      const printed: string[] = [];
      const ctx = { print: (seg: Array<{ text: string }>) => printed.push(seg.map((x) => x.text).join('')), glyphs: glyphSet(true) } as unknown as ReplContext;
      expect(await runSlash('/cloud', ctx)).toBe('handled');
      expect(printed[0]).toMatch(/^ {2}Timmy Cloud http:\/\/127\.0\.0\.1:\d+ {2}read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
      expect(printed.join('\n')).toContain('provider    simulated provider (simulated: nothing real is bought or set up)');
      expect(printed.join('\n')).toContain('kept in ~/timmy/cloud/overview.json (0600); God\'s Eye View shows it: /overview hosting');
      expect(JSON.parse(fs.readFileSync(path.join(home, 'cloud', 'overview.json'), 'utf8')).read_at).toMatch(/^\d{4}-/);
      outputs.push(...printed);
      printed.length = 0;
      await runSlash('/cloud status --json', ctx);
      expect(JSON.parse(printed.at(-1)!)).toMatchObject({ ok: true, verb: 'status', backend: backend.url });
      outputs.push(...printed);
      printed.length = 0;
      await runSlash('/cloud help', ctx);
      expect(printed[0]).toBe('/cloud: Timmy Cloud\'s backend, read by its operator (Timmy Cloud client)');
      outputs.push(...printed);
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);
});

describe('timmy cloud status: the backend read, kept with when it was read; a failed read keeps the previous answer', () => {
  it('reads the overview and the orders and keeps them 0600; a refused token and a backend that is gone keep the answer and record the attempt', async () => {
    const r = await cloud(['status', '--json']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const j = lastJson(r.stdout);
    expect(j).toMatchObject({ ok: true, verb: 'status', backend: backend.url, cache: '~/timmy/cloud/overview.json' });
    expect(j.overview.provider).toMatchObject({ name: 'simulated provider', simulated: true });
    expect(j.orders.orders).toHaveLength(2);
    const file = path.join(home, 'cloud', 'overview.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(kept).toMatchObject({ schema: 'timmy.cloud.cache/1', backend: backend.url, read_at: j.read_at });
    expect(kept.failed).toBeUndefined();
    // the words, as a person reads them
    const said = await cloud(['status']);
    expect(said.code).toBe(0);
    expect(said.stdout).toContain('provider    simulated provider (simulated: nothing real is bought or set up)');
    expect(said.stdout).toMatch(/orders {6}2, 1 waiting for a person; 1 resource/);
    expect(said.stdout).toContain('kept in ~/timmy/cloud/overview.json (0600); God\'s Eye View shows it: /overview hosting');
    // that read the backend again: this is the answer kept now
    const keptNow = JSON.parse(fs.readFileSync(file, 'utf8')) as { read_at: string; overview: unknown };
    const readAt = keptNow.read_at;
    expect(readAt).not.toBe(kept.read_at);

    // a token the backend does not take: refused, said, and the previous answer kept with the attempt
    const wrong = path.join(account, 'wrong.token');
    fs.writeFileSync(wrong, `${newToken()}\n`, { mode: 0o600 });
    expect((await cloud(['use', backend.url, '--token-file', wrong])).code).toBe(0);
    const refused = await cloud(['status', '--json']);
    expect(refused.code).toBe(1);
    expect(lastJson(refused.stdout).error).toMatch(/^not read: GET \/v1\/operator\/overview: the backend refused the operator's token \(401: This route needs the operator's token\.\); check the token file named by timmy cloud use; the previous answer is kept \(read /);
    const afterRefusal = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(afterRefusal.read_at).toBe(readAt);
    expect(afterRefusal.overview).toEqual(keptNow.overview);
    expect(afterRefusal.failed).toMatchObject({ why: expect.stringMatching(/refused the operator's token/) });

    // the right file again, then the token file loosened: refused before anything is sent
    expect((await cloud(['use', backend.url, '--token-file', tokenFile])).code).toBe(0);
    fs.chmodSync(tokenFile, 0o640);
    const loosened = await cloud(['status', '--json']);
    expect(loosened.code).toBe(1);
    expect(lastJson(loosened.stdout).error).toMatch(/^not read: the token file ~\/\.config\/timmy-cloud\/operator\.token can be read or changed by others \(mode 640\)/);
    fs.chmodSync(tokenFile, 0o600);

    // the backend stopped: nothing answers, the answer read before is kept, the attempt recorded
    backend.child.kill('SIGTERM');
    expect((await backend.exited).code).toBe(0);
    const gone = await cloud(['status', '--json']);
    expect(gone.code).toBe(1);
    expect(lastJson(gone.stdout).error).toMatch(/^not read: GET \/v1\/operator\/overview: nothing answered \(connection refused\): is the backend running there\?; the previous answer is kept/);
    const afterGone = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(afterGone.read_at).toBe(readAt);
    expect(afterGone.failed.why).toMatch(/connection refused/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  }, 120_000);

  it('the operator\'s token is in no printed word, no JSON and no file but its own', () => {
    expect(outputs.length).toBeGreaterThan(8);
    for (const out of outputs) expect(out).not.toContain(operatorToken);
    for (const f of files(base)) {
      if (f.file === tokenFile || f.file === path.join(account, 'loose.token') || f.file === path.join(account, 'link.token')) continue;
      expect(f.text, f.file).not.toContain(operatorToken);
    }
    // what the client prints or keeps passes this, whatever a backend sends back
    expect(redactToken(`a ${operatorToken} b ${encodeURIComponent(operatorToken)}`, operatorToken)).toBe('a [REDACTED_OPERATOR_TOKEN] b [REDACTED_OPERATOR_TOKEN]');
    expect(os.tmpdir()).toBeTruthy();
  });
});

describe('a backend that answers too slowly: the client waits its limit in all, not longer', () => {
  it('a real HTTP server on 127.0.0.1 that sends a byte every 100 ms and never ends: given up at the limit, in words', async () => {
    const token = newToken();
    const sockets = new Set<Socket>();
    // never finishes its answer: a limit on silence alone would wait for ever
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"generated_at":');
      const tick = setInterval(() => res.write(' '), 100);
      res.on('close', () => clearInterval(tick));
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const started = Date.now();
      const r = await getJson(`http://127.0.0.1:${port}`, '/v1/operator/overview', token, { timeoutMs: 1000 });
      const took = Date.now() - started;
      expect(r).toEqual({ ok: false, status: null, why: 'GET /v1/operator/overview: no complete answer within 1 s' });
      expect(took).toBeGreaterThanOrEqual(900);
      expect(took).toBeLessThan(4000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
