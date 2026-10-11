/**
 * The agent's iterate tools (round R4). iterate_recipe (helper H24) starts the same flow as the REPL's
 * `/iterate tray "<instruction>"`: a local, free code agent (Qwen Code on the operator's local endpoint, with the
 * operator's own model setting) may change only recipes/tray.params.json; the CadQuery tray recipe then rebuilds
 * as a durable job and a separate worker reads its STEP back. iterate_native (helper H33) starts the same flow as
 * `/iterate scad <model.scad> "<instruction>"` (the agent may change only the values in <model>.params.json; OpenSCAD
 * exports the model as a judged job; Timmy's reading of its STL is compared with OpenSCAD's own summary) or
 * `/iterate freecad <script.py> "<instruction>"` (the agent may change only that script; FreeCAD runs it as a judged
 * job; its STEP is read back as /freecad readback reads it). The answer is the flow's id and its agent's job at once,
 * never a finished build. The operator is asked before every call (the REPL's NEEDS YOU rules for iterate_recipe and
 * iterate_native ask each time). No model, route, path or executor can be given here beyond the file named.
 */
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';

/** What a tool asks the workspace to start: the tray (by its instruction), or an OpenSCAD model or FreeCAD script. */
export type IterateToolRequest = { target: 'tray'; instruction: string } | { target: 'scad' | 'freecad'; file: string; instruction: string };

export interface IterateToolOptions {
  /**
   * Starts the flow through the REPL's workspace (Workspace.iterateForTool) and answers with what happened. iterate_recipe
   * gives the tray's instruction (a string); iterate_native gives its target, file and instruction.
   */
  start: (request: string | IterateToolRequest) => Promise<Record<string, unknown>>;
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
  // R4 (H33): /iterate scad and /iterate freecad as a tool, asked each time (src/repl/approvals.ts).
  const native = tool({
    name: 'iterate_native',
    description: [
      "Start an iteration of an OpenSCAD model or a FreeCAD script in the operator's active project: a local, free code agent changes one file as the instruction says, then the app runs as a judged background job and its output is read back.",
      "app 'openscad' with file '<model>.scad': the agent may change only the values in the model's parameter file (<model>.params.json beside it, which must already exist; no name added or removed); OpenSCAD then exports the model to an STL and a PNG preview, and Timmy's own reading of the STL is compared with OpenSCAD's own summary.",
      "app 'freecad' with file '<script>.py': the agent may change only that FreeCAD Python script; freecadcmd then runs it as a judged job, and the STEP it exports is read back in a separate process and compared with FreeCAD's own report (when TIMMY_CADQUERY_PYTHON is set; otherwise the flow ends after FreeCAD, succeeded without readback).",
      'The operator is asked first, every time. You get the flow id and the agent job at once: nothing is built or measured then. Report the ids; the operator follows the flow with /iterate and stops it with /stop <flow id>. Its record appears in results/flows/ when it ends. Do not claim the part is built or measured.',
    ].join(' '),
    inputSchema: z.object({
      app: z.enum(['openscad', 'freecad']).describe("'openscad' (a .scad model's parameter file) or 'freecad' (a FreeCAD Python script)"),
      file: z.string().min(1).max(1000).describe('the .scad model (openscad) or the .py script (freecad), relative to the project'),
      instruction: z.string().min(1).max(2000).describe('what to change, in plain words with millimetre values'),
    }),
    outputSchema: answer,
    execute: async (input: { app: 'openscad' | 'freecad'; file: string; instruction: string }) => {
      if (input.app !== 'openscad' && input.app !== 'freecad') return { ok: false, started: false, error: 'app is openscad or freecad; nothing started' };
      if (typeof input.file !== 'string' || !input.file.trim()) return { ok: false, started: false, error: 'name the file: the .scad model or the .py script; nothing started' };
      if (typeof input.instruction !== 'string' || !input.instruction.trim()) return { ok: false, started: false, error: 'say what to change; nothing started' };
      try { return await o.start({ target: input.app === 'openscad' ? 'scad' : 'freecad', file: input.file.trim(), instruction: input.instruction.trim() }); } catch (e) {
        return { ok: false, started: false, error: `the flow did not start: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  });
  return [run, native];
}
