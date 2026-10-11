#!/usr/bin/env node
// fake-unreal.mjs: a TEST DOUBLE of Unreal Engine's UnrealEditor-Cmd, for tests/native-unreal.test.ts. It is not Unreal
// Engine: it has no editor, no renderer and no real `unreal` module. It reproduces only the command line Timmy's Unreal
// jobs pass and the things they rely on it to do with it:
//   UnrealEditor-Cmd <project.uproject> -run=pythonscript -script=<file.py> -unattended -nullrhi -nosplash -nopause -stdout
//                    -FullStdOutLogOutput -DDC=InstalledNoZenLocalFallback -LocalDataCachePath=<folder> -abslog=<file>
// that is, run <file.py> as a script, here with python3 (FAKE_UNREAL_PYTHON, default python3) and the stand-in `unreal`
// module (tests/fixtures/unreal-stub, found through the job's PYTHONPATH), told which project is open
// (UNREAL_STUB_PROJECT) and that it runs as the pythonscript commandlet (UNREAL_STUB_COMMANDLET=1). Like Unreal's
// pythonscript commandlet it exits 0 when the script ran and 1 when Python did not, and prints "Python script executed
// successfully" whatever the script's own result said.
//
// R4 (H72): what Unreal Engine 5.8.2 did with the rest of that command line and its environment on the operator's Mac
// (H72's first Mac run), done here in miniature:
//   -LocalDataCachePath=<folder>  its derived-data cache there: the FAKE writes one cache file into it
//   -abslog=<file>                its log there: the FAKE writes its own lines into it
//   CFFIXED_USER_HOME             its user folders (Library/Application Support/Epic/UnrealEngine/5.8/Saved/Config/MacEditor/
//                                 EditorSettings.ini and Library/Logs/Unreal Engine/<Project>Editor/AutoSDKInfo.json) under
//                                 that home; without it, under the account's home, which here is FAKE_UNREAL_ACCOUNT_HOME
//                                 (a test's folder standing in for it; with neither the FAKE writes no user files). HOME is
//                                 ignored for them, as Unreal on macOS ignored it (the Mac run r21).
// The paths must be absolute and the cache and the log must lie in the .uproject's own Saved folder.
// FAKE_UNREAL_MODE picks what it does:
//   python     (the default) as above
//   no-result  runs nothing and exits 0 (an Unreal that ended without running the script)
//   sleep      waits 30 s, running nothing, then exits 0 (for /stop and time limits)
//   exit3      runs nothing and exits 3
// FAKE_UNREAL_READBACK=sleep makes only a readback (a run whose environment has TIMMY_READBACK_TOKEN) wait 30 s instead.
// FAKE_UNREAL_OUTSIDE_WRITE names a file (absolute) the FAKE also writes, as an Unreal writing outside the project would.
// A command line other than the one above exits 2, as a mistyped Unreal call would run no script.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FLAGS = ['-unattended', '-nullrhi', '-nosplash', '-nopause', '-stdout', '-FullStdOutLogOutput'];
const argv = process.argv.slice(2);
const mode = process.env.FAKE_UNREAL_MODE || 'python';
const project = argv[0];
const script = (argv[2] ?? '').startsWith('-script=') ? argv[2].slice('-script='.length) : undefined;
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const value = (i, name) => ((argv[i] ?? '').startsWith(`-${name}=`) ? argv[i].slice(name.length + 2) : undefined);
const said = [];
const say = (line) => { said.push(line); process.stdout.write(`${line}\n`); };
say(`LogInit: Display: fake-unreal (TEST DOUBLE): ${project ? path.basename(project) : '(no project)'} ${argv.slice(1).map((a) => (a.startsWith('-script=') ? `-script=${path.basename(a.slice(8))}` : a.includes('=') && a.includes(path.sep) ? `${a.split('=')[0]}=…` : a)).join(' ')}`);

const at = 3 + FLAGS.length;
const ddc = value(at, 'DDC');
const cache = value(at + 1, 'LocalDataCachePath');
const log = value(at + 2, 'abslog');
const saved = project ? path.join(path.dirname(project), 'Saved') : '';
const wrong = !project || !/\.uproject$/i.test(project) || !isFile(project) || argv[1] !== '-run=pythonscript' || !script
  || !path.isAbsolute(script) || /\s|"/.test(script) || !/\.py$/i.test(script) || !isFile(script)
  || argv.length !== at + 3 || FLAGS.some((f, i) => argv[3 + i] !== f)
  || ddc !== 'InstalledNoZenLocalFallback' || !cache || cache !== path.join(saved, 'DerivedDataCache') || !log || !path.isAbsolute(log) || path.dirname(log) !== path.join(saved, 'Logs');
if (wrong) {
  process.stderr.write(`fake-unreal: expected <project.uproject> -run=pythonscript -script=<absolute .py, no spaces> ${FLAGS.join(' ')} -DDC=InstalledNoZenLocalFallback -LocalDataCachePath=<the project's Saved/DerivedDataCache> -abslog=<a file in the project's Saved/Logs>\n`);
  process.exit(2);
}

// Unreal's own writes besides the script's: its cache, its user folders, then its log
mkdirSync(cache, { recursive: true });
writeFileSync(path.join(cache, 'fake-unreal-ddc.udd'), 'a TEST DOUBLE cache entry\n');
const userHome = process.env.CFFIXED_USER_HOME || process.env.FAKE_UNREAL_ACCOUNT_HOME;
if (userHome) {
  const settings = path.join(userHome, 'Library', 'Application Support', 'Epic', 'UnrealEngine', '5.8', 'Saved', 'Config', 'MacEditor');
  const logs = path.join(userHome, 'Library', 'Logs', 'Unreal Engine', `${path.basename(project, path.extname(project))}Editor`);
  mkdirSync(settings, { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(settings, 'EditorSettings.ini'), '[fake-unreal]\nTestDouble=True\n');
  writeFileSync(path.join(logs, 'AutoSDKInfo.json'), '{"fake": "TEST DOUBLE"}\n');
}
if (process.env.FAKE_UNREAL_OUTSIDE_WRITE) {
  mkdirSync(path.dirname(process.env.FAKE_UNREAL_OUTSIDE_WRITE), { recursive: true });
  writeFileSync(process.env.FAKE_UNREAL_OUTSIDE_WRITE, 'written by fake-unreal (TEST DOUBLE)\n');
}
const finish = (code) => {
  mkdirSync(path.dirname(log), { recursive: true });
  appendFileSync(log, `${said.join('\n')}\n`);
  process.exit(code);
};

if (mode === 'sleep' || (process.env.TIMMY_READBACK_TOKEN && process.env.FAKE_UNREAL_READBACK === 'sleep')) {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  finish(0);
}
if (mode === 'no-result') finish(0);
if (mode === 'exit3') finish(3);
if (mode !== 'python') {
  process.stderr.write(`fake-unreal: unknown FAKE_UNREAL_MODE ${mode}\n`);
  process.exit(2);
}
say(`LogPythonScriptCommandlet: Display: Running Python script: ${path.basename(script)}`);
// PYTHONDONTWRITEBYTECODE is the job's own (the tests set it; one test leaves it out to see what the harness writes)
const py = spawnSync(process.env.FAKE_UNREAL_PYTHON || 'python3', [script], {
  stdio: 'inherit', env: { ...process.env, UNREAL_STUB_PROJECT: path.resolve(project), UNREAL_STUB_COMMANDLET: '1' },
});
const ok = py.status === 0;
say(`LogPythonScriptCommandlet: Display: Python script executed ${ok ? 'successfully' : 'with errors'}`);
finish(ok ? 0 : 1);
