// R4 lead (the r26 dry run, 2026-10-12): the Workbench's Companion · Show asks for the port `timmy watch` asks for
// (TIMMY_COMPANION_PORT, else 3001), then the next three, then any free port, and says which it took when it is not the one
// asked for. Before, it always took a free port, so the preview's TIMMY_COMPANION_PORT was not honoured there. And Studio's
// run card says "role not recorded" once (the dry run's card said "role role not recorded").
// FAKE here: the server's start (it records the ports it is asked for and refuses the taken ones as Node does, EADDRINUSE)
// and the browser opener; nothing listens.
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RoomRun } from '../src/room/index.js';
import { runResult } from '../src/studio/card-detail.js';
import { CompanionControl, companionPorts, type Opener } from '../src/workbench/servers.js';

const taken = (port: number): NodeJS.ErrnoException => Object.assign(new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`), { code: 'EADDRINUSE' });

function fakeCompanion(o: { env: Record<string, string | undefined>; busy?: number[]; fail?: Error }) {
  const asked: number[] = [];
  const hrefs: string[] = [];
  const opener: Opener = { program: 'FAKE opener', open: (href) => { hrefs.push(href); return { ok: true }; } };
  const control = new CompanionControl({
    opener, env: o.env,
    start: async (port: number) => {
      asked.push(port);
      if (o.fail) throw o.fail;
      if (o.busy?.includes(port)) throw taken(port);
      const p = port === 0 ? 45555 : port;
      return { port: p, url: `http://127.0.0.1:${p}/#t=FAKE`, address: `http://127.0.0.1:${p}/`, shutdown: async () => undefined };
    },
  });
  const cleanup = () => { for (const h of hrefs) rmSync(dirname(fileURLToPath(h)), { recursive: true, force: true }); };
  return { control, asked, hrefs, cleanup };
}

describe('Companion · Show asks for the companion port as `timmy watch` does (R4 lead)', () => {
  it('tries the port asked for, the next three, then any free port; never past 65535', () => {
    expect(companionPorts(4432)).toEqual([4432, 4433, 4434, 4435, 0]);
    expect(companionPorts(65534)).toEqual([65534, 65535, 0]);
  });

  it('takes TIMMY_COMPANION_PORT when it is free, and says nothing more about the port', async () => {
    const f = fakeCompanion({ env: { TIMMY_COMPANION_PORT: '4432' } });
    try {
      const words = await f.control.show();
      expect(f.asked).toEqual([4432]);
      expect(words).toBe('The Companion opened in your browser (http://127.0.0.1:4432/), through a private page that carries its key');
      // a second press opens the same server: no second start
      await f.control.show();
      expect(f.asked).toEqual([4432]);
      expect(f.hrefs).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  it('when that port is taken, takes the next free one and names both', async () => {
    const f = fakeCompanion({ env: { TIMMY_COMPANION_PORT: '4432' }, busy: [4432] });
    try {
      const words = await f.control.show();
      expect(f.asked).toEqual([4432, 4433]);
      expect(words).toBe('The Companion opened in your browser (http://127.0.0.1:4433/), through a private page that carries its key. Browser companion on port 4433: 4432, the port asked for, was taken.');
      expect(f.control.state()).toMatchObject({ serving: true, address: 'http://127.0.0.1:4433/' });
    } finally { f.cleanup(); }
  });

  it('with no TIMMY_COMPANION_PORT asks for 3001 (the monitor\'s default); four taken ports end on a free one', async () => {
    const f = fakeCompanion({ env: {}, busy: [3001, 3002, 3003, 3004] });
    try {
      const words = await f.control.show();
      expect(f.asked).toEqual([3001, 3002, 3003, 3004, 0]);
      expect(words).toContain('(http://127.0.0.1:45555/)');
      expect(words).toContain('Browser companion on port 45555: 3001, the port asked for, was taken.');
    } finally { f.cleanup(); }
  });

  it('a start that fails for any other reason is said at once, and nothing opens', async () => {
    const f = fakeCompanion({ env: { TIMMY_COMPANION_PORT: '4432' }, fail: Object.assign(new Error('FAKE: listen EACCES: permission denied'), { code: 'EACCES' }) });
    try {
      const words = await f.control.show();
      expect(f.asked).toEqual([4432]);
      expect(words).toBe('The Companion did not start: FAKE: listen EACCES: permission denied');
      expect(f.hrefs).toEqual([]);
      expect(f.control.state().serving).toBe(false);
    } finally { f.cleanup(); }
  });
});

describe('Studio\'s run card (R4 lead, the r26 dry run)', () => {
  const run = (role: string | undefined): RoomRun => ({ kind: 'job', id: 'jae7a9e', owner: 'upmd (a workflow run)', route: 'this machine (a job); no cost recorded', state: 'completed', tone: 'ok', running: false, cost: { kind: 'none', words: 'no cost recorded: a job on this machine' }, costKey: 'job:jae7a9e', outputs: [], ...(role ? { role } : {}) } as RoomRun);
  const t = (s: string) => s;
  it('says "role not recorded" once when the record names no role, and "role <role>" when it does', () => {
    for (const role of [undefined, 'role not recorded']) {
      const owner = runResult(run(role), '/nowhere', t).facts.find((f) => f.label === 'owner');
      expect(owner?.how).toBe('role not recorded');
    }
    expect(runResult(run('builder'), '/nowhere', t).facts.find((f) => f.label === 'owner')?.how).toBe('role builder');
  });
});
