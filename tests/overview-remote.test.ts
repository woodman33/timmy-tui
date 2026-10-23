/**
 * Round R4 (helper H93): God's Eye View, slice 2: the operator's computers (Timmy Connect), hosting (Timmy Cloud's backend
 * as its client last read it), provider costs, the new things that need a person, and the dependencies they make, in
 * `/overview`, the board's Overview section (its HTML, and the live board in a real headless Chromium) and GET /overview.
 *
 * REAL here: Timmy Connect's own functions (addDevice, scanDevice, trustKey, probeDevice, runJob, reconcileJob, stopJob)
 * wrote devices.json and the remote job records in the sandbox's Timmy home; the remote jobs run for real on this machine (a
 * real `sleep` in a process group of its own); the Timmy Cloud backend runs as its own process (services/cloud/main.ts);
 * orders went through its HTTP API; `timmy cloud use` and `timmy cloud status` ran as the real CLI's processes and kept its
 * answer; a REPL Workspace builds the overview from the board's records; Chromium is real.
 *
 * FAKE pieces, labelled: ssh, ssh-keyscan and ssh-keygen are FAKE OpenSSH programs (tests/fixtures/connect: no OpenSSH in
 * this container; their "devices" are folders here, at 127.0.0.1 with made-up ports, and run commands through /bin/sh);
 * the identity is a FAKE key (a placeholder nothing reads, and a real ed25519 public key made at run time); the provider is
 * the SIMULATED one, in this process (nothing real is bought, registered or set up; its prices are simulated). Tokens and
 * credentials are made at run time. Every folder is under os.tmpdir() and is removed when the tests end.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDevice } from '../src/connect/devices.js';
import { scanDevice, trustKey } from '../src/connect/hostkeys.js';
import { reconcileJob, runJob, stopJob } from '../src/connect/jobs.js';
import { probeDevice } from '../src/connect/probe.js';
import { connectPaths, type ConnectPaths } from '../src/connect/store.js';
import { SETUP_COMMAND } from '../src/cloud/commands.js';
import { buildOverview, OVERVIEW_SCHEMA, OVERVIEW_SECTIONS, type NeedsItem, type Overview } from '../src/overview/index.js';
import { remoteNeeds } from '../src/overview/remote.js';
import { readSources } from '../src/overview/sources.js';
import { esc, kit as boardKit } from '../src/repl/board-kit.js';
import { overviewSection, overviewShape } from '../src/repl/board-overview.js';
import { overviewFirstLines, overviewLines } from '../src/repl/overview.js';
import { glyphSet } from '../src/term/glyphs.js';
import { agencyCredential, http, newCustomer, spawnBackend, type SpawnedBackend } from '../services/cloud/test-support.js';
import { SimulatedProvider } from '../services/cloud/simulated-provider.js';
import { newToken } from '../services/cloud/redaction.js';
import { makeKit, newHostKey, until, type Kit } from './fixtures/connect/kit.js';
import { opsKit, replOf, sandbox, text, type Sandbox } from './helpers/ops-sandbox.js';
import type { Workspace } from '../src/repl/workspace.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((x): x is string => Boolean(x) && fs.existsSync(x!));
if (!browserPath) console.warn('overview-remote: no Chromium or Chrome found, so the real-browser check is skipped here');

const g = glyphSet(true);
const plain = (lines: Array<Array<{ text: string }>>): string[] => lines.map((l) => l.map((x) => x.text).join(''));
const PORT = { studio: 2391, lab: 2392, newbox: 2393, moved: 2394 } as const;
const DOMAIN_ITEM = 'sim-domain-com-1y';
const SITE_ITEM = 'sim-agency-site';
const VPS_ITEM = 'sim-vps-small-1m';
const HOUR = 3_600_000;

const ops = opsKit();
let s: Sandbox;
let net: Kit;
let timmyHome: string;
let p: ConnectPaths;
let ws: Workspace;
let sim: SimulatedProvider;
let backend: SpawnedBackend & { listening: boolean };
let operatorToken: string;
let tokenFile: string;
let o: Overview;
let repl: Overview;
const outputs: string[] = [];
const job: Record<'running' | 'ended' | 'unknown' | 'stopAsked', string> = { running: '', ended: '', unknown: '', stopAsked: '' };
const order: Record<'waits' | 'lost' | 'cancel' | 'partial', string> = { waits: '', lost: '', cancel: '', partial: '' };

/** `timmy …` as the real CLI's process (the sandbox's `timmy`), with the sandbox's HOME and Timmy home. */
function timmy(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(path.join(s.bin, 'timmy'), args, { cwd: s.root, env: { ...s.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('close', (code) => { outputs.push(stdout, stderr); resolve({ code, stdout, stderr }); });
  });
}
const lastJson = (out: string): Record<string, any> => JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, any>;
const op = (method: string, route: string, body?: unknown) => http(backend.url, method, route, { token: operatorToken, body });

/** A FAKE device added through Timmy Connect's own functions, its host key fetched and confirmed, and probed. */
async function ready(id: keyof typeof PORT, name: string): Promise<void> {
  const h = net.addHost(PORT[id]);
  const added = addDevice(p, { id, name, address: h.address, port: h.port, user: h.user, identity: '~/.ssh/timmy_test_identity' });
  expect(added.problems).toEqual([]);
  const scan = await scanDevice(p, id);
  if ('error' in scan) throw new Error(scan.error);
  expect(trustKey(p, id, scan.keys[0].fingerprint, 'cli').ok).toBe(true);
  const probe = await probeDevice(p, id);
  if ('error' in probe) throw new Error(probe.error);
  expect(probe.probe.outcome, probe.probe.words).toBe('connected');
}
async function run(id: string, command: string[]): Promise<string> {
  const r = await runJob(p, id, { command });
  if ('error' in r) throw new Error(r.error);
  return r.job.id;
}

beforeAll(async () => {
  s = sandbox(ops, 'overview-remote-');
  timmyHome = path.join(s.home, 'timmy');
  // ── Timmy Connect: FAKE OpenSSH programs first on PATH, this sandbox's HOME and Timmy home, the project's own receipt store
  net = makeKit('h93-net-');
  net.stub((k, v) => { vi.stubEnv(k, v as string); });
  vi.stubEnv('HOME', s.home);
  vi.stubEnv('TIMMY_HOME', timmyHome);
  vi.stubEnv('TIMMY_STORE', s.env.TIMMY_STORE!);
  // the FAKE identity under HOME, so each record names its key file from ~
  fs.mkdirSync(path.join(s.home, '.ssh'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(net.key.file, path.join(s.home, '.ssh', 'timmy_test_identity'));
  fs.chmodSync(path.join(s.home, '.ssh', 'timmy_test_identity'), 0o600);
  fs.copyFileSync(`${net.key.file}.pub`, path.join(s.home, '.ssh', 'timmy_test_identity.pub'));
  p = connectPaths(timmyHome);
  // studio: answers; one job runs (a real sleep there), one has ended
  await ready('studio', 'Studio box');
  job.running = await run('studio', ['sleep', '300']);
  job.ended = await run('studio', ['sh', '-c', 'echo made > made.txt']);
  await until(async () => { const r = await reconcileJob(p, job.ended); return !('error' in r) && r.job.state === 'ended'; }, 30_000, 'the short job to end');
  // lab: answered, ran two jobs, then refused connections: its last probe did not connect, one job's status is unknown,
  // and a stop asked of the other is not confirmed
  await ready('lab', 'Lab box');
  job.unknown = await run('lab', ['sleep', '300']);
  job.stopAsked = await run('lab', ['sleep', '300']);
  net.update(PORT.lab, (h) => { h.mode = 'refused'; });
  const labProbe = await probeDevice(p, 'lab');
  expect('error' in labProbe ? labProbe.error : labProbe.probe.outcome).toBe('unreachable');
  const unknown = await reconcileJob(p, job.unknown);
  expect('error' in unknown ? unknown.error : unknown.job.state).toBe('unknown');
  const stop = await stopJob(p, job.stopAsked);
  expect('error' in stop ? stop.error : stop.job.state).toBe('stop asked');
  // newbox: its host key fetched and waiting for a person
  const nb = net.addHost(PORT.newbox);
  expect(addDevice(p, { id: 'newbox', address: nb.address, port: nb.port, user: nb.user, identity: '~/.ssh/timmy_test_identity' }).problems).toEqual([]);
  const nbScan = await scanDevice(p, 'newbox');
  expect('error' in nbScan ? nbScan.error : nbScan.keys.length).toBe(1);
  // moved: confirmed, then it offers another host key: refused, and recorded
  await ready('moved', 'Moved box');
  net.update(PORT.moved, (h) => { h.keys = [newHostKey()]; });
  const movedProbe = await probeDevice(p, 'moved');
  expect('error' in movedProbe ? movedProbe.error : movedProbe.probe.outcome).toBe('host-key-changed');

  // ── Timmy Cloud: the SIMULATED provider (this process) and the backend (its own process)
  const credential = agencyCredential();
  sim = new SimulatedProvider({ credential, certificateCooldownMs: 0 });
  await sim.start();
  operatorToken = newToken();
  backend = await spawnBackend({ dataDir: path.join(s.base, 'cloud-backend'), providerUrl: sim.url, credential, operatorToken });
  expect(backend.listening, backend.stderr()).toBe(true);
  const stackish = { url: backend.url, op };
  // A: every purchase waits for the operator (threshold 0): one waits, one bought
  const a = await newCustomer(stackish, { per_order_cents: 5000, monthly_cents: 9000 });
  order.waits = (await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'waits.example' }, 'a1')).json.order.order_id;
  const bought = await a.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'bought.example' }, 'a2');
  expect((await op('POST', `/v1/operator/orders/${bought.json.order.order_id}/approve`)).json.order.summary).toMatch(/^Done/);
  // B: approved up to $20.00 by itself: a VPS purchase whose answer was lost, and a domain cancelled after it was bought
  const b = await newCustomer(stackish, { per_order_cents: 5000, monthly_cents: 20_000, auto_approve_up_to_cents: 2000 });
  sim.faults.push({ op: 'purchase', mode: 'lose_answer' });
  order.lost = (await b.order({ kind: 'vps', item_id: VPS_ITEM }, 'b1')).json.order.order_id;
  expect((await op('POST', `/v1/operator/orders/${order.lost}/reconcile`)).json.order.needs_person).toBeTruthy();
  sim.payments.push({ processing: 2, then: 'paid' });
  order.cancel = (await b.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'late.example' }, 'b2')).json.order.order_id;
  expect((await b.post(`/v1/orders/${order.cancel}/cancel`)).json.cancelled_here).toBe(false);
  expect((await op('POST', `/v1/operator/orders/${order.cancel}/reconcile`)).json.order.steps.payment.state).toBe('paid');
  // C: a domain, a site whose domain link failed (partly provisioned), then Timmy Pro cancelled, and a deletion asked
  const c = await newCustomer(stackish, { per_order_cents: 5000, monthly_cents: 9000 });
  const keep = await c.order({ kind: 'domain', item_id: DOMAIN_ITEM, domain: 'keep.example' }, 'c1');
  await op('POST', `/v1/operator/orders/${keep.json.order.order_id}/approve`);
  sim.linkOutcomes.push('fail');
  order.partial = (await c.order({ kind: 'site', item_id: SITE_ITEM, domain: 'keep.example' }, 'c2')).json.order.order_id;
  expect((await op('POST', `/v1/operator/orders/${order.partial}/approve`)).json.order.partial).toBe(true);
  expect((await op('POST', '/v1/operator/billing-notices', { notice_id: 'c-cancel', customer_id: c.id, state: 'canceled' })).status).toBe(200);
  const site = (await c.get('/v1/resources')).json.resources.find((r: any) => r.kind === 'site');
  expect((await op('POST', '/v1/operator/deletions', { resource_id: site.resource_id, reason: 'the customer asked for its removal' })).status).toBe(201);

  // ── the client, through the real CLI: the operator's token in a 0600 file under HOME; the answer kept in Timmy home
  tokenFile = path.join(s.home, '.config', 'timmy-cloud', 'operator.token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, `${operatorToken}\n`, { mode: 0o600 });
  const used = await timmy(['cloud', 'use', backend.url, '--token-file', tokenFile, '--json']);
  expect(used.code, used.stdout + used.stderr).toBe(0);
  const read = await timmy(['cloud', 'status', '--json']);
  expect(read.code, read.stdout + read.stderr).toBe(0);
  expect(lastJson(read.stdout).orders.orders).toHaveLength(6);

  // ── the REPL of this sandbox, and the overview read outside it (as Timmy Canvas would)
  ws = replOf(ops, s).ws;
  o = buildOverview(s.root, { name: 'project', jobsDir: path.join(timmyHome, 'jobs'), store: path.join(s.root, '.timmy', 'receipts'), env: { TIMMY_HOME: timmyHome } });
  repl = JSON.parse(text(await ws.overview('--json'))) as Overview;
}, 300_000);

