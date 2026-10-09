/**
 * The agent's vision tools (round R2, look; the pattern of project-tools.ts). observe_image gives any agent,
 * a text-only one included, Look's measurements of a project image: deterministic computations on the
 * pixels (OpenCV), never a claim about what the image shows. describe_image asks an image-capable model
 * for its interpretation, a claim with the model's name and its reported cost; it spends money, so the
 * REPL asks every time.
 *
 * With `observe` (the REPL's Workspace.observeFile), each call runs as a job and lands in Results: a file
 * in results/observations/ and an observe receipt. Without it Look runs directly and nothing is recorded,
 * and the answer says so (recorded: false).
 */
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import { readProjectFile, resolveInside } from '../project/index.js';
import { checkOpenCv, DETERMINISTIC, lookPython, OPENCV_SETUP, runLook, type LookObservation } from '../vision/look.js';
import { describeImage } from '../vision/route.js';

type Observed = { ok: true; file: string; receipt?: string; tiers: string[]; interpretation?: Record<string, unknown> } | { ok: false; error: string; receipt?: string };

export interface VisionToolOptions {
  root: () => string;
  /** Runs Look (and, with a question, a model) through the REPL's workspace; the outcome once recorded. */
  observe?: (rel: string, question?: string, model?: string) => Promise<Observed>;
  env?: NodeJS.ProcessEnv;
  onPath?: (cmd: string) => string | null;
  /** The REPL's current model: describe_image's default. */
  model?: () => string;
  fetch?: typeof fetch;
}

const answer = z.record(z.string(), z.unknown());
/** What a tool answer may carry, at most (characters of JSON). */
const MAX_ANSWER = 16_000;

/** The observation as an agent reads it: bounded, corner lists dropped first when it is long. */
function bounded(look: Pick<LookObservation, 'image' | 'measurements' | 'uncertainty'>): Record<string, unknown> {
  const out: Record<string, unknown> = { image: look.image, measurements: look.measurements, uncertainty: look.uncertainty };
  if (JSON.stringify(out).length <= MAX_ANSWER) return out;
  const slim = look.measurements.map((m) => (Array.isArray(m.value) ? { ...m, value: (m.value as Array<Record<string, unknown>>).slice(0, 10).map(({ corners: _c, ...rest }) => rest) } : m));
  return { ...out, measurements: slim, trimmed: 'corner points and items past ten were left out; the full observation is in its file' };
}

export function createVisionTools(o: VisionToolOptions) {
  const env = o.env ?? process.env;
  const observeImage = tool({
    name: 'observe_image',
    description: "Measure an image in the operator's active project with Look (OpenCV): size, mean and dominant colors, sharpness, edge density, decoded QR codes and ArUco markers. These are deterministic computations on the pixels, with their uncertainty; they do not say what the image shows. Works for any model, text-only ones included. The path is relative to the project (files added with /add are under refs/).",
    inputSchema: z.object({ path: z.string().describe('Image path relative to the project folder, e.g. refs/board.png') }),
    outputSchema: answer,
    execute: async ({ path }: { path: string }) => {
      const at = resolveInside(o.root(), path);
      if ('error' in at) return { ok: false, error: at.error };
      if (o.observe) {
        const r = await o.observe(at.rel);
        if (!r.ok) return { ok: false, error: r.error, ...(r.receipt ? { receipt: r.receipt } : {}) };
        const file = readProjectFile(o.root(), r.file, 1024 * 1024);
        let look: LookObservation | undefined;
        try { look = file.ok && file.text ? (JSON.parse(file.text) as { look: LookObservation }).look : undefined; } catch { look = undefined; }
        if (!look) return { ok: false, error: `the observation was recorded in ${r.file} but could not be read back` };
        return { ok: true, path: at.rel, tier: DETERMINISTIC, recorded: true, observation_file: r.file, ...(r.receipt ? { receipt: r.receipt } : {}), ...bounded(look) };
      }
      const py = lookPython(env, o.onPath);
      if ('error' in py) return { ok: false, error: `Look needs a Python with OpenCV: ${py.error}. Setup: ${OPENCV_SETUP}` };
      const cv = await checkOpenCv(py.python, env);
      if (!cv.ok) return { ok: false, error: `${cv.error}. Setup: ${OPENCV_SETUP}` };
      const r = await runLook({ python: py.python, imagePath: at.path, rel: at.rel, env });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, path: at.rel, tier: DETERMINISTIC, recorded: false, sha256: r.observation.source.sha256, ...bounded(r.observation) };
    },
  });
  const describe = tool({
    name: 'describe_image',
    description: "Ask an image-capable model what an image in the operator's active project shows. Its answer is the model's interpretation, a claim and not a measurement; it costs money, so the operator is asked every time. A model that does not take images is refused, with some that do. Prefer observe_image for anything that can be measured.",
    inputSchema: z.object({
      path: z.string().describe('Image path relative to the project folder'),
      question: z.string().describe('What to ask about the image'),
      model: z.string().optional().describe('An OpenRouter model id that takes images; default: the current model'),
    }),
    outputSchema: answer,
    execute: async ({ path, question, model }: { path: string; question: string; model?: string }) => {
      const at = resolveInside(o.root(), path);
      if ('error' in at) return { ok: false, error: at.error };
      const chosen = model ?? o.model?.();
      if (!chosen) return { ok: false, error: 'name a model that takes images' };
      if (o.observe) {
        const r = await o.observe(at.rel, question, chosen);
        if (!r.ok) return { ok: false, error: r.error, ...(r.receipt ? { receipt: r.receipt } : {}) };
        const i = r.interpretation ?? {};
        if (i.status !== 'answered') return { ok: false, error: String(i.reason ?? 'the model did not answer'), ...(Array.isArray(i.alternatives) ? { alternatives: i.alternatives } : {}), observation_file: r.file, ...(r.receipt ? { receipt: r.receipt } : {}) };
        return { ok: true, tier: i.tier, model: i.model, answer: i.answer, cost_usd: i.cost_usd ?? null, recorded: true, observation_file: r.file, ...(r.receipt ? { receipt: r.receipt } : {}) };
      }
      const r = await describeImage({ model: chosen, imagePath: at.path, question, apiKey: env.OPENROUTER_API_KEY, ...(o.fetch ? { fetch: o.fetch } : {}) });
      if (!r.ok) return { ok: false, error: r.error, ...(r.alternatives ? { alternatives: r.alternatives } : {}) };
      return { ok: true, tier: r.tier, model: r.model, answer: r.answer, cost_usd: r.cost_usd, recorded: false };
    },
  });
  return [observeImage, describe];
}
