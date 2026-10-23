// Explicit local integration gate. Missing Python/OpenCV is a failure here,
// never a skipped green result. No hosted inference, credentials or model needed.
import { spawn } from 'node:child_process';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.TIMMY_VISION_PYTHON || 'python3';
if (process.env.TIMMY_VISION_PYTHON && !isAbsolute(python)) {
  throw new Error('TIMMY_VISION_PYTHON must be the absolute path to the Python used by Timmy.');
}
function run(command, args, env = process.env) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    let expired = false;
    const timeout = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 120_000);
    child.once('error', () => { clearTimeout(timeout); done(1); });
    child.once('close', code => { clearTimeout(timeout); done(expired ? 124 : code ?? 1); });
  });
}
let exit = await run(python, ['-c', 'import cv2,numpy,sys; print("REAL local runtime:",sys.version.split()[0],"OpenCV",cv2.__version__,"NumPy",numpy.__version__)']);
if (exit === 0) {
  const env = { ...process.env, TIMMY_REQUIRE_REAL_VISION: '1' };
  // The existing real-worker tests discover python3 through PATH. Resolve the
  // configured interpreter's directory without changing the caller's shell.
  if (isAbsolute(python)) env.PATH = `${dirname(resolve(python))}${delimiter}${env.PATH ?? ''}`;
  exit = await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/vox-look-real.test.ts', '--maxWorkers=1', '--testTimeout=30000', '-t', 'Look --vox with real OpenCV'], env);
}
if (exit !== 0) console.error('Real local vision gate failed; inspect the actual error above. Missing runtimes and runner errors are failures, not skipped passes.');
process.exitCode = exit;