afterAll(async () => {
  if (backend?.child.exitCode === null) { backend.child.kill('SIGTERM'); await backend.exited; }
  await sim?.close();
  net?.cleanup();
  await ops.cleanup();
}, 120_000);

describe("God's Eye View, slice 2, from real Connect records and a real backend's answer", () => {
  it('is timmy.overview/2: Devices, Hosting and Costs beside the first slice\'s sections, each with its as_of and counts, no absolute path', () => {
    expect(o.schema).toBe(OVERVIEW_SCHEMA);
    expect(OVERVIEW_SCHEMA).toBe('timmy.overview/2');
    expect([...OVERVIEW_SECTIONS]).toEqual(['needs', 'devices', 'hosting', 'agents', 'workflows', 'apps', 'spatial', 'history', 'costs', 'project']);
    for (const id of OVERVIEW_SECTIONS) {
      expect(o[id].as_of, id).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      for (const cnt of o[id].counts) expect(Number.isInteger(cnt.n), `${id}: ${cnt.of}`).toBe(true);
    }
    expect(o.devices.state).toBe('read');
    expect(o.hosting.state).toBe('read');
    expect(o.costs.state).toBe('read');
    const json = JSON.stringify(o) + JSON.stringify(repl);
    for (const x of new Set([s.base, s.root, s.home, net.root, os.tmpdir(), os.homedir()])) expect(json).not.toContain(x);
    expect(JSON.parse(JSON.stringify(o))).toEqual(o);
  });

  it('Devices: how each computer is reached, its last probe and when (never "online"), its system, what was found on its PATH, its remote jobs', () => {
    const d = Object.fromEntries(o.devices.items.map((x) => [x.id, x]));
    expect(Object.keys(d).sort()).toEqual(['lab', 'moved', 'newbox', 'studio']);
    // those that need a person first
    expect(o.devices.items[0].id).toBe('moved');
    const studio = d.studio;
    expect(studio.reach).toMatchObject({ address: '127.0.0.1', port: PORT.studio, user: 'tester', tailnet: null, words: `tester@127.0.0.1:${PORT.studio} over SSH` });
    expect(studio.probe).toMatchObject({ outcome: 'connected', answered: true });
    expect(studio.probe!.line).toMatch(/^answered its last probe, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(when it was true, not now\)$/);
    expect(studio.probe!.ago).toMatch(/^\d+ (s|min) ago$/);
    expect(studio.system.words).toMatch(/^Linux .*, shell POSIX sh \(login shell /);
    expect(studio.system.arch).toBe(os.arch() === 'x64' ? 'x86_64' : studio.system.arch);
    expect(studio.found_on_path).toContain('sh');
    expect(studio.found_words).toMatch(/^found on PATH: .* \(found on PATH only: not proven supported or working\)$/);
    expect(studio.host_key.state).toBe('confirmed');
    expect(studio.jobs).toEqual({ running: 1, ended: 1 });
    expect(studio.source).toMatchObject({ record: null, home: 'connect/devices.json', command: '/connect probe studio', board: 'ov-devices', detail: 'ov-dev-studio' });
    // lab: did not connect at its last probe; its system as the last probe that connected found it, its PATH not known now
    expect(d.lab.probe).toMatchObject({ outcome: 'unreachable', answered: false });
    expect(d.lab.probe!.line).toMatch(/^did not connect at its last probe, .* UTC: unreachable, refused$/);
    expect(d.lab.system.words).toMatch(/as its last probe that connected found it/);
    expect(d.lab.found_words).toBe('not known: its last probe did not connect');
    expect(d.newbox.host_key).toMatchObject({ state: 'fetched, not confirmed', words: expect.stringMatching(/^fetched .* UTC, not confirmed: ED25519 SHA256:/) });
    expect(d.newbox.probe).toBeNull();
    expect(d.moved.host_key.state).toBe('changed');
    expect(d.moved.host_key.words).toMatch(/^changed: Timmy refuses the key it offered \(.* UTC: SHA256:.*\); the confirmed one is ED25519 SHA256:/);
    // a tailnet is said only from the record's own address (none of these is one)
    expect(o.devices.items.every((x) => x.reach.tailnet === null)).toBe(true);
    // no computer is ever called online
    expect(JSON.stringify(o.devices)).not.toMatch(/\bonline\b/i);
    expect(o.devices.scope).toMatch(/^This computer's Timmy home, not the project/);
    expect(o.devices.summary).toBe('4 computers, 1 answered its last probe; 4 jobs, 1 running as read');
    expect(o.devices.counts.map((c) => `${c.n} ${c.of}`)).toEqual(expect.arrayContaining(['2 did not connect at their last probe', '1 not probed yet', '1 unknown', '1 stop asked, not confirmed']));
  });

  it('remote jobs keep Connect\'s states and words: running only as its status file said when read, unknown, stop asked, ended', () => {
    const j = Object.fromEntries(o.devices.jobs.map((x) => [x.id, x]));
    expect(j[job.running]).toMatchObject({ device: 'studio', state: 'running', label: 'sleep 300', device_known: true });
    expect(j[job.running].read_at).toMatch(/^\d{4}-/);
    expect(j[job.running].words).toMatch(/^running on studio: its status file said so \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(j[job.running].commands).toEqual([`/connect status ${job.running}`, `/connect stop ${job.running}`]);
    expect(j[job.ended]).toMatchObject({ state: 'ended', commands: [`/connect status ${job.ended}`, `/connect fetch ${job.ended} out.log`] });
    expect(j[job.unknown].state).toBe('unknown');
    expect(j[job.unknown].words).toMatch(/^unknown since .*: unreachable: 127\.0\.0\.1:2392 refused the connection/);
    expect(j[job.stopAsked].state).toBe('stop asked');
    expect(j[job.stopAsked].words).toMatch(/^stop asked .* UTC, not confirmed: /);
    // unknown and stop asked come first
    expect(o.devices.jobs.slice(0, 2).map((x) => x.state).sort()).toEqual(['stop asked', 'unknown']);
  });

  it('Needs you: the new kinds first among their peers, each with its reason and the command or route that settles it; bounded', () => {
    // nothing of the project's own waits here: the new kinds, by how urgent each is, the first 8 shown and the rest counted
    const all = remoteNeeds(readSources(s.root, { name: 'project', env: { TIMMY_HOME: timmyHome } })).items;
    expect(all.map((i) => i.kind).sort()).toEqual([
      'cloud-approval', 'cloud-cancel_asked', 'cloud-deletion_approval', 'cloud-domain_decision', 'cloud-export', 'cloud-failed_step', 'cloud-unknown_outcome',
      'device-unreachable', 'host-key', 'host-key-changed', 'remote-job', 'remote-job',
    ]);
    const own = o.needs.total - all.length; // the project's own (none is expected here, but its list is Waiting on you's)
    expect(own).toBeGreaterThanOrEqual(0);
    expect(o.needs.items).toHaveLength(8);
    expect(o.needs.more).toBe(o.needs.total - 8);
    expect(o.needs.items[0]).toMatchObject({ kind: 'host-key-changed', from: 'connect', commands: ['/connect scan moved', '/connect trust moved'] });
    expect(o.needs.urgent).toMatchObject({ tone: 'failed', source: { command: '/connect scan moved', board: 'ov-devices', detail: 'ov-dev-moved' } });
    const by = (kind: string): NeedsItem => all.find((i) => i.kind === kind)!;
    expect(by('device-unreachable')).toMatchObject({ title: expect.stringMatching(/^lab did not connect at its last probe \(.* UTC\): unreachable, refused$/), commands: ['/connect probe lab'], ago: expect.stringMatching(/ ago$/) });
    expect(by('host-key')).toMatchObject({ title: expect.stringMatching(/^newbox: a host key fetched .* UTC, not confirmed$/), commands: ['/connect trust newbox'] });
    const jobsWaiting = all.filter((i) => i.kind === 'remote-job');
    expect(jobsWaiting.map((i) => i.commands)).toEqual(expect.arrayContaining([[`/connect status ${job.unknown}`], [`/connect status ${job.stopAsked}`, `/connect stop ${job.stopAsked}`]]));
    // the backend's, with its words, its route and the read again
    expect(by('cloud-approval')).toMatchObject({ title: 'domain waits.example: waits for the operator\'s approval (quote $12.00 USD)', commands: [`POST /v1/operator/orders/${order.waits}/approve`, 'timmy cloud status'], from: 'cloud' });
    expect(by('cloud-unknown_outcome').title).toBe(`VPS ${VPS_ITEM}: a purchase or call whose outcome is unknown (the provider may have acted)`);
    expect(by('cloud-unknown_outcome').commands[0]).toBe(`POST /v1/operator/orders/${order.lost}/resolve`);
    expect(by('cloud-cancel_asked').title).toBe('domain late.example: cancel asked; the provider operation was NOT cancelled');
    expect(by('cloud-cancel_asked').why).toMatch(/the provider operation was NOT cancelled/);
    expect(by('cloud-failed_step').title).toBe('site for keep.example: DNS failed');
    expect(by('cloud-export').title).toMatch(/^site .*: export it for the customer \(retained until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/);
    expect(by('cloud-domain_decision').title).toMatch(/^domain keep\.example: transfer, renew or let lapse \(registration ends \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/);
    expect(by('cloud-deletion_approval').title).toMatch(/^site .*: a deletion waits for approval \(irreversible\)$/);
    for (const i of all) {
      expect(i.why.length, i.title).toBeGreaterThan(10);
      expect(i.commands.length, i.title).toBeGreaterThan(0);
      expect(i.source.home, i.title).toMatch(/^(connect\/devices\.json|jobs\/r[0-9a-f]{8}\.json|cloud\/overview\.json)$/);
    }
    expect(o.needs.notes.join(' ')).toMatch(/Timmy Cloud's items are as its backend at http:\/\/127\.0\.0\.1:\d+ answered .* UTC: timmy cloud status reads it again\./);
  });

  it('Hosting: each site, domain and VPS with its eight steps, each its own state; "simulated" on every item; the answer\'s time', () => {
    const h = o.hosting;
    expect(h.backend).toMatchObject({ set_up: true, url: backend.url });
    expect(h.read).toMatchObject({ old: false, command: 'timmy cloud status' });
    expect(h.read.words).toMatch(/^read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(h.provider).toMatchObject({ name: 'simulated provider', simulated: true });
    expect(h.items).toHaveLength(6);
    for (const it of h.items) {
      expect(it.steps.map((st) => st.label)).toEqual(['quote', 'approval', 'payment', 'acceptance', 'provisioning', 'DNS', 'certificate', 'health']);
      expect(it.steps_line.split(' · ')).toHaveLength(8);
      expect(it.simulated).toBe(true);
      expect(it.line).toMatch(/ \(simulated\)$/);
      expect(it.source).toMatchObject({ home: 'cloud/overview.json', board: 'ov-hosting', detail: `ov-order-${it.order}` });
    }
    const waits = h.items.find((x) => x.order === order.waits)!;
    expect(waits.steps_line).toBe('quote quoted · approval waiting · payment not started · acceptance not started · provisioning not started · DNS not needed · certificate not needed · health not needed');
    expect(waits.cost.words).toBe('$12.00 quoted; no purchase went out (nothing charged)');
    const lost = h.items.find((x) => x.order === order.lost)!;
    expect(lost.cost).toMatchObject({ charged_cents: null, words: '$7.00 quoted; charged: unknown (a purchase went out and no amount came back; never summed as 0)' });
    const partial = h.items.find((x) => x.order === order.partial)!;
    expect(partial).toMatchObject({ partial: true, name: 'site for keep.example' });
    expect(partial.steps.find((st) => st.name === 'dns')?.state).toBe('failed');
    expect(partial.resources.some((r) => r.kind === 'site' && r.state === 'retained' && r.retained_until)).toBe(true);
    const cancel = h.items.find((x) => x.order === order.cancel)!;
    expect(cancel.cancel?.words).toMatch(/^Cancel asked\. The provider has no operation that cancels a purchase or a setup, so the provider operation was NOT cancelled/);
    // those waiting for a person come first
    expect(h.items.slice(0, 4).every((x) => x.needs_person)).toBe(true);
    expect(h.summary).toMatch(/^6 orders, 4 need a person, 1 partial, simulated; read (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} UTC$/);
  });

  it('Costs: provider spend per customer against its limits, unknown cost counted and never summed as 0; model spend as the first slice has it', () => {
    const c = o.costs;
    const { scope, ...model } = c.model;
    expect(model).toEqual(o.history.costs);
    expect(scope).toMatch(/^this project's runs/);
    expect(c.provider.known).toBe(true);
    expect(c.provider.customers).toHaveLength(3);
    const waitsFirst = c.provider.customers.find((x) => x.limits?.auto_approve_up_to_cents === 2000)!;
    expect(waitsFirst.limits_words).toBe('at most $50.00 an order and $200.00 a month; approved without the operator up to $20.00 (and inside both limits)');
    expect(waitsFirst.unknown_cost_orders).toBe(1);
    expect(waitsFirst.words).toMatch(/1 order of unknown cost \(a purchase went out and no amount came back\), counted, never summed as 0$/);
    for (const x of c.provider.customers.filter((y) => y.limits?.auto_approve_up_to_cents === 0)) {
      expect(x.limits_words).toBe('at most $50.00 an order and $90.00 a month; no automatic approval (a threshold of 0: every purchase waits for the operator)');
    }
    // the reported amounts summed; the unknown one counted apart, never as 0
    expect(c.provider.paid_cents).toBe(c.provider.customers.reduce((n, x) => n + (x.paid_cents ?? 0), 0));
    expect(c.provider.paid_cents).toBe(3600);
    expect(c.provider.unknown_cost_orders).toBe(1);
    expect(c.summary).toBe('provider $36.00 paid this month, 1 unknown; model none reported, 0 unknown');
  });

  it('the map: a remote job depends on its device; an order\'s step waits on a decision; each line says why; still a layout', () => {
    const ids = o.map.columns.map((col) => col.id);
    expect(ids).toEqual(['agents', 'workflows', 'artifacts', 'remote', 'depends']);
    const edge = (from: string, to: string) => o.map.edges.find((e) => e.from === from && e.to === to);
    expect(edge(`r:${job.unknown}`, 'd:lab')?.why).toMatch(new RegExp(`^remote job ${job.unknown} runs on lab, as its record names it: it depends on lab \\(did not connect at its last probe`));
    const columnNodes = o.map.columns.flatMap((col) => col.nodes.map((n) => n.id));
    const orderEdges = o.map.edges.filter((e) => e.from.startsWith('o:'));
    expect(orderEdges.length).toBeGreaterThan(0);
    for (const e of orderEdges) { expect(columnNodes).toContain(e.from); expect(e.why).toMatch(/waits on a person's decision: /); }
    expect(o.map.label).toBe('layout, not geometry');
  });

  it('/overview: the first screen fits 80 columns with Devices, Hosting and Costs one line each; each section in full', () => {
    const first = plain(overviewFirstLines(o, { glyphs: g }));
    expect(first.length).toBeLessThanOrEqual(25);
    for (const l of first) expect(Array.from(l).length, l).toBeLessThanOrEqual(80);
    expect(first.slice(1).map((l) => l.slice(2, 13).trim())).toEqual(['Needs you', '', 'Devices', 'Hosting', 'Agents', 'Workflows', 'Apps', 'Spatial', 'History', 'Costs', 'Project', 'Map', 'In full', 'Board'] /* R4 (H99, gap 4): the newest request, its operation id whole; where the board shows it */);
    expect(first[2].trim()).toBe('/connect scan moved');
    expect(first[3]).toMatch(/^ {2}Devices {5}4 computers, 1 answered its last probe; 4 jobs, 1 running as read/);
    expect(first[4]).toMatch(/^ {2}Hosting {5}6 orders, 4 need a person, 1 partial, simulated; read /);
    expect(first[10]).toMatch(/^ {2}Costs {7}provider \$36\.00 paid this month, 1 unknown; model/);
    const devices = plain(overviewLines(o, 'devices', { glyphs: g })).join('\n');
    expect(devices).toContain('  DEVICES');
    expect(devices).toMatch(/probe {5}did not connect at its last probe, .* UTC: unreachable, refused \(\d+ (s|min) ago\)/);
    expect(devices).toContain('type      /connect probe studio · /connect devices');
    expect(devices).toContain('type      /connect probe moved · /connect scan moved · /connect trust moved · /connect devices');
    expect(devices).toContain(`${job.running}  running  on studio · sleep 300`);
    const hosting = plain(overviewLines(o, 'hosting', { glyphs: g })).join('\n');
    expect(hosting).toContain('steps   quote quoted · approval waiting · payment not started');
    expect(hosting).toContain(`type    POST /v1/operator/orders/${order.waits}/approve · timmy cloud status`);
    expect(hosting).toContain('provider  simulated provider: simulated (nothing real is bought, registered or set up)');
    const costs = plain(overviewLines(o, 'costs', { glyphs: g })).join('\n');
    expect(costs).toContain('limits  at most $50.00 an order and $90.00 a month; no automatic approval (a threshold of 0: every purchase waits for the operator)');
    // the aliases and the usage
    expect(plain(overviewLines(o, 'cloud', { glyphs: g }))[1]).toMatch(/^ {2}HOSTING/);
    expect(plain(overviewLines(o, 'computers', { glyphs: g }))[1]).toMatch(/^ {2}DEVICES/);
    expect(plain(overviewLines(o, 'nonsense', { glyphs: g }))).toEqual(['  Usage: /overview [needs|devices|hosting|agents|workflows|apps|spatial|history|costs|fleet|project|map] [--all] [--json]']);
  });

  it('one item said the same in /overview, the board and the JSON; the REPL\'s own overview reads the same', () => {
    // the first thing waiting (the board's Needs you card shows the first 4 and counts the rest)
    const first = o.needs.items[0];
    expect(first.kind).toBe('host-key-changed');
    const terminal = plain(overviewLines(o, 'needs', { glyphs: g })).join('\n');
    const board = overviewSection(o, boardKit({ live: false, base: '../../' })).html;
    expect(terminal).toContain(first.title);
    expect(terminal).toContain(first.commands.join(' · '));
    expect(board).toContain(esc(first.title));
    expect(board).toContain(`data-cmd="${esc(first.commands[0])}"`);
    expect(repl.needs.items[0].title).toBe(first.title);
    // the device's own line too, and the order's
    const labDevice = o.devices.items.find((d) => d.id === 'lab')!;
    expect(plain(overviewLines(o, 'devices', { glyphs: g })).join('\n')).toContain(labDevice.probe!.line);
    expect(board).toContain(esc(labDevice.probe!.line));
    const waits = o.hosting.items.find((x) => x.order === order.waits)!;
    expect(plain(overviewLines(o, 'hosting', { glyphs: g })).join('\n')).toContain(waits.summary);
    expect(board).toContain(esc(waits.summary));
    expect(repl.devices.items.map((d) => `${d.id}:${d.probe?.line ?? ''}`)).toEqual(o.devices.items.map((d) => `${d.id}:${d.probe?.line ?? ''}`));
    expect(repl.hosting.items.map((x) => x.steps_line)).toEqual(o.hosting.items.map((x) => x.steps_line));
  });

  it('the board\'s cards: each computer, remote job and order opens its detail in place, with its commands to copy; no style attribute; links stay within', () => {
    const html = overviewSection(o, boardKit({ live: true, base: '' })).html;
    expect(html).not.toMatch(/ style="/);
    for (const d of o.devices.items) {
      expect(html).toContain(`data-keep="overview:dev:${d.id}"`);
      expect(html).toContain(`<div class="ov-body" id="ov-dev-${d.id}">`);
      expect(html).toContain(`data-cmd="/connect probe ${d.id}"`);
    }
    for (const j of o.devices.jobs) expect(html).toContain(`<div class="ov-body" id="ov-job-${j.id}">`);
    for (const x of o.hosting.items) expect(html).toContain(`<div class="ov-body" id="ov-order-${x.order}">`);
    expect(html).toContain(`data-cmd="POST /v1/operator/orders/${order.waits}/approve"`);
    expect(html).toContain('Probing, reading a job&#39;s status, stopping and fetching contact the computer: in this slice they stay typed commands in Timmy');
    expect(html).toContain('<span class="ov-tag">simulated</span>');
    // a link from Needs you goes to the item's own detail on this page
    expect(html).toContain('<a class="ov-go" href="#ov-dev-moved">Devices</a>');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const inPage = [...html.matchAll(/<a [^>]*href="#([^"]+)"/g)].map((m) => m[1]).filter((t) => t.startsWith('ov-'));
    expect(inPage.length).toBeGreaterThan(5);
    expect(inPage.filter((t) => !ids.has(t))).toEqual([]);
    // the live page's shape leaves out what changes as the clock moves
    expect(JSON.stringify(overviewShape(o))).not.toMatch(/"ago":/);
  });

  it('the operator\'s token is in no printed word, no JSON and no file but its own', () => {
    expect(outputs.length).toBeGreaterThanOrEqual(4);
    for (const out of outputs) expect(out).not.toContain(operatorToken);
    expect(JSON.stringify(o)).not.toContain(operatorToken);
    const walk = (dir: string): string[] => fs.readdirSync(dir).flatMap((n) => {
      const f = path.join(dir, n);
      const st = fs.lstatSync(f);
      return st.isDirectory() ? walk(f) : st.isFile() ? [f] : [];
    });
    for (const f of walk(s.base)) if (f !== tokenFile) expect(fs.readFileSync(f).includes(operatorToken), f).toBe(false);
  });
});

describe('unknown and old sources: each said so, with why and the command that settles it', () => {
  const temp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h93-overview-home-')));
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  it('no backend set up: Hosting says not set up, with the command; Costs says provider not set up; no computers yet', () => {
    const home = temp();
    dirs.push(home);
    const x = buildOverview(s.root, { name: 'project', env: { TIMMY_HOME: home } });
    expect(x.hosting).toMatchObject({ state: 'read', summary: 'not set up', backend: { set_up: false, command: SETUP_COMMAND } });
    expect(x.hosting.urgent).toMatchObject({ text: 'timmy cloud use <url> --token-file <file> sets one up', source: { command: SETUP_COMMAND } });
    expect(x.costs.provider).toMatchObject({ known: false, words: `not set up: ${SETUP_COMMAND}` });
    expect(x.devices).toMatchObject({ state: 'read', summary: 'no computers yet (/connect add)', items: [], jobs: [] });
    const first = plain(overviewFirstLines(x, { glyphs: g }));
    expect(first.find((l) => l.startsWith('  Hosting'))).toBe('  Hosting     not set up · timmy cloud use <url> --token-file <file> sets one up');
  });

  it('a kept answer that cannot be read, and one older than an hour: unknown with why, and old with the command that reads it again', () => {
    const home = temp();
    dirs.push(home);
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.copyFileSync(path.join(timmyHome, 'cloud', 'config.json'), path.join(home, 'cloud', 'config.json'));
    fs.writeFileSync(path.join(home, 'cloud', 'overview.json'), '{ not json');
    const bad = buildOverview(s.root, { name: 'project', env: { TIMMY_HOME: home } });
    expect(bad.hosting.state).toBe('unknown');
    expect(bad.hosting.why).toBe('the backend\'s last answer (cloud/overview.json in this computer\'s Timmy home) cannot be read: it is not JSON; timmy cloud status reads the backend again');
    expect(bad.costs.state).toBe('partial');
    expect(bad.costs.provider.known).toBe(false);
    // the real answer, read now as if two hours had passed
    const later = buildOverview(s.root, { name: 'project', env: { TIMMY_HOME: timmyHome }, now: () => Date.now() + 2 * HOUR });
    expect(later.hosting.read).toMatchObject({ old: true, ago: expect.stringMatching(/^2 h ago$/) });
    expect(later.hosting.read.words).toMatch(/^read .* UTC: old, older than an hour$/);
    expect(later.hosting.urgent?.text).toMatch(/^the backend's answer is old \(read .* UTC\): timmy cloud status reads it again$/);
    expect(later.hosting.summary).toMatch(/^old, read .* UTC: timmy cloud status reads it again; 6 orders, 4 need a person$/);
    expect(later.costs.provider.old).toBe(true);
    expect(plain(overviewFirstLines(later, { glyphs: g })).find((l) => l.startsWith('  Hosting'))).toMatch(/^ {2}Hosting {5}old, read .* UTC: timmy cloud status reads it again/);
    // a backend set up and never read
    const never = temp();
    dirs.push(never);
    fs.mkdirSync(path.join(never, 'cloud'), { recursive: true });
    fs.copyFileSync(path.join(timmyHome, 'cloud', 'config.json'), path.join(never, 'cloud', 'config.json'));
    const unread = buildOverview(s.root, { name: 'project', env: { TIMMY_HOME: never } });
    expect(unread.hosting).toMatchObject({ state: 'unknown', why: `the backend at ${backend.url} has not been read yet: timmy cloud status reads it` });
  });

  it('a device record that cannot be read, and a remote job record that cannot be read: unknown, named with why', () => {
    const home = temp();
    dirs.push(home);
    fs.mkdirSync(path.join(home, 'connect'), { recursive: true });
    fs.writeFileSync(path.join(home, 'connect', 'devices.json'), 'not json');
    fs.mkdirSync(path.join(home, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'jobs', 'r0000beef.json'), '{ "kind": "remote" ');
    const x = buildOverview(s.root, { name: 'project', env: { TIMMY_HOME: home } });
    expect(x.devices.state).toBe('unknown');
    expect(x.devices.summary).toBe('not known');
    expect(x.devices.why).toMatch(/^connect\/devices\.json: .*devices\.json is not valid JSON; jobs\/r0000beef\.json: not a readable remote job record$/);
    expect(x.devices.unreadable.map((u) => u.record)).toEqual(['connect/devices.json', 'jobs/r0000beef.json']);
    const shown = plain(overviewLines(x, 'devices', { glyphs: g })).join('\n');
    expect(shown).toContain('unknown: connect/devices.json could not be read');
    expect(plain(overviewFirstLines(x, { glyphs: g })).find((l) => l.startsWith('  Devices'))).toMatch(/^ {2}Devices {5}unknown: connect\/devices\.json: /);
  });
});

/** One HTTP request to the live board on 127.0.0.1 (Node, not the page). */
function raw(port: number, o2: { method?: string; path: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o2.method ?? 'GET', path: o2.path, headers: o2.headers ?? {} }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c: string) => { body += c; }).on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(!browserPath)('the live board in a real headless Chromium: selecting an item opens its detail', () => {
  let browser: Browser;
  // A real Chromium's launch and close each get a deadline of their own (R5 H130). Vitest's default for a hook is 10 s, below
  // Playwright's own 30 s for a launch; in a full run on 2 CPUs with two other agents testing, this close took longer than
  // that ("Hook timed out in 10000ms", after every test here had passed), though it takes 0.1 s here alone and 0.2 to
  // 0.25 s beside four CPU burners. As board-needs-person-browser and board-results-browser give their launch.
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath, timeout: 60_000 }); }, 90_000);
  afterAll(async () => { await browser?.close(); }, 60_000);

  it('Devices, Hosting and Costs are cards of the Overview; a computer, a remote job and an order open in place; a link from Needs you opens its detail; GET /overview needs the token', async () => {
    expect(text(await ws.boardLive('live'))).toContain('Live board');
    const lb = ws.liveBoard!;
    const token = lb.url.split('#t=')[1];
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(lb.url);
    await page.waitForSelector('#ov-devices');
    expect(await page.$$eval('.ov-grid > article', (els) => els.map((e) => e.getAttribute('data-ov')))).toEqual(['needs', 'devices', 'hosting', 'agents', 'workflows', 'apps', 'spatial', 'history', 'costs', 'project']);
    // a computer: closed, then selected: its record's words, its last probe and its commands
    const lab = page.locator('details[data-keep="overview:dev:lab"]');
    expect(await lab.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
    await lab.locator('summary').click();
    expect(await lab.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true);
    const labText = await lab.locator('.ov-body').innerText();
    expect(labText).toMatch(/did not connect at its last probe, .* UTC: unreachable, refused/);
    expect(labText).toContain('connect/devices.json in this computer\'s Timmy home');
    expect(await lab.locator('button.cmd').evaluateAll((els) => els.map((e) => e.getAttribute('data-cmd')))).toEqual(['/connect probe lab', '/connect devices']);
    // a remote job
    const unknown = page.locator(`details[data-keep="overview:job:${job.unknown}"]`);
    await unknown.locator('summary').click();
    expect(await unknown.locator('.ov-body').innerText()).toMatch(/unknown since .*: unreachable: 127\.0\.0\.1:2392 refused the connection/);
    // an order: its eight steps, each its own state, and its route to copy
    const waits = page.locator(`details[data-keep="overview:order:${order.waits}"]`);
    await waits.locator('summary').click();
    expect(await waits.locator('.ov-steps li').count()).toBe(8);
    expect(await waits.locator('.ov-steps li.ov-step-waiting b').textContent()).toBe('approval');
    expect(await waits.locator('summary .ov-tag').textContent()).toBe('simulated');
    expect(await waits.locator('button.cmd').evaluateAll((els) => els.map((e) => e.getAttribute('data-cmd')))).toEqual([`POST /v1/operator/orders/${order.waits}/approve`, 'timmy cloud status']);
    // the first thing waiting (moved's changed host key) links to that computer's detail, which opens when followed; R4 (H99,
    // r24 gap 11): it is said once, as the list's first item (no "first" line repeats it above the list)
    const moved = page.locator('details[data-keep="overview:dev:moved"]');
    expect(await moved.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
    expect(await page.locator('.ov-needs .ov-urgent').count()).toBe(0);
    await page.locator('.ov-needs .ov-items > li:first-child a.ov-go[href="#ov-dev-moved"]').click();
    await page.waitForFunction(() => location.hash === '#ov-dev-moved');
    await page.waitForFunction(() => (document.querySelector('details[data-keep="overview:dev:moved"]') as HTMLDetailsElement | null)?.open === true, undefined, { timeout: 5000 });
    expect(await moved.locator('.ov-body').innerText()).toMatch(/host key\s+changed: Timmy refuses the key it offered/);
    // GET /overview: the same model, with the token only
    const auth = { Authorization: `Bearer ${token}` };
    const got = await raw(lb.port, { path: '/overview', headers: auth });
    expect(got.status).toBe(200);
    const model = JSON.parse(got.body) as Overview;
    expect(model.schema).toBe('timmy.overview/2');
    expect(model.devices.items.map((d) => d.id).sort()).toEqual(['lab', 'moved', 'newbox', 'studio']);
    expect(model.hosting.items).toHaveLength(6);
    expect(model.needs.items[0].title).toBe(o.needs.items[0].title);
    expect(got.body).not.toContain(operatorToken);
    expect((await raw(lb.port, { path: '/overview' })).status).toBe(401);
    expect(problems).toEqual([]);
    await context.close();
  }, 180_000);
});
