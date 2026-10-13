/**
 * The agent's recipe tool (round R3, helper H11): run_recipe starts the CadQuery enclosure-tray recipe
 * (enclosure.tray/1, millimetres) as a durable background job, the same start as the REPL's /recipe tray:
 * the request is validated and its analytic prediction sealed before any native start, and the answer is
 * the Timmy job id and the recipe job's UUID at once, never a finished build. The operator is asked before
 * each call (the REPL's NEEDS YOU rule for run_recipe). No executor or path can be given here.
 */
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';

export interface RecipeToolOptions {
  /** Starts the job through the REPL's workspace (Workspace.runRecipe) and answers with what happened. */
  start: (parameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const answer = z.record(z.string(), z.unknown());

export function createRecipeTools(o: RecipeToolOptions) {
  const run = tool({
    name: 'run_recipe',
    description: [
      "Start the CadQuery enclosure-tray recipe (enclosure.tray/1) as a durable background job in the operator's active project; you get the job id and the recipe job's UUID back at once, and the build is NOT finished then.",
      'Parameters are millimetres: width (40 to 1000, default 140), wall (above 0 up to 10, default 3), supportOffset (above wall + 6 and below min(width, 80)/2 - 6, default 10), bore (diameter above 0 and below 12, default 3). An invalid request is refused before anything starts.',
      'The operator is asked first. Report the job id and UUID; the operator follows it with /jobs <id> and /recipe status. Exports appear in out/recipes/<first 8 of the UUID>/ only after the signed result verifies. Do not claim the tray is built.',
    ].join(' '),
    inputSchema: z.object({
      recipe: z.enum(['enclosure.tray/1']).describe("the recipe: 'enclosure.tray/1'"),
      parameters: z.object({
        width: z.number().optional(), wall: z.number().optional(), supportOffset: z.number().optional(), bore: z.number().optional(),
      }).optional().describe('millimetres; omitted ones keep the recipe defaults'),
    }),
    outputSchema: answer,
    execute: async (input: { recipe: 'enclosure.tray/1'; parameters?: Record<string, number | undefined> }) => {
      if (input.recipe !== 'enclosure.tray/1') return { ok: false, error: 'the only recipe is enclosure.tray/1; nothing started' };
      const given = Object.fromEntries(Object.entries(input.parameters ?? {}).filter(([, v]) => v !== undefined));
      try { return await o.start(given); } catch (e) {
        return { ok: false, error: `the recipe did not start: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  });
  return [run];
}
