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
import { checkOpenCv, DETERMINISTIC, lookPython, OPENCV_SETUP, runLook, type LookObservation, lookEnv } from '../vision/look.js';
import { describeImage } from '../vision/route.js';

type Observed = { ok: true; file: string; receipt?: string; tiers: string[]; interpretation?: Record<string, unknown>; qualified?: Record<string, unknown> }
  /** R4 (H30): `cost_usd` when a model request went out (null: no cost came back) */
  | { ok: false; error: string; receipt?: string; cost_usd?: number | null };
/** R4 (H30): a failure says what it cost when a request went out (a number, or null: unknown), so the turn can count it. */
const costOf = (r: { cost_usd?: number | null }): { cost_usd?: number | null } => ('cost_usd' in r ? { cost_usd: r.cost_usd ?? null } : {});

export interface VisionToolOptions {
  root: () => string;
  /** Runs Look (and, with a question, a model) through the REPL's workspace; the outcome once recorded. */
  observe?: (rel: string, question?: string, model?: string, opts?: { qualify?: boolean }) => Promise<Observed>;
  env?: NodeJS.ProcessEnv;
  onPath?: (cmd: string) => string | null;
  /** The REPL's current model: describe_image's default. */
  model?: () => string;
  fetch?: typeof fetch;
}

const answer = z.record(z.string(), z.unknown());
/** Round R3: what the agent reads of a model's answer; the observation file keeps the whole of it. */
const AGENT_ANSWER_CHARS = 8000;
const agentText = (a: unknown): unknown => (typeof a === 'string' && a.length > AGENT_ANSWER_CHARS
  ? `${a.slice(0, AGENT_ANSWER_CHARS)}… [${a.length - AGENT_ANSWER_CHARS} more characters in the observation file]`
  : a);
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
      const cv = await checkOpenCv(py.python, lookEnv(env));
      if (!cv.ok) return { ok: false, error: `${cv.error}. Setup: ${OPENCV_SETUP}` };
      const r = await runLook({ python: py.python, imagePath: at.path, rel: at.rel, env: lookEnv(env) });
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
      // R3 (H14): the observed-handle + cite protocol (/observe <file> --qualify).
      qualify: z.boolean().optional().describe("Admit the answer only if it cites Look's measurements of this image through the cite tool (recorded as a qualified answer; refused answers keep their raw output). Still a claim, not a measurement."),
    }),
    outputSchema: answer,
    execute: async ({ path, question, model, qualify }: { path: string; question: string; model?: string; qualify?: boolean }) => {
      const at = resolveInside(o.root(), path);
      if ('error' in at) return { ok: false, error: at.error };
      const chosen = model ?? o.model?.();
      if (!chosen) return { ok: false, error: 'name a model that takes images' };
      if (qualify) {
        // R3 (H14): a qualified answer exists only as a recorded observation (its handles, run and receipt).
        if (!o.observe) return { ok: false, error: "a qualified answer is recorded through the REPL's workspace: /observe <file> --qualify" };
        const r = await o.observe(at.rel, question, chosen, { qualify: true });
        if (!r.ok) return { ok: false, error: r.error, ...(r.receipt ? { receipt: r.receipt } : {}), ...costOf(r) };
        const q = r.qualified ?? {};
        const cost = 'cost_usd' in q ? { cost_usd: (q.cost_usd as number | null | undefined) ?? null } : {};
        const where = { observation_file: r.file, ...(r.receipt ? { receipt: r.receipt } : {}) };
        if (q.status !== 'admitted') {
          return { ok: false, status: q.status, ...(typeof q.refusal === 'string' ? { refusal: q.refusal } : {}), error: String(q.reason ?? 'no admitted answer'), ...(typeof q.raw_output === 'string' && q.raw_output ? { raw_output: agentText(q.raw_output) } : {}), ...cost, ...where };
        }
        return {
          ok: true, tier: q.tier, qualified: true, model: q.model, answer: agentText(q.answer), cites: q.cites, run_id: q.run_id, source_revision: q.source_revision,
          semantic_correctness_verified: false, note: "A model's claim whose citations point at Look's measured values; not a measurement.", ...cost, recorded: true, ...where,
        };
      }
      if (o.observe) {
        const r = await o.observe(at.rel, question, chosen);
        if (!r.ok) return { ok: false, error: r.error, ...(r.receipt ? { receipt: r.receipt } : {}), ...costOf(r) };
        const i = r.interpretation ?? {};
        // Round R3: a request that went out reports its cost whatever its status (null: not reported, unknown).
        const cost = 'cost_usd' in i ? { cost_usd: (i.cost_usd as number | null | undefined) ?? null } : {};
        if (i.status !== 'answered') return { ok: false, status: i.status, error: String(i.reason ?? 'the model did not answer'), ...cost, ...(Array.isArray(i.alternatives) ? { alternatives: i.alternatives } : {}), observation_file: r.file, ...(r.receipt ? { receipt: r.receipt } : {}) };
        return { ok: true, tier: i.tier, model: i.model, answer: agentText(i.answer), ...cost, recorded: true, observation_file: r.file, ...(r.receipt ? { receipt: r.receipt } : {}) };
      }
      const r = await describeImage({ model: chosen, imagePath: at.path, question, apiKey: env.OPENROUTER_API_KEY, ...(o.fetch ? { fetch: o.fetch } : {}) });
      if (!r.ok) return { ok: false, error: r.error, ...(r.alternatives ? { alternatives: r.alternatives } : {}), ...(r.sent ? { cost_usd: r.cost_usd ?? null } : {}) };
      return { ok: true, tier: r.tier, model: r.model, answer: agentText(r.answer), cost_usd: r.cost_usd, recorded: false };
    },
  });
  return [observeImage, describe];
}
