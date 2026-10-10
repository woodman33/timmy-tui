/**
 * Unreal Engine as a Timmy job (round R4, helper H63): the Unreal Editor's own Python, headless, as a judged native job,
 * with the rules Blender's and FreeCAD's runs follow (src/native/index.ts): a run token, the script's sha256 echoed, a
 * read-only copy of the script kept in the run's folder and run instead of the original, the outputs inventoried before
 * the run and classified after it, and a result file that decides the run, never Unreal's exit status.
 *
 * How it runs. UnrealEditor-Cmd opens the project and its pythonscript commandlet runs Timmy's harness,
 * workers/unreal/timmy_unreal.py (unrealArgs builds the command line, for both passes, in one place: UNREAL_FLAGS, then
 * unrealPlace's flags):
 *     UnrealEditor-Cmd <project.uproject> -run=pythonscript -script=<harness> -unattended -nullrhi -nosplash -nopause -stdout
 *       -FullStdOutLogOutput -DDC=InstalledNoZenLocalFallback -LocalDataCachePath=<the .uproject's folder>/Saved/DerivedDataCache
 *       -abslog=<the .uproject's folder>/Saved/Logs/Timmy-<run>.log
 * with HOME and CFFIXED_USER_HOME set to Timmy's native home when it has one (TIMMY_NATIVE_HOME). The harness runs the copy
 * of the user's script (TIMMY_SCRIPT) inside the same Python, so the script's own path never goes through Unreal's command
 * line. The harness's own folder must hold no space or quote in its path (H63 read that Unreal takes the first word of
 * -script=): when it does, nothing starts and the line says so (TIMMY_UNREAL_LIB names another folder, a copy of
 * workers/unreal). The project's own paths may hold spaces: on the Mac, Unreal quoted them itself when it rebuilt its
 * command line ("<…>/grid 22/TimmyStarter.uproject", -LocalDataCachePath="<…>/grid 22/…") and found the cache folder whole.
 *
 * What was observed on the operator's Mac (Unreal Engine 5.8.2-56702186, macOS 26.6.2), through a driver giving Unreal this
 * module's exact command line and environment, not through Timmy (R4 H72, four runs, evidence kept in the Mac's sandbox
 * folder): the commandlet route is the one that works headless. EditorActorSubsystem.spawn_actor_from_object gave no
 * actor in the commandlet ("SpawnActorFromObject. No actor was spawned.", as in the run r21), while
 * spawn_actor_from_class(StaticMeshActor) and the component's set_static_mesh gave the actor, its mesh and its bounds; so
 * the harness spawns that way. The starter then built /Game/Timmy/TimmyGrid with its 9 cubes in 15 s (the script's own
 * checks 9 of 9), a second commandlet process read it back with the same bytes and the same 9 actors (Timmy's comparison:
 * agrees, every difference 0), and run again it opened the level, replaced its own cubes and saved. The full editor
 * (-ExecutePythonScript=, which the Python plugin refuses in a commandlet and runs once the editor is ready, then quits)
 * was not run: it opens the editor and its window, and the commandlet did what was needed. With the flags and environment
 * above, Unreal kept its derived-data cache in the project ("Local: Found command line override LocalDataCachePath=…",
 * "Using data cache path …: Writable"), started no Zen, wrote its log where -abslog said, and put its user files (config,
 * UnrealBuildTool's settings, its project log folder, the trace server's store) in the sandbox home; the operator's
 * ~/Library/Application Support/Epic and ~/Library/Logs/Unreal Engine changed not at all in any of the four runs. After every
 * job Timmy checks Unreal's user folders of the account's real home for files changed during it (src/native/unreal-outside.ts)
 * and says what it found.
 *
 * What the result holds is the harness's report (Unreal's own numbers, in the process that built the level): each level
 * the script saved, with every actor in it as it was saved (class, label, location, rotation, scale and bounds), the
 * actors the script made, and every file created or changed in the watched folders (the project's Content folder and
 * out/), with sha256. Timmy then checks each file against its own inventory taken before the job started, and checks that
 * the harness that ran is the one it started (its sha256) and that the file the harness ran is the copy. The first pass
 * alone is never trusted: a second Unreal process opens each saved level and lists its actors again
 * (src/native/unreal-readback.ts), and an operation's outcome is that readback's (src/ops/outcome.ts).
 *
 * A failed run's result still names the files the harness saw written (r21: the level saved before the spawn failed); each
 * is checked against disk and recorded as written by the failed run (UnrealJudgement.failedWrites), never as an output.
 *
 * Tests: tests/native-unreal.test.ts runs the job, the harness, the starter and the readback with a FAKE UnrealEditor-Cmd
 * (tests/fixtures/fake-unreal.mjs) and a stand-in `unreal` module (tests/fixtures/unreal-stub), which reproduce what the
 * Mac runs showed (the commandlet's spawn_actor_from_object giving no actor; user files following CFFIXED_USER_HOME, never
 * HOME). Timmy itself (the REPL, `timmy act`, the receipts) has not run Unreal yet: that is the next run on the Mac.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { resolveInside } from '../project/index.js';
import type { Segment } from '../term/theme.js';
import { packagedPath } from '../utils/asset-dirs.js';
import {
  judgeNativeJob, locateNative, NATIVE_APPS, NATIVE_RUNS_DIR, NativeNotFound, nativeReceiptFields, preStates, readNativeRecord, readNativeResult,
  sha256File, writeSubmission, type FinderSeams, type NativeFileCheck, type NativeJobSpec, type NativeJudgement, type NativeMeta, type NativeVerdictLine,
} from './index.js';
import { classifyOutput, inventoryFolders, keepScript, OUT_FOLDER, readSubmittedScript, scriptEnv, stateBefore, type OutputChange } from './provenance.js';
import { checkUnrealOutsideOnce, UNREAL_OUTSIDE_SLACK_MS, unrealOutsideEnv, unrealOutsideScope, unrealOutsideWords, type UnrealOutsideCheck } from './unreal-outside.js';

type Env = Record<string, string | undefined>;
type Line = Segment[];

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const RUN_DIR = NATIVE_RUNS_DIR.split(path.sep).join('/');
const LIVE: ReadonlySet<string> = new Set(['queued', 'running', 'ready']);

/**
 * Unreal's command line after the project, in one place. What each word does, and where it was checked:
 *   -run=pythonscript     the Python Editor Script Plugin's commandlet: Epic's UE 5.8 release notes show
 *                         `UnrealEditor.exe <project> -run=pythonscript -script="<file>.py"`; Epic's "Scripting the Unreal
 *                         Editor Using Python" (5.8): it "can even run your scripts in headless mode without opening the
 *                         Editor UI" and "does not automatically load levels"
 *   -script=<file>        the Python file that commandlet runs (the same; the plugin's own PythonScriptCommandlet.cpp, read in
 *                         the installed 5.8.2 engine, takes a quoted value or the first token)
 *   -unattended           "Run in unattended mode." (Epic's UE 5.8 command-line arguments reference)
 *   -nullrhi              "Use null rendering hardware interface to run UE headless." (the same reference)
 *   -nosplash             "Disable splash screen." (the same reference)
 *   -nopause              "Close the log window automatically on exit." (a community copy of Epic's older list; not in the
 *                         part of the 5.8 reference reached)
 *   -stdout               "Use stdout for log output." (the 5.8 reference)
 *   -FullStdOutLogOutput  every log line to standard output: the 5.8 reference lists "fullstdoutlogoutputs" with no
 *                         description; on the Mac (5.8.2), with -stdout and this spelling, the whole log reached standard
 *                         output (about as many lines as the -abslog file); which of the two did that was not tested
 * unrealPlace adds -DDC=, -LocalDataCachePath= and -abslog= (see there, each with its source).
 */
