/**
 * R11 (H170; Phase 0 item 4): the openhands adapter's docker engine inventories the runner image and never builds it. Before,
 * a missing image started a 600 s `docker build` with network (inventory A, note 7), against the inventory-before-install rule.
 * A FAKE `docker` on the PATH (a shell script, labelled FAKE) answers `info` with 0 and `image inspect` with 1, and records
 * every command it was given: the run is refused with the one build command, nothing is built, no workspace is made.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OH_RUNNER_BUILD, OH_RUNNER_IMAGE, OH_RUNNER_NOT_BUILT, openHandsPlanHash, runOpenHandsTask } from '../src/utils/openhands-adapter.js';
import { issueApproval } from '../src/utils/approvals.js';
import { readChain } from '../src/utils/receipts.js';

let dir = '';
let bin = '';
let pathBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-oh-image-'));
  bin = join(dir, 'FAKE-bin');
  mkdirSync(bin);
  // FAKE docker: `info` ok; `image inspect` says the image is absent; `build` and `run` would be a defect, and are recorded
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${join(dir, 'docker-calls.txt')}"\ncase "$1" in\n  info) exit 0 ;;\n  image) exit 1 ;;\n  *) echo "FAKE docker: $1 must not run" >&2; exit 97 ;;\nesac\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  pathBefore = process.env.PATH;
  process.env.PATH = bin;
});
afterEach(() => {
  process.env.PATH = pathBefore;
  rmSync(dir, { recursive: true, force: true });
});

describe('openhands docker engine: the runner image is inventoried, never built', () => {
  it('refuses with the one build command, before any build, run, clone or scaffold', async () => {
    const started = Date.now() - 1000;
    const o = { task: 'make the failing test pass', acceptance: ['npm test'], wall_ms: 120000, max_iterations: 2, dir, engine: 'docker' as const };
    const r = await runOpenHandsTask({ ...o, approval: issueApproval(openHandsPlanHash(o)).token });
    expect(r).toMatchObject({ ok: false, state: 'not_configured', note: OH_RUNNER_NOT_BUILT });
    expect(OH_RUNNER_NOT_BUILT).toBe(`the image ${OH_RUNNER_IMAGE} is not built; build it yourself, in the repository root: ${OH_RUNNER_BUILD} (Timmy never builds or pulls it by itself; nothing was started)`);
    expect(OH_RUNNER_BUILD).toBe('docker build -f scripts/oh-runner.Dockerfile -t timmy-oh-runner:1.21.0 .');
    // what docker was asked: the daemon, the image; never build, never run
    expect(readFileSync(join(dir, 'docker-calls.txt'), 'utf8').trim().split('\n')).toEqual(['info', `image inspect ${OH_RUNNER_IMAGE}`]);
    // the receipt says so, and no workspace was made (the adapter makes one in the OS temp folder, timmy-oh-*, once past this)
    const last = readChain('runs', dir).at(-1) as { status: string; error_class: string; subject: string; discrepancies: string[] };
    expect(last).toMatchObject({ status: 'failed', error_class: 'not_configured', subject: 'openhands runner image not built', discrepancies: [OH_RUNNER_NOT_BUILT] });
    // the adapter's workspace is timmy-oh-<6 random characters> exactly (other openhands tests make timmy-oh-test-*, timmy-oh-image-*)
    expect(readdirSync(tmpdir()).filter((n) => /^timmy-oh-[A-Za-z0-9]{6}$/.test(n) && statSync(join(tmpdir(), n)).mtimeMs >= started)).toEqual([]);
    expect(existsSync(join(dir, 'scripts'))).toBe(false);
  });
});
