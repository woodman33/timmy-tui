import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, createReadStream, realpathSync } from 'node:fs';
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
  if (JSON.stringify(data).length > 65536) throw new Error('Request exceeds 64 KiB.');
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
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 2 * 1024 ** 3) throw new Error('Artifact is not a bounded regular file.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    result.push({ path: rel, bytes: stat.size, sha256: hash.digest('hex') });
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
      let out = '', err = '', bytes = 0;
      const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const finishFailure = (failure: string) => done({ code: null, stdout: out, stderr: err, failure });
      const timer = setTimeout(() => { kill(); finishFailure('Adapter exceeded the 15-minute limit.'); }, 900000);
      const collect = (chunk: Buffer, isError: boolean) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) { kill(); clearTimeout(timer); finishFailure('Adapter output exceeded 4 MiB.'); return; }
        if (isError) err += chunk.toString(); else out += chunk.toString();
      };
      child.stdout.on('data', chunk => collect(chunk, false)); child.stderr.on('data', chunk => collect(chunk, true));
      child.once('error', error => { clearTimeout(timer); finishFailure(error.message); });
      child.once('close', exitCode => { clearTimeout(timer); done({ code: exitCode, stdout: out, stderr: err }); });
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