export const UNREAL_FLAGS: readonly string[] = ['-unattended', '-nullrhi', '-nosplash', '-nopause', '-stdout', '-FullStdOutLogOutput'];
/**
 * UnrealEditor-Cmd's arguments: the project, the commandlet, the file it runs, the flags, then where Unreal keeps its
 * cache and its log (`place`: unrealPlace's flags). The one builder of Unreal's command line, for both passes.
 */
export const unrealArgs = (projectFile: string, script: string, place: readonly string[] = []): string[] => [projectFile, '-run=pythonscript', `-script=${script}`, ...UNREAL_FLAGS, ...place];

// ── where Unreal writes besides the project's own files (R4, H72) ───────────────

/**
 * The derived-data cache graph Timmy names (-DDC=): InstalledNoZenLocalFallback, defined by the engine itself in
 * Engine/Config/BaseEngine.ini [DerivedDataCacheGraphs] (UE 5.8.2, read on the operator's Mac): the installed engine's
 * graph, (ProjectPak, InstalledProjectPak, EnginePak=InstalledEnginePak, Local=InstalledLocal, ZenShared, Shared, Cloud),
 * without ZenLocal, so Unreal starts no zenserver and keeps no Zen data. That file's own comment: "A different graph can be
 * specified on the command line: -DDC=GraphName"; Epic's "Using Derived Data Cache in Unreal Engine" (5.8) runs the editor
 * with "-ddc=YourDDCSettings". Not overriding Zen's DataPath instead is deliberate: when Zen's default data path changes,
 * Unreal moves to the new one and deletes the old (a thread on Epic's forum, June 2026, quotes Unreal's log line "Migrating
 * default data path from '…' to '…'. Old location will be deleted.", and Epic's answer there, 2026-06-12, calls it expected),
 * which with the operator's own settings could delete the operator's own Zen data.
 */
export const UNREAL_DDC_GRAPH = 'InstalledNoZenLocalFallback';
/**
 * The derived-data cache, beside the .uproject: -LocalDataCachePath=, the Local store's CommandLineOverride in
 * BaseEngine.ini [DerivedDataCacheStores] (Local=(Type=FileSystem, ..., CommandLineOverride=LocalDataCachePath)).
 */
export const UNREAL_CACHE = 'Saved/DerivedDataCache';
/** Unreal's log, beside the .uproject: -abslog= ("ABSLOG: Absolute log filename", Epic's 5.8 command-line reference). */
export const UNREAL_LOGS = 'Saved/Logs';

/** Where one Unreal job keeps what it writes besides the project's own files: its flags, its environment, in words. */
export interface UnrealPlace {
  /** after UNREAL_FLAGS: -DDC=<graph> -LocalDataCachePath=<the cache> -abslog=<the log> */
  flags: string[];
  /** HOME and CFFIXED_USER_HOME set to Timmy's native home, when Timmy has one (TIMMY_NATIVE_HOME); else nothing */
  env: Record<string, string>;
  /** the cache folder and the log file, relative to the project, and their full paths */
  cache: string;
  log: string;
  abs: { cache: string; log: string };
  /** Unreal's user folders go to Timmy's native home (TIMMY_NATIVE_HOME), not this account's own home */
  nativeHome: boolean;
}

/**
 * Where an Unreal job (the first pass or a readback) keeps its writes, in one place: its derived-data cache in
 * <the .uproject's folder>/Saved/DerivedDataCache, no Zen (UNREAL_DDC_GRAPH), its log in <…>/Saved/Logs/<logName>, and, when
 * Timmy has a native home (TIMMY_NATIVE_HOME: a sandboxed Timmy), Unreal's user folders in that home. Unreal on macOS finds
 * its user folders (~/Library/Application Support/Epic: its user config, and the derived-data cache and Zen data by
 * default; ~/Library/Logs/Unreal Engine: its project log folder) through CoreFoundation, which ignores HOME: the Mac run
 * r21 wrote 152 files into the operator's own Library with HOME set to the sandbox. CoreFoundation honours
 * CFFIXED_USER_HOME instead (_CFCopyHomeDirURLForUser, Apple's CF sources, unless the process is setuid): on the Mac (macOS
 * 26.6.2) NSHomeDirectory and NSSearchPathForDirectoriesInDomains followed it and not HOME, and with both set (H72's Mac
 * runs, UE 5.8.2) Unreal's Paths named the sandbox home for its user, engine-user and log folders and the operator's home
 * folders changed not at all. HOME stays set too: Unreal's trace server keeps its store under HOME.
 */
export function unrealPlace(root: string, projectFile: string, logName: string, env: Env = process.env): UnrealPlace {
  const dir = path.dirname(projectFile);
  const cache = path.join(dir, ...UNREAL_CACHE.split('/'));
  const log = path.join(dir, ...UNREAL_LOGS.split('/'), logName);
  const named = env.TIMMY_NATIVE_HOME?.trim();
  const home = named ? path.resolve(named) : undefined;
  return {
    flags: [`-DDC=${UNREAL_DDC_GRAPH}`, `-LocalDataCachePath=${cache}`, `-abslog=${log}`],
    env: home ? { HOME: home, CFFIXED_USER_HOME: home } : {},
    cache: relTo(root, cache), log: relTo(root, log), abs: { cache, log }, nativeHome: Boolean(home),
  };
}

/**
 * Makes the cache's and the log's folders before Unreal starts (the Local store is configured PromptIfMissing=true:
 * Unreal warns when its folder is missing), each checked to lead inside the project; throws (nothing starts) when not.
 */
export function makeUnrealPlace(root: string, place: UnrealPlace): void {
  for (const rel of [place.cache, path.posix.dirname(place.log)]) {
    const at = resolveInside(root, rel);
    if ('error' in at) throw new Error(`Unreal's ${rel === place.cache ? 'cache folder' : 'log folder'} ${rel} does not lead inside the project (${at.error}); nothing started`);
    mkdirSync(at.path, { recursive: true });
  }
}

/** The words for where an Unreal job keeps its writes (said where it starts). */
export function unrealPlaceWords(place: { cache: string; log: string; nativeHome?: boolean; native_home?: boolean }, sep: string): string {
  const native = place.nativeHome ?? place.native_home ?? false;
  return `${place.cache} (derived data; no Zen: its local store is not used)${sep}log ${place.log}${sep}${native
    ? 'Unreal\'s user folders in Timmy\'s native home (TIMMY_NATIVE_HOME)'
    : 'Unreal\'s user folders in this account\'s own home (TIMMY_NATIVE_HOME would keep them out of it)'}`;
}

/** The harness Unreal runs, and the second pass's worker, both in workers/unreal. */
export const UNREAL_HARNESS = 'timmy_unreal.py';
export const UNREAL_READBACK_WORKER = 'unreal_readback.py';
/** The run's own Unreal record, beside job.json: the project file, its Content folder, the harness, the script's arguments. */
export const UNREAL_RECORD = 'unreal.json';
/** Who reported what the result lists. */
export const UNREAL_REPORTED_BY = "Unreal's own report of the level it saved, in the process that built it (Timmy's harness reading Unreal's numbers)";
/** What the numbers are, said with them. */
export const UNREAL_SCOPE = 'Unreal units (centimetres) and degrees of a generated scene, as Unreal reports them; never a measurement of a physical object.';
/** Said where a run is started: what the first run of a project costs. */
export const UNREAL_FIRST_RUN = 'the first run of a new project makes Unreal build its caches (slow: minutes)';
/** Why a run with no result file may have written none (said only beside such an outcome; not checked). */
export const UNREAL_NO_RESULT_HINT = "a possible cause, not checked: Unreal did not run the harness (its log in /jobs <id> says why: a plugin not enabled in the .uproject, the Python Editor Script Plugin missing, the project not opening)";

