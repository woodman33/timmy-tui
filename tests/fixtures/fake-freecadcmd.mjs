#!/usr/bin/env node
// fake-freecadcmd.mjs: a TEST DOUBLE of FreeCAD's freecadcmd, for tests/native-freecad.test.ts. It is not FreeCAD: it
// has no FreeCAD in it and builds no geometry. It reproduces the command line Timmy uses (freecadcmd <one .py file>)
// and how freecadcmd handles a .py file given to it, as FreeCAD's source reads (App::Application::processFiles; not
// observed against a real FreeCAD here): the file's folder is appended to sys.path and the file is IMPORTED as a module
// named after it; when that import raises, the file is run again in __main__; an error is printed, and the program
// exits 0 either way (a SystemExit ends it with its code). It runs Python 3 (FAKE_FREECAD_PYTHON, default python3); the
// stand-in FreeCAD and Part modules (tests/fixtures/freecad-stub) come from the job's PYTHONPATH.
// FAKE_FREECAD_MODE picks what it does:
//   python      (the default) the above; the current folder is NOT on sys.path (FreeCAD's own path starts with its own
//               folders)
//   python-cwd  the above with the current folder (the project) first on sys.path, so a file there with the module's
//               name is imported instead of the file given
//   no-result   runs nothing, exits 0
//   crash       runs nothing, exits 134 as a crashed program would
// A command line that is not one .py file exits 2.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_FREECAD_MODE || 'python';
process.stdout.write(`fake-freecadcmd: ${argv.map((a) => path.basename(a)).join(' ')}\n`);
if (argv.length !== 1 || !/\.py$/i.test(argv[0])) {
  process.stderr.write('fake-freecadcmd: expected exactly one .py file: Timmy runs freecadcmd <copy>\n');
  process.exit(2);
}
if (mode === 'no-result') process.exit(0);
if (mode === 'crash') {
  process.stderr.write('fake-freecadcmd: a crash (a test double)\n');
  process.exit(134);
}
if (mode !== 'python' && mode !== 'python-cwd') {
  process.stderr.write(`fake-freecadcmd: unknown FAKE_FREECAD_MODE ${mode}\n`);
  process.exit(2);
}

const BOOT = String.raw`
import os, runpy, sys
script = os.path.abspath(sys.argv[1])
folder, base = os.path.split(script)
name = os.path.splitext(base)[0]
cwd = os.getcwd()
sys.path[:] = [p for p in sys.path if p not in ("", cwd)]
if os.environ.get("FAKE_FREECAD_CWD_FIRST") == "1":
    sys.path.insert(0, cwd)
sys.argv = ["freecadcmd", script]
sys.path.append(folder)
try:
    __import__(name)
except SystemExit:
    raise
except BaseException as first:
    sys.stderr.write("fake-freecadcmd: importing %s raised (%s: %s); running it again in __main__, as freecadcmd does\n" % (base, type(first).__name__, first))
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit:
        raise
    except BaseException as second:
        sys.stderr.write("Exception while processing file: %s [%s: %s]\n" % (base, type(second).__name__, second))
sys.exit(0)
`;

const py = spawnSync(process.env.FAKE_FREECAD_PYTHON || 'python3', ['-c', BOOT, argv[0]], {
  stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', FAKE_FREECAD_CWD_FIRST: mode === 'python-cwd' ? '1' : '' },
});
process.exit(py.status ?? 1);
