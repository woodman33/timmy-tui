/**
 * The agent's native app tool (R2): run_native starts Cinema 4D's c4dpy (a Python script, headless),
 * After Effects' aerender (renders an existing project) or (R3) Blender's own Python (a script, headless)
 * as a background job in the active project, through the REPL's own JobManager, and answers with the
 * job's id at once. It does not wait for the job: the turn goes on, and the job's outcome is judged when it
 * ends (src/native: the script's result file for c4dpy and Blender, the outputs for aerender; the exit is
 * recorded beside it). The operator is asked before each call
 * (the REPL's NEEDS YOU rule for run_native).
 */
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import type { JobRecord, JobSpec } from '../jobs/index.js';
import { aerenderJob, blenderJob, c4dpyJob, locateNative, NATIVE_APPS, noteNativeStarted, type NativeApp, type NativeFound, type NativeJobSpec } from '../native/index.js';

export interface NativeToolOptions {
  /** the active project's folder */
  root: () => string;
  /** the active project's name */
  project: () => string;
  /** starts a job and returns at once: the REPL's JobManager.start */
  start: (spec: JobSpec) => JobRecord;
  /** where each app's program is (default: the finder in src/native, which reads the environment) */
  find?: Partial<Record<NativeApp, () => NativeFound | null>>;
  /** told of each job started, with its spec, so the owner can judge it when it ends */
  onStarted?: (job: JobRecord, spec: NativeJobSpec) => void;
  /** added to each job's environment */
  env?: NodeJS.ProcessEnv;
}

const answer = z.record(z.string(), z.unknown());
const DEFAULT_MINUTES = 60;

export function createNativeTools(o: NativeToolOptions) {
  const run = tool({
    name: 'run_native',
    description: [
      "Start a native creative app as a background job in the operator's active project and get its job id back at once; the job keeps running after this call returns and is NOT finished when you get the id.",
      "app 'c4dpy' runs a Python file with Cinema 4D's own Python, headless (script, relative to the project, plus args); the script can build or change a scene, save an editable .c4d and render, and writes this run's own result file (.timmy/native/<run>/result.json) through workers/c4d/timmy_c4d.py.",
      "app 'aerender' renders an EXISTING After Effects project (project_file .aep/.aepx, comp by name, output file); it cannot create or edit a project.",
      "app 'blender' runs a Python file with Blender's own Python, headless (blender -b --factory-startup --python <script> -- <args>); the script can build or change a scene, save an editable .blend and render a still, and writes this run's own result file through workers/blender/timmy_blender.py.",
      'The operator is asked first. Report the job id; the operator follows it with /jobs <id>. Do not claim the render or the scene is done.',
    ].join(' '),
    inputSchema: z.object({
      app: z.enum(['c4dpy', 'aerender', 'blender']).describe("'c4dpy' (Cinema 4D Python), 'aerender' (After Effects render of an existing project) or 'blender' (Blender Python, headless)"),
      script: z.string().optional().describe('c4dpy, blender: the .py file to run, relative to the project'),
      args: z.array(z.string()).optional().describe('c4dpy: arguments after the script; blender: the script\'s arguments (after --)'),
      project_file: z.string().optional().describe('aerender: the existing .aep or .aepx, relative to the project'),
      comp: z.string().optional().describe('aerender: the composition to render, by name'),
      output: z.string().optional().describe('aerender: the file to render to, relative to the project, e.g. out/title.mov'),
      render_settings_template: z.string().optional().describe('aerender: -RStemplate, a render settings template by name'),
      output_module_template: z.string().optional().describe('aerender: -OMtemplate, an output module template by name'),
      start_frame: z.number().int().nonnegative().optional().describe('aerender: -s, the first frame; with end_frame, an image sequence ([####] in output) is judged whole only with every frame of the range'),
      end_frame: z.number().int().nonnegative().optional().describe('aerender: -e, the last frame'),
      timeout_minutes: z.number().positive().max(24 * 60).optional().describe(`stop the job after this many minutes (default ${DEFAULT_MINUTES})`),
    }),
    outputSchema: answer,
    execute: async (input: {
      app: NativeApp; script?: string; args?: string[]; project_file?: string; comp?: string; output?: string;
      render_settings_template?: string; output_module_template?: string; start_frame?: number; end_frame?: number; timeout_minutes?: number;
    }) => {
      const app = input.app;
      const info = NATIVE_APPS[app];
      if (!info) return { ok: false, error: `no app ${String(app)}: c4dpy, aerender or blender` };
      if ((app === 'c4dpy' || app === 'blender') && !input.script) return { ok: false, error: `${app} needs script: the .py file to run, relative to the project` };
      if (app === 'aerender' && (!input.project_file || !input.comp || !input.output)) {
        return { ok: false, error: 'aerender needs project_file (an existing .aep/.aepx), comp and output' };
      }
      let found: NativeFound | null;
      let problem: string | undefined;
      if (o.find?.[app]) found = o.find[app]!();
      else ({ found, problem } = locateNative(app));
      if (!found) return { ok: false, error: `${info.name} was not found on this machine${problem ? ` (${problem})` : ''}; nothing started`, setup: info.setup };
      const root = o.root();
      const project = o.project();
      const timeoutMs = Math.round((input.timeout_minutes ?? DEFAULT_MINUTES) * 60_000);
      let spec: NativeJobSpec;
      try {
        spec = app === 'c4dpy'
          ? c4dpyJob({ script: input.script!, args: input.args ?? [], root, project, timeoutMs, bin: found.path, ...(o.env ? { env: o.env } : {}) })
          : app === 'blender'
            ? blenderJob({ script: input.script!, args: input.args ?? [], root, project, timeoutMs, bin: found.path, ...(o.env ? { env: o.env } : {}) })
            : aerenderJob({
              projectFile: input.project_file!, comp: input.comp!, output: input.output!, root, project, timeoutMs, bin: found.path,
              ...(input.render_settings_template ? { rsTemplate: input.render_settings_template } : {}),
              ...(input.output_module_template ? { omTemplate: input.output_module_template } : {}),
              ...(input.start_frame !== undefined ? { startFrame: input.start_frame } : {}),
              ...(input.end_frame !== undefined ? { endFrame: input.end_frame } : {}),
              ...(o.env ? { env: o.env } : {}),
            });
      } catch (e) {
        return { ok: false, error: `${e instanceof Error ? e.message : String(e)}; nothing started` };
      }
      let job: JobRecord;
      try { job = o.start(spec); } catch (e) {
        return { ok: false, error: `the job did not start: ${e instanceof Error ? e.message : String(e)}` };
      }
      noteNativeStarted(spec, job);
      try { o.onStarted?.(job, spec); } catch { /* the owner's bookkeeping failing does not unstart the job */ }
      const rel = (abs: string | undefined): string | undefined => (abs && abs.startsWith(`${spec.root}/`) ? abs.slice(spec.root.length + 1) : undefined);
      return {
        ok: true, job: job.id, run: spec.native.run, state: job.state, app, label: job.label,
        ...(app === 'aerender' ? { output: rel(spec.native.output) } : { result_file: rel(spec.native.result) }),
        timeout_minutes: timeoutMs / 60_000,
        note: `Started, not finished: the job runs in the background. /jobs ${job.id} follows it; its outcome is judged when it ends, from ${app === 'aerender' ? 'the output file' : 'the script\'s result file'}, with the exit recorded beside it.`,
      };
    },
  });
  return [run];
}
