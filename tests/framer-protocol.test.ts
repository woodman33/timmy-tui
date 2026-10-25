import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Framer adapter through actual MCPorter and a local MCP fixture', () => {
  it('discovers schemas, preserves successful output, and propagates tool failure', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framer-protocol-'));
    try {
      const config = path.join(tmp, 'mcporter.json');
      fs.writeFileSync(config, JSON.stringify({ mcpServers: { framer: {
        command: process.execPath, args: [path.resolve('tests/fixtures/framer-mcp.mjs')],
      } }, imports: [] }));
      const run = (args: string[]) => spawnSync(process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'framer', ...args], {
          encoding: 'utf8', timeout: 15000,
          env: { ...process.env, TIMMY_FRAMER_CONFIG: config },
        });
      const discovery = run(['tools']);
      expect(discovery.status).toBe(0);
      expect(JSON.parse(discovery.stdout).tools[0].name).toBe('open_project');
      const success = run(['open', 'fixture-project']);
      expect(success.status).toBe(0);
      expect(JSON.parse(success.stdout)).toMatchObject({ fixture: true, arguments: { projectId: 'fixture-project' } });
      const failure = run(['open', 'fail']);
      expect(failure.status).toBe(1);
      expect(JSON.parse(failure.stdout).fixture).toBe(true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 45000);
});
