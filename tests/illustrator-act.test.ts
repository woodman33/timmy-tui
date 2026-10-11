/**
 * Round R4 (helper H64): `timmy act '/illustrator author badge.jsx' --wait --json` as a real child process (the CLI through
 * tsx) in a temporary project, as one operation: its exit code, its --json object, the run's records and the receipt.
 *
 * FAKE pieces, each labelled: tests/fixtures/fake-illustrator.mjs, a TEST DOUBLE standing in for osascript (on the
 * sandbox's PATH) and for Adobe Illustrator (TIMMY_ILLUSTRATOR names a fake Adobe Illustrator.app; its program is never run).
 * FAKE_AI_MODE picks what the fake does. Real: the CLI, the Workspace, the job manager, the run's folder, Timmy's own SVG
 * reading, the operation record and the receipt chain (the project's own, .timmy/receipts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startsWork } from '../src/ops/act.js';
import { readOperationRecord } from '../src/ops/operations.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';
import { act, opsKit, REPO, sandbox, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-illustrator.mjs');
/** The one JSON object --json ends with (the last line of stdout). */
const lastJson = (stdout: string): Record<string, unknown> => {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
};

/** A sandbox (src/ops tests' own) with the badge starter, the FAKE osascript on its PATH and a FAKE Illustrator bundle. */
function illustratorSandbox(prefix: string, mode: string): Sandbox {
  const s = sandbox(kit, prefix);
  const put = (at: string): void => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.copyFileSync(FAKE, at); fs.chmodSync(at, 0o755); };
  put(path.join(s.bin, 'osascript'));
  const bundle = path.join(s.base, 'Applications', 'Adobe Illustrator 2026', 'Adobe Illustrator.app');
  put(path.join(bundle, 'Contents', 'MacOS', 'Adobe Illustrator'));
  fs.copyFileSync(path.join(REPO, 'templates', 'illustrator-starter', 'badge.jsx'), path.join(s.root, 'badge.jsx'));
  return { ...s, env: { ...s.env, TIMMY_ILLUSTRATOR: bundle, FAKE_AI_MODE: mode } };
}

describe('timmy act runs /illustrator, a real child process', () => {
  it('counts /illustrator with words as a command that starts work', () => {
    expect(startsWork('/illustrator author badge.jsx')).toBe(true);
    expect(startsWork('/illustrator inspect out/illustrator/badge-v1.ai')).toBe(true);
    expect(startsWork('/illustrator')).toBe(false);
  });

  it('succeeds (exit 0) with --wait --json: the document and its exports made, the native run and its job under the operation, one native receipt whose reading agrees', async () => {
    const s = illustratorSandbox('ai-act-ok-', 'ok');
    const r = await act(kit, s, ['/illustrator author badge.jsx --name badge', '--wait', '--json']).done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const o = lastJson(r.stdout);
    expect(o).toMatchObject({ schema: 'timmy.act/1', joined: false, request: '/illustrator author badge.jsx --name badge', project: 'project', outcome: 'succeeded', exit_code: 0 });
    const op = String(o.operation);
    const runs = o.runs as Array<{ kind: string; id: string }>;
    expect(runs.map((x) => x.kind).sort()).toEqual(['job', 'native']);
    const native = runs.find((x) => x.kind === 'native')!.id;
    expect(o.records).toEqual([`.timmy/operations/${op}.json`, `.timmy/native/${native}/job.json`]);
    expect(o.receipts).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{8}$/), kind: 'native', status: 'ok' }]);
    for (const ext of ['ai', 'svg', 'pdf', 'png']) expect(fs.existsSync(path.join(s.root, 'out', 'illustrator', `badge-v1.${ext}`)), ext).toBe(true);
    // the progress went to stderr: the start lines and the end lines with Timmy's own reading
    expect(r.stderr).toMatch(/App {8}Adobe Illustrator, asked through osascript \(do javascript\)/);
    expect(r.stderr).toMatch(/readback agrees: artboard 600 × 400 \(viewBox\); 4 shapes/);
    const chain = readChain('runs', s.root);
    expect(chain.map((x) => [x.kind, x.operation_id, (x.native as { illustrator?: { readback?: { verdict?: string } } }).illustrator?.readback?.verdict])).toEqual([['native', op, 'agrees']]);
    expect(verifyChain('runs', s.root).ok).toBe(true);
    const rec = readOperationRecord(s.root, op);
    expect(rec.ok && rec.record).toMatchObject({ id: op, via: 'act', state: 'succeeded' });
    expect(JSON.parse(fs.readFileSync(path.join(s.root, '.timmy', 'native', native, 'job.json'), 'utf8'))).toMatchObject({ app: 'illustrator', operation: op });
    expect(r.stdout).not.toContain(s.base);
  }, 120_000);

  it('Timmy\'s own reading differs from Illustrator\'s report: exit 1, the operation "differs"; macOS\'s refusal (-1743): exit 1, said exactly', async () => {
    const d = illustratorSandbox('ai-act-differs-', 'svg-differs');
    const r = await act(kit, d, ['/illustrator author badge.jsx', '--wait', '--json']).done;
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(lastJson(r.stdout)).toMatchObject({ outcome: 'differs', exit_code: 1, why: expect.stringMatching(/native [0-9a-f-]{36} ok \(judged by its result file\); Timmy's own reading of its export differs/) });
    expect(r.stderr).toMatch(/readback differs: .*shapes differ: Illustrator 4, the SVG 3/);
    const n = illustratorSandbox('ai-act-denied-', 'not-allowed');
    const denied = await act(kit, n, ['/illustrator author badge.jsx', '--wait', '--json']).done;
    expect(denied.code, denied.stdout + denied.stderr).toBe(1);
    expect(lastJson(denied.stdout)).toMatchObject({ outcome: 'failed', exit_code: 1 });
    expect(denied.stderr).toContain('macOS did not let osascript control Adobe Illustrator: osascript reported "Not authorized to send Apple events to Adobe Illustrator." (-1743). The operator grants this, once: System Settings › Privacy & Security › Automation, then under the app Timmy runs in (your terminal, or whichever app started Timmy) turn on Adobe Illustrator, and run again; Timmy never grants it and never opens System Settings');
  }, 180_000);
});
