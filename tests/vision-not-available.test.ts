/**
 * Bridge asset and missing-asset controls. The real script must ship, while an
 * explicitly simulated missing installation fails closed before inference.
 * Local history/feedback and the direct-HTTP catalog do not require Python.
 * Injected runners and the JavaScript child below are UNIT doubles, not models.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVisionCli } from '../src/vision/cli.js';
import { callVisionTool } from '../src/vision/mcp.js';
import { getVisionStatus, runVisionInspection, visionBridgeAvailability, VISION_BRIDGE } from '../src/vision/runtime.js';
import { visionAsset } from '../src/vision/config.js';
import { verifyChain } from '../src/utils/receipts.js';

const trap = vi.hoisted(() => ({ calls: [] as string[], missingBridge: false }));
vi.mock('../src/vision/config.js', async (orig) => {
  const real = await orig<typeof import('../src/vision/config.js')>();
  return { ...real, visionAsset: (path: string, dir = process.cwd()) =>
    trap.missingBridge && path === 'scripts/vision-bridge.py' ? join(dir, path) : real.visionAsset(path, dir) };
});
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const wrapped = Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => {
    trap.calls.push(`${n} ${String(args[0])}`);
    return (real[n] as (...a: unknown[]) => unknown)(...args);
  }]));
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=';
let dir: string;
let before: string;
let exitBefore: typeof process.exitCode;
const said: string[] = [];
const printed: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-vision-asset-'));
  before = process.cwd();
  exitBefore = process.exitCode;
  process.chdir(dir);
  trap.calls.length = 0;
  trap.missingBridge = false;
  said.length = 0; printed.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(a.join(' ')); });
  vi.stubEnv('ROBOFLOW_API_KEY', '');
  vi.stubEnv('ROBOFLOW_WORKSPACE', '');
  vi.stubGlobal('fetch', (input: unknown) => { throw new Error(`a request was made: ${String(input)}`); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.chdir(before);
  process.exitCode = exitBefore;
  rmSync(dir, { recursive: true, force: true });
});

describe('the shipped bridge and explicit missing-installation negative controls', () => {
  it('the repository carries the real bridge asset; finding it alone does not run inference', () => {
    const asset = visionAsset(VISION_BRIDGE, before);
    expect(existsSync(asset)).toBe(true);
    expect(visionBridgeAvailability(before)).toEqual({ available: true, bridge: asset });
    expect(trap.calls).toEqual([]);
  });

  it('simulated missing asset: CLI run/status/serve/open exit 2 without Python, network, or retained data', async () => {
    trap.missingBridge = true;
    writeFileSync(join(dir, 'in.png'), Buffer.from(PNG, 'base64'));
    for (const sub of ['run', 'status', 'serve', 'open'] as const) {
      said.length = 0; printed.length = 0; process.exitCode = 0;
      await runVisionCli(sub === 'run' ? ['run', '--image', 'in.png', '--model', 'unit-only/1'] : [sub]);
      expect(process.exitCode, sub).toBe(2);
      expect(said.join('\n'), sub).toBe(`timmy vision ${sub} is not available in this build: the vision bridge (${VISION_BRIDGE}) is missing from this installation. Reinstall a Timmy build that ships the bridge, then check the configured runtime. VoxVision's /observe, /detect and /measure do not need it.`);
      if (sub === 'run' || sub === 'status') {
        expect(JSON.parse(printed.join('\n'))).toMatchObject({ ok: false, state: 'not_available',
          capabilities: { imageInference: false, workflows: false, cloudEvents: false,
            localEvents: true, feedback: true } });
      }
    }
    expect(trap.calls).toEqual([]);
    expect(existsSync(join(dir, '.timmy'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['in.png']);
  });

  it('simulated missing asset: inference and cloud-runtime MCP operations refuse before work starts', async () => {
    trap.missingBridge = true;
    const args = { imagePath: join(dir, 'not-read.png'), modelId: 'unit-only/1', eventId: 'unit-only' };
    for (const name of ['timmy_vision_status', 'timmy_vision_inspect', 'timmy_vision_sync', 'timmy_vision_cloud_events']) {
      expect(await callVisionTool(name, args), name).toMatchObject({ ok: false, state: 'not_available', bridge: VISION_BRIDGE });
    }
    expect(await callVisionTool('timmy_vision_nothing')).toMatchObject({ ok: false, state: 'invalid_request' });
    expect(trap.calls).toEqual([]);
    expect(existsSync(join(dir, '.timmy'))).toBe(false);
  });

  it('simulated missing asset: local retained history, review queue and supplied feedback still work', async () => {
    // Seed a real local record/receipt using an explicitly injected UNIT result.
    // No inference, server or Python process is involved in this storage fixture.
    await runVisionInspection({ imageBase64: PNG, modelId: 'unit-only/1' }, {
      dir, env: { ROBOFLOW_API_KEY: 'UNIT-key-not-real' },
      runner: async () => ({ ok: true, state: 'observed', result: { predictions: [{ class: 'unit-only', confidence: 0.4 }] } }),
    });
    trap.missingBridge = true;
    const history = await callVisionTool('timmy_vision_events', { limit: 5 });
    expect(history).toMatchObject({ ok: true, events: [{ state: 'observed' }] });
    const eventId = (history as { events: Array<{ id: string }> }).events[0].id;
    expect(await callVisionTool('timmy_vision_learning')).toMatchObject({ ok: true, events: [{ id: eventId }] });
    expect(await callVisionTool('timmy_vision_feedback', { eventId, verdict: 'incorrect', note: 'Unit operator fixture' }))
      .toMatchObject({ ok: true, state: 'recorded', feedback: { eventId, verdict: 'incorrect' } });
    expect(verifyChain('runs', dir).ok).toBe(true);
    // Receipt seals read local OS metadata (src/utils/envlock.ts: sh, sw_vers on macOS, uname elsewhere). No Python or
    // bridge child may start: nothing is spawned, and no call names python or the bridge.
    expect(trap.calls.filter(call => !/^execFileSync (sh|sw_vers|uname)$/.test(call))).toEqual([]);
    expect(trap.calls.some(call => /python|vision-bridge/.test(call))).toBe(false);
  });

  it('simulated missing asset: catalog has its own configuration check and does not require Python', async () => {
    trap.missingBridge = true;
    expect(await callVisionTool('timmy_vision_catalog')).toMatchObject({ ok: false, state: 'not_configured' });
    expect(trap.calls).toEqual([]);
  });

  it('simulated missing asset: direct runtime inspection refuses without storing its input or a success receipt', async () => {
    trap.missingBridge = true;
    const env = { ROBOFLOW_API_KEY: 'UNIT-rf-key-not-real', TIMMY_VISION_MODEL_ID: 'unit-only/1' };
    const status = await getVisionStatus({ dir, env });
    expect(status).toMatchObject({ ok: false, state: 'not_available', serverChecked: false, dependencies: {},
      capabilities: { imageInference: false, localEvents: true, feedback: true } });
    expect(JSON.stringify(status)).not.toContain('UNIT-rf-key');
    expect(await runVisionInspection({ imageBase64: PNG, modelId: 'unit-only/1' }, { dir, env }))
      .toMatchObject({ ok: false, state: 'not_available', bridge: VISION_BRIDGE });
    expect(existsSync(join(dir, '.timmy'))).toBe(false);
    expect(trap.calls).toEqual([]);
  });

  it('UNIT child control: an explicit JavaScript bridge double can be probed but never establishes live inference', async () => {
    trap.missingBridge = true;
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, VISION_BRIDGE), 'process.stdout.write(JSON.stringify({ ok: true, state: "checked", dependencies: { inference_sdk: { installed: true, version: "UNIT" } }, capabilities: { imageInference: true, workflows: false, cloudEvents: false }, UNIT_ONLY: true }));\n');
    expect(visionBridgeAvailability(dir).available).toBe(true);
    const status = await getVisionStatus({ dir, env: { TIMMY_VISION_PYTHON: process.execPath,
      ROBOFLOW_API_KEY: 'UNIT-rf-key-not-real', TIMMY_VISION_MODEL_ID: 'unit-only/1' } });
    expect(status.state).toBe('configured_unchecked');
    expect(status.serverChecked).toBe(false);
    expect(status.capabilities).toMatchObject({ imageInference: true, workflows: false, cloudEvents: false });
    expect(trap.calls).toEqual([`spawn ${process.execPath}`]);
  });
});
