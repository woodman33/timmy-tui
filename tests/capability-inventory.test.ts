/**
 * R11 Phase 2 (H170): the one capability inventory both surfaces read (src/capabilities/inventory.ts), on FAKE homes and
 * FAKE projects. Every state word is proven apart: available (the files or binaries are here), configured (the key,
 * setting or address is set), exercised (a receipt of a real run exists). A key's value never enters the output; nothing
 * is run to compute it (a trap on node:child_process); the receipts that count are sealed on the project's real chain
 * (appendReceipt: hash-chained and signed there); a tampered chain vouches for nothing.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityInventory, inventory, INVENTORY_GROUPS, STATE_MEANS, type InventoryRow } from '../src/capabilities/inventory.js';
import { rowWords, standingWord } from '../src/capabilities/inventory-words.js';
import { PROVIDER_LABEL } from '../src/setup/providers-state.js';
import { appendReceipt, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';

const trap = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const wrapped = Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => {
    trap.calls.push(`${n} ${String(args[0])}`);
    return (real[n] as (...a: unknown[]) => unknown)(...args);
  }]));
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); trap.calls.length = 0; });

const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const byId = (rows: InventoryRow[]): Record<string, InventoryRow> => Object.fromEntries(rows.map((r) => [r.id, r]));

/** A FAKE home and a FAKE project: an empty PATH, a Timmy home of its own, the project's store pinned (as timmy init writes it). */
function fakeBox(o: { env?: Record<string, string>; setup?: Record<string, unknown> } = {}): { env: Record<string, string>; project: string; bin: string; home: string } {
  const box = temp('timmy-inventory-');
  const bin = join(box, 'bin'); mkdirSync(bin);
  const home = join(box, 'home'); mkdirSync(home);
  const timmyHome = join(home, 'timmy'); mkdirSync(timmyHome);
  const project = join(box, 'project'); mkdirSync(project);
  put(project, '.timmy/store-pin', `${join(project, '.timmy', 'receipts')}\n`);
  if (o.setup) put(timmyHome, 'setup.json', JSON.stringify({ version: 1, answers: o.setup }));
  const env: Record<string, string> = {
    PATH: bin, HOME: home, TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: project, TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_MCP_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), ...o.env,
  };
  return { env, project, bin, home };
}

/** A program the inventory can find on the PATH: a FAKE shell script (the inventory never runs it; the trap proves it). */
function program(bin: string, name: string): void {
  const f = join(bin, name);
  writeFileSync(f, '#!/bin/sh\necho "FAKE: found by the inventory tests, never run"\nexit 1\n');
  chmodSync(f, 0o755);
}

/** A receipt sealed on the project's real chain (appendReceipt: hash-chained and signed there). */
const seal = (project: string, input: Partial<ReceiptInput> & { kind: string }): Receipt =>
  appendReceipt('runs', { subject: `${input.kind} · the inventory tests`, policy: 'human-gated', status: 'ok', project: 'inventory', ...input } as ReceiptInput, project);

