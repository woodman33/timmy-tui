import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, createReadStream, realpathSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { appendReceipt, receiptsDir, verifySignature } from '../../utils/receipts.js';
import { redactVisionValue } from '../runtime.js';
import { integrationDefinitions } from './registry.js';

const MAX_OUTPUT = 4 * 1024 * 1024;
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export function validateIntegrationRequest(id: string, request: unknown, dir = process.cwd()) {
  const definition = integrationDefinitions(dir).find(d => d.id === id);
  if (!definition) throw new Error('Unknown integration. Use vision integrations list.');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be a JSON object.');
  const data = request as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 65536) throw new Error('Request exceeds 64 KiB.');
  if (typeof data.operation !== 'string' || !definition.operations.includes(data.operation)) throw new Error(`Supported operations: ${definition.operations.join(', ')}`);
  const check = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(check); return; }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (/^(api[_-]?key|secret|password|authorization|access[_-]?token|credentials|env|executable|command|shell|output_dir|admission_receipt_hash|capability)$/i.test(key)) throw new Error('Runtime authority and credentials cannot be supplied in a retained request.');
      check(child);
    }
  };
  check(data);
  return { definition, request: data };
}

export async function hashArtifacts(outputDir: string, paths: unknown) {
  if (!Array.isArray(paths) || paths.length > 256) throw new Error('Adapter artifacts must be a bounded list.');
  // The adapter creates this directory. Checking only its descendants would
  // admit an external file when the artifact root itself is a symlink.
  const root = paths.length > 0 ? lstatSync(outputDir) : null;
  if (root) {
    if (root.isSymbolicLink()) throw new Error('Linked artifacts are not admitted.');
    if (!root.isDirectory()) throw new Error('Artifact root must be a directory.');
  }
  const result: { path: string; bytes: number; sha256: string }[] = [];
  for (const path of [...new Set(paths)]) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Artifact path must be absolute.');
    const rel = relative(outputDir, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact must be inside this invocation.');
    let current = outputDir;
    for (const part of rel.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Linked artifacts are not admitted.');
    }
    const listed = lstatSync(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      const sameIdentity = (a: typeof stat, b: typeof stat) => a.dev === b.dev && a.ino === b.ino;
      const sameSnapshot = (a: typeof stat, b: typeof stat) => sameIdentity(a, b)
        && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
      if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw new Error('Artifact is not a bounded regular file.');
      if (!sameSnapshot(listed, stat)) throw new Error('Artifact changed before hashing.');
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(path, { fd, autoClose: false })) {
        bytes += chunk.length;
        if (bytes > stat.size || bytes > 2 * 1024 ** 3) throw new Error('Artifact changed beyond its bounded snapshot.');
        hash.update(chunk);
      }
      const after = fstatSync(fd), atPath = lstatSync(path), rootAfter = lstatSync(outputDir);
      if (bytes !== stat.size || !sameSnapshot(stat, after) || !sameSnapshot(stat, atPath)
        || atPath.isSymbolicLink() || rootAfter.isSymbolicLink() || !rootAfter.isDirectory()
        || !sameIdentity(root!, rootAfter)) throw new Error('Artifact changed while hashing.');
      // An intermediate directory may have changed after its initial check.
      current = outputDir;
      for (const part of rel.split('/')) {
        current = join(current, part);
        if (lstatSync(current).isSymbolicLink()) throw new Error('Linked artifacts are not admitted.');
      }
      result.push({ path: rel, bytes, sha256: hash.digest('hex') });
    } finally { closeSync(fd); }
  }
  return result;
}

/** Fixed adapter process. Records intent before dispatch and both failure and success.
 * These receipts establish execution provenance, not correctness of model judgments.
 */
