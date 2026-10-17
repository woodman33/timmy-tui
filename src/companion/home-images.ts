/**
 * R7 (H152; the R6 interaction review's N9, the package's defect 14: Home's newest images followed the newest run only, so
 * after a run with no image the report run's image was gone from Home): the newest run of the project's records that holds
 * an image, whatever ran after it, for Home's Preview.
 *
 * GET /api/newest-run-image?project=<id> (the companion's token, as every content route) answers it: the project's operations,
 * newest first (src/ops/operations.ts listOperationRecords, the records `timmy op` and Workflows read), each asked of the
 * run-detail producer and its inspector as Workflows asks them (src/companion/run-detail.ts runDetailAnswer), until one's
 * inspection holds an image it can draw (an output, or a file it changed, as a data: address), at most HOME_RUNS_LOOKED.
 * The answer names that run, the file, its size, how many newer runs hold none, and the image; or no image, and why. It
 * reads only.
 */
import type { FilePreview } from '../ops/run-detail.js';
import { listOperationRecords } from '../ops/operations.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { runDetailAnswer, type RunDetailProducer } from './run-detail.js';

/** The most runs looked at, newest first, for one answer. */
export const HOME_RUNS_LOOKED = 12;

export interface HomeRunImage {
  /** the run's operation id */
  op: string;
  /** the file, project-relative */
  path: string;
  width?: number;
  height?: number;
  /** the image as a data: address */
  src: string;
  /** how many runs newer than this one hold no image Timmy can show */
  newer: number;
}

export type HomeRunImageAnswer =
  | { ok: true; image: HomeRunImage; looked: number }
  | { ok: true; image: null; looked: number; why: string }
  | { ok: false; error: string };

type Previewed = { path: string; preview?: FilePreview };
const drawable = (x: Previewed | undefined): x is Previewed & { preview: Extract<FilePreview, { kind: 'image' }> & { data: string } } =>
  !!x && !!x.preview && x.preview.kind === 'image' && typeof x.preview.data === 'string' && x.preview.data.startsWith('data:image/');

/** The newest run of the project at `root` that holds an image, asked of `producer` (the built-in one when undefined). */
export async function newestRunImage(root: string, producer?: RunDetailProducer, max = HOME_RUNS_LOOKED): Promise<HomeRunImageAnswer> {
  let ops: string[];
  try { ops = listOperationRecords(root, max).list.map((x) => x.record.id); } catch (err) {
    return { ok: false, error: `The project's runs could not be listed: ${scrubHomes(err instanceof Error ? err.message.split('\n')[0] : String(err))}` };
  }
  let looked = 0;
  for (const op of ops) {
    looked += 1;
    const a = await runDetailAnswer(op, root, producer);
    if (a.body.ok !== true || !a.body.inspection) continue;
    const insp = a.body.inspection;
    const hit = [...(insp.outputs as Previewed[]), ...(insp.changes.list as Previewed[])].find(drawable);
    if (!hit || !drawable(hit)) continue;
    const p = hit.preview;
    return { ok: true, looked, image: { op, path: hit.path, ...(p.width && p.height ? { width: p.width, height: p.height } : {}), src: p.data, newer: looked - 1 } };
  }
  return {
    ok: true, image: null, looked,
    why: ops.length ? `none of the ${looked === 1 ? 'one run' : `${looked} newest runs`} in this project's records holds an image Timmy can show` : 'no run in this project\'s records yet',
  };
}
