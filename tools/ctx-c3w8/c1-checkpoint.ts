/** ctx-c3w8 C1: sealed local-fallback controls; no model inference or downloads. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { appendReceipt, verifySignature, type ReceiptInput } from '../../src/utils/receipts.js';
import { captureEnvLock } from '../../src/utils/envlock.js';
import { ollamaChatCompletion, probeOllama } from '../../src/agent/providers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runId = `${Date.now()}-${randomUUID()}`;
const directory = join(root, 'studio/ctx-c3w8/C1', runId);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const clean = (text: string) => text.replaceAll(root, '<worktree>').replaceAll(homedir(), '<home>');
const artifact = (name: string, data: unknown) => {
  const bytes = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  const path = join(directory, name); writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path: relative(root, path), sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
};
const sourceFiles = ['src/agent/providers.ts', 'src/agent/core.ts', 'tests/providers.test.ts', 'tools/ctx-c3w8/c1-checkpoint.ts'];
const sources = sourceFiles.map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }));
const env = captureEnvLock([], root);
const seal = (input: ReceiptInput) => {
  const receipt = appendReceipt('runs', { env_lock: env, ...input }, root);
  if (!verifySignature(receipt)) throw new Error('Checkpoint receipt signature did not verify');
  return receipt;
};
const predictionArtifact = artifact('prediction.json', {
  schema: 'timmy.ctx-c3w8.c1.prediction/1', order: 'ctx-c3w8', checkpoint: 'C1', runId,
  scope: 'One real core fallback method with controlled loopback responses; separate live local model metadata discovery.',
  expected: { providerTestsPass: 17, cloudNegativeControl: { refused: true, fetchCalls: 0, inferenceCalls: 0 },
    liveMetadata: { minimumLocalCandidates: 1, cloudCandidates: 0, inferenceCalls: 0 },
    controlledFallback: { returnedModel: 'ollama/granite-c1:latest', returnedText: 'C1 controlled local reply.',
      apiTags: 1, apiShow: 3, apiChat: 1, nonLoopbackRequests: 0, realModelInferenceCalls: 0 },
    daemonOsEgress: 'unmeasured', mcpTransport: 'not-exercised' },
  measurementRules: ['Instrument this Node process fetch and Undici request creation only.',
    'The controlled responder is not an Ollama daemon and does not run a model.',
    'Live Ollama discovery is restricted to api/tags and api/show.',
    'Zero observed Node nonloopback requests does not attest Ollama daemon OS egress or other processes.'], sources,
});
const prediction = seal({ kind: 'ctx.c1.predict', subject: 'ctx-c3w8/C1', policy: 'Prediction sealed before checkpoint execution; user waived HOLD',
  prompt_hash: predictionArtifact.sha256, artifacts: [predictionArtifact.path], sources });
artifact('prediction.receipt.json', prediction);

const fetchEvents: { phase: string; method: string; origin: string; path: string; disposition: string }[] = [];
const wireEvents: { phase: string; origin: string; path: string }[] = [];
const nativeFetch = globalThis.fetch;
const previousHost = process.env.OLLAMA_HOST;
let phase = 'negative-control', allowedOrigin: string | null = null;
const wireChannel = channel('undici:request:create');
const onWire = (raw: unknown) => {
  const data = raw as { request?: { origin?: unknown; path?: unknown } };
  wireEvents.push({ phase, origin: String(data.request?.origin ?? 'unknown'), path: String(data.request?.path ?? 'unknown') });
};
wireChannel.subscribe(onWire);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const allowedPaths = phase === 'live-metadata' ? ['/api/tags', '/api/show'] : ['/api/tags', '/api/show', '/v1/chat/completions'];
  const allowed = url.origin === allowedOrigin && allowedPaths.includes(url.pathname) && !url.username && !url.password;
  fetchEvents.push({ phase, method: init?.method ?? 'GET', origin: url.origin, path: url.pathname, disposition: allowed ? 'allowed' : 'refused-before-fetch' });
  if (!allowed) throw new Error('C1 transport refused an unexpected origin or operation before dispatch');
  return nativeFetch(input, init);
}) as typeof fetch;
let outcome: any = null;
let server: ReturnType<typeof createServer> | undefined;
try {
  process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
  const before = fetchEvents.length; let refused = false, refusal: string | null = null;
  try { await ollamaChatCompletion('kimi-k2.7-code:cloud', [{ role: 'user', content: 'C1 negative control: this must never reach inference.' }], 1000); }
  catch (error) { refused = true; refusal = clean(String(error)); }
  const negative = { schema: 'timmy.ctx-c3w8.c1.negative-control/1', refused, refusal,
    fetchCalls: fetchEvents.length - before, inferenceCalls: 0, realModelInferenceCalls: 0,
    interpretation: 'Cloud tag refused before any transport request; no cloud service was contacted.' };
  const negativeArtifact = artifact('negative-control.json', negative);
  const negativeReceipt = seal({ kind: 'ctx.c1.negative-control', subject: 'kimi-k2.7-code:cloud',
    policy: 'Expected local-only refusal; no inference authorized', status: refused && negative.fetchCalls === 0 ? 'denied' : 'failed',
    plan_hash: prediction.hash, output_sha256: negativeArtifact.sha256, artifacts: [negativeArtifact.path], sources });
  artifact('negative-control.receipt.json', negativeReceipt);

  phase = 'live-metadata'; allowedOrigin = 'http://127.0.0.1:11434';
  const live = await probeOllama(5000);
  const liveArtifact = artifact('live-metadata.json', { ...live, endpoint: allowedOrigin,
    scope: 'Read-only installed-weight metadata; no inference, pull, daemon restart or OS egress claim.' });

  phase = 'controlled-fallback';
  const serverEvents: { method: string; path: string; model?: string }[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = []; let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) request.destroy(); else chunks.push(Buffer.from(chunk)); });
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const path = request.url ?? '';
      serverEvents.push({ method: request.method ?? 'GET', path, ...(typeof body.model === 'string' ? { model: body.model } : {}) });
      let data: unknown;
      if (path === '/api/tags') data = { models: [{ name: 'kimi-k2.7-code:cloud' }, { name: 'disguised-remote:latest' }, { name: 'granite-c1:latest' }] };
      else if (path === '/api/show') data = { details: { format: 'gguf', family: 'controlled-fixture' }, capabilities: ['completion'],
        ...(body.model === 'disguised-remote:latest' ? { remote_model: 'remote-alias' } : {}) };
      else if (path === '/v1/chat/completions' && body.model === 'granite-c1:latest') data = { model: body.model, choices: [{ message: { content: 'C1 controlled local reply.' } }] };
      else { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
    });
  });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing controlled loopback listener');
  allowedOrigin = `http://127.0.0.1:${address.port}`; process.env.OLLAMA_HOST = allowedOrigin;
  const { Agent } = await import('../../src/agent/core.js');
  const events: { event: string }[] = [], logs: { event: string; data: unknown }[] = [];
  const receiver = { modelHealthStatus: 'UNTESTED', activeProvider: 'none',
    logModelEvent: (event: string, data: unknown) => logs.push({ event, data }), emit: (event: string) => events.push({ event }) };
  const result = await (Agent.prototype as any).tryOllamaLastResort.call(receiver,
    [{ role: 'user', content: 'C1 controlled fallback transport test.' }], 'controlled upstream failure; no upstream request was made');
  await new Promise<void>(done => server!.close(() => done())); server = undefined;
  const controlled = { result, modelHealthStatus: receiver.modelHealthStatus, activeProvider: receiver.activeProvider, serverEvents, events, logs,
    realModelInferenceCalls: 0, classification: 'Actual Agent.tryOllamaLastResort path; response provided by a controlled loopback fixture.' };
  const controlledArtifact = artifact('controlled-fallback.json', controlled);

  phase = 'focused-tests'; allowedOrigin = null;
  const unit = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/providers.test.ts'],
    { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:11434' } });
  const testArtifact = artifact('provider-tests.txt', clean((unit.stdout ?? '') + (unit.stderr ?? '')));
  const traceArtifact = artifact('node-transport.json', { fetchEvents, undiciRequestCreate: wireEvents,
    scope: 'This parent Node process only. Focused test child uses mocked transport. Other processes and daemon egress are not observed.',
    mcpTransport: 'not-exercised', daemonOsEgress: 'unmeasured' });
  const requestCount = (path: string) => serverEvents.filter(event => event.path === path).length;
  const checks = { cloudRefusedBeforeTransport: negative.refused && negative.fetchCalls === 0,
    liveLocalCandidates: live.ok && live.models.length >= 1 && live.models.every(name => !/(?:^|[:/_-])cloud(?:$|[:/_-])/i.test(name)),
    actualFallbackReturnedControlledReply: result?.actualModel === 'ollama/granite-c1:latest' && result?.fullText === 'C1 controlled local reply.',
    controlledRequestCounts: requestCount('/api/tags') === 1 && requestCount('/api/show') === 3 && requestCount('/v1/chat/completions') === 1,
    noUnexpectedNodeFetch: fetchEvents.every(event => event.disposition === 'allowed' && new URL(event.origin).hostname === '127.0.0.1'),
    focusedProviderTestsPassed: unit.status === 0 && /17 passed/.test((unit.stdout ?? '') + (unit.stderr ?? '')) };
  const findingArtifact = artifact('daemon-egress-finding.json', {
    schema: 'timmy.ctx-c3w8.c1.finding/1', finding: 'daemon-os-egress-not-measured', status: 'unmeasured',
    reason: 'The Node client guards destinations and rejects remote model metadata, but this checkpoint does not isolate or trace the Ollama daemon process network namespace.',
    measured: 'Client fetch admission plus Undici request creation; negative control; actual fallback method against a controlled loopback endpoint.',
    notEstablished: ['Ollama daemon has no OS egress', 'MCP processes have no OS egress', 'Whole-machine airgap', 'A real local model answered in C1'],
    nextMeasurement: 'Run an explicitly authorized local inference under daemon-level egress containment or process-attributed network tracing; retain that separate evidence.',
  });
  const findingReceipt = seal({ kind: 'ctx.c1.finding', subject: 'ctx-c3w8/C1/daemon-egress', policy: 'Seal the limit of the measured boundary; do not infer airgap',
    status: 'ok', plan_hash: prediction.hash, output_sha256: findingArtifact.sha256, artifacts: [findingArtifact.path], sources });
  artifact('finding.receipt.json', findingReceipt);
  outcome = { schema: 'timmy.ctx-c3w8.c1.result/1', order: 'ctx-c3w8', checkpoint: 'C1', runId,
    ok: Object.values(checks).every(Boolean), checks, artifacts: [predictionArtifact, negativeArtifact, liveArtifact, controlledArtifact, testArtifact, traceArtifact, findingArtifact],
    sources, limits: { realModelInferenceCalls: 0, daemonOsEgress: 'unmeasured', mcpTransport: 'not-exercised', wholeMachineAirgap: 'not-established' } };
  const outcomeArtifact = artifact('result.json', outcome);
  const checkpoint = seal({ kind: 'ctx.c1.checkpoint', subject: 'ctx-c3w8/C1', policy: 'Compare predeclared local fallback controls with retained observations',
    status: outcome.ok ? 'ok' : 'failed', plan_hash: prediction.hash, output_sha256: outcomeArtifact.sha256,
    artifacts: [outcomeArtifact.path], sources, child_receipts: [negativeReceipt.hash, findingReceipt.hash], ms: Date.now() - Number(runId.split('-')[0]) });
  artifact('checkpoint.receipt.json', checkpoint);
  console.log(JSON.stringify({ ok: outcome.ok, directory: relative(root, directory), prediction: prediction.hash,
    negativeControl: negativeReceipt.hash, finding: findingReceipt.hash, checkpoint: checkpoint.hash, checks }, null, 2));
  if (!outcome.ok) process.exitCode = 1;
} catch (error) {
  const failureArtifact = artifact('failure.json', { error: clean(String(error)), partialNodeObservations: fetchEvents });
  const receipt = seal({ kind: 'ctx.c1.checkpoint', subject: 'ctx-c3w8/C1', policy: 'Retain incomplete checkpoint failure', status: 'failed',
    plan_hash: prediction.hash, output_sha256: failureArtifact.sha256, artifacts: [failureArtifact.path], sources });
  artifact('failure.receipt.json', receipt);
  console.error(JSON.stringify({ ok: false, directory: relative(root, directory), error: clean(String(error)), checkpoint: receipt.hash }));
  process.exitCode = 1;
} finally {
  wireChannel.unsubscribe(onWire); globalThis.fetch = nativeFetch;
  if (previousHost === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = previousHost;
  if (server) await new Promise<void>(done => server!.close(() => done()));
}
