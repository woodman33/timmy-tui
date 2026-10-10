/**
 * The agent's iterate tool (round R4, helper H24): iterate_recipe starts the same flow as the REPL's
 * `/iterate tray "<instruction>"`: a local, free code agent (Qwen Code on the operator's local endpoint, with the
 * operator's own model setting) may change only recipes/tray.params.json; the CadQuery tray recipe then rebuilds
 * as a durable job and a separate worker reads its STEP back. The answer is the flow's id and its agent's job at
 * once, never a finished build. The operator is asked before every call (the REPL's NEEDS YOU rule for
 * iterate_recipe asks each time). No model, route, path or executor can be given here.
 */
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';

export interface IterateToolOptions {
  /** Starts the flow through the REPL's workspace (Workspace.iterateForTool) and answers with what happened. */
  start: (instruction: string) => Promise<Record<string, unknown>>;
}

const answer = z.record(z.string(), z.unknown());

export function createIterateTools(o: IterateToolOptions) {
  const run = tool({
    name: 'iterate_recipe',
    description: [
      "Start an iteration of the CadQuery enclosure-tray recipe (enclosure.tray/1) in the operator's active project: a local, free code agent changes only recipes/tray.params.json as the instruction says, then the recipe rebuilds as a durable background job and a separate worker reads the delivered STEP back and compares it with the sealed prediction.",
      'Give the instruction in plain words with millimetre values (for example: make the tray 180 mm wide). The parameters are width (40 to 1000), wall (above 0 up to 10), supportOffset (above wall + 6 and below min(width, 80)/2 - 6) and bore (diameter above 0 and below 12).',
      'The operator is asked first, every time. You get the flow id and the agent job at once: nothing is rebuilt or measured then. Report the ids; the operator follows the flow with /iterate and stops it with /stop <flow id>. Its record appears in results/flows/ when it ends. Do not claim the tray is rebuilt or measured.',
    ].join(' '),
    inputSchema: z.object({
      recipe: z.enum(['enclosure.tray/1']).describe("the recipe: 'enclosure.tray/1'"),
      instruction: z.string().min(1).max(2000).describe('what to change, in plain words with millimetre values'),
    }),
    outputSchema: answer,
    execute: async (input: { recipe: 'enclosure.tray/1'; instruction: string }) => {
      if (input.recipe !== 'enclosure.tray/1') return { ok: false, started: false, error: 'the only recipe is enclosure.tray/1; nothing started' };
      if (typeof input.instruction !== 'string' || !input.instruction.trim()) return { ok: false, started: false, error: 'say what to change; nothing started' };
      try { return await o.start(input.instruction.trim()); } catch (e) {
        return { ok: false, started: false, error: `the flow did not start: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  });
  return [run];
}
