import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSceneForgeConfigured,
  ensureSceneForgeConfig,
} from '../src/sceneforge/client.js';

const originalAgentKey = process.env.SCENEFORGE_AGENT_KEY;
const originalConfig = process.env.SCENEFORGE_MCPORTER_CONFIG;

afterEach(() => {
  if (originalAgentKey === undefined) delete process.env.SCENEFORGE_AGENT_KEY;
  else process.env.SCENEFORGE_AGENT_KEY = originalAgentKey;
  if (originalConfig === undefined) delete process.env.SCENEFORGE_MCPORTER_CONFIG;
  else process.env.SCENEFORGE_MCPORTER_CONFIG = originalConfig;
});

describe('SceneForge MCPorter bridge', () => {
  it('writes a secret-free MCPorter config with lazy environment expansion', () => {
    delete process.env.SCENEFORGE_MCPORTER_CONFIG;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timmy-sceneforge-'));
    const configPath = ensureSceneForgeConfig(tempRoot);
    const config = fs.readFileSync(configPath, 'utf8');

    expect(configPath).toContain(path.join('.timmy', 'sceneforge', 'mcporter.json'));
    expect(config).toContain('${SCENEFORGE_AGENT_KEY}');
    expect(config).toContain('houdini-mcp-agent.<hostname>/mcp');
    expect(config).not.toContain('test-operator-key');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails closed when no SceneForge operator key is present', () => {
    delete process.env.SCENEFORGE_AGENT_KEY;
    expect(() => assertSceneForgeConfigured()).toThrow('SCENEFORGE_AGENT_KEY is required');
  });

  it('accepts a key without exposing or transforming it', () => {
    process.env.SCENEFORGE_AGENT_KEY = 'test-only-key';
    expect(() => assertSceneForgeConfigured()).not.toThrow();
  });
});