describe('the capability inventory: one shape, three words kept apart, nothing run', () => {
  it('a bare FAKE home: every row carries its three facts with a source and a sentence, grouped in order, with nothing run', () => {
    const { env, project } = fakeBox();
    const t0 = performance.now();
    const inv = inventory({ env, cwd: project, platform: 'linux', now: Date.parse('2026-10-23T20:00:00Z') });
    const ms = performance.now() - t0;
    expect(trap.calls).toEqual([]);
    expect(inv.schema).toBe('timmy.capability-inventory/1');
    expect(inv.readAt).toBe('2026-10-23T20:00:00.000Z');
    expect(inv.means).toEqual(STATE_MEANS);
    expect(inv.groups).toEqual(INVENTORY_GROUPS);
    const rows = inv.rows;
    expect(rows.length).toBeGreaterThan(10);
    // ids unique; groups in INVENTORY_GROUPS order; every row names an existing name
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const order = rows.map((r) => INVENTORY_GROUPS.indexOf(r.group));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const r of rows) {
      expect(r.name.trim().length).toBeGreaterThan(0);
      for (const word of ['available', 'configured'] as const) {
        const f = r[word];
        expect(typeof f.ok).toBe('boolean');
        expect(f.found.length).toBeGreaterThan(0);
        expect(f.source).toMatch(/\(src\/[a-z/-]+\.ts/);
        expect(f.words.startsWith(`${r.name}: `)).toBe(true);
        expect(f.words.endsWith('.')).toBe(true);
        expect(f.words).toContain(f.ok ? `: ${word}, ` : `: not ${word}, `);
      }
      expect(r.exercised.ok).toBe(false); // an empty chain vouches for no run
      expect(r.exercised.source).toMatch(/\(src\/[a-z/-]+\.ts/);
      expect(r.exercised.words.startsWith(`${r.name}: not exercised, `)).toBe(true);
      expect(r.next?.length ?? 0).toBeGreaterThan(0); // nothing exercised: every row has its one step
    }
    // the four chat providers by their names, first
    expect(rows.slice(0, 4).map((r) => [r.id, r.name])).toEqual([
      ['model:openrouter', PROVIDER_LABEL.openrouter], ['model:ollama-local', PROVIDER_LABEL['ollama-local']],
      ['model:ollama-cloud', PROVIDER_LABEL['ollama-cloud']], ['model:cloudflare', PROVIDER_LABEL.cloudflare],
    ]);
    const r = byId(rows);
    expect(r['model:ollama-local'].available.ok).toBe(false);
    expect(r['model:ollama-local'].available.found).toContain('not installed here');
    expect(r['model:ollama-local'].configured.ok).toBe(false);
    expect(r['model:openrouter'].configured.ok).toBe(false);
    expect(r['model:openrouter'].configured.found).toContain('no key is set');
    expect(r['model:cloudflare'].configured.ok).toBe(false);
    expect(r['model:cloudflare'].exercised.found).toContain('Timmy sends Cloudflare no request');
    // the MCP-to-CLI routes keep their current names; OpenHands; the vision bridge; the receipts chain
    expect(r['mcp:route:mcporter'].name).toBe('MCP to CLI · MCPorter');
    expect(r['mcp:route:sdk'].name).toBe('MCP to CLI · SDK');
    expect(r['agent:openhands'].name).toBe('OpenHands, local model');
    expect(r['agent:openhands'].available.found).toContain('docker is not on PATH');
    expect(r['vision:bridge'].group).toBe('Vision');
    expect(r['receipts:chain'].group).toBe('Receipts');
    expect(r['receipts:chain'].configured.ok).toBe(true); // the store pin
    expect(r['receipts:chain'].available.ok).toBe(false); // no chain file yet
    expect(r['receipts:chain'].exercised.found).toBe('no receipt sealed yet');
    // the vox tools, one row each, Tools
    expect(rows.filter((x) => x.id.startsWith('vox:')).length).toBeGreaterThan(5);
    expect(rows.filter((x) => x.id.startsWith('vox:')).every((x) => x.group === 'Tools')).toBe(true);
    // the lanes, one row each, Lanes; none on the empty PATH
    const lanes = rows.filter((x) => x.id.startsWith('lane:'));
    expect(lanes.length).toBeGreaterThan(5);
    expect(lanes.every((x) => x.group === 'Lanes' && !x.available.ok && /is not on PATH$/.test(x.available.found))).toBe(true);
    // quick: files, settings and receipts only (the brief: under 200 ms on the dev box; here with the trap and a cold import)
    expect(ms).toBeLessThan(1500);
    process.stdout.write(`inventory read in ${ms.toFixed(0)} ms (${rows.length} rows)\n`);
  });

  it('a key is present or not, and where; its value never enters the output', () => {
    // FAKE values shaped so no real-key pattern matches them (hyphens break the runs the privacy gate looks for); never real keys
    const values = { OPENROUTER_API_KEY: 'sk-or-v1-FAKE-key-value-0123-4567-89ab', ROBOFLOW_API_KEY: 'FAKE-roboflow-key-value-98765', RETOOL_API_KEY: 'FAKE-retool-key-value-4321', OLLAMA_API_KEY: 'FAKE-ollama-cloud-key-value-1357' };
    const { env, project } = fakeBox({ env: { ...values, TIMMY_VISION_MODEL_ID: 'fake-workspace/fake-model/1' } });
    const inv = inventory({ env, cwd: project, platform: 'linux' });
    const text = JSON.stringify(inv);
    for (const v of Object.values(values)) expect(text).not.toContain(v);
    const r = byId(inv.rows);
    expect(r['model:openrouter'].configured.ok).toBe(true);
    expect(r['model:openrouter'].configured.found).toMatch(/^a key is present \(.+\), from /);
    expect(r['model:openrouter'].configured.found).not.toContain('sk-or-v1-FAKE');
    expect(r['vox:roboflow'].configured.ok).toBe(true);
    expect(r['vox:roboflow'].configured.found).toBe('ROBOFLOW_API_KEY is set (its value is never shown)');
    expect(r['lane:retool'].configured.ok).toBe(true);
    expect(r['lane:retool'].configured.found).toBe('RETOOL_API_KEY is set (its value is never shown)');
    expect(r['vision:bridge'].configured.ok).toBe(true);
    expect(r['vision:bridge'].configured.found).toContain('model fake-workspace/fake-model/1 (TIMMY_VISION_MODEL_ID)');
    expect(trap.calls).toEqual([]);
  });

  it('the three words stay apart: a sealed run makes a row exercised without making it configured or available', () => {
    const { env, project } = fakeBox();
    put(project, 'config/mcporter.json', JSON.stringify({ mcpServers: { 'fake-server': { command: 'fake-mcp-server' } } }));
    const local = seal(project, { kind: 'turn', subject: 'repl · 1 step', via: 'ollama', model_requested: 'qwen3:8b', sources: [{ kind: 'ollama', host: '127.0.0.1:11434', endpoint: '/api/chat', tools: false, cost_basis: 'local' }] } as Partial<ReceiptInput> & { kind: string });
    const cloud = seal(project, { kind: 'chat', subject: 'chat.turn · workbench · 1 step · gpt-oss:120b-cloud', via: 'ollama', model_requested: 'gpt-oss:120b-cloud', model_resolved: 'gpt-oss:120b-cloud', sources: [{ kind: 'ollama', host: '127.0.0.1:11434', endpoint: '/api/chat', tools: false, cost_basis: 'cloud' }] } as Partial<ReceiptInput> & { kind: string });
    const openrouter = seal(project, { kind: 'turn', subject: 'repl · 2 steps', model_requested: 'fake/chat-model' } as Partial<ReceiptInput> & { kind: string });
    const mcp = seal(project, { kind: 'mcp.call', subject: 'mcp.call · fake-server · tools/list', sources: [{ server: 'fake-server', route: 'mcporter', outcome: 'answered', called: true, isError: false }], outputs: [{ path: '.timmy/mcp/m00000001/output.json', sha256: '0'.repeat(64), bytes: 2 }] } as Partial<ReceiptInput> & { kind: string });
    const dispatch = seal(project, { kind: 'run', subject: 'dispatch d1 · retool · 1x' } as Partial<ReceiptInput> & { kind: string });
    const failed = seal(project, { kind: 'turn', subject: 'repl · failed', status: 'failed', model_requested: 'fake/chat-model' } as Partial<ReceiptInput> & { kind: string });
    expect(failed.hash).not.toBe(openrouter.hash);
    trap.calls.length = 0; // sealing records the environment (uname, sw_vers, sh): the test's own doing, before the inventory reads
    const r = byId(capabilityInventory({ env, cwd: project, platform: 'linux' }));
    const exercised = (row: InventoryRow): { receipt: string; hash: string; when: string; what: string } => {
      expect(row.exercised.ok).toBe(true);
      if (!row.exercised.ok) throw new Error('unreachable');
      return row.exercised;
    };
    // Ollama on this computer: exercised by the local turn; not installed, not configured
    const ol = r['model:ollama-local'];
    expect(exercised(ol)).toMatchObject({ hash: local.hash, receipt: local.hash.slice(7, 15), when: local.ts });
    expect(exercised(ol).what).toBe('a sealed chat turn answered by qwen3:8b through Ollama at 127.0.0.1:11434');
    expect(ol.available.ok).toBe(false);
    expect(ol.configured.ok).toBe(false);
    expect(ol.next).toBeUndefined();
    expect(ol.exercised.words).toContain(`${PROVIDER_LABEL['ollama-local']}: exercised on ${local.ts.slice(0, 10)} at ${local.ts.slice(11, 16)} UTC, a sealed chat turn`);
    expect(standingWord(ol)).toBe('exercised');
    // Ollama Cloud: the cloud-backed model's turn, not the local one
    expect(exercised(r['model:ollama-cloud']).hash).toBe(cloud.hash);
    expect(exercised(r['model:ollama-cloud']).what).toContain('gpt-oss:120b-cloud, a cloud-backed model through Ollama');
    expect(r['model:ollama-cloud'].configured.ok).toBe(false);
    // OpenRouter: the newest ok turn without the Ollama route; a failed turn never counts
    expect(exercised(r['model:openrouter']).hash).toBe(openrouter.hash);
    expect(exercised(r['model:openrouter']).what).toBe('a sealed chat turn answered by fake/chat-model through OpenRouter');
    expect(r['model:openrouter'].configured.ok).toBe(false);
    // the MCP server named in the project's MCPorter config: configured by the file, exercised by its answered call
    expect(r['mcp:server:fake-server'].configured.found).toBe('named in config/mcporter.json; the server itself is not contacted here');
    expect(exercised(r['mcp:server:fake-server'])).toMatchObject({ hash: mcp.hash, what: 'an MCP call to fake-server answered through the mcporter route', record: '.timmy/mcp/m00000001/output.json' });
    expect(r['mcp:route:mcporter'].configured.found).toContain('1 server named in config/mcporter.json: fake-server');
    // the lane: dispatched (the launch's receipt), while its key is not set and its command is not here
    expect(exercised(r['lane:retool']).hash).toBe(dispatch.hash);
    expect(exercised(r['lane:retool']).what).toContain('dispatch d1 started 1 copy of this lane');
    expect(r['lane:retool'].configured.ok).toBe(false);
    expect(r['lane:retool'].available.ok).toBe(false);
    // the chain itself: here, pinned, and its newest receipt shown
    const chain = r['receipts:chain'];
    expect(chain.available.ok).toBe(true);
    expect(chain.available.found).toBe('the runs chain is here (.timmy/receipts/runs.jsonl)');
    expect(exercised(chain).hash).toBe(failed.hash);
    expect(exercised(chain).what).toContain('6 receipts, chain verified');
    // Cloudflare and the vision bridge never count a run from these receipts
    expect(r['model:cloudflare'].exercised.ok).toBe(false);
    expect(r['vision:bridge'].exercised.ok).toBe(false);
    expect(trap.calls).toEqual([]);
  });

  it('a tampered chain vouches for nothing: every exercised word falls, and says why', () => {
    const { env, project } = fakeBox();
    seal(project, { kind: 'turn', subject: 'repl · 1 step', model_requested: 'fake/chat-model' } as Partial<ReceiptInput> & { kind: string });
    seal(project, { kind: 'turn', subject: 'repl · 1 step', model_requested: 'fake/chat-model' } as Partial<ReceiptInput> & { kind: string });
    const file = join(project, '.timmy', 'receipts', 'runs.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n');
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first.subject = 'repl · 1 step (TAMPERED by the test)';
    lines[0] = JSON.stringify(first);
    writeFileSync(file, lines.join('\n'));
    trap.calls.length = 0; // the sealing's own environment capture, not the inventory's
    const rows = capabilityInventory({ env, cwd: project, platform: 'linux' });
    for (const r of rows) expect(r.exercised.ok).toBe(false);
    const r = byId(rows);
    expect(r['model:openrouter'].exercised.found).toMatch(/^no run counts: the receipts chain does not verify/);
    expect(r['receipts:chain'].exercised.found).toMatch(/^the receipts chain does not verify/);
    expect(trap.calls).toEqual([]);
  });

  it('available means the files are here: a FAKE ollama on the PATH is found, never run; the setup makes it configured', () => {
    const box = fakeBox({ setup: { chat: 'local', model: 'qwen3:8b', ollama: 'http://127.0.0.1:11434' } });
    program(box.bin, 'ollama');
    program(box.bin, 'docker');
    const r = byId(capabilityInventory({ env: box.env, cwd: box.project, platform: 'linux' }));
    expect(r['model:ollama-local'].available).toMatchObject({ ok: true, found: 'Ollama is installed (the ollama program is on the PATH)', source: 'ollamaInstalled (src/setup/ollama-local.ts)' });
    expect(r['model:ollama-local'].configured).toMatchObject({ ok: true, found: 'the chat is set to local qwen3:8b from the setup; Ollama at http://127.0.0.1:11434', source: 'resolveChatRoute (src/agent/chat-route.ts)' });
    expect(r['model:ollama-local'].exercised.ok).toBe(false);
    expect(standingWord(r['model:ollama-local'])).toBe('configured');
    expect(r['model:ollama-local'].next).toContain('Send a message');
    // a cloud-backed name chosen for the chat configures Ollama Cloud, not Ollama on this computer
    const cloud = fakeBox({ setup: { chat: 'local', model: 'gpt-oss:120b-cloud' } });
    const c = byId(capabilityInventory({ env: cloud.env, cwd: cloud.project, platform: 'linux' }));
    expect(c['model:ollama-local'].configured.ok).toBe(false);
    expect(c['model:ollama-local'].configured.found).toContain('it runs in Ollama Cloud, not on this computer');
    expect(c['model:ollama-cloud'].configured.ok).toBe(true);
    expect(c['model:ollama-cloud'].configured.found).toContain('the chat is set to local gpt-oss:120b-cloud (a cloud-backed name)');
    // docker found: OpenHands' docker is here (its daemon not asked), the worker as this build has it
    expect(r['agent:openhands'].available.found).toMatch(/^docker at .*bin\/docker \(its daemon and the timmy-openhands:[0-9.]+ image are not asked here\); the OpenHands worker is (in|not in) this build$/);
    expect(trap.calls).toEqual([]);
  });

  it('the vision bridge: present it is a file, absent the build says so; Roboflow inference stays unverified either way', () => {
    const { env, project } = fakeBox();
    const present = byId(capabilityInventory({ env, cwd: project, platform: 'linux', packaged: () => true }))['vision:bridge'];
    expect(present.name).toBe('vision bridge (timmy vision run, timmy_vision_* tools)');
    expect(present.available).toMatchObject({ ok: true, found: 'in this build: scripts/vision-bridge.py (a file, not a verified model)' });
    expect(present.configured.ok).toBe(false);
    expect(present.exercised).toMatchObject({ ok: false, found: 'Roboflow inference is unverified: no real authorized run has succeeded, so no receipt counts here' });
    expect(present.next).toBe('set ROBOFLOW_API_KEY, a Python with inference-sdk and a configured model or server');
    const absent = byId(capabilityInventory({ env, cwd: project, platform: 'linux', packaged: () => false }))['vision:bridge'];
    expect(absent.available).toMatchObject({ ok: false, found: 'missing from this installation: scripts/vision-bridge.py (the npm package carries it)' });
    expect(absent.exercised.found).toContain('unverified');
    expect(absent.next).toBe('reinstall Timmy, or run it from a checkout of its repository');
    // the vox Roboflow tool says the same, in its own row
    const rf = byId(capabilityInventory({ env, cwd: project, platform: 'linux' }))['vox:roboflow'];
    expect(rf.exercised.found).toContain('Roboflow inference is unverified');
    expect(trap.calls).toEqual([]);
  });

  it('the words file: one sentence per word per row, and the one word a glyph shows', () => {
    const base = { id: 'x', name: 'A thing', group: 'Tools' as const, available: { ok: true, found: 'its file is here', source: 'f' }, configured: { ok: false, found: 'no key is set', source: 'g' } };
    const none = rowWords({ ...base, exercised: { ok: false, found: 'no run yet', source: 'h' } });
    expect(none).toEqual({ available: 'A thing: available, its file is here.', configured: 'A thing: not configured, no key is set.', exercised: 'A thing: not exercised, no run yet.' });
    const ran = rowWords({ ...base, exercised: { ok: true, receipt: 'abcdef01', hash: 'sha256_abcdef01', when: '2026-10-23T19:39:15.000Z', what: 'a sealed run', source: 'h' } });
    expect(ran.exercised).toBe('A thing: exercised on 2026-10-23 at 19:39 UTC, a sealed run (receipt abcdef01).');
    expect(standingWord({ ...base, exercised: { ok: false, found: 'x', source: 'h' } })).toBe('available');
    expect(standingWord({ ...base, configured: { ok: true, found: 'set', source: 'g' }, exercised: { ok: false, found: 'x', source: 'h' } })).toBe('configured');
    expect(standingWord({ ...base, available: { ok: false, found: 'no', source: 'f' }, exercised: { ok: false, found: 'x', source: 'h' } })).toBe('none');
  });
});
