/**
 * R13 (the operator's 15:31 order, item 4): Timmy Animate's agent tools and MCP tools, adapted to the C1 host from the owner's
 * reference hunk (`src/agent/animate-tools.ts` in the Animate owner's host patch; the owner keeps the engine).
 *
 * Authoring (timmy_animate_catalog … timmy_animate_motion_react): the owner's own authoring engine
 * (integrations/studio-dispatch.mjs) from the hosted copy Timmy names (TIMMY_ANIMATE_DIR, as the page's host reads it),
 * loaded lazily at call time. Each returns a candidate (a scene, source or SVG) in memory: no file, no open canvas, no server
 * and no receipt, exactly as the owner ships it. What changed from the owner's hunk: the engine is found through Timmy's
 * hosted copy rather than inside the Timmy package.
 *
 * Export (timmy_animate_export, new here): the app's native Blender export as its own durable job, through the C1 host
 * (src/companion/miniapps/session.ts): it waits for the app's own end state and returns it with the receipt Timmy sealed in
 * the project's runs chain. It runs Blender on this computer, so it asks first (src/repl/approvals.ts).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';

const sceneJson = z.string().min(2).max(3 * 1024 * 1024)
  .describe('Complete Timmy Animate scene JSON from the user or a previous tool result. Authoring tools return a candidate and never replace the open canvas.');
const objectId = z.string().min(1).max(200).describe('Existing layer ID from the scene.');
const empty = z.object({}).strict();
const sceneOnly = z.object({ sceneJson }).strict();

const authoring = [
  { suffix: 'catalog', description: 'List Timmy Animate templates, icons, primitives, path and state presets, themes and drawing guides. Local only.', schema: empty },
  { suffix: 'template', description: 'Create an editable original animation starter in memory. Returns a scene; no files or open canvas are changed.', schema: z.object({ id: z.enum(['weather', 'hearth', 'botanical', 'orbit', 'rhythm', 'welcome']) }).strict() },
  { suffix: 'recipe', description: 'Apply a motion recipe to unlocked scene layers and return a candidate. Replaces their keys and paths; preserves locked layers.', schema: z.object({ sceneJson, recipeId: z.enum(['stagger-rise', 'settle', 'breathe']) }).strict() },
  { suffix: 'svg', description: 'Render one scene frame to SVG using the editor geometry and animation evaluator. Returns SVG text.', schema: z.object({ sceneJson, time: z.number().min(0).max(12).optional() }).strict() },
  { suffix: 'lottie', description: 'Export a visual animation to editable Lottie JSON. Audio and interactive state events are not included.', schema: sceneOnly },
  { suffix: 'after_effects', description: 'Generate an additive After Effects composition script. Returns source only; never launches or changes After Effects.', schema: sceneOnly },
  { suffix: 'xstate', description: 'Export the scene state graph as executable XState source. Returns source only.', schema: sceneOnly },
  { suffix: 'state_preview', description: 'Preview up to 64 events in a real local XState actor. Returns the active state and candidate scene; the open canvas stays unchanged.', schema: z.object({ sceneJson, events: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/)).max(64) }).strict() },
  { suffix: 'path_preset', description: 'Apply an editable route to one unlocked layer and return a candidate scene. Does not overwrite the open document.', schema: z.object({ sceneJson, objectId, presetId: z.enum(['line', 'arc', 'wave', 'loop', 'figure8', 'zigzag', 'spiral', 'bounce']), width: z.number().min(1).max(2000).optional(), height: z.number().min(0).max(2000).optional(), mode: z.enum(['once', 'ping-pong']).optional(), orient: z.boolean().optional() }).strict() },
  { suffix: 'layer', description: 'Set a scene layer visibility or lock flag and return a candidate. Does not change geometry or the open canvas.', schema: z.object({ sceneJson, objectId, hidden: z.boolean().optional(), locked: z.boolean().optional() }).strict().refine((a) => a.hidden !== undefined || a.locked !== undefined, 'Supply hidden or locked.') },
  { suffix: 'motion_react', description: 'Export a scene as an editable Motion React JSX component. Visual animation only; no audio or code execution.', schema: sceneOnly },
] as const;

const exportSchema = z.object({ sceneJson, cancelAfterSeconds: z.number().min(0).max(600).optional().describe('Ask the app to cancel the export after this many seconds (its outcome is still sealed).') }).strict();
const EXPORT = { suffix: 'export', description: 'Export a scene natively with Blender through Timmy Animate (the app\'s own job, hosted by Timmy for the active project): .blend, .usda and previews. Waits for the app\'s end state and returns it with the receipt Timmy sealed. Runs Blender on this computer.', schema: exportSchema } as const;

export const ANIMATE_AUTHORING_NAMES: readonly string[] = authoring.map((d) => `timmy_animate_${d.suffix}`);
export const ANIMATE_EXPORT_NAME = 'timmy_animate_export';

export const ANIMATE_TOOLS = [...authoring, EXPORT].map((d) => ({ name: `timmy_animate_${d.suffix}`, description: d.description, inputSchema: z.toJSONSchema(d.schema, { target: 'draft-7' }) }));

/** The owner's authoring engine in the hosted copy (TIMMY_ANIMATE_DIR). */
function dispatcherUrl(env: Record<string, string | undefined>): string {
  const dir = env.TIMMY_ANIMATE_DIR;
  const entry = dir ? join(dir, 'integrations', 'studio-dispatch.mjs') : '';
  if (!dir || !existsSync(entry)) throw new Error('Timmy Animate is not installed with this Timmy: TIMMY_ANIMATE_DIR names no folder with integrations/studio-dispatch.mjs (the review package sets it to the copy it carries).');
  return pathToFileURL(entry).href;
}

