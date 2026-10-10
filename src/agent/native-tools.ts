/**
 * The agent's native app tool (R2): run_native starts Cinema 4D's c4dpy (a Python script, headless),
 * After Effects' aerender (renders an existing project) or (R3) Blender's own Python (a script, headless)
 * as a background job in the active project, through the REPL's own JobManager, and answers with the
 * job's id at once. It does not wait for the job: the turn goes on, and the job's outcome is judged when it
 * ends (src/native: the script's result file for c4dpy and Blender, the outputs for aerender; the exit is
 * recorded beside it). The operator is asked before each call
 * (the REPL's NEEDS YOU rule for run_native).
 * R4: app 'afterfx' runs a .jsx inside After Effects itself (src/native/ae-author.ts): author a new project, edit a
 * new version of one, or inspect one; After Effects opens its window. The same rule asks before each call.
 * R4 (H27): app 'openscad' exports a .scad model to a binary STL with -D parameters (src/native/openscad.ts); the
 * STL is read back by Timmy's own reader when the job is judged. The same rule asks before each call.
 * R4 (H28): app 'freecad' runs a .py with FreeCAD's freecadcmd, headless (src/native/freecad.ts); the same rule asks.
 * R4 (H63): app 'unreal' runs a .py inside the Unreal Editor through UnrealEditor-Cmd, headless, on a .uproject
 * (src/native/unreal.ts); when it is judged ok the REPL reads its saved levels back in a second Unreal process. It asks
 * every time (no "this session").
 * R4 (H64): app 'illustrator' runs a .jsx inside Adobe Illustrator through osascript (src/native/illustrator.ts): author a
 * document, edit a new version of one, or inspect one; Timmy reads the SVG export back itself. It is asked each time.
 */
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import type { JobRecord, JobSpec } from '../jobs/index.js';
import { aeScriptJob, aeToolNote, isAeJobSpec, type AeMode } from '../native/ae-author.js';
import { freecadJob, freecadToolNote, isFreecadJobSpec } from '../native/freecad.js';
import { illustratorJob, illustratorToolNote, isIllustratorJobSpec } from '../native/illustrator.js';
import { aerenderJob, blenderJob, c4dpyJob, locateNative, NATIVE_APPS, noteNativeStarted, type NativeApp, type NativeFound, type NativeJobSpec } from '../native/index.js';
import { isScadJobSpec, scadJob, scadToolNote } from '../native/openscad.js';
import { isUnrealJobSpec, unrealJob, unrealToolNote } from '../native/unreal.js';

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
      "app 'afterfx' runs an ExtendScript .jsx inside After Effects itself (its window opens): mode 'author' (script, optional name) writes a new project saved as out/ae/<name>-v<N>.aep; mode 'edit' (project_file, script) saves a new version and never writes project_file; mode 'inspect' (project_file) has After Effects read a project back (its own report, not an independent reader). Then app 'aerender' renders the saved project.",
      "app 'openscad' runs OpenSCAD headless on a read-only copy of a .scad model (model, relative to the project) and exports a binary STL to out/scad/<run>/<model>.stl; parameters (numbers, true or false, or text) become -D values over <model>.params.json beside the model; png adds a preview. It is judged by openscad's exit, the STL created by this run and OpenSCAD's ERROR lines, and the STL is read back by Timmy's own reader (triangles, bounding box, volume, area, manifold edges): dimensions of the generated mesh, never of a physical object.",
      "app 'freecad' runs a Python file with FreeCAD's freecadcmd, headless (script, relative to the project; args reach it in TIMMY_SCRIPT_ARGS); the script builds a part with FreeCAD's Part workbench, saves an editable .FCStd and exports STEP, and writes this run's own result file through workers/freecad/timmy_freecad.py, calling run_script(main) at the top level (freecadcmd imports the file as a module). What the result lists is FreeCAD's own report; the operator's /freecad readback reads the STEP back separately.",
      "app 'unreal' runs a Python file inside the Unreal Editor, headless (UnrealEditor-Cmd <project_file> -run=pythonscript through Timmy's harness, workers/unreal/timmy_unreal.py): project_file is the .uproject and script the .py, both relative to the project; args reach the script as run.args. The script defines main(run) and uses run.new_level or run.load_level, run.load_mesh, run.spawn_mesh and run.save_level; the harness writes the result file (the levels saved with their actors, the files written with sha256). What the result lists is Unreal's own report: when the run is judged ok, a second Unreal process reads each saved level back, and that readback's verdict is the check. The first run of a new project makes Unreal build its caches (slow).",
      "app 'illustrator' runs an ExtendScript .jsx inside Adobe Illustrator through osascript on macOS (its window opens; macOS may ask the operator to allow Automation): mode 'author' (script, optional name) draws on a new document saved as out/illustrator/<name>-v<N>.ai with .svg and .pdf exports (and .png when Illustrator's export allows); mode 'edit' (project_file, script) saves the next version and never writes project_file; mode 'inspect' (project_file) has Illustrator read a document back. In the script, TIMMY.document is the document. Timmy then reads the SVG export itself and compares it with Illustrator's report.",
      'The operator is asked first. Report the job id; the operator follows it with /jobs <id>. Do not claim the render or the scene is done.',
    ].join(' '),
    inputSchema: z.object({
      app: z.enum(['c4dpy', 'aerender', 'blender', 'afterfx', 'openscad', 'freecad', 'unreal', 'illustrator']).describe("'c4dpy' (Cinema 4D Python), 'aerender' (After Effects render of an existing project), 'blender' (Blender Python, headless), 'afterfx' (a .jsx inside After Effects: author, edit or inspect a project), 'openscad' (a .scad model exported to an STL, read back by Timmy), 'freecad' (FreeCAD Python through freecadcmd, headless), 'unreal' (a Python script inside the Unreal Editor, headless, its saved levels read back) or 'illustrator' (a .jsx inside Adobe Illustrator: author, edit or inspect a document)"),
      model: z.string().optional().describe('openscad: the .scad model, relative to the project'),
      parameters: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional().describe('openscad: name: value parameters (a number, true or false, or text), given to OpenSCAD as -D name=value over <model>.params.json'),
      png: z.boolean().optional().describe('openscad: also a PNG preview rendered by OpenSCAD'),
      script: z.string().optional().describe('c4dpy, blender, freecad, unreal: the .py file to run; afterfx, illustrator author, edit: the .jsx to run; relative to the project'),
      args: z.array(z.string()).optional().describe('c4dpy: arguments after the script; blender: the script\'s arguments (after --); freecad, unreal: the script\'s arguments (TIMMY_SCRIPT_ARGS)'),
      mode: z.enum(['author', 'edit', 'inspect']).optional().describe("afterfx, illustrator: 'author' (default) a new project or document, 'edit' a new version of project_file, 'inspect' read project_file back"),
      name: z.string().optional().describe('afterfx author: the new project\'s name (default: the script\'s); its versions are out/ae/<name>-v<N>.aep. illustrator author: the document\'s, out/illustrator/<name>-v<N>.ai'),
      project_file: z.string().optional().describe('aerender: the existing .aep or .aepx; afterfx edit, inspect: the .aep or .aepx (never written); illustrator edit, inspect: the .ai (never written); unreal: the .uproject; relative to the project'),
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
      mode?: AeMode; name?: string; model?: string; parameters?: Record<string, number | boolean | string>; png?: boolean;
    }) => {
      const app = input.app;
      const info = NATIVE_APPS[app];
      if (!info) return { ok: false, error: `no app ${String(app)}: c4dpy, aerender, blender, afterfx, openscad, freecad, unreal or illustrator` };
      if (app === 'openscad' && !input.model) return { ok: false, error: 'openscad needs model: the .scad file, relative to the project' };
      if ((app === 'c4dpy' || app === 'blender' || app === 'freecad' || app === 'unreal') && !input.script) return { ok: false, error: `${app} needs script: the .py file to run, relative to the project` };
      if (app === 'unreal' && !input.project_file) return { ok: false, error: 'unreal needs project_file: the .uproject Unreal opens, relative to the project' };
      if (app === 'aerender' && (!input.project_file || !input.comp || !input.output)) {
        return { ok: false, error: 'aerender needs project_file (an existing .aep/.aepx), comp and output' };
      }
      const aeMode: AeMode = input.mode ?? 'author';
      if (app === 'afterfx' && aeMode !== 'inspect' && !input.script) return { ok: false, error: `afterfx ${aeMode} needs script: the .jsx to run, relative to the project` };
      if (app === 'afterfx' && aeMode !== 'author' && !input.project_file) return { ok: false, error: `afterfx ${aeMode} needs project_file: the .aep or .aepx, relative to the project` };
      if (app === 'illustrator' && aeMode !== 'inspect' && !input.script) return { ok: false, error: `illustrator ${aeMode} needs script: the .jsx to run, relative to the project` };
      if (app === 'illustrator' && aeMode !== 'author' && !input.project_file) return { ok: false, error: `illustrator ${aeMode} needs project_file: the .ai, relative to the project` };
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
        if (app === 'openscad') {
          spec = scadJob({
            model: input.model!, params: input.parameters ?? {}, png: input.png ?? false, root, project, timeoutMs, bin: found.path, ...(o.env ? { env: o.env } : {}),
          });
        } else if (app === 'afterfx') {
          spec = aeScriptJob({
            mode: aeMode, root, project, timeoutMs, bin: found.path,
            ...(input.script ? { script: input.script } : {}), ...(input.project_file ? { projectFile: input.project_file } : {}),
            ...(input.name ? { name: input.name } : {}), ...(o.env ? { env: o.env } : {}),
          });
        } else if (app === 'illustrator') {
          spec = illustratorJob({
            mode: aeMode, root, project, timeoutMs, bin: found.path,
            ...(input.script ? { script: input.script } : {}), ...(input.project_file ? { docFile: input.project_file } : {}),
            ...(input.name ? { name: input.name } : {}), ...(o.env ? { env: o.env } : {}),
          });
        } else if (app === 'freecad') {
          spec = freecadJob({ script: input.script!, args: input.args ?? [], root, project, timeoutMs, bin: found.path, ...(o.env ? { env: o.env } : {}) });
        } else if (app === 'unreal') {
          // R4 (H63): the harness and its folder are checked too: nothing starts when Unreal cannot be given them
          spec = unrealJob({ projectFile: input.project_file!, script: input.script!, args: input.args ?? [], root, project, timeoutMs, bin: found.path, ...(o.env ? { env: o.env } : {}) });
        } else spec = app === 'c4dpy'
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
        ...(isScadJobSpec(spec)
          ? { model: spec.scad.model.rel, stl: spec.scad.stl.rel, ...(spec.scad.png ? { png: spec.scad.png.rel } : {}), defines: spec.scad.defines, ...(spec.scad.paramsFile ? { params_file: spec.scad.paramsFile.path } : {}), ...(spec.scad.notes.length ? { notes: spec.scad.notes } : {}) }
          : app === 'aerender' ? { output: rel(spec.native.output) } : { result_file: rel(spec.native.result) }),
        ...(isAeJobSpec(spec) ? { mode: spec.ae.mode, ...(spec.ae.saved ? { saved: spec.ae.saved.rel } : {}), ...(spec.ae.source ? { project_file: spec.ae.source.rel } : {}) } : {}),
        ...(isIllustratorJobSpec(spec) ? {
          mode: spec.illustrator.mode, ...(spec.illustrator.saved ? { saved: spec.illustrator.saved.rel } : {}), ...(spec.illustrator.source ? { project_file: spec.illustrator.source.rel } : {}),
          exports: [spec.illustrator.exports.svg.rel, ...(spec.illustrator.exports.pdf ? [spec.illustrator.exports.pdf.rel] : []), ...(spec.illustrator.exports.png ? [spec.illustrator.exports.png.rel] : [])],
        } : {}),
        timeout_minutes: timeoutMs / 60_000,
        ...(isFreecadJobSpec(spec) ? { copy: spec.native.copy?.path, module: spec.freecad.module } : {}),
        ...(isUnrealJobSpec(spec) ? { copy: spec.native.copy?.path, project_file: spec.unreal.project.path } : {}),
        note: isScadJobSpec(spec) ? scadToolNote(spec, job.id)
          : isAeJobSpec(spec) ? aeToolNote(spec, job.id) : isIllustratorJobSpec(spec) ? illustratorToolNote(spec, job.id) : isFreecadJobSpec(spec) ? freecadToolNote(spec, job.id)
            : isUnrealJobSpec(spec) ? unrealToolNote(spec, job.id) : `Started, not finished: the job runs in the background. /jobs ${job.id} follows it; its outcome is judged when it ends, from ${app === 'aerender' ? 'the output file' : 'the script\'s result file'}, with the exit recorded beside it.`,
      };
    },
  });
  return [run];
}