export const UNREAL_USAGE = [
  '/unreal <project.uproject> <script.py> [args]  run a Python script inside the Unreal Editor, headless, as a judged job; then a second Unreal process reads each level it saved back',
  '/unreal readback [<run>]                       read a run\'s saved levels back again in a second Unreal process and compare their actors',
];

// ── finding the program and the harness ────────────────────────────────────────

/** UnrealEditor-Cmd: TIMMY_UNREAL, then on macOS Epic's shared engines folder newest version first, then PATH. */
export const findUnreal = (env: Env = process.env, seams: FinderSeams = {}) => locateNative('unreal', env, seams).found;

/** The folder holding timmy_unreal.py and unreal_readback.py: TIMMY_UNREAL_LIB, else workers/unreal in this Timmy. */
export function unrealHelperDir(env: Env = process.env): string | undefined {
  const named = env.TIMMY_UNREAL_LIB?.trim();
  if (named) return path.resolve(named);
  const helper = packagedPath(`workers/unreal/${UNREAL_HARNESS}`, import.meta.url, { kind: 'file' });
  return helper === undefined ? undefined : path.dirname(helper);
}

const isFile = (file: string): boolean => { try { return statSync(file).isFile(); } catch { return false; } };

/** The harness and the readback worker as Unreal can be given them, or why not (and the step that fixes it). */
export function unrealWorkers(env: Env = process.env): { ok: true; lib: string; harness: string; readback: string } | { ok: false; why: string; setup: string } {
  const lib = unrealHelperDir(env);
  const where = env.TIMMY_UNREAL_LIB?.trim() ? 'the folder TIMMY_UNREAL_LIB names' : "this Timmy's workers/unreal";
  const setup = 'set TIMMY_UNREAL_LIB to a folder holding timmy_unreal.py and unreal_readback.py (a copy of workers/unreal) whose path has no space';
  if (!lib) return { ok: false, why: `Timmy's Unreal harness (workers/unreal/${UNREAL_HARNESS}) is missing from this Timmy`, setup };
  const harness = path.join(lib, UNREAL_HARNESS);
  const readback = path.join(lib, UNREAL_READBACK_WORKER);
  for (const f of [harness, readback]) if (!isFile(f)) return { ok: false, why: `${path.basename(f)} is not in ${where}`, setup };
  if (/[\s"']/.test(lib)) return { ok: false, why: `the path of ${where} has a space or a quote in it, and Unreal reads the first word of -script= as the file to run`, setup };
  return { ok: true, lib, harness, readback };
}

// ── the job ──────────────────────────────────────────────────────────────────────

export interface UnrealJobInput {
  /** the project file Unreal opens (.uproject), relative to root */
  projectFile: string;
  /** the Python file to run inside Unreal, relative to root */
  script: string;
  /** the script's own arguments: in TIMMY_SCRIPT_ARGS, a JSON list (run.args in the harness) */
  args?: string[];
  root: string;
  project: string;
  timeoutMs?: number;
  /** where the harness writes the result file, relative to root (default .timmy/native/<run>/result.json) */
  result?: string;
  /** files the result must name, or this run must write, relative to root */
  expect?: string[];
  /** the UnrealEditor-Cmd to run (default: found by locateNative('unreal'), TIMMY_UNREAL first) */
  bin?: string;
  /** added to the job's environment */
  env?: NodeJS.ProcessEnv;
  /** where the finder and the harness are looked for (default: this process's environment with `env` over it) */
  findEnv?: Env;
  seams?: FinderSeams;
  label?: string;
}

/** What an Unreal run carries beyond the native module's meta, on its spec and in its unreal.json. */
export interface UnrealRunMeta {
  /** the .uproject Unreal opens, relative to the project, with its sha256 at submission */
  project: { path: string; sha256: string };
  /** its Content folder (where a level under /Game/ is saved), relative to the project */
  content: string;
  /** the folders the harness lists before and after the script, relative to the project (Timmy inventories the same) */
  watch: string[];
  /** the harness Unreal runs: its file name and its sha256 at submission (its folder is Timmy's, outside the project) */
  harness: { file: string; sha256: string };
  /** the script's own arguments (TIMMY_SCRIPT_ARGS) */
  args: string[];
  /** Unreal's fixed flags after the -script= argument (UNREAL_FLAGS); R4 (H72): `place` says the rest */
  flags: string[];
  /**
   * R4 (H72): where this run's Unreal kept its cache and its log (relative to the project), the cache graph it was given,
   * and whether its user folders went to Timmy's native home (never that home's path). Absent in a record from before.
   */
  place?: { cache: string; log: string; ddc: string; native_home: boolean };
}
export interface UnrealJobSpec extends NativeJobSpec { unreal: UnrealRunMeta }

export function isUnrealJobSpec(spec: unknown): spec is UnrealJobSpec {
  return Boolean(spec && typeof spec === 'object' && 'unreal' in spec && 'native' in spec && (spec as { native?: { app?: unknown } }).native?.app === 'unreal');
}

function realRoot(root: string): string {
  try { return realpathSync(root); } catch { throw new Error('the project folder is gone'); }
}
function inside(root: string, rel: string): { path: string; rel: string } {
  const at = resolveInside(root, rel);
  if ('error' in at) throw new Error(at.error);
  return at;
}
/**
 * As for the other native apps, TIMMY_NATIVE_HOME names the home that holds the app's settings (a sandboxed Timmy): from
 * the job's own environment, then the finder's, then this process's. R4 (H72): HOME alone did not keep Unreal there (r21);
 * unrealPlace sets CFFIXED_USER_HOME beside it.
 */
function homeEnv(input: { env?: NodeJS.ProcessEnv; findEnv?: Env }): Env {
  const home = input.env?.TIMMY_NATIVE_HOME ?? input.findEnv?.TIMMY_NATIVE_HOME ?? process.env.TIMMY_NATIVE_HOME;
  return home ? { TIMMY_NATIVE_HOME: home } : {};
}
function findProgram(input: UnrealJobInput): string {
  if (input.bin) return input.bin;
  const { found, problem } = locateNative('unreal', input.findEnv ?? { ...process.env, ...input.env }, input.seams);
  if (!found) throw new NativeNotFound('unreal', NATIVE_APPS.unreal.setup, problem);
  return found.path;
}

/** The project's Content folder, relative to the project: beside the .uproject. */
export function contentFolder(projectRel: string): string {
  const dir = path.posix.dirname(projectRel);
  return dir === '.' ? 'Content' : `${dir}/Content`;
}

/** `/unreal <project.uproject> <script.py> [args]` in words, or what is wrong with them. */
export function parseUnrealWords(words: string[]): { projectFile: string; script: string; args: string[] } | { error: string } {
  const [first, second, ...rest] = words;
  if (!first || !/\.uproject$/i.test(first)) return { error: `Name the project file (.uproject) first, then the script. Usage: ${UNREAL_USAGE[0].split('  ')[0]}` };
  if (!second || !/\.py$/i.test(second)) return { error: `Name the Python script (.py) after ${first}: /unreal ${first} <script.py> [args]` };
  return { projectFile: first, script: second, args: rest };
}

/**
 * A task job running `UnrealEditor-Cmd <project> -run=pythonscript -script=<harness> <flags>` in the project folder. The
 * script runs as a read-only copy kept in the run's folder (.timmy/native/<run>/source/<name>.py, its sha256 checked when
 * made and when judged). Making the spec checks the project file and the harness, inventories every file under the
 * project's Content folder and out/ (what the harness lists too) and the expected outputs, keeps the copy, and writes the
 * run's job.json and unreal.json. Nothing starts when the harness cannot be given to Unreal (unrealWorkers says why).
 */
export function unrealJob(input: UnrealJobInput): UnrealJobSpec {
  const root = realRoot(input.root);
  const projectAt = inside(root, input.projectFile);
  if (!/\.uproject$/i.test(projectAt.rel)) throw new Error(`${projectAt.rel} is not an Unreal project file (.uproject)`);
  if (!isFile(projectAt.path)) throw new Error(`no project file at ${projectAt.rel}`);
  const projectSha = sha256File(projectAt.path);
  if (!projectSha) throw new Error(`${projectAt.rel} cannot be read`);
  const script = readSubmittedScript(inside(root, input.script));
  if (!/\.py$/i.test(script.rel)) throw new Error(`${script.rel} is not a Python file (.py)`);
  const args = (input.args ?? []).map((a) => String(a));
  const bin = findProgram(input);
  const workers = unrealWorkers(input.findEnv ?? { ...process.env, ...input.env });
  if (!workers.ok) throw new Error(`${workers.why}; nothing started. Setup: ${workers.setup}`);
  const harnessSha = sha256File(workers.harness);
  if (!harnessSha) throw new Error(`Timmy's Unreal harness (${UNREAL_HARNESS}) cannot be read; nothing started`);
  const run = randomUUID();
  const record = path.join(root, NATIVE_RUNS_DIR, run);
  const result = inside(root, input.result ?? `${RUN_DIR}/${run}/result.json`);
  const expect = (input.expect ?? []).map((rel) => inside(root, rel).rel);
  const content = contentFolder(projectAt.rel);
  const watch = [...new Set([content, OUT_FOLDER])];
  // R4 (H72): Unreal's cache and log beside the .uproject, no Zen, its user folders in Timmy's native home when it has one
  const place = unrealPlace(root, projectAt.path, `Timmy-${run.slice(0, 8)}.log`, homeEnv(input));
  makeUnrealPlace(root, place);
  const submittedMs = Date.now();
  const pre = preStates(root, expect);
  const inventory = inventoryFolders(root, pre, watch);
  const copy = keepScript(root, record, script);
  const unreal: UnrealRunMeta = {
    project: { path: projectAt.rel, sha256: projectSha }, content, watch, harness: { file: UNREAL_HARNESS, sha256: harnessSha }, args, flags: [...UNREAL_FLAGS],
    place: { cache: place.cache, log: place.log, ddc: UNREAL_DDC_GRAPH, native_home: place.nativeHome },
  };
  const spec: UnrealJobSpec = {
    kind: 'task', label: input.label ?? `Unreal · ${script.rel} in ${projectAt.rel}`, project: input.project, root,
    command: bin, args: unrealArgs(projectAt.path, workers.harness, place.flags),
    env: {
      ...input.env, ...place.env, TIMMY_RESULT: result.path, TIMMY_RUN: run, TIMMY_ROOT: root, TIMMY_OUT: path.join(root, OUT_FOLDER),
      ...scriptEnv(script, copy), TIMMY_SCRIPT_ARGS: JSON.stringify(args), TIMMY_UNREAL_PROJECT: projectAt.path,
      TIMMY_UNREAL_CONTENT: path.join(root, ...content.split('/')), TIMMY_UNREAL_WATCH: JSON.stringify(watch), TIMMY_UNREAL_LIB: workers.lib,
    },
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    native: {
      app: 'unreal', root, run, record, result: result.path, expect, input: { path: script.rel, sha256: script.sha256 }, copy: { path: copy.rel, sha256: copy.sha256 },
      pre, inventory, submittedMs,
    },
    unreal,
  };
  writeSubmission(spec);
  writeFileSync(path.join(record, UNREAL_RECORD), `${JSON.stringify({ record: 'timmy-unreal-run', v: 1, run, ...unreal }, null, 2)}\n`, { flag: 'wx' });
  return spec;
}

// ── what the result reports ──────────────────────────────────────────────────────

/** An actor as Unreal reported it (centimetres, degrees as [pitch, yaw, roll]): Unreal's numbers, never Timmy's measurement. */
export interface UnrealActor {
  name: string;
  label: string;
  class: string;
  class_name?: string;
  mesh?: string;
  location: number[];
  rotation: number[];
  scale: number[];
  /** origin and extent as reported; min, max and size computed here from them, never taken from the report */
  bounds: { origin: number[]; extent: number[]; min: number[]; max: number[]; size: number[] };
}
/** A level as the first pass saved it: its file and sha256 then, and its actors at that save. */
export interface UnrealLevel { asset: string; file?: string; sha256?: string; saved_at?: string; actors: UnrealActor[]; actors_total: number; malformed: number }
export interface UnrealActorRef { level?: string; name: string; label?: string }
/** Unreal's part of a run: what its result reported (Unreal's own words about its own level), and the run's own record. */
export interface UnrealReport {
  version?: string;
  harness?: { name?: string; version?: string; sha256?: string };
  /** the file the harness ran, relative to the project */
  script_ran?: string;
  project?: string;
  levels: UnrealLevel[];
  made: UnrealActorRef[];
  removed: UnrealActorRef[];
  deleted: string[];
  watched: string[];
  inputs: Record<string, string>;
  /** the script's own checks (main's returned "checks"), as it reported them */
  checks?: Array<{ label: string; passed: boolean }>;
  /** the error the harness reported (ok: false), as written */
  error?: string;
  notes: string[];
  result_file: string;
  /** from the run's own record */
  args?: string[];
}
/**
 * R4 (H72): a file the result of a failed run names, checked against disk: what the harness recorded, what is there now,
 * what the run did to it against the inventory taken before it. Written by a failed run, never an output of a successful one.
 */
export interface UnrealFailedWrite {
  path: string;
  /** the sha256 the harness recorded */
  recorded: string;
  present: boolean;
  /** Timmy's sha256 of the file now */
  sha256?: string;
  matches?: boolean;
  change?: OutputChange;
}
export interface UnrealJudgement extends NativeJudgement {
  unreal: UnrealReport;
  /** R4 (H72): the files a failed run's result names (each checked against disk); absent when it named none */
  failedWrites?: UnrealFailedWrite[];
  /** R4 (H72): what the job wrote in Unreal's user folders outside the project (unreal-outside.ts); absent while it runs */
  outside?: UnrealOutsideCheck;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(finite);
const text = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length ? v.slice(0, max) : undefined);
const relTo = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');
const round6 = (n: number): number => { const x = Math.round(n * 1e6) / 1e6; return x === 0 ? 0 : x; };
const SHA = /^[0-9a-f]{64}$/i;
/** The most actors kept per level (the harness lists at most 2000; actors_total counts them all). */
const MAX_ACTORS = 2000;

/** One actor from a report, or undefined when it lacks a name or a number Timmy compares. Bounds' min, max, size computed here. */
export function actorOf(v: unknown): UnrealActor | undefined {
  const a = obj(v);
  const b = obj(a?.bounds);
  const name = text(a?.name, 300);
  if (!a || !b || !name || !triple(a.location) || !triple(a.rotation) || !triple(a.scale) || !triple(b.origin) || !triple(b.extent)) return undefined;
  const origin = [...b.origin];
  const extent = [...b.extent];
  return {
    name, label: text(a.label, 300) ?? '', class: text(a.class, 300) ?? '', ...(text(a.class_name, 120) ? { class_name: text(a.class_name, 120) } : {}),
    ...(text(a.mesh, 300) ? { mesh: text(a.mesh, 300) } : {}),
    location: [...a.location], rotation: [...a.rotation], scale: [...a.scale],
    bounds: { origin, extent, min: origin.map((o, i) => round6(o - extent[i])), max: origin.map((o, i) => round6(o + extent[i])), size: extent.map((e) => round6(2 * e)) },
  };
}

function refs(v: unknown): UnrealActorRef[] {
  return Array.isArray(v) ? v.slice(0, MAX_ACTORS).flatMap((x) => {
    const o = obj(x);
    const name = text(o?.name, 300);
    return o && name ? [{ name, ...(text(o.level, 300) ? { level: text(o.level, 300) } : {}), ...(text(o.label, 300) ? { label: text(o.label, 300) } : {}) }] : [];
  }) : [];
}

/** A name the result gave, as the project knows it: relative and inside it, or "(outside the project) <name>"; never a full path. */
function projectName(root: string, v: unknown): string | undefined {
  const s = text(v, 400);
  if (!s) return undefined;
  if (!path.isAbsolute(s)) return s.split(path.sep).join('/');
  const rel = path.relative(root, s);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : `(outside the project) ${path.basename(s)}`;
}

/** The Unreal part of a result file (parsed JSON), defensively: names capped, numbers finite, paths relative to the project. */
export function unrealReport(r: Record<string, unknown> | undefined, o: { root: string; resultFile: string; run?: UnrealRunMeta }): UnrealReport {
  const levels = Array.isArray(r?.levels) ? r.levels.slice(0, 50).flatMap((v): UnrealLevel[] => {
    const l = obj(v);
    const asset = text(l?.asset, 300);
    if (!l || !asset) return [];
    const listed = Array.isArray(l.actors) ? l.actors.slice(0, MAX_ACTORS) : [];
    const actors = listed.map(actorOf).filter((a): a is UnrealActor => !!a);
    const file = projectName(o.root, l.file);
    const total = finite(l.actors_total) && Number.isInteger(l.actors_total) && l.actors_total >= listed.length ? l.actors_total : listed.length;
    return [{
      asset, ...(file ? { file } : {}), ...(typeof l.sha256 === 'string' && SHA.test(l.sha256) ? { sha256: l.sha256.toLowerCase() } : {}),
      ...(text(l.saved_at, 40) ? { saved_at: text(l.saved_at, 40) } : {}), actors, actors_total: total, malformed: listed.length - actors.length,
    }];
  }) : [];
  const h = obj(r?.harness);
  const returned = obj(r?.returned);
  const checks = Array.isArray(returned?.checks) ? returned.checks.slice(0, 400).flatMap((v) => {
    const x = obj(v);
    return x && text(x.label) && typeof x.passed === 'boolean' ? [{ label: text(x.label)!, passed: x.passed }] : [];
  }) : undefined;
  const inputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(r?.inputs) ?? {}).slice(0, 50)) if (typeof v === 'string' && SHA.test(v)) inputs[projectName(o.root, k) ?? k] = v.toLowerCase();
  const ran = projectName(o.root, r?.script_ran);
  return {
    ...(text(r?.unreal_version, 120) ? { version: text(r?.unreal_version, 120) } : {}),
    ...(h ? { harness: { ...(text(h.name, 60) ? { name: text(h.name, 60) } : {}), ...(text(h.version, 30) ? { version: text(h.version, 30) } : {}), ...(typeof h.sha256 === 'string' && SHA.test(h.sha256) ? { sha256: h.sha256.toLowerCase() } : {}) } } : {}),
    ...(ran ? { script_ran: ran } : {}),
    ...(projectName(o.root, r?.project) ? { project: projectName(o.root, r?.project) } : {}),
    levels, made: refs(r?.actors_made), removed: refs(r?.removed),
    deleted: Array.isArray(r?.deleted) ? r.deleted.slice(0, 200).flatMap((d) => { const n = projectName(o.root, d); return n ? [n] : []; }) : [],
    watched: Array.isArray(r?.watched) ? r.watched.slice(0, 10).flatMap((d) => { const n = projectName(o.root, d); return n ? [n] : []; }) : [],
    inputs,
    ...(checks && checks.length ? { checks } : {}),
    ...(r?.ok === false && text(r.error, 2000) ? { error: text(r.error, 2000) } : {}),
    notes: Array.isArray(r?.notes) ? r.notes.slice(0, 20).flatMap((n) => (text(n, 500) ? [text(n, 500)!] : [])) : [],
    result_file: o.resultFile,
    ...(o.run ? { args: [...o.run.args] } : {}),
  };
}

