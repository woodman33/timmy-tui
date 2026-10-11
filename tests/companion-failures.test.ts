// R4 (H87): the browser companion answers every failure with words: no path of this computer, no stack. r23 (the installed
// package from b234164): GET / answered 404 with "ENOENT … dist/src/companion/client/index.html", the absolute install path
// included (express's default error page). Slate 3D's built bundle is not in the package: where Slate 3D would be, the
// companion says so in words.
//
// The real companion server (src/companion/server.ts) on 127.0.0.1, over real HTTP; its page folder is the test's where a test
// needs the page missing (CompanionOptions.clientDir).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPANION_BAD_REQUEST, COMPANION_NOT_FOUND, COMPANION_PAGE_ABSENT, SLATE3D_ABSENT, startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { packagedPath } from '../src/utils/asset-dirs.js';

const TOKEN = 'cd'.repeat(32);
const servers: CompanionServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.shutdown();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function companion(clientDir?: string): Promise<{ base: string }> {
  const s = await startCompanionServer(0, { token: TOKEN, ...(clientDir ? { clientDir } : {}) });
  servers.push(s);
  return { base: `http://127.0.0.1:${s.port}` };
}
const answer = async (url: string, init: RequestInit = {}): Promise<{ status: number; type: string; body: string }> => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
};
/** Words only: none of this computer's folders, no stack, no error code. */
const wordsOnly = (body: string): boolean => !body.includes(process.cwd()) && !/\n\s+at |ENOENT|EISDIR|EACCES|\/home\/|\/Users\/|\/tmp\/|node_modules/.test(body);

describe('the browser companion\'s failures are words (R4 H87)', () => {
  it('its page answers 200 from its client folder', async () => {
    const c = await companion();
    const page = await answer(`${c.base}/`);
    expect({ status: page.status, html: /^text\/html/.test(page.type), title: /<html/i.test(page.body) }).toEqual({ status: 200, html: true, title: true });
  });

  it('its page missing: a 404 with words, not ENOENT and a path', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'timmy-noclient-'));
    dirs.push(empty);
    const c = await companion(empty);
    const page = await answer(`${c.base}/`);
    expect({ status: page.status, words: page.body.trim() }).toEqual({ status: 404, words: COMPANION_PAGE_ABSENT });
    expect(wordsOnly(page.body)).toBe(true);
  });

  it('where Slate 3D would be, without its built bundle: words, never a 404 with a path', async () => {
    const c = await companion();
    const slate = await answer(`${c.base}/slate3d/?board=ledger`);
    if (packagedPath('companion/slate3d/dist', import.meta.url, { kind: 'dir' })) {
      // a checkout that built Slate 3D serves it
      expect(slate.status).toBe(200);
      return;
    }
    expect({ status: slate.status, words: slate.body.trim() }).toEqual({ status: 404, words: SLATE3D_ABSENT });
    expect(wordsOnly(slate.body)).toBe(true);
  });

  it('an address with nothing, and a body that is not JSON: words with no path or stack (express\'s own pages are not shown)', async () => {
    const c = await companion();
    const nothing = await answer(`${c.base}/no/such/page.html`);
    expect({ status: nothing.status, words: nothing.body.trim() }).toEqual({ status: 404, words: COMPANION_NOT_FOUND });
    const bad = await answer(`${c.base}/api/workflow/fusion`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{not json' });
    expect({ status: bad.status, body: JSON.parse(bad.body) }).toEqual({ status: 400, body: { ok: false, error: COMPANION_BAD_REQUEST } });
    for (const b of [nothing.body, bad.body]) expect(wordsOnly(b)).toBe(true);
  });
});
