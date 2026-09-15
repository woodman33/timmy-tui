import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendReceipt, hashOf, readChain, receiptsDir, rootStoreDir, verifySignature, type Receipt } from '../../utils/receipts.js';
import { planRoute, type RouteGraph, type RouteRequest } from './route-graph.js';

const modulePath = fileURLToPath(import.meta.url);
function repositoryRoot(): string {
  let directory = dirname(modulePath);
  for (;;) {
    const packagePath = join(directory, 'package.json');
    if (existsSync(packagePath)) {
      try { if (JSON.parse(readFileSync(packagePath, 'utf8')).name === 'timmy-tui') return directory; }
      catch { /* Continue to the owning package if an intermediate file is not package metadata. */ }
    }
    const parent = dirname(directory);
    if (parent === directory) throw Error('Cannot locate the canonical Timmy package');
    directory = parent;
  }
}
const root = repositoryRoot();
const operations = join(root, '.timmy/private/route-ops');
const defaultGraph = 'studio/box-loop-20260914/s3/graph.json';
// This checkpoint admits only these qualified descriptor bytes. Changes require
// requalification and a new explicit pin; the S2 seal alone does not qualify a graph.
const admittedGraphSha256 = 'e57bfc9054e37a0ef946056dabb888fdf495899a58b08c9375df9dea063bd8fd';
const operationPattern = /^route-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const parse = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(label + ' must be an object');
  return value as Record<string, any>;
}

function repositoryFile(input: unknown): string {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw Error('Invalid repository artifact path');
  const path = resolve(root, input), actual = realpathSync(path), canonicalRoot = realpathSync(root);
  if (!actual.startsWith(canonicalRoot + sep)) throw Error('Artifact must remain inside the canonical repository');
  return path;
}

function pinnedStore(): string {
  const expected = join(root, '.timmy/receipts');
  if (rootStoreDir(root) !== expected || receiptsDir(root) !== expected
    || process.env.TIMMY_STORE && resolve(process.env.TIMMY_STORE) !== expected) throw Error('Pinned receipt store mismatch');
  return expected;
}

function verifyReceipt(receipt: Receipt): void {
  pinnedStore();
  if (!receipt || !verifySignature(receipt) || hashOf({ ...receipt, hash: '' }) !== receipt.hash) throw Error('Receipt signature or hash verification failed');
  if (receipt.stream !== 'runs' || !readChain('runs', root).some(row => row.id === receipt.id && row.hash === receipt.hash)) {
    throw Error('Receipt is absent from the canonical runs chain');
  }
}

function seal(kind: 'op.request' | 'op.result', status: 'ok' | 'failed', artifact: string, opId: string, outcome: string, children: string[] = []): Receipt {
  console.error('store: ' + pinnedStore());
  const receipt = appendReceipt('runs', {
    kind, subject: 'route.plan', status, tier: 'LIGHT', policy: 'Planning only; frozen request and graph; qualified evidence required; no route execution.',
    artifacts: [relative(root, artifact)], output_sha256: sha(readFileSync(artifact)), child_receipts: children,
    sources: [{ op_id: opId, outcome, execution: 'planning-only' }],
    ...(status === 'failed' ? { error_class: 'route_planning', exit_code: 2 } : {}),
  }, root);
  verifyReceipt(receipt);
  return receipt;
}

function verifyArtifact(input: unknown): void {
  const artifact = record(input, 'Artifact binding');
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw Error('Invalid artifact digest');
  if (sha(readFileSync(repositoryFile(artifact.path))) !== artifact.sha256) throw Error('Artifact digest mismatch: ' + artifact.path);
}

