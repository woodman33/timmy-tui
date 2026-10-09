// The review of 40022d9: an observation file is editable, so the board may call its values verified only
// when a sealed observe receipt names exactly this file's bytes and the image it measured is unchanged.
import { describe, expect, it } from 'vitest';
import { checkObservation } from '../src/evidence/observation-check.js';
import { hashOf, type Receipt } from '../src/utils/receipts.js';
import { DETERMINISTIC, INTERPRETATION } from '../src/vision/look.js';

const SRC = 'ab'.repeat(32);
const FILE_SHA = 'cd'.repeat(32);
const FILE = 'results/observations/card-20261009-090000.json';
const PROJECT = 'project-id-1';

const RECORD = {
  observation: 1,
  made_at: '2026-10-09T09:00:00.000Z',
  project: 'demo',
  source: { path: 'refs/card.png', sha256: SRC, bytes: 2048 },
  tiers: [DETERMINISTIC],
  look: {
    ok: true,
    worker: { name: 'timmy-look', version: '1.0.0' },
    image: { width: 640, height: 480, channels: 3 },
    measurements: [
      { name: 'sharpness', value: 12.5, unit: 'variance of the Laplacian (relative)', tier: DETERMINISTIC, note: '' },
      { name: 'edge_density', value: 0.04, unit: 'fraction of pixels', tier: DETERMINISTIC, note: '' },
    ],
    uncertainty: [],
  },
  job: { id: 'j0a1b2c' },
};

/** A receipt as appendReceipt seals it: its hash is the hash of its own body. */
function receipt(extra: Record<string, unknown> = {}): Receipt {
  const body = {
    v: 1, id: 'rc_1', stream: 'runs', ts: '2026-10-09T09:00:01.000Z', kind: 'observe', subject: 'observe · refs/card.png', policy: 'human-gated', status: 'ok',
    project: 'demo', project_id: PROJECT, files: [{ path: 'refs/card.png', sha256: SRC, bytes: 2048 }],
    outputs: [{ path: FILE, sha256: FILE_SHA, bytes: 900 }], observation: { tiers: [DETERMINISTIC], worker: 'timmy-look 1.0.0', measurements: 2 },
    prev_hash: 'genesis', ...extra,
  };
  return { ...body, hash: hashOf({ ...body, hash: '' }) } as unknown as Receipt;
}

const check = (o: Partial<Parameters<typeof checkObservation>[0]> = {}) => checkObservation({
  record: RECORD, file: FILE, fileSha256: FILE_SHA, currentSourceSha256: SRC, receipts: [receipt()], projectId: PROJECT, ...o,
});

describe('checkObservation', () => {
  it('is verified when an observe receipt sealed exactly these bytes and the image is unchanged', () => {
    const r = check();
    expect(r).toMatchObject({ status: 'verified', reasons: [] });
    expect(r.receipt).toBe(receipt().hash.slice(7, 15));
  });

  it('is unverified without a receipt that names the file', () => {
    const r = check({ receipts: [] });
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toMatch(/no observe receipt names this file/);
    // A receipt of another kind, a failed one, or one for another file does not count.
    for (const other of [receipt({ kind: 'edit' }), receipt({ status: 'failed' }), receipt({ outputs: [{ path: 'results/observations/other.json', sha256: FILE_SHA, bytes: 900 }] })]) {
      expect(check({ receipts: [other] }).status).toBe('unverified');
    }
  });

  it('is unverified when the file is not the bytes that were sealed', () => {
    const r = check({ fileSha256: 'ef'.repeat(32) });
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toMatch(/changed after it was sealed/);
    expect(r.reasons.join(' ')).toContain(FILE_SHA.slice(0, 12));
    expect(check({ fileSha256: undefined }).status).toBe('unverified');
  });

  it('is unverified when the receipt itself does not hash to its recorded hash, or is another project\'s', () => {
    const edited = { ...receipt(), outputs: [{ path: FILE, sha256: FILE_SHA, bytes: 901 }] } as Receipt;
    const r = check({ receipts: [edited] });
    expect(r.status).toBe('unverified');
    expect(r.reasons.join(' ')).toMatch(/does not match its contents/);
    expect(check({ receipts: [receipt({ project_id: 'another-project' })] }).status).toBe('unverified');
    // The receipt must name the same source the record names.
    expect(check({ receipts: [receipt({ files: [{ path: 'refs/other.png', sha256: SRC }] })] }).status).toBe('unverified');
  });

  it('is stale when the image changed since it was observed, or is gone', () => {
    const changed = check({ currentSourceSha256: '12'.repeat(32) });
    expect(changed.status).toBe('stale');
    expect(changed.reasons.join(' ')).toMatch(/refs\/card\.png changed since it was observed/);
    const gone = check({ currentSourceSha256: null });
    expect(gone.status).toBe('stale');
    expect(gone.reasons.join(' ')).toMatch(/no longer in the project/);
    // Not known (it could not be read): not stale, not verified.
    expect(check({ currentSourceSha256: undefined }).status).toBe('unverified');
  });

  it('a record that is not a Look observation, or whose values are not all deterministic, is unverified', () => {
    const noWorker = { ...RECORD, look: { ...RECORD.look, worker: undefined } };
    expect(check({ record: noWorker }).status).toBe('unverified');
    expect(check({ record: { ...RECORD, observation: 2 } }).status).toBe('unverified');
    for (const m of [
      { name: 'depth', value: 0.4, unit: 'm', tier: INTERPRETATION },
      { name: 'guess', value: 1 },
      'not a measurement',
    ]) {
      const mixed = { ...RECORD, look: { ...RECORD.look, measurements: [...RECORD.look.measurements, m] } };
      const r = check({ record: mixed });
      expect(r.status).toBe('unverified');
      expect(r.reasons.join(' ')).toMatch(/not marked "deterministic computation"/);
    }
    // A source path outside the project is never checked against the project.
    const outside = { ...RECORD, source: { path: '/etc/passwd', sha256: SRC } };
    expect(check({ record: outside }).status).toBe('unverified');
  });

  it('unverified wins over stale: every reason is kept', () => {
    const r = check({ receipts: [], currentSourceSha256: '12'.repeat(32) });
    expect(r.status).toBe('unverified');
    expect(r.reasons.length).toBe(2);
  });
});