export async function callAnimateTool(name: string, input: unknown = {}, env: Record<string, string | undefined> = process.env): Promise<unknown> {
  if (name === ANIMATE_EXPORT_NAME) {
    const args = exportSchema.parse(input);
    const scene = JSON.parse(args.sceneJson) as unknown;
    const { openAppSession, waitFor } = await import('../companion/miniapps/session.js');
    const s = await openAppSession('animate', { env });
    if ('error' in s) return { ok: false, error: s.error };
    try {
      const started = await s.request('POST', '/api/jobs', { scene });
      const job = started.json as { id?: string; error?: string } | null;
      if (started.status >= 400 || !job?.id) return { ok: false, status: started.status, error: job?.error ?? 'The app did not start the export.' };
      const timer = args.cancelAfterSeconds !== undefined ? setTimeout(() => { void s.request('POST', `/api/jobs/${job.id}/cancel`, {}); }, args.cancelAfterSeconds * 1000) : null;
      const end = await waitFor(async () => (await s.request('GET', `/api/jobs/${job.id}`)).json as { status?: string; error?: string; artifacts?: Array<{ name: string; bytes?: number }> } | null, (j) => !j || !['queued', 'running'].includes(String(j.status)), 600_000);
      if (timer) clearTimeout(timer);
      await s.sealNow();
      await s.close();
      return { ok: end?.status === 'succeeded', app: 'animate', project: s.project.name, job: job.id, state: end?.status ?? 'unknown', ...(end?.error ? { error: end.error } : {}), artifacts: (end?.artifacts ?? []).map((a) => ({ name: a.name, bytes: a.bytes })), receipts: s.receiptsOf(job.id) };
    } finally { await s.close(); }
  }
  const d = authoring.find((x) => `timmy_animate_${x.suffix}` === name);
  if (!d) throw new Error(`Unknown Timmy Animate tool: ${name}`);
  const args = d.schema.parse(input) as Record<string, unknown>;
  const { sceneJson: raw, ...rest } = args;
  const payload = raw === undefined ? rest : { ...rest, scene: JSON.parse(raw as string) };
  const engine = await import(dispatcherUrl(env)) as { dispatchStudio: (n: string, p: unknown) => Promise<unknown> };
  return engine.dispatchStudio(`studio_${d.suffix}`, payload);
}

/** The agent's tools (OpenRouter SDK): the same definitions. */
export const animateTools = [...authoring, EXPORT].map((d) => tool({
  name: `timmy_animate_${d.suffix}`,
  description: d.description,
  inputSchema: d.schema,
  outputSchema: z.any(),
  execute: (args: unknown) => callAnimateTool(`timmy_animate_${d.suffix}`, args),
} as any));