function admitGraph(graph: RouteGraph): string {
  const data = record(graph, 'Route graph'), admission = record(data.admission, 'Graph admission');
  const receipt = parse(repositoryFile(admission.receiptPath)) as Receipt;
  verifyReceipt(receipt);
  if (receipt.kind !== 'seal' || receipt.subject !== 'view.ground' || receipt.status !== 'ok') throw Error('S2 view.ground admission is not successful');
  const manifestPath = repositoryFile(admission.manifestPath), manifestBytes = readFileSync(manifestPath);
  if (receipt.output_sha256 !== sha(manifestBytes)
    || !receipt.artifacts?.some(path => resolve(root, path) === manifestPath)) throw Error('S2 manifest is not bound by its admission receipt');
  const manifest = record(JSON.parse(manifestBytes.toString('utf8')), 'S2 manifest');
  if (manifest.schema !== 'timmy.native-view.manifest/1' || manifest.status !== 'ok'
    || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || !Array.isArray(manifest.implementation) || !manifest.implementation.length) {
    throw Error('Invalid S2 admission manifest');
  }
  for (const artifact of [...manifest.artifacts, ...manifest.implementation]) verifyArtifact(artifact);
  if (!Array.isArray(data.evidence) || !data.evidence.length) throw Error('Graph must declare evidence artifact bindings');
  for (const artifact of data.evidence) verifyArtifact(artifact);
  const evidencePaths = new Set(data.evidence.map((artifact: any) => artifact.path));
  if (!Array.isArray(data.edges)) throw Error('Graph edges are missing');
  for (const edge of data.edges) {
    if (edge.qualification?.eligible === true && (!Array.isArray(edge.qualification.evidence) || !edge.qualification.evidence.length
      || edge.qualification.evidence.some((path: unknown) => typeof path !== 'string' || !evidencePaths.has(path)))) {
      throw Error('Eligible edge cites evidence absent from the verified graph artifact list: ' + edge.id);
    }
  }
  return receipt.hash;
}

function parseRequest(args: string[]): { graphPath: string; request: RouteRequest } {
  const words = [...args];
  if (words[0] === 'plan' || words[0] === 'submit') words.shift();
  const options = new Map<string, string>();
  for (let i = 0; i < words.length; i += 2) {
    const key = words[i], value = words[i + 1];
    if (!['--from', '--to', '--require', '--independent', '--graph'].includes(key)) throw Error('Unknown argument: ' + key);
    if (options.has(key)) throw Error('Duplicate argument: ' + key);
    if (value === undefined || value.startsWith('--') || !value.trim()) throw Error('Missing value for ' + key);
    options.set(key, value);
  }
  const from = options.get('--from'), to = options.get('--to'), required = options.get('--require');
  if (!from || !to || required === undefined) throw Error('--from, --to and --require are required');
  const requiredProperties = required.split(',').map(value => value.trim());
  if (requiredProperties.some(value => !value) || new Set(requiredProperties).size !== requiredProperties.length) throw Error('--require must contain distinct nonempty comma-separated properties');
  const independent = options.get('--independent') ?? '1';
  if (independent !== '1' && independent !== '2') throw Error('--independent must be 1 or 2');
  return { graphPath: repositoryFile(options.get('--graph') ?? defaultGraph),
    request: { from, to, requiredProperties, independent: Number(independent) as 1 | 2 } };
}

async function submit(args: string[]): Promise<number> {
  const { graphPath, request } = parseRequest(args);
  pinnedStore();
  const graphBytes = readFileSync(graphPath);
  if (graphBytes.length > 16 * 1024 * 1024) throw Error('Graph exceeds the 16 MiB planning input limit');
  record(JSON.parse(graphBytes.toString('utf8')), 'Route graph');
  mkdirSync(operations, { recursive: true, mode: 0o700 });
  repositoryFile(operations);
  const opId = 'route-' + randomUUID(), directory = join(operations, opId);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'graph.json'), graphBytes, { flag: 'wx', mode: 0o600 });
  const requestPath = join(directory, 'request.json');
  save(requestPath, { schema: 'timmy.route.op.request/1', op_id: opId, operation: 'route.plan', request,
    graphSha256: sha(graphBytes), submittedAt: new Date().toISOString(), scope: 'planning-only' });
  const receipt = seal('op.request', 'ok', requestPath, opId, 'submitted');
  save(join(directory, 'op.request.receipt.json'), receipt);
  const child = spawn(process.execPath, ['--import', 'tsx', modulePath, '--worker', opId], {
    cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, TIMMY_STORE: pinnedStore() },
  });
  try {
    await new Promise<void>((done, failed) => { child.once('spawn', done); child.once('error', failed); });
  } catch (error) {
    const resultPath = join(directory, 'result.json');
    save(resultPath, { schema: 'timmy.route.op.result/1', op_id: opId, status: 'failed', outcome: 'failed', error: errorText(error) });
    const failedReceipt = seal('op.result', 'failed', resultPath, opId, 'failed', [receipt.hash]);
    save(join(directory, 'op.result.receipt.json'), failedReceipt);
    save(join(directory, 'complete.json'), { op_id: opId, status: 'failed', outcome: 'failed', verified: true, receipt: failedReceipt.hash });
    throw error;
  }
  child.unref();
  console.log(JSON.stringify({ op_id: opId, state: 'submitted', pid: child.pid, requestReceipt: receipt.hash,
    result_path: join(directory, 'result.json'), receipt_path: join(directory, 'op.result.receipt.json'), complete_path: join(directory, 'complete.json') }));
  return 0;
}

