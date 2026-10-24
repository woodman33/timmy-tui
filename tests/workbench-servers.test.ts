// R5 (H131; the lead's installed-package rehearsal): Studio · Show waits longer for the Studio this Workbench started than for
// one of unknown origin. Under load the Workbench's own Studio answered later than 1 s, was said to be "something holds the
// port but did not answer within 1000 ms", and nothing opened; a second press worked.
//
// FAKE here: the server start (ensure: started, or another already running) and the health check (it records how long it
// was asked to wait, and says nothing answers, so nothing is opened or handed off); the opener, which opens nothing.
import { describe, expect, it } from 'vitest';
import { OWNED_STUDIO_WAIT_MS, STUDIO_WAIT_MS, StudioControl, type Opener } from '../src/workbench/servers.js';

const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

function studio(started: boolean, waits: number[]): StudioControl {
  const env = { HOME: '/nonexistent-home', TIMMY_STUDIO_PORT: '47999' };
  return new StudioControl({
    env, opener: FAKE_OPENER, project: () => ({ root: '/nonexistent-project', name: 'FAKE project' }), projectId: () => '0000000000000000',
    jobsDir: '/nonexistent-jobs', receipts: () => '/nonexistent-store',
    // FAKE: this Workbench started it, or another Timmy already serves it
    ensure: async () => (started ? { state: 'started', server: { projectToken: 'FAKE', close: ((cb?: () => void) => { cb?.(); }) as never } } : { state: 'already-running' }),
    // FAKE: nothing answers (so nothing is handed off or opened); the wait asked for is kept
    health: async (_base: string, ms: number) => { waits.push(ms); return { state: 'not-running' }; },
  });
}

describe('Studio · Show\'s wait for an answer (R5 H131)', () => {
  it('the Studio this Workbench started gets 5 s to answer; one of unknown origin, 1 s; either way nothing is said to have opened when nothing answered', async () => {
    expect(OWNED_STUDIO_WAIT_MS).toBe(5000);
    expect(STUDIO_WAIT_MS).toBe(1000);
    const own: number[] = [];
    const said = await studio(true, own).show();
    expect(own).toEqual([OWNED_STUDIO_WAIT_MS]);
    expect(said).toMatch(/^Studio does not answer at .+ \(not-running\)$/);
    const other: number[] = [];
    const saidOther = await studio(false, other).show();
    expect(other).toEqual([STUDIO_WAIT_MS]);
    expect(saidOther).toMatch(/^Studio does not answer at /);
  });
});