export async function runIntegration(id: string, raw: unknown, dir = process.cwd()) {
  const { definition, request } = validateIntegrationRequest(id, raw, dir);
  const runId = `${Date.now()}-${randomUUID()}`;
  const requestedOutputDir = resolve(receiptsDir(dir), 'integrations', runId);
  mkdirSync(requestedOutputDir, { recursive: true });
  // Adapters resolve paths too. Establish one physical run root before dispatch,
  // including stores reached through a system alias such as macOS /var.
  const outputDir = realpathSync(requestedOutputDir);
  const requestBody = JSON.stringify(request, null, 2) + '\n';
  writeFileSync(join(outputDir, 'request.json'), requestBody, { flag: 'wx', mode: 0o600 });
  const adapterSource = existsSync(definition.script) ? readFileSync(definition.script) : null;
  const adapterSnapshot = join(outputDir, 'adapter-source.py');
  if (adapterSource) writeFileSync(adapterSnapshot, adapterSource, { flag: 'wx', mode: 0o600 });
  // Camera fitting and telemetry are self-contained: execute the retained bytes, so concurrent source
  // edits cannot change the implementation after its intent was recorded. Legacy
  // native adapters may rely on sibling files and remain at their original path.
  const executionScript = ['camera-fit', 'mcap', 'plotjuggler'].includes(id) ? adapterSnapshot : definition.script;
  const intent = appendReceipt('runs', {
    kind: 'vision.integration.intent', subject: `${id}.${request.operation}`,
    policy: 'Explicit bounded Timmy adapter invocation', prompt_hash: digest(requestBody),
    artifacts: [join(outputDir, 'request.json')],
    sources: [{ adapter: definition.script, adapterSha256: adapterSource ? digest(adapterSource) : null }],
  }, dir);
  const started = Date.now();
  let code: number | null = null, stderr = '', stdout = '', failure = '';
  let result: Record<string, unknown> = { ok: false, artifacts: [] };
  try {
    if (!existsSync(definition.executable) || !existsSync(executionScript)) throw new Error('Adapter runtime is unavailable.');
    const execution = await new Promise<{ code: number | null; stdout: string; stderr: string; failure?: string }>((done) => {
      const child = spawn(definition.executable, [executionScript], { cwd: dir, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: process.env });
      const out: Buffer[] = [], err: Buffer[] = [];
      let bytes = 0, settled = false;
      // Decode only the complete byte sequence: UTF-8 characters can straddle
      // arbitrary process stream chunks.
      const finish = (code: number | null, failure?: string) => {
        if (settled) return;
        settled = true;
        done({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ...(failure ? { failure } : {}) });
      };
      const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const finishFailure = (failure: string) => finish(null, failure);
      const timer = setTimeout(() => { kill(); finishFailure('Adapter exceeded the 15-minute limit.'); }, 900000);
      const collect = (chunk: Buffer, isError: boolean) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) { kill(); clearTimeout(timer); finishFailure('Adapter output exceeded 4 MiB.'); return; }
        (isError ? err : out).push(chunk);
      };
      child.stdout.on('data', chunk => collect(chunk, false)); child.stderr.on('data', chunk => collect(chunk, true));
      child.once('error', error => { clearTimeout(timer); finishFailure(error.message); });
      child.once('close', exitCode => { clearTimeout(timer); finish(exitCode); });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ ...request, capability: id, output_dir: join(outputDir, 'artifacts'), admission_receipt_hash: intent.hash }));
    });
    code = execution.code;
    stdout = String(redactVisionValue(execution.stdout)); stderr = String(redactVisionValue(execution.stderr));
    if (execution.failure) throw new Error(execution.failure);
    result = JSON.parse(stdout);
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw new Error('Invalid adapter result envelope.');
    if (code !== 0 || result.ok !== true) failure = 'Adapter did not complete successfully.';
  } catch (error) { failure = error instanceof Error ? error.message : 'Adapter failed.'; }
  writeFileSync(join(outputDir, 'stdout.txt'), stdout, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(outputDir, 'stderr.txt'), stderr, { flag: 'wx', mode: 0o600 });
  let artifacts: Awaited<ReturnType<typeof hashArtifacts>> = [];
  try {
    artifacts = (await hashArtifacts(join(outputDir, 'artifacts'), result.artifacts ?? []))
      .map(artifact => ({ ...artifact, path: `artifacts/${artifact.path}` }));
  }
  catch (error) { failure = error instanceof Error ? error.message : 'Artifact verification failed.'; }
  const report = { schema: 'timmy.integration-run/1', id: runId, capability: id, operation: request.operation,
    ok: !failure, admissionReceipt: intent.hash, exitCode: code, elapsedMs: Date.now() - started,
    result: redactVisionValue(result), error: failure || null, artifacts,
    limits: { executedRetainedAdapterSnapshot: ['camera-fit', 'mcap', 'plotjuggler'].includes(id), inferenceJudgmentIsProof: false, byteIntegrityIsBehaviorProof: false } };
  const reportBody = JSON.stringify(report, null, 2) + '\n';
  const reportPath = join(outputDir, 'result.json');
  writeFileSync(reportPath, reportBody, { flag: 'wx', mode: 0o600 });
  const receipt = appendReceipt('runs', {
    kind: 'vision.integration.result', subject: `${id}.${request.operation}`,
    policy: 'Fixed adapter execution and retained output; correctness limited to declared checks',
    status: failure ? 'failed' : 'ok', ...(failure ? { error_class: 'adapter' } : {}),
    plan_hash: intent.hash, output_sha256: digest(reportBody), artifacts: [reportPath],
    ms: report.elapsedMs, exit_code: code ?? -1,
  }, dir);
  writeFileSync(join(outputDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return { ...report, reportPath, receiptId: receipt.id, receiptHash: receipt.hash, signatureVerified: verifySignature(receipt) };
}
