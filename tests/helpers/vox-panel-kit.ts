/**
 * R6 (H143): records for the VoxVision panel's tests (tests/companion-vox-panel*.test.ts, tests/workbench-voxvision-tab.test.ts).
 *
 * Two ways, each labelled:
 *  - through Timmy's own record writer: the REPL's Workspace runs /detect and /measure (src/repl/vox.ts), with the FAKE Look
 *    of tests/helpers/vox-fakes.ts (a labelled test double, not OpenCV; its records say "fake" in the tool's version) or
 *    Timmy's real STL reader (TypeScript, in process), each sealed with a real vox receipt on the per-test chain
 *    (appendReceipt, TIMMY_STORE);
 *  - written here, for what no FAKE tool makes (a video's sampled frames, a record naming a link or a file that is not an
 *    image): a FAKE record, saying FAKE in its command, its tool's version and its notes, sealed the same way.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { folderProject, projectId } from '../../src/project/index.js';
import { appendReceipt, readChain, type Receipt, type ReceiptInput } from '../../src/utils/receipts.js';
import { LABEL, TIER } from '../../src/vox/record.js';
import { fakeTools, png, settled, sha, tempKit, workspace } from './vox-fakes.js';

export { cubeStl, png, put, sha, tempKit } from './vox-fakes.js';

/** The REPL's own seal: a receipt on the runs chain (the per-test TIMMY_STORE), its short id. */
export const realSeal = (input: ReceiptInput): string => appendReceipt('runs', input).hash.slice(7, 15);
export const chainNow = (): Receipt[] => readChain('runs');

/** A 4 × 2 PNG: the size the FAKE Look reports for any image (the record keeps what the tool said). */
export const SMALL = png(4, 2, (x) => (x < 2 ? [200, 10, 10] : [10, 10, 200]));

/** Runs one VoxVision action through the REPL's Workspace with the FAKE tools and real receipts; its record id. */
export async function act(kit: ReturnType<typeof tempKit>, root: string, run: (ws: ReturnType<typeof workspace>['ws']) => Promise<unknown>, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const fake = fakeTools(kit.temp('vox-panel-fake-'));
  const before = new Set(listIds(root));
  const { ws } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look, ...env }, extra: { seal: realSeal, receipts: chainNow } });
  await run(ws);
  await settled(ws);
  const made = listIds(root).filter((x) => !before.has(x));
  if (made.length !== 1) throw new Error(`expected one new record, found ${made.length}`);
  return made[0];
}