// ── judging a run ────────────────────────────────────────────────────────────────

/** R4 (H72): a verdict line of an Unreal run, with the files a failed run's result named and the outside check. */
export interface UnrealVerdictLine extends NativeVerdictLine { failed_writes?: UnrealFailedWrite[]; outside?: UnrealOutsideCheck }

/** The run's verdicts so far (a torn line is skipped, never repaired). */
function readVerdictLines(dir: string): UnrealVerdictLine[] {
  try {
    return readFileSync(path.join(dir, 'verdicts.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => {
      try { return [JSON.parse(l) as UnrealVerdictLine]; } catch { return []; }
    });
  } catch { return []; }
}

/** Appends the final judgement to the run's verdicts.jsonl, unless its last line already says the same. */
function appendVerdict(dir: string | undefined, j: UnrealJudgement, jobId?: string): void {
  if (!dir) return;
  const file = path.join(dir, 'verdicts.jsonl');
  try {
    const last = readVerdictLines(dir).at(-1);
    if (last && last.outcome === j.outcome && last.why === j.why && last.job === jobId) return;
    const line: UnrealVerdictLine = {
      judged_at: new Date().toISOString(), ...(jobId ? { job: jobId } : {}), outcome: j.outcome, why: j.why, exit: j.exit, files: j.files,
      ...(j.checked ? { checked: j.checked } : {}), ...(j.source ? { source: j.source } : {}),
      ...(j.failedWrites ? { failed_writes: j.failedWrites } : {}), ...(j.outside ? { outside: j.outside } : {}),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch { /* the judgement stands without its record */ }
}

/**
 * R4 (H72): the files a failed run's result names (the harness lists every file created or changed in the watched folders,
 * whether the script ended well or not), each checked against disk: inside the project, its sha256 now against the one
 * recorded, and what the run did to it against the inventory taken before it. A name outside the project is not kept.
 */
export function unrealFailedWrites(spec: UnrealJobSpec, files: Record<string, unknown>, sinceMs: number): UnrealFailedWrite[] {
  const out: UnrealFailedWrite[] = [];
  for (const [name, hash] of Object.entries(files).slice(0, 200)) {
    if (typeof hash !== 'string' || !SHA.test(hash)) continue;
    const at = resolveInside(spec.root, name);
    if ('error' in at) continue;
    const c = classifyOutput(at.path, stateBefore(at.rel, spec.native.pre, spec.native.inventory), sinceMs);
    const recorded = hash.toLowerCase();
    out.push({ path: at.rel, recorded, present: c.present, ...(c.sha256 ? { sha256: c.sha256 } : {}), ...(c.present ? { matches: c.sha256 === recorded } : {}), change: c.change });
  }
  return out;
}

/** "written by this failed run: Content/Timmy/TimmyGrid.umap (created; sha256 881f123e…)", or '' when it named none. */
export function failedWritesWords(ws: UnrealFailedWrite[] | undefined): string {
  if (!ws?.length) return '';
  const one = (f: UnrealFailedWrite): string => {
    const did = f.change === 'created' || f.change === 'changed' ? `${f.change}; ` : f.change === 'reused' ? 'the same bytes as before this run; ' : '';
    const now = !f.present ? '; not there now' : f.matches ? '' : `; ${short(f.sha256)} now`;
    return `${f.path} (${did}sha256 ${short(f.recorded)}${now})`;
  };
  return `written by this failed run: ${ws.slice(0, 6).map(one).join(', ')}${ws.length > 6 ? ` and ${ws.length - 6} more` : ''}`;
}

const short = (sha: string | undefined): string => (sha ? `${sha.slice(0, 12)}…` : 'none');

/**
 * Why a run the native rules judge ok is still not known to be what Timmy started, or undefined: the harness that ran must
 * be the one started (its sha256), the file it ran must be the copy kept at submission, and each saved level's file must
 * be named among the files written with the sha256 it had at its save.
 */
function unrealDoubt(report: UnrealReport, spec: UnrealJobSpec, files: NativeFileCheck[], recorded: Record<string, unknown>): string | undefined {
  const harness = report.harness?.sha256;
  if (!harness) return 'the result says ok, but does not say which harness ran it (its sha256)';
  if (harness !== spec.unreal.harness.sha256) return `the result says ok, but the harness that ran (sha256 ${short(harness)}) is not the one Timmy started (sha256 ${short(spec.unreal.harness.sha256)})`;
  const copy = spec.native.copy?.path;
  if (!report.script_ran) return `the result says ok, but does not say which file the harness ran (script_ran), so it cannot be bound to the copy kept at submission (${copy ?? 'the copy'})`;
  if (copy && report.script_ran !== copy) return `the result says ok, but the harness ran ${report.script_ran}, not the copy kept at submission (${copy})`;
  for (const l of report.levels) {
    if (!l.file || !l.sha256) return `the result says ok and reports ${l.asset} saved, but without its file and that file's sha256`;
    const named = recorded[l.file];
    if (typeof named !== 'string') return `the result says ok and reports ${l.asset} saved in ${l.file}, but its files do not name ${l.file}: the harness did not see it written`;
    if (named.toLowerCase() !== l.sha256) return `${l.file} changed after ${l.asset} was last saved (sha256 at that save ${short(l.sha256)}, at the end ${short(named)}): what the first pass reported is not what the file holds`;
    if (!files.find((f) => f.path === l.file)?.written) return `${l.file} was not shown to be made by this run`;
    if (l.malformed) return `the result reports ${l.malformed} actor${l.malformed === 1 ? '' : 's'} of ${l.asset} without the numbers Timmy compares`;
  }
  return undefined;
}

/**
 * A finished Unreal run, judged: first by the native module's rules (judgeNativeJob, not let to record: the result is this
 * run's, echoes the script's sha256 as submitted, the copy that ran still holds those bytes and the harness read them; it
 * says ok; every file it names is in the project, with a sha256 matching the file now, made by this run), then by the
 * harness's own binding (unrealDoubt): an ok whose harness, file run or level files do not agree is unknown. The final
 * judgement alone is appended to the run's verdicts.jsonl. A job still going is judged unknown and not recorded.
 */
export function judgeUnrealJob(job: JobRecord, spec: UnrealJobSpec): UnrealJudgement {
  const base = judgeNativeJob(job, { ...spec.native, record: undefined });
  const read = spec.native.result ? readNativeResult(spec.native.result) : { state: 'missing' as const };
  const r = read.state === 'read' ? obj(read.data) : undefined;
  const report = unrealReport(r, { root: spec.root, resultFile: relTo(spec.root, spec.native.result ?? ''), run: spec.unreal });
  if (!job.stale && LIVE.has(job.state)) return { ...base, unreal: report };
  let outcome = base.outcome;
  let why = base.why;
  if (outcome === 'ok') {
    const doubt = unrealDoubt(report, spec, base.files, obj(r?.files) ?? {});
    if (doubt) { outcome = 'unknown'; why = `${doubt}; ${why}`; }
  }
  if (read.state === 'missing' && outcome !== 'ok') why = `${why}; ${UNREAL_NO_RESULT_HINT.replace('<id>', job.id)}`;
  // R4 (H72): a failed run's result still names what the harness saw written (r21: the level saved before the spawn
  // failed); each is checked against disk and recorded as written by a failed run, never as an output (base.files stays).
  const startedMs = Date.parse(job.startedAt);
  const sinceMs = spec.native.submittedMs ?? startedMs;
  const named = r?.ok === false && r.run === spec.native.run ? obj(r.files) : undefined;
  const failedWrites = named && Object.keys(named).length ? unrealFailedWrites(spec, named, Number.isNaN(sinceMs) ? 0 : sinceMs) : undefined;
  if (failedWrites?.length) why = `${why}; ${failedWritesWords(failedWrites)}`;
  const outside = unrealOutsideOf(job, spec);
  if (outside) why = `${why}; ${unrealOutsideWords(outside, { nativeHome: spec.unreal.place?.native_home ?? false })}`;
  const j: UnrealJudgement = { ...base, outcome, why, unreal: report, ...(failedWrites?.length ? { failedWrites } : {}), ...(outside ? { outside } : {}) };
  appendVerdict(spec.native.record, j, job.id);
  return j;
}

/**
 * R4 (H72): the job's outside check (unreal-outside.ts), once per job: in the window from the job's start to its end (+ a
 * few seconds), when both are known. A job judged again after a restart reuses the check its verdict line kept for the same
 * job; with no exit recorded (a stale job) and none kept, it is not checked again (a later window would count others' writes).
 */
function unrealOutsideOf(job: JobRecord, spec: UnrealJobSpec): UnrealOutsideCheck | undefined {
  const sinceMs = Date.parse(job.startedAt);
  if (Number.isNaN(sinceMs)) return undefined;
  if (spec.native.record) {
    const kept = readVerdictLines(spec.native.record).filter((l) => l.job === job.id && l.outside).at(-1)?.outside;
    if (kept) return kept;
  }
  const endedMs = job.endedAt ? Date.parse(job.endedAt) : Number.NaN;
  if (job.stale || Number.isNaN(endedMs)) return undefined;
  return checkUnrealOutsideOnce(`${spec.native.run}:${job.id}`, { sinceMs, untilMs: endedMs + UNREAL_OUTSIDE_SLACK_MS, env: unrealOutsideEnv(spec.env) });
}

/** A run's spec rebuilt from its folder (job.json and unreal.json), every name in them checked to lead inside the project. */
export function unrealSpecFromRecord(root: string, run: string): UnrealJobSpec {
  const base = realRoot(root);
  const rec = readNativeRecord(base, run);
  if (!rec || rec.job.app !== 'unreal') throw new Error(`no record of an Unreal run ${run} in this project`);
  let meta: UnrealRunMeta;
  try {
    const u = JSON.parse(readFileSync(path.join(rec.dir, UNREAL_RECORD), 'utf8')) as Record<string, unknown>;
    const p = obj(u.project);
    const h = obj(u.harness);
    if (u.record !== 'timmy-unreal-run' || u.run !== run || !p || typeof p.path !== 'string' || typeof p.sha256 !== 'string' || typeof u.content !== 'string'
      || !h || typeof h.sha256 !== 'string' || !Array.isArray(u.watch) || !Array.isArray(u.args)) throw new Error('malformed');
    const pl = obj(u.place);
    meta = {
      project: { path: p.path, sha256: p.sha256 }, content: u.content, watch: u.watch.map(String), harness: { file: String(h.file ?? UNREAL_HARNESS), sha256: h.sha256 },
      args: u.args.map(String), flags: Array.isArray(u.flags) ? u.flags.map(String) : [...UNREAL_FLAGS],
      ...(pl && typeof pl.cache === 'string' && typeof pl.log === 'string' && typeof pl.ddc === 'string' && typeof pl.native_home === 'boolean'
        ? { place: { cache: pl.cache, log: pl.log, ddc: pl.ddc, native_home: pl.native_home } } : {}),
    };
  } catch { throw new Error(`the record of run ${run} has no Unreal part (${UNREAL_RECORD})`); }
  const within = (rel: string): string => {
    const at = resolveInside(base, rel);
    if ('error' in at) throw new Error(`the record of run ${run} names ${rel}, which does not lead inside the project: ${at.error}`);
    return at.path;
  };
  within(meta.project.path);
  within(meta.content);
  const j = rec.job;
  const expect = Array.isArray(j.expect) ? j.expect.filter((n): n is string => typeof n === 'string') : [];
  for (const n of expect) within(n);
  if (j.input) within(j.input.path);
  const copy = j.copy && typeof j.copy.path === 'string' && typeof j.copy.sha256 === 'string' ? { path: j.copy.path, sha256: j.copy.sha256 } : undefined;
  if (copy) within(copy.path);
  const inventory = j.inventory && Array.isArray(j.inventory.folders) && j.inventory.folders.every((f) => typeof f === 'string') ? j.inventory : undefined;
  const native: NativeMeta = {
    app: 'unreal', root: base, run, record: rec.dir, expect, pre: j.pre ?? {}, submittedMs: Date.parse(j.started_at),
    ...(j.result ? { result: within(j.result) } : {}), ...(j.input ? { input: j.input } : {}), ...(copy ? { copy } : {}), ...(inventory ? { inventory } : {}),
  };
  return { kind: 'task', label: j.label, project: j.project, root: base, command: j.program, args: j.args, timeoutMs: j.timeout_ms, native, unreal: meta };
}

/**
 * Judges an Unreal run again from its folder after a restart: with the job's record when the caller has it (`job`, or
 * `findJob` given the id its started.json names), else as a run whose exit was not recorded, which never decides.
 */
export function reconcileUnreal(root: string, run: string, opts: { job?: JobRecord; findJob?: (id: string) => JobRecord | undefined } = {}): UnrealJudgement {
  const spec = unrealSpecFromRecord(root, run);
  const rec = readNativeRecord(spec.root, run);
  const found = opts.job ?? (rec?.started && opts.findJob ? opts.findJob(rec.started.job) : undefined);
  const job: JobRecord = found ?? {
    id: rec?.started?.job ?? 'j000000', kind: 'task', label: spec.label, project: spec.project, root: spec.root, command: spec.command, args: spec.args,
    state: 'running', startedAt: rec?.job.started_at ?? new Date(0).toISOString(), steps: [], logPath: '', lines: 0, stale: true,
  };
  return judgeUnrealJob(job, spec);
}

/** A judgement as a receipt carries it: the native fields (app unreal) and Unreal's report, project-relative names only. */
export function unrealReceiptFields(j: UnrealJudgement): ReturnType<typeof nativeReceiptFields> & { native: { unreal: Record<string, unknown>; unreal_version?: string } } {
  const base = nativeReceiptFields('unreal', j);
  const u = j.unreal;
  const passed = u.checks?.filter((c) => c.passed).length ?? 0;
  return {
    ...base,
    native: {
      ...base.native,
      ...(u.version ? { unreal_version: u.version } : {}),
      unreal: {
        ...(u.harness ? { harness: { ...u.harness } } : {}), ...(u.script_ran ? { script_ran: u.script_ran } : {}), ...(u.project ? { project: u.project } : {}),
        ...(u.args ? { args: u.args.slice(0, 40) } : {}),
        levels: u.levels.map((l) => ({ asset: l.asset, ...(l.file ? { file: l.file } : {}), ...(l.sha256 ? { sha256: l.sha256 } : {}), actors: l.actors_total })),
        actors_made: u.made.length, removed: u.removed.length, ...(u.deleted.length ? { deleted: u.deleted.slice(0, 50) } : {}), inputs: { ...u.inputs },
        ...(u.checks ? { checks: { passed, of: u.checks.length } } : {}),
        // R4 (H72): what a failed run's result named, checked against disk: written by a failed run, never its outputs
        ...(j.failedWrites?.length ? { failed_run_writes: j.failedWrites.map((f) => ({ ...f })) } : {}),
        // R4 (H72): what the job wrote in Unreal's user folders outside the project (names relative to the account's home)
        ...(j.outside ? { outside: { ...j.outside, by_folder: { ...j.outside.by_folder }, names: [...j.outside.names], folders: [...j.outside.folders] } } : {}),
        reported_by: UNREAL_REPORTED_BY, units: 'Unreal units (centimetres), degrees', scope: UNREAL_SCOPE,
        // DOCTRINE §15: Unreal's numbers of a generated scene, constructed by the run; only the readback's agreement checks them.
        geometry: { provenance: 'generated', evidence: 'constructed' },
      },
    },
  };
}

// ── what the REPL and the agent are told ─────────────────────────────────────────

const size = (n: number | undefined): string => (n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
/** A number of centimetres in a few characters: up to 3 decimals, no trailing zeros. */
export const cm = (n: number): string => String(Math.round(n * 1000) / 1000);
const triplet = (v: number[]): string => `(${v.map(cm).join(', ')})`;

/** A level's actors in a few words: "9 actors (9 StaticMeshActor)". */
export function actorsWords(l: UnrealLevel): string {
  const byClass = new Map<string, number>();
  for (const a of l.actors) { const k = a.class_name ?? a.class.split('.').pop() ?? a.class; byClass.set(k, (byClass.get(k) ?? 0) + 1); }
  const classes = [...byClass].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${n} ${k}`).join(', ');
  const more = l.actors_total > l.actors.length ? `, ${l.actors.length} of them listed` : '';
  return `${l.actors_total} actor${l.actors_total === 1 ? '' : 's'}${classes ? ` (${classes}${more})` : ''}`;
}

/** An actor in a few words: "TimmyCube_0_0 (StaticMeshActor_0): bounds 100 x 100 x 100 cm, centred at (0, 0, 50)". */
export function actorWords(a: UnrealActor): string {
  return `${a.label || a.name}${a.label && a.label !== a.name ? ` (${a.name})` : ''}: bounds ${a.bounds.size.map(cm).join(' x ')} cm, centred at ${triplet(a.bounds.origin)}`;
}

/** Said before the run: how Unreal runs the copy, the arguments, and what a first run costs. */
export function unrealStartLines(spec: UnrealJobSpec, sep: string): Line[] {
  const u = spec.unreal;
  return [
    [{ text: '  App        ', role: 'secondary' }, { text: `UnrealEditor-Cmd, headless${sep}it opens ${u.project.path} and runs Timmy's harness, which runs ${spec.native.copy?.path ?? 'a copy of the script'}, a read-only copy of ${spec.native.input?.path ?? 'the script'}` }],
    // R4 (H72): where Unreal keeps its cache, its log and its user folders, said before it starts
    ...(u.place ? [[{ text: '  Caches     ', role: 'secondary' }, { text: unrealPlaceWords(u.place, sep), role: 'secondary' }] as Line] : []),
    [{ text: '  Note       ', role: 'secondary' }, { text: `${UNREAL_FIRST_RUN}${sep}the result file decides the run; then a second Unreal process reads each level it saved back${sep}arguments: ${u.args.length ? `${u.args.length} in TIMMY_SCRIPT_ARGS` : 'none'}`, role: 'secondary' }],
  ];
}

/** R4 (H72): the lines for the files a failed run left and for what the job wrote outside the project. */
export function unrealLeftLines(j: { failedWrites?: UnrealFailedWrite[]; outside?: UnrealOutsideCheck }, o: { root: string; sep: string; nativeHome: boolean }): Line[] {
  const lines: Line[] = [];
  for (const f of (j.failedWrites ?? []).slice(0, 12)) {
    let bytes: number | undefined;
    try { bytes = statSync(path.join(o.root, f.path)).size; } catch { bytes = undefined; }
    const did = f.change === 'created' || f.change === 'changed' ? `written by this failed run (${f.change})` : f.change === 'reused' ? 'named by the failed run, with the same bytes as before it' : 'named by the failed run';
    const state = !f.present ? `${o.sep}not there now (the harness recorded sha256 ${short(f.recorded)})`
      : `${o.sep}sha256 ${short(f.sha256)} (Timmy's, after the run${f.matches ? ', as the harness recorded it' : `; the harness recorded ${short(f.recorded)}`})${bytes !== undefined ? `${o.sep}${size(bytes)}` : ''}`;
    lines.push([{ text: '      left     ', role: 'secondary' }, { text: f.path }, { text: `${o.sep}${did}${state}${o.sep}not an output: the run failed`, role: 'secondary' }]);
  }
  if (j.outside) {
    const c = j.outside;
    const scope = unrealOutsideScope(c);
    lines.push([{ text: '      outside  ', role: 'secondary' }, { text: unrealOutsideWords(c, { nativeHome: o.nativeHome }), role: c.files ? 'estimate' : undefined },
      { text: `${scope ? `${o.sep}${scope}` : ''}`, role: 'secondary' }]);
    if (c.files && c.names.length) lines.push([{ text: '               ', role: 'secondary' }, { text: `${c.names.slice(0, 5).join(', ')}${c.files > 5 ? ` and ${c.files - 5} more` : ''}`, role: 'secondary' }]);
  }
  return lines;
}

/**
 * Said when the first pass ends: the outcome, each file the result names with Timmy's sha256 and what the run did to it,
 * Unreal's report of each level it saved (labelled as Unreal's own, with what its numbers are), the script's own checks,
 * and what follows (the readback's start, or why there is none: `next`).
 */
export function unrealEndLines(j: UnrealJudgement, spec: UnrealJobSpec, o: {
  id: string; label: string; glyphs: { ok: string; fail: string }; sep: string; scrub: (s: string) => string; receipt?: string;
}): Line[] {
  const u = j.unreal;
  const mark = j.outcome === 'ok' ? o.glyphs.ok : j.outcome === 'failed' ? o.glyphs.fail : '?';
  const lines: Line[] = [[
    { text: `  ${mark} `, role: j.outcome === 'failed' ? 'failure' : undefined },
    { text: `${o.id} ${j.outcome}`, role: j.outcome === 'failed' ? 'failure' : 'strong' },
    { text: `  ${o.label}: ${o.scrub(j.why)}${o.receipt ? `${o.sep}receipt ${o.receipt}` : ''}${o.sep}/results`, role: 'secondary' },
  ]];
  for (const file of j.files.filter((x): x is NativeFileCheck & { recorded: string } => x.recorded !== undefined).slice(0, 12)) {
    const word = /\.umap$/i.test(file.path) ? 'saved    ' : 'wrote    ';
    let bytes: number | undefined;
    try { bytes = statSync(path.join(spec.root, file.path)).size; } catch { bytes = undefined; }
    const did = file.written ? `${file.change ?? 'written'} by this run` : `not made by this run (${file.change ?? 'not shown'})`;
    const how = !file.present ? 'not there' : `${did}${o.sep}sha256 ${short(file.sha256)} (Timmy's, after the run)${bytes !== undefined ? `${o.sep}${size(bytes)}` : ''}`;
    lines.push([{ text: `      ${word}`, role: 'secondary' }, { text: `${file.path}${o.sep}${how}`, role: file.present && file.written ? undefined : 'failure' }]);
  }
  if (u.deleted.length) lines.push([{ text: '      deleted  ', role: 'secondary' }, { text: `${u.deleted.slice(0, 6).join(', ')}${u.deleted.length > 6 ? ` and ${u.deleted.length - 6} more` : ''}${o.sep}there before the script and gone after it`, role: 'failure' }]);
  for (const l of u.levels.slice(0, 4)) {
    lines.push([{ text: '      reported ', role: 'secondary' }, { text: `${l.asset}: ` }, { text: actorsWords(l), role: 'strong' },
      { text: `${o.sep}Unreal ${u.version ?? '(version not reported)'}: ${UNREAL_REPORTED_BY}`, role: 'secondary' }]);
    for (const a of l.actors.slice(0, 3)) lines.push([{ text: '               ', role: 'secondary' }, { text: actorWords(a), role: 'secondary' }]);
    if (l.actors.length > 3) lines.push([{ text: `               and ${l.actors_total - 3} more${o.sep}${UNREAL_SCOPE}`, role: 'secondary' }]);
  }
  if (u.made.length || u.removed.length) {
    lines.push([{ text: '      script   ', role: 'secondary' }, { text: `made ${u.made.length} actor${u.made.length === 1 ? '' : 's'}${u.removed.length ? `, removed ${u.removed.length}` : ''}${Object.keys(u.inputs).length ? `${o.sep}read ${Object.keys(u.inputs).join(', ')} (sha256 recorded)` : ''}`, role: 'secondary' }]);
  }
  if (u.checks) {
    const passed = u.checks.filter((c) => c.passed).length;
    const failing = u.checks.filter((c) => !c.passed).map((c) => c.label).slice(0, 4);
    lines.push([{ text: '      checks   ', role: 'secondary' }, { text: `the script's own: ${passed} of ${u.checks.length} passed${failing.length ? ` (failed: ${o.scrub(failing.join('; '))})` : ''}${o.sep}Unreal's numbers against the script's own expectations`, role: failing.length ? 'failure' : 'secondary' }]);
  }
  for (const n of u.notes.slice(0, 3)) lines.push([{ text: '      note     ', role: 'secondary' }, { text: o.scrub(n), role: 'secondary' }]);
  lines.push(...unrealLeftLines(j, { root: spec.root, sep: o.sep, nativeHome: spec.unreal.place?.native_home ?? false }));
  if (u.error) {
    lines.push([{ text: '      error    ', role: 'secondary' }, { text: `${o.scrub(u.error)}${o.sep}${u.result_file}${o.sep}/jobs ${o.id} for Unreal's own log`, role: 'failure' }]);
  } else if (j.outcome !== 'ok') {
    lines.push([{ text: '      look     ', role: 'secondary' }, { text: `${u.result_file}${o.sep}/jobs ${o.id} for Unreal's own log`, role: 'secondary' }]);
  }
  return lines;
}

/** The agent's note on a started run. */
export function unrealToolNote(spec: UnrealJobSpec, jobId: string): string {
  return [
    `Started, not finished: UnrealEditor-Cmd opens ${spec.unreal.project.path} headless and runs Timmy's harness, which runs ${spec.native.copy?.path ?? 'a copy of the script'} (a read-only copy of ${spec.native.input?.path}); /jobs ${jobId} follows it.`,
    `It is judged when it ends, by the harness's result file (${relTo(spec.root, spec.native.result ?? '')}); ${UNREAL_FIRST_RUN}.`,
    'The script defines main(run): run.new_level or run.load_level, run.load_mesh, run.spawn_mesh, run.save_level (workers/unreal/timmy_unreal.py). Its arguments are in run.args.',
    'Do not claim the level is made until the job is judged ok, and do not trust that alone: what the result lists is Unreal\'s own report. A second Unreal process then reads each saved level back, and its verdict (agrees or differs) is the check.',
    `Unreal keeps its cache and its log in ${spec.unreal.place ? `${spec.unreal.place.cache} and ${spec.unreal.place.log}` : 'the project\'s Saved folder'}; each verdict says whether files changed during the job in the folders Unreal keeps in this account's home, by their timestamps (not which process changed them, and no other folder): report that as said.`,
  ].join(' ');
}
