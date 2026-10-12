// R4 (H98): the monitor's legacy `/studio <idea>` (a HyperFrames storyboard, previewed by `python3 -m http.server`, which
// listens on every network address) is `/storyboard <idea>`, served by Timmy's own dashboard server on 127.0.0.1 only
// (src/utils/dash-server.ts). The monitor's `/studio` is Timmy Studio, as in the REPL: the monitor cannot give its page the
// one-time grant, so it says exactly how; `/setup` says where the guided setup asks. Real files in a temporary folder and
// real HTTP; when something else holds port 4273 here, the served page is not checked and the test says so (as the
// dashboard server's own /publish test does).
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleSlashCommand } from '../src/utils/slash-commands.js';
import { dashHealth, DASH_PORT } from '../src/utils/dash-server.js';
import { ensureDashServer, stopDashServer } from '../src/utils/dash.js';
import { MONITOR_SETUP_WORDS, MONITOR_STUDIO_WORDS } from '../src/setup/surfaces.js';

const dirs: string[] = [];
const folder = (): string => { const d = mkdtempSync(join(tmpdir(), 'storyboard-')); dirs.push(d); return d; };
afterEach(async () => {
  await stopDashServer();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const get = async (path: string): Promise<{ status: number; body: string }> => {
  const r = await fetch(`http://127.0.0.1:${DASH_PORT}${path}`);
  return { status: r.status, body: await r.text() };
};
/** Whether anything accepts a connection on 127.0.0.1:`port`. */
const listening = (port: number): Promise<boolean> => new Promise((done) => {
  const s = connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});

describe('the monitor\'s /studio, /setup and /storyboard (R4 H98)', () => {
  it('/studio says exactly how Timmy Studio opens (from the REPL) and makes nothing; with words it names /storyboard', () => {
    const root = folder();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(handleSlashCommand('/studio', {}, {})).toBe(MONITOR_STUDIO_WORDS);
      expect(MONITOR_STUDIO_WORDS).toMatch(/^Timmy Studio: in a terminal, run timmy and type \/studio/);
      expect(handleSlashCommand('/studio a tray demo', {}, {})).toContain('that is /storyboard a tray demo now.');
      expect(existsSync(join(root, 'studio'))).toBe(false);
      expect(handleSlashCommand('/setup', {}, {})).toBe(MONITOR_SETUP_WORDS);
    } finally { process.chdir(cwd); }
  });

  it('/storyboard writes the composition and its storyboard, and serves the preview on 127.0.0.1 only; no Python server', async () => {
    const root = folder();
    const cwd = process.cwd();
    const busy = (await dashHealth(DASH_PORT)).state !== 'none';
    const said: string[] = [];
    const agent = { emit: (_e: string, m: { content?: string }) => { if (m?.content) said.push(m.content); } };
    process.chdir(root);
    try {
      expect(handleSlashCommand('/storyboard', agent, {})).toMatch(/^Usage: \/storyboard \[--template <name>\] <idea>/);
      const out = String(handleSlashCommand('/storyboard a tray demo', agent, {}));
      expect(out).toContain(`• preview:     http://127.0.0.1:${DASH_PORT}/studio/a-tray-demo/index.html (server starting on 127.0.0.1:${DASH_PORT}, this computer only)`);
      expect(readFileSync(join(root, 'studio', 'a-tray-demo', 'STORYBOARD.md'), 'utf8')).toContain('Brief: a tray demo');
      const page = readFileSync(join(root, 'studio', 'a-tray-demo', 'index.html'), 'utf8');
      // the old preview's port (4173 plus the slug's hash): nothing was started there
      const old = 4173 + (createHash('sha256').update('a-tray-demo').digest().readUInt16BE(0) % 100);
      expect(await listening(old)).toBe(false);
      const r = await ensureDashServer(root).ready;
      if (busy) {
        console.warn('monitor-storyboard: port 4273 is in use here, so the served preview was not checked; its message was', r.words);
        expect(r.up).toBe(false);
        return;
      }
      expect(r.up).toBe(true);
      expect(await get('/studio/a-tray-demo/index.html')).toEqual({ status: 200, body: page });
      expect((await get('/.env')).status).toBe(403);
      expect(said).toEqual([]);
    } finally { process.chdir(cwd); }
  });
});
