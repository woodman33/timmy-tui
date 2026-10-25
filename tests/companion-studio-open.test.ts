/**
 * R11 round 7 (H176; the lead's D14 R88): the Canvas page's Open Timmy Studio opens a Studio page that LOADS — the companion mints a
 * one-time grant with the Studio's token (the token file a REPL-served Studio leaves in this Timmy home, honoured only while that
 * process runs) and hands the page `<studio>/#code=<grant>`; without the file, or without an answer, it hands the plain address
 * with why (the Studio page then says what to type in Timmy). The Studio here is a FAKE fetch (said so); the token file is real,
 * written by src/studio/project-link.ts for this process's own pid (alive). Nothing is opened: the target is a value.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GRANT_WAIT_MS, studioOpenTarget } from '../src/companion/panels/studio.js';
import { canvasDir } from '../src/studio/document.js';
import { writeProjectToken } from '../src/studio/project-link.js';

const GRANT = 'a'.repeat(32);
const TOKEN = 'b'.repeat(64);

describe('the Canvas page\'s Open Timmy Studio: a one-time grant for the Studio page (R11 round 7, H176; D14 R88)', () => {
  const boxes: string[] = [];
  const home = (): string => { const d = mkdtempSync(join(tmpdir(), 'studio-open-')); boxes.push(d); return d; };
  afterEach(() => { for (const d of boxes.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('with the Studio\'s token file in this Timmy home, the grant is asked for with that token and the page\'s address carries it', async () => {
    const h = home();
    const env = { TIMMY_HOME: h, HOME: h, TIMMY_STUDIO_URL: 'http://127.0.0.1:47123' } as NodeJS.ProcessEnv;
    expect(writeProjectToken(canvasDir(env), 47123, TOKEN)).toBe(true);
    const asked: Array<{ url: string; auth: string | undefined; method: string | undefined }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization, method: init?.method });
      return new Response(JSON.stringify({ ok: true, grant: GRANT }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const t = await studioOpenTarget(env, fakeFetch);
    expect(t).toEqual({ ok: true, url: `http://127.0.0.1:47123/#code=${GRANT}` });
    expect(asked).toEqual([{ url: 'http://127.0.0.1:47123/api/project/grant', auth: `Bearer ${TOKEN}`, method: 'POST' }]);
    expect(GRANT_WAIT_MS).toBeGreaterThan(0);
  });

  it('without the token file nothing is asked and the plain address is handed with why (what to type in Timmy)', async () => {
    const h = home();
    const env = { TIMMY_HOME: h, HOME: h, TIMMY_STUDIO_URL: 'http://127.0.0.1:47124' } as NodeJS.ProcessEnv;
    let calls = 0;
    const t = await studioOpenTarget(env, (async () => { calls += 1; return new Response('{}'); }) as typeof fetch);
    expect(calls).toBe(0);
    expect(t).toEqual({ ok: false, url: 'http://127.0.0.1:47124/', why: expect.stringMatching(/^No grant could be made for Studio at http:\/\/127\.0\.0\.1:47124: its token file is not in this Timmy home .* Open Studio from Timmy: \/studio, then \/canvas open\.$/) });
  });

  it('a Studio that refuses, or does not answer, leaves the plain address with its own words', async () => {
    const h = home();
    const env = { TIMMY_HOME: h, HOME: h, TIMMY_STUDIO_URL: 'http://127.0.0.1:47125' } as NodeJS.ProcessEnv;
    expect(writeProjectToken(canvasDir(env), 47125, TOKEN)).toBe(true);
    const refused = await studioOpenTarget(env, (async () => new Response(JSON.stringify({ ok: false, error: 'FAKE: no project is named to this canvas' }), { status: 409 })) as typeof fetch);
    expect(refused).toEqual({ ok: false, url: 'http://127.0.0.1:47125/', why: 'Studio at http://127.0.0.1:47125 gave no grant (FAKE: no project is named to this canvas). Open it from Timmy: /canvas open.' });
    const silent = await studioOpenTarget(env, (async () => { throw new Error('FAKE: connection refused'); }) as typeof fetch);
    expect(silent).toEqual({ ok: false, url: 'http://127.0.0.1:47125/', why: 'Studio at http://127.0.0.1:47125 did not answer for a grant (FAKE: connection refused). Is it running? Open it from Timmy: /studio.' });
  });
});