function listIds(root: string): string[] {
  try { return readdirSync(join(root, 'results', 'vox')).filter((f) => /^v[0-9a-f]{8}\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch { return []; }
}

const write = (root: string, rel: string, body: string | Buffer): { path: string; sha256: string; bytes: number } => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  const b = typeof body === 'string' ? Buffer.from(body) : body;
  return { path: rel, sha256: sha(b), bytes: b.length };
};

/** Seals a hand-written record as VoxVision does: a vox receipt whose first output is the record's bytes. */
export function sealRecord(root: string, rec: Record<string, unknown>, extra: Array<{ path: string; sha256: string; bytes: number }> = []): void {
  const id = String(rec.id);
  const file = write(root, `results/vox/${id}.json`, `${JSON.stringify(rec, null, 2)}\n`);
  appendReceipt('runs', {
    kind: 'vox', subject: `vox · ${String(rec.action)} · FAKE fixture · ok`, policy: 'human-gated', status: 'ok',
    project: folderProject(root).name, project_id: projectId(root),
    files: (rec.inputs as Array<{ path: string; sha256: string; bytes: number }>).map((x) => ({ path: x.path, sha256: x.sha256, bytes: x.bytes })),
    outputs: [file, ...extra], sources: [{ vox: id, schema: 'timmy.vox/1', action: String(rec.action), fake: 'FAKE fixture (tests/helpers/vox-panel-kit.ts)' }],
  } as ReceiptInput);
}

export interface FakeFrame { n: number; time: number; x: number }
export const VIDEO_FRAMES: readonly FakeFrame[] = [{ n: 5, time: 0.5, x: 16 }, { n: 10, time: 1, x: 64 }, { n: 15, time: 1.5, x: 112 }];

/**
 * FAKE: a video record of three sampled frames (160 × 120), each with an amber square at a known place and the colour
 * region's box and centroid recorded at its time, as the video readback records them. No video was read and no tool ran.
 */
export function fakeVideoRecord(root: string, id = 'vfa4e0001'): { id: string; frames: readonly FakeFrame[] } {
  const clip = write(root, 'refs/clip.mp4', 'FAKE: not a video (tests/helpers/vox-panel-kit.ts)');
  const hl = VIDEO_FRAMES.map((f) => {
    const img = png(160, 120, (x, y) => (x >= f.x && x < f.x + 32 && y >= 40 && y < 72 ? [255, 176, 0] : [16, 16, 16]));
    return { f, file: write(root, `results/vox/${id}/frames/frame-${String(f.n).padStart(6, '0')}.png`, img) };
  });
  const note = 'one sampled frame, as ffmpeg decoded it (FAKE: no frame was decoded)';
  const rec = {
    schema: 'timmy.vox/1', id, action: 'detect', command: '/detect refs/clip.mp4 color 255,176,0 --at 0.5,1,1.5', made_at: '2026-10-16T12:00:00.000Z', project: folderProject(root).name, status: 'ok',
    inputs: [{ ...clip, kind: 'video', kind_by: 'bytes', frame: { space: 'video pixels', unit: 'px', unit_by: 'declared', size: [160, 120], words: "the video's pixel frame: 160 × 120 px (FAKE)" } }],
    tools: [{ tool: 'video', name: 'timmy-video-readback', version: 'fake', ran: 'job', job: { id: 'j0fa4e1', state: 'completed', exit_code: 0 } }],
    metrics: VIDEO_FRAMES.map((f) => ({
      name: `color_at:${f.time}`, title: `Colour region at ${f.time} s (frame ${f.n})`,
      value: { rgb: [255, 176, 0], found: true, pixels_scaled: 1024, centroid_px: [f.x + 16, 56], centroid_fraction: [(f.x + 16) / 160, 56 / 120], box_px: [f.x, 40, f.x + 32, 72] },
      unit: 'video pixels (x right, y down); fraction of the frame', method: 'FAKE: written by the test, not measured', tier: TIER.computed, label: LABEL.video,
      measured_by: 'timmy-video-readback fake', status_word: 'estimated', status_note: note,
    })),
    highlights: hl.map(({ f, file }) => ({ ...file, type: 'frame', drawn_from: ['color_at'], drawn_by: 'timmy-video-readback fake (FAKE)', method: `the frame shown at ${f.time} s (FAKE)`, status_word: 'estimated', status_note: note })),
    failures: [], notes: ['FAKE: a test fixture (tests/helpers/vox-panel-kit.ts): no video was read and no tool ran.'],
  };
  sealRecord(root, rec, hl.map((x) => x.file));
  return { id, frames: VIDEO_FRAMES };
}

/** FAKE: a record naming one image input at `rel` (whatever is there), sealed: for the file route's refusals. */
export function fakeImageRecord(root: string, id: string, rel: string, bytes: { sha256: string; bytes: number }): void {
  sealRecord(root, {
    schema: 'timmy.vox/1', id, action: 'inspect', command: `/inspect ${rel}`, made_at: '2026-10-16T11:00:00.000Z', project: folderProject(root).name, status: 'ok',
    inputs: [{ path: rel, ...bytes, kind: 'image', kind_by: 'name' }], tools: [{ tool: 'look', name: 'timmy-look', version: 'fake', ran: 'job', job: { id: 'j0fa4e2', state: 'completed', exit_code: 0 } }],
    metrics: [], highlights: [], failures: [], notes: ['FAKE: a test fixture (tests/helpers/vox-panel-kit.ts).'],
  });
}

export { write as writeFile };
