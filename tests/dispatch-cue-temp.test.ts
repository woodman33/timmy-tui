/**
 * Round R4, task H29 (3): validatePlanCue (src/utils/dispatch.ts) wrote each plan into a new temporary folder
 * (timmy-cue-*) and never removed it: thousands piled up in the system temp folder. Each test here points TMPDIR at
 * a private folder, so it sees only what its own call left behind. The FAKE cue (a shell script first on PATH) stands
 * in for the CUE binary: it records the plan file it was given and passes or fails the check on its content. The
 * last test uses the real cue binary when this machine has one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePlanCue, type DispatchPlan } from '../src/utils/dispatch.js';

const plan = (): DispatchPlan => ({
  schema_version: 'dispatch/0.1', objective: 'red test to green test', deliverables: ['patch'], acceptance_tests: ['npm test'], harnesses: ['pi'],
  model_policy: { requested: 'local/qwen', allow_paid: false, max_spend_usd: 0 }, copies: 1, cadence: { mode: 'parallel', depends_on: [] },
  context_manifest: [], repo_ref: 'main', workspace: { kind: 'host-ephemeral' }, permissions: { filesystem: 'rw-ephemeral', network: false, tools: [], secrets: [] },
  limits: { cost_usd: 0, wall_ms: 60000 }, retry_limit: 1, approval: { required: true, mode: 'manual' }, expected_artifacts: ['patch.diff'], telemetry: { redact: true, events: true },
});
const malformed = (): Record<string, unknown> => { const p: Record<string, unknown> = { ...plan() }; delete p.objective; return p; };
/** The real cue on this machine's PATH, looked up before any test puts the fake first. */
const realCue = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).some((d) => { try { accessSync(path.join(d, 'cue'), constants.X_OK); return true; } catch { return false; } });

let scratch = '';
let temp = '';
let log = '';
const saved = { TMPDIR: process.env.TMPDIR, PATH: process.env.PATH };
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'timmy-cue-temp-test-'));
  temp = path.join(scratch, 'tmp');
  mkdirSync(temp);
  log = path.join(scratch, 'fake-cue.log');
  process.env.TMPDIR = temp;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(scratch, { recursive: true, force: true });
});
/** Puts the FAKE cue first on PATH. */
function fakeCue(): void {
  const bin = path.join(scratch, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'cue'), `#!/bin/sh
# FAKE cue (H29 temp-folder test): "version" succeeds; "vet -d #Plan <schema> <plan>" records the plan file and
# whether it existed, then passes a plan with an objective and fails one without.
case "$1" in
  version) echo "cue version (fake)"; exit 0 ;;
  vet) if [ -f "$5" ]; then echo "present $5" >> ${JSON.stringify(log)}; else echo "absent $5" >> ${JSON.stringify(log)}; fi
       if grep -q '"objective"' "$5"; then exit 0; fi
       echo "objective: field is required but not present" >&2; exit 1 ;;
esac
exit 2
`);
  chmodSync(path.join(bin, 'cue'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
}
/** The plan files the fake cue was given, each with whether it existed when the check ran. */
const given = (): Array<{ present: boolean; file: string }> =>
  (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []).map((l) => ({ present: l.startsWith('present '), file: l.slice(l.indexOf(' ') + 1) }));
const left = (): string[] => readdirSync(temp).filter((n) => n.startsWith('timmy-cue-'));

describe.skipIf(process.platform === 'win32')('the CUE plan check leaves no temporary folder behind', () => {
  it('removes its temporary folder after a check that passes and after one that fails', () => {
    fakeCue();
    expect(validatePlanCue(plan())).toEqual({ ok: true });
    expect(validatePlanCue(malformed())).toMatchObject({ ok: false, error_class: 'schema', note: expect.stringContaining('objective') });
    const files = given();
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f.present, 'the plan was there while cue checked it').toBe(true);
      expect(path.dirname(path.dirname(f.file))).toBe(temp);
      expect(existsSync(path.dirname(f.file)), `${path.basename(path.dirname(f.file))} is removed`).toBe(false);
    }
    expect(left()).toEqual([]);
  });

  it('removes its temporary folder when the plan cannot even be written', () => {
    fakeCue();
    expect(() => validatePlanCue({ ...plan(), copies: 1n } as unknown)).toThrow(/BigInt/);
    expect(given()).toEqual([]);
    expect(left()).toEqual([]);
  });

  it.skipIf(!realCue)('with the real cue binary: no temporary folder is left after a valid or a malformed plan', () => {
    expect(validatePlanCue(plan())).toEqual({ ok: true });
    expect(validatePlanCue(malformed())).toMatchObject({ ok: false, error_class: 'schema' });
    expect(left()).toEqual([]);
  });
});
