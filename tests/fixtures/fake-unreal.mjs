#!/usr/bin/env node
// fake-unreal.mjs: a TEST DOUBLE of Unreal Engine's UnrealEditor-Cmd, for tests/native-unreal.test.ts. It is not Unreal
// Engine: it has no editor, no renderer and no real `unreal` module. It reproduces only the command line Timmy's Unreal
// jobs pass and the one thing they rely on it to do with it:
//   UnrealEditor-Cmd <project.uproject> -run=pythonscript -script=<file.py> -unattended -nullrhi -nosplash -nopause -stdout -FullStdOutLogOutput
// that is, run <file.py> as a script, here with python3 (FAKE_UNREAL_PYTHON, default python3) and the stand-in `unreal`
// module (tests/fixtures/unreal-stub, found through the job's PYTHONPATH), told which project is open
// (UNREAL_STUB_PROJECT). Like Unreal's pythonscript commandlet it exits 0 when the script ran and 1 when Python did not.
// FAKE_UNREAL_MODE picks what it does:
//   python     (the default) as above
//   no-result  runs nothing and exits 0 (an Unreal that ended without running the script)
//   sleep      waits 30 s, running nothing, then exits 0 (for /stop and time limits)
//   exit3      runs nothing and exits 3
// FAKE_UNREAL_READBACK=sleep makes only a readback (a run whose environment has TIMMY_READBACK_TOKEN) wait 30 s instead.
// A command line other than the one above exits 2, as a mistyped Unreal call would run no script.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const FLAGS = ['-unattended', '-nullrhi', '-nosplash', '-nopause', '-stdout', '-FullStdOutLogOutput'];
const argv = process.argv.slice(2);
const mode = process.env.FAKE_UNREAL_MODE || 'python';
const project = argv[0];
const script = (argv[2] ?? '').startsWith('-script=') ? argv[2].slice('-script='.length) : undefined;
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
process.stdout.write(`LogInit: Display: fake-unreal (TEST DOUBLE): ${project ? path.basename(project) : '(no project)'} ${argv.slice(1).map((a) => (a.startsWith('-script=') ? `-script=${path.basename(a.slice(8))}` : a)).join(' ')}\n`);

const wrong = !project || !/\.uproject$/i.test(project) || !isFile(project) || argv[1] !== '-run=pythonscript' || !script
  || !path.isAbsolute(script) || /\s|"/.test(script) || !/\.py$/i.test(script) || !isFile(script)
  || argv.length !== 3 + FLAGS.length || FLAGS.some((f, i) => argv[3 + i] !== f);
if (wrong) {
  process.stderr.write(`fake-unreal: expected <project.uproject> -run=pythonscript -script=<absolute .py, no spaces> ${FLAGS.join(' ')}\n`);
  process.exit(2);
}
if (mode === 'sleep' || (process.env.TIMMY_READBACK_TOKEN && process.env.FAKE_UNREAL_READBACK === 'sleep')) {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  process.exit(0);
}
if (mode === 'no-result') process.exit(0);
if (mode === 'exit3') process.exit(3);
if (mode !== 'python') {
  process.stderr.write(`fake-unreal: unknown FAKE_UNREAL_MODE ${mode}\n`);
  process.exit(2);
}
process.stdout.write(`LogPythonScriptCommandlet: Display: Running Python script: ${path.basename(script)}\n`);
const py = spawnSync(process.env.FAKE_UNREAL_PYTHON || 'python3', [script], {
  stdio: 'inherit', env: { ...process.env, UNREAL_STUB_PROJECT: path.resolve(project), PYTHONDONTWRITEBYTECODE: '1' },
});
const ok = py.status === 0;
process.stdout.write(`LogPythonScriptCommandlet: Display: Python script executed ${ok ? 'successfully' : 'with errors'}\n`);
process.exit(ok ? 0 : 1);
