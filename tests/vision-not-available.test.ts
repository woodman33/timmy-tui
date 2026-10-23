/**
 * R11 (H170; Phase 0 item 2): the vision bridge, scripts/vision-bridge.py, is in neither this tree nor its git history, so
 * `timmy vision run / status / serve` and the eight timmy_vision_* MCP tools cannot do what they advertise. Each now says
 * "not available in this build" with the one thing that would make it available, exits non-zero and runs nothing: no
 * python, no file stored, no request. The MCP tools return it as a structured refusal. A negative control shows that a
 * build with the bridge present takes the old path (a FAKE bridge, node standing in for python, labelled here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVisionCli } from '../src/vision/cli.js';
import { VISION_TOOLS, callVisionTool } from '../src/vision/mcp.js';
import { getVisionStatus, runVisionInspection, visionBridgeAvailability, VISION_BRIDGE } from '../src/vision/runtime.js';
import { visionAsset } from '../src/vision/config.js';

const trap = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const wrapped = Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => { trap.calls.push(`${n} ${String(args[0])}`); return (real[n] as (...a: unknown[]) => unknown)(...args); }]));
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=';
const WORDS = `not available in this build: the vision bridge (${VISION_BRIDGE}) is not included. What would make it available: a Timmy build that ships that script (this tree and its history hold none, so no build does today). VoxVision's /observe, /detect and /measure do not need it.`;

let dir: string;
let before: string;
let exitBefore: typeof process.exitCode;
const said: string[] = [];
const printed: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-vision-na-'));
  before = process.cwd();
  exitBefore = process.exitCode;
  process.chdir(dir);
  trap.calls.length = 0;
  said.length = 0; printed.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(a.join(' ')); });
  vi.stubGlobal('fetch', (input: unknown) => { throw new Error(`a request was made: ${String(input)}`); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.chdir(before);
  process.exitCode = exitBefore;
  rmSync(dir, { recursive: true, force: true });
});

describe('the vision bridge is not in this build: every entry point says so, exits non-zero and runs nothing', () => {
  it('the repository carries no bridge (the fact the refusal rests on)', () => {
    expect(existsSync(visionAsset(VISION_BRIDGE, before))).toBe(false);
    expect(visionBridgeAvailability(dir)).toEqual({ available: false, bridge: join(dir, VISION_BRIDGE), state: 'not_available', words: WORDS });
  });

  it('timmy vision run / status / serve / open: the words on stderr, exit 2, no python started, nothing stored', async () => {
    writeFileSync(join(dir, 'in.png'), Buffer.from(PNG, 'base64'));
    for (const sub of ['run', 'status', 'serve', 'open'] as const) {
      said.length = 0; printed.length = 0; process.exitCode = 0;
      await runVisionCli(sub === 'run' ? ['run', '--image', 'in.png', '--model', 'fake/1'] : [sub]);
      expect(process.exitCode, sub).toBe(2);
      expect(said.join('\n'), sub).toBe(`timmy vision ${sub} is ${WORDS}`);
      if (sub === 'run' || sub === 'status') expect(JSON.parse(printed.join('\n'))).toMatchObject({ ok: false, state: 'not_available', note: WORDS, capabilities: { imageInference: false, workflows: false, cloudEvents: false } });
    }
    expect(trap.calls).toEqual([]);
    expect(existsSync(join(dir, '.timmy'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['in.png']);
  });

  it('the eight timmy_vision_* tools return one structured refusal, before anything is read, stored or sent', async () => {
    writeFileSync(join(dir, 'in.png'), Buffer.from(PNG, 'base64'));
    expect(VISION_TOOLS.map((t) => t.name)).toEqual(['timmy_vision_catalog', 'timmy_vision_status', 'timmy_vision_inspect', 'timmy_vision_events', 'timmy_vision_feedback', 'timmy_vision_learning', 'timmy_vision_sync', 'timmy_vision_cloud_events']);
    const args: Record<string, unknown> = { imagePath: join(dir, 'in.png'), modelId: 'fake/1', eventId: 'v-fake', verdict: 'correct', limit: 5 };
    for (const t of VISION_TOOLS) {
      const r = await callVisionTool(t.name, args);
      expect(r, t.name).toEqual({ ok: false, state: 'not_available', note: WORDS, bridge: VISION_BRIDGE, tool: t.name });
    }
    expect(await callVisionTool('timmy_vision_nothing')).toMatchObject({ ok: false, state: 'invalid_request' });
    expect(trap.calls).toEqual([]);
    expect(existsSync(join(dir, '.timmy'))).toBe(false);
  });

  it('the runtime itself: status and an inspection refuse the same way (no image stored, no event, no receipt)', async () => {
    const env = { ROBOFLOW_API_KEY: 'FAKE-rf-key-not-real', TIMMY_VISION_MODEL_ID: 'fake/1' };
    const status = await getVisionStatus({ dir, env });
    expect(status).toMatchObject({ ok: false, state: 'not_available', reasons: [WORDS], serverChecked: false, dependencies: {} });
    expect(JSON.stringify(status)).not.toContain('FAKE-rf-key');
    const r = await runVisionInspection({ imageBase64: PNG, modelId: 'fake/1' }, { dir, env });
    expect(r).toEqual({ ok: false, state: 'not_available', note: WORDS, bridge: VISION_BRIDGE });
    expect(existsSync(join(dir, '.timmy'))).toBe(false);
    expect(trap.calls).toEqual([]);
  });

  it('negative control: with a FAKE bridge present (node standing in for python), the old path runs it', async () => {
    mkdirSync(join(dir, 'scripts'));
    // a FAKE bridge in JavaScript: answers the probe as a bridge would (labelled FAKE; never a real inference)
    writeFileSync(join(dir, 'scripts', 'vision-bridge.py'), 'process.stdout.write(JSON.stringify({ ok: true, state: "checked", dependencies: { inference_sdk: { installed: true, version: "FAKE" } }, FAKE: true }));\n');
    process.env.TIMMY_VISION_PYTHON = process.execPath;
    try {
      expect(visionBridgeAvailability(dir).available).toBe(true);
      const status = await getVisionStatus({ dir, env: { TIMMY_VISION_PYTHON: process.execPath, ROBOFLOW_API_KEY: 'FAKE-rf-key-not-real', TIMMY_VISION_MODEL_ID: 'fake/1' } });
      expect(status.state).toBe('configured_unchecked');
      expect(trap.calls).toEqual([`spawn ${process.execPath}`]);
    } finally { delete process.env.TIMMY_VISION_PYTHON; }
  });
});
