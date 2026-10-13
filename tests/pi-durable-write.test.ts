/**
 * Pi Durable S1 (R4 H118), fix N4 of H119's second review: slow_write's failures. Before the fix, a write that failed
 * after its `started` record (the model names an existing folder with expected "absent": a folder reads as absent, and
 * the rename fails with EISDIR; or a new file in a folder that does not exist) threw: the record stayed `started`, so its
 * words said "started and never ended" about a write that verifiably did not happen, an accept would have recorded it
 * "accepted as done", and the temp file could be left in the project.
 *
 * Now a target that is not a regular file (or a new file in an existing folder) is refused before anything is recorded;
 * and a write or rename that fails after `started` removes its temp file, ends the record with the readback it observes
 * ("not written: <code>") and returns an error result. S3's real write tool copies this pattern.
 *
 * REAL: the tool's execute(), called in this process on a fixture project, the effect ledger and the files. FAKE: the
 * fixture project, and the failing rename of the third case (a test seam of the tool host, as src/project's
 * writeProjectFile has one for its temp name).
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PiApi, ToolResult, ToolSpec } from '../src/pi-durable/adapter/pi-api.js';
import { EffectLedger, effectKey } from '../src/pi-durable/effects.js';
import { piPaths } from '../src/pi-durable/paths.js';
import { slowTools, type ToolHost } from '../src/pi-durable/slow-tools.js';
import { cleanup, project, sha } from './helpers/pi-durable.js';

afterAll(() => { cleanup(); });

const stubPi = { schema: { object: (f: unknown) => f, string: () => ({}), integer: () => ({}), boolean: () => ({}), array: () => ({}), optional: (s: unknown) => s } } as unknown as PiApi;
const api = { taskId: 1, conversationId: 1, callId: 'call-1' };
const said = (r: ToolResult): string => r.content.map((c) => c.text).join('');
const temps = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

function writeTool(root: string, extra: Partial<ToolHost> = {}): { write: ToolSpec; ledger: EffectLedger } {
  const p = piPaths(root);
  const ledger = new EffectLedger(p.effects);
  const tools = slowTools(stubPi, { root, ledger, readsLog: join(p.dir, 'reads.jsonl'), runOf: () => 'aaaaaaaa', ...extra } as ToolHost);
  return { write: tools.find((t) => t.name === 'slow_write') as ToolSpec, ledger };
}

describe('slow_write\'s failures (fix N4), called in this process', () => {
  it('a folder named as the target is refused before anything is recorded: no record, no temp file', async () => {
    const root = project('write-folder');
    mkdirSync(join(root, 'notes'));
    const { write, ledger } = writeTool(root);
    const r = await write.execute({ path: 'notes', content: 'x', expected_sha256: 'absent' }, api, {});
    expect([r.isError, said(r)]).toEqual([true, 'refused: notes is a folder, not a file: slow_write writes a regular file, or a new one in an existing folder']);
    expect(ledger.all()).toEqual([]);
    expect(temps(root)).toEqual([]);
  });

  it('a new file in a folder that does not exist is refused before anything is recorded', async () => {
    const root = project('write-no-folder');
    const { write, ledger } = writeTool(root);
    const r = await write.execute({ path: 'missing/x.txt', content: 'x', expected_sha256: 'absent' }, api, {});
    expect([r.isError, said(r)]).toEqual([true, 'refused: the folder of missing/x.txt does not exist: slow_write writes a regular file, or a new one in an existing folder']);
    expect(ledger.all()).toEqual([]);
  });

  it('a write that fails after `started` removes its temp file, ends its record with what it reads back ("not written") and returns an error; a retry is not refused', async () => {
    const root = project('write-fails', { 'a.txt': 'old bytes' });
    const failing = (): void => { throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' }); };
    const { write, ledger } = writeTool(root, { rename: failing });
    const r = await write.execute({ path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes') }, api, {});
    expect([r.isError, said(r)]).toEqual([true, `failed: a.txt was not written (EIO); it is as it was (sha256 ${sha('old bytes')})`]);
    expect(ledger.all().map((e) => [e.state, e.outcome ?? null, e.readback ?? null])).toEqual([['started', null, null], ['ended', 'not written: EIO', { sha256: sha('old bytes') }]]);
    expect(temps(root)).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old bytes');
    expect(ledger.unreconciled(effectKey('slow_write', 'a.txt', 'aaaaaaaa'))).toBeUndefined(); // no NEEDS YOU: nothing happened
    // the same call again, with a rename that works, writes
    const again = await writeTool(root).write.execute({ path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes') }, api, {});
    expect(said(again)).toBe(`wrote a.txt (sha256 ${sha('new bytes')})`);
  });
});