async function worker(opId: string): Promise<number> {
  if (!operationPattern.test(opId)) throw Error('Invalid operation ID');
  pinnedStore();
  const directory = repositoryFile(join(operations, opId));
  if (existsSync(join(directory, 'complete.json'))) throw Error('Operation already completed');
  save(join(directory, 'started.json'), { op_id: opId, pid: process.pid, startedAt: new Date().toISOString() });
  const started = Date.now();
  let result: Record<string, unknown>, requestReceipt: Receipt | undefined;
  try {
    const requestPath = join(directory, 'request.json'), requestBytes = readFileSync(requestPath), snapshot = record(JSON.parse(requestBytes.toString('utf8')), 'Operation request');
    const candidateReceipt = parse(join(directory, 'op.request.receipt.json')) as Receipt;
    verifyReceipt(candidateReceipt);
    requestReceipt = candidateReceipt;
    if (requestReceipt.kind !== 'op.request' || requestReceipt.subject !== 'route.plan' || requestReceipt.status !== 'ok'
      || requestReceipt.output_sha256 !== sha(requestBytes) || !requestReceipt.artifacts?.includes(relative(root, requestPath))
      || snapshot.op_id !== opId || snapshot.schema !== 'timmy.route.op.request/1' || snapshot.scope !== 'planning-only') throw Error('Operation request binding failed');
    const graphBytes = readFileSync(join(directory, 'graph.json'));
    if (sha(graphBytes) !== snapshot.graphSha256) throw Error('Frozen graph digest mismatch');
    if (sha(graphBytes) !== admittedGraphSha256) throw Error('Graph is not the admitted checkpoint revision; graph changes require requalification and a new pin');
    const graph = JSON.parse(graphBytes.toString('utf8')) as RouteGraph;
    const admittedBy = admitGraph(graph);
    const plan = planRoute(graph, snapshot.request as RouteRequest);
    if (plan.status !== 'planned' && plan.status !== 'refused') throw Error('Invalid planner outcome');
    result = { schema: 'timmy.route.op.result/1', op_id: opId, status: 'ok', outcome: plan.status,
      graphSha256: snapshot.graphSha256, admittedBy, request: snapshot.request, plan, scope: 'planning-only', durationMs: Date.now() - started };
  } catch (error) {
    result = { schema: 'timmy.route.op.result/1', op_id: opId, status: 'failed', outcome: 'failed',
      error: errorText(error), scope: 'planning-only', durationMs: Date.now() - started };
  }
  const resultPath = join(directory, 'result.json');
  save(resultPath, result);
  const receipt = seal('op.result', result.status === 'ok' ? 'ok' : 'failed', resultPath, opId, String(result.outcome), requestReceipt ? [requestReceipt.hash] : []);
  save(join(directory, 'op.result.receipt.json'), receipt);
  verifyReceipt(parse(join(directory, 'op.result.receipt.json')) as Receipt);
  if (receipt.output_sha256 !== sha(readFileSync(resultPath))) throw Error('Result artifact changed before completion');
  save(join(directory, 'complete.json'), { op_id: opId, status: result.status, outcome: result.outcome, verified: true,
    resultSha256: receipt.output_sha256, receiptId: receipt.id, receipt: receipt.hash });
  return result.status === 'ok' ? 0 : 2;
}

export async function runRouteCli(args: string[]): Promise<number> {
  if (args.length === 0 || args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
    console.log('Usage: timmy route [plan] --from NODE --to NODE --require property,property [--independent 1|2] [--graph REPO_PATH]\n'
      + 'Submits a detached, receipt-bound planning operation; executes no conversion. Default graph: ' + defaultGraph
      + '\nOnly the pinned checkpoint graph bytes are admitted, including relocated copies inside this repository. Graph changes require requalification and a new pin.');
    return 0;
  }
  try { return await submit(args); }
  catch (error) { console.log(JSON.stringify({ status: 'failed', error: errorText(error) })); return 2; }
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath && process.argv[2] === '--worker') {
  if (process.argv.length !== 4) { console.error('Invalid worker arguments'); process.exitCode = 2; }
  else worker(process.argv[3]).then(code => { process.exitCode = code; }, error => { console.error(errorText(error)); process.exitCode = 2; });
}
