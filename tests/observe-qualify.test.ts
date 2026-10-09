// /observe <file> --qualify (round R3, H14): after Look, the current model is asked through the observed-handle +
// cite protocol (AGENTS.md §4; src/vision/evidence.ts) instead of the plain interpretation. Every model here is a
// LABELLED FAKE (fakeModel below): no network, no paid call. Look is a labelled fake Python (fakePython below).
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVisionTools } from '../src/agent/vision-tools.js';
import { checkObservation } from '../src/evidence/observation-check.js';
import { folderProject } from '../src/project/index.js';
import { readObservationRecord, renderBoard } from '../src/repl/board.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import type { InterpretationRequest } from '../src/vision/evidence.js';
import { resetLookChecks } from '../src/vision/look.js';
import type { QualifyClient } from '../src/vision/qualify-route.js';
import { resetImageModelCache } from '../src/vision/route.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
const MODEL = 'fake/vision-model';
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
afterEach(async () => {
  resetLookChecks();
  resetImageModelCache();
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A labelled test double for a Python with OpenCV: prints a Look observation with deterministic values. With
 *  `touch`, the image changes once it has been measured (another program saving over it). */
function fakePython(o: { touch?: boolean } = {}): string {
  const dir = temp('fake-python-');
  const js = join(dir, 'fake-look.mjs');
  writeFileSync(js, [
    "import { createHash } from 'node:crypto';",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "if (args[0] === '-c') { console.log('5.0.0-fake'); process.exit(0); }",
    "const bytes = readFileSync(args[1]); const as = args[args.indexOf('--as') + 1];",
    ...(o.touch ? ['appendFileSync(args[1], Buffer.from([1, 2, 3]));'] : []),
    "const D = 'deterministic computation';",
    "const measurements = [",
    "  { name: 'mean_color', value: { r: 7, g: 7, b: 7, hex: '#070707' }, unit: 'sRGB 8-bit, uncalibrated', tier: D, note: '' },",
    "  { name: 'sharpness', value: 0, unit: 'variance of the Laplacian', tier: D, note: '' },",
    "  { name: 'qr_codes_decoded', value: [{ text: 'CARD-0042' }], unit: 'decoded text', tier: D, note: '' },",
    "];",
    "console.log(JSON.stringify({ ok: true, worker: { name: 'timmy-look', version: 'fake' }, opencv: '5.0.0-fake', python: 'fake', source: { path: as, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, image: { width: 4, height: 2, channels: 3 }, measurements, uncertainty: ['test double'] }));",
  ].join('\n'));
  const sh = join(dir, 'python');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

/** OpenRouter's public models list only (a fake fetch): the fake model takes images. Any other request is counted. */
function modelsList(o: { hang?: boolean } = {}) {
  const other: string[] = [];
  let listed: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => { listed = resolve; });
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      listed();
      if (o.hang) return new Promise<Response>((_r, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
      return new Response(JSON.stringify({ data: [{ id: MODEL, architecture: { input_modalities: ['text', 'image'] } }] }), { status: 200 });
    }
    other.push(url);
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  return { fn, other, asked };
}

interface Shown { question: string; run_id: string; source_revision: string; observations: Array<{ handle_id: string; measurement: string; value: { value?: unknown } }> }
interface Ctx { req: InterpretationRequest; shown: Shown; cite: (id: string) => Promise<unknown>; signal?: AbortSignal; round: (response: Record<string, unknown>) => Promise<void> }
type Script = (c: Ctx) => Promise<string>;

/**
 * A LABELLED FAKE model client shaped like @openrouter/sdk's callModel. It reads what it was shown, calls the
 * controller's real cite tool (its execute closure, as the SDK's tool loop does), reports tool rounds through
 * the request's stop condition (as the SDK's loop does), then answers. Its final response reports a cost.
 */
function fakeModel(script: Script, final: Record<string, unknown> = { id: 'fake-final', model: MODEL, usage: { cost: 0.002, totalTokens: 300 } }) {
  const requests: InterpretationRequest[] = [];
  let calledResolve: () => void = () => undefined;
  const called = new Promise<void>((resolve) => { calledResolve = resolve; });
  const client: QualifyClient = {
    callModel(req, options) {
      requests.push(req);
      calledResolve();
      const textPart = typeof req.input === 'string' ? req.input : String(req.input[0].content.find((c) => c.type === 'input_text')!.text);
      const shown = JSON.parse(textPart) as Shown;
      const cite = (handle_id: string): Promise<unknown> => req.tools[0].function.execute({ handle_id }, undefined as never) as Promise<unknown>;
      const rounds: Array<Record<string, unknown>> = [];
      const round = async (response: Record<string, unknown>): Promise<void> => { rounds.push(response); await req.stopWhen({ steps: rounds.map((r) => ({ response: r })) as never }); };
      const out = script({ req, shown, cite, ...(options?.signal ? { signal: options.signal } : {}), round });
      return { getText: () => out, getResponse: async () => { await out; return final; } };
    },
  };
  return { client, requests, called };
}
const handleOf = (shown: Shown, name: string): string => shown.observations.find((o) => o.measurement === name)!.handle_id;
const envelope = (shown: Shown, handles: string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ run_id: shown.run_id, source_revision: shown.source_revision, evidence: { answer: handles }, payload: { answer: 'A dark grey card with the QR code CARD-0042.' }, ...extra });
/** The usual well-behaved fake: cites two handles in one tool round (cost 0.001), then answers with the exact envelope. */
const citesTwo: Script = async ({ shown, cite, round }) => {
  await cite(handleOf(shown, 'mean_color'));
  await cite(handleOf(shown, 'qr_codes_decoded'));
  await round({ id: 'fake-round-1', usage: { cost: 0.001, totalTokens: 200 } });
  return envelope(shown, [handleOf(shown, 'mean_color'), handleOf(shown, 'qr_codes_decoded')]);
};

/** Receipts as the runs chain keeps them: each hashes to its own body, so checkObservation can match them. */
function make(root: string, client: QualifyClient | undefined, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const list = modelsList();
  const chain = (): Receipt[] => sealed.map((input, i) => {
    const body = { v: 1, id: `r${i}`, stream: 'runs', ts: '2026-10-09T00:00:00.000Z', ...input } as Record<string, unknown>;
    return { ...body, hash: hashOf({ ...body, hash: '' }) } as unknown as Receipt;
  });
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { TIMMY_VISION_PYTHON: fakePython(), OPENROUTER_API_KEY: 'test-key-not-real' },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
    receipts: chain,
    model: () => MODEL,
    fetch: list.fn,
    ...(client ? { qualifyClient: () => client } : {}),
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed, chain, list };
}

async function observeQualified(ws: Workspace, question = 'What does the card say?') {
  const started = await ws.observeFile('refs/card.png', question, undefined, { qualify: true });
  if (!started.ok) throw new Error(started.error);
  const outcome = await started.done;
  if (!outcome.ok) throw new Error(outcome.error);
  return { started, outcome };
}
const readRecord = (root: string, file: string): Record<string, any> => JSON.parse(readFileSync(join(root, file), 'utf8'));
const check = (root: string, file: string, chain: Receipt[], record?: unknown) => checkObservation({
  record: record ?? readRecord(root, file), file, fileSha256: sha(readFileSync(join(root, file))), currentSourceSha256: sha(readFileSync(join(root, 'refs/card.png'))), receipts: chain,
});

describe('/observe --qualify: admitted', () => {
  it('a fake model that cites real handles and returns the exact envelope: admitted, with cited values, run, revision and cost', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const fake = fakeModel(citesTwo);
    const { ws, sealed, chain, notes, list } = make(root, fake.client);
    const { outcome } = await observeQualified(ws);
    const record = readRecord(root, outcome.file);
    expect(record.interpretation).toBeUndefined();
    expect(record.tiers).toEqual(['deterministic computation', 'model interpretation']);
    const q = record.qualified;
    expect(q).toMatchObject({
      status: 'admitted', tier: 'model interpretation', protocol: expect.stringContaining('cite'), question: 'What does the card say?',
      model_requested: MODEL, model: MODEL, source_revision: PNG_SHA, semantic_correctness_verified: false,
      answer: 'A dark grey card with the QR code CARD-0042.', image_sent: true,
      cost_usd: 0.003, tokens: 500,
    });
    expect(q.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(q.cites.map((c: { measurement: string }) => c.measurement)).toEqual(['mean_color', 'qr_codes_decoded']);
    expect(q.cites[0].value).toEqual(record.look.measurements[0].value);
    expect(q.cites[1].value).toEqual(record.look.measurements[2].value);
    for (const c of q.cites) expect(c.handle_id).toMatch(/^ev:/);
    // The raw output is kept exactly: the envelope the fake returned, naming this run and this image.
    expect(JSON.parse(q.raw_output)).toEqual({ run_id: q.run_id, source_revision: PNG_SHA, evidence: { answer: q.cites.map((c: { handle_id: string }) => c.handle_id) }, payload: { answer: q.answer } });

    // What the fake was given: the real cite tool, a JSON-schema answer, the image as exactly the measured bytes.
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.model).toBe(MODEL);
    expect(req.tools.map((t) => t.function.name)).toEqual(['cite']);
    expect(req.text.format.type).toBe('json_schema');
    expect(Array.isArray(req.input) && req.input[0].content.some((c) => c.type === 'input_image' && c.imageUrl === `data:image/png;base64,${PNG.toString('base64')}`)).toBe(true);
    expect(list.other).toEqual([]);

    // The receipt seals the qualified outcome and the reported cost.
    const receipt = sealed.at(-1)!;
    expect(receipt).toMatchObject({ kind: 'observe', status: 'ok', cost_usd: 0.003, model_requested: MODEL, model_resolved: MODEL });
    expect((receipt.observation as Record<string, any>).qualified).toEqual({
      status: 'admitted', model: MODEL, run_id: q.run_id, source_revision: PNG_SHA, cites: q.cites.map((c: { handle_id: string }) => c.handle_id),
      raw_output_sha256: sha(q.raw_output), cost_usd: 0.003,
    });
    expect(notes.join('\n')).toMatch(/answered, citing mean_color, qr_codes_decoded \(measured values; the answer is a claim/);

    // observation-check: verified (the receipt sealed exactly this file, citations consistent, image unchanged).
    expect(check(root, outcome.file, chain())).toMatchObject({ status: 'verified', reasons: [] });
  });

  it('/observe <file> --qualify [question] takes the qualified route; without --qualify the plain route is unchanged', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const fake = fakeModel(citesTwo);
    const { ws } = make(root, fake.client);
    const lines = text(await ws.observe('refs/card.png --qualify What does the card say?'));
    expect(lines).toMatch(/an answer admitted only if it cites Look's measurements/);
    await fake.called;
    // The plain route asks through fetch (describeImage); the qualified one never does.
    const outcome = await (async () => { for (let i = 0; i < 200; i++) { const r = text(ws.results('')); if (/model interpretation/.test(r)) return r; await new Promise((r2) => setTimeout(r2, 25)); } return text(ws.results('')); })();
    expect(outcome).toMatch(/refs\/card\.png/);
    expect(fake.requests[0].input).toBeDefined();
    const shown = JSON.parse(String((fake.requests[0].input as Array<{ content: Array<{ type: string; text?: string }> }>)[0].content[0].text)) as Shown;
    expect(shown.question).toBe('What does the card say?');
    expect(text(await ws.observe('--qualify refs/card.png'))).toMatch(/an answer admitted only if it cites/);
    const usage = text(await ws.observe(''));
    expect(usage).toContain('--qualify');
  });
});

describe('/observe --qualify: refused answers keep their raw output', () => {
  const cases: Array<{ name: string; refusal: string; script: (first?: Shown) => Script }> = [
    { name: 'a handle listed but never cited', refusal: 'uncited_handle', script: () => async ({ shown, round }) => { await round({ id: 'fake-round-1', usage: { cost: 0.001, totalTokens: 1 } }); return envelope(shown, [handleOf(shown, 'mean_color')]); } },
    {
      name: 'a handle from another run', refusal: 'unknown_handle', script: (first) => async ({ shown, cite }) => {
        const foreign = handleOf(first!, 'mean_color');
        await cite(foreign).catch(() => undefined); // the real cite tool refuses a handle this run never observed
        return envelope(shown, [foreign]);
      },
    },
    { name: 'the wrong image revision', refusal: 'wrong_revision', script: () => async ({ shown, cite }) => { await cite(handleOf(shown, 'mean_color')); return envelope({ ...shown, source_revision: 'cd'.repeat(32) }, [handleOf(shown, 'mean_color')]); } },
    { name: 'another run id', refusal: 'wrong_run', script: () => async ({ shown, cite }) => { await cite(handleOf(shown, 'mean_color')); return envelope({ ...shown, run_id: '00000000-0000-4000-8000-000000000000' }, [handleOf(shown, 'mean_color')]); } },
    { name: 'invalid JSON', refusal: 'invalid_output', script: () => async ({ shown, cite }) => { await cite(handleOf(shown, 'mean_color')); return `Sure! Here it is: ${envelope(shown, [handleOf(shown, 'mean_color')])}`; } },
    { name: 'a plain UNKNOWN (no observation bears on the question)', refusal: 'invalid_output', script: () => async () => 'UNKNOWN' },
    { name: 'extra fields', refusal: 'invalid_output', script: () => async ({ shown, cite }) => { await cite(handleOf(shown, 'mean_color')); return envelope(shown, [handleOf(shown, 'mean_color')], { confidence: 0.99 }); } },
  ];
  for (const c of cases) {
    it(`${c.name}: refused (${c.refusal}), the raw output exactly as returned, the cost kept, no answer admitted`, async () => {
      const root = temp('proj-');
      put(root, 'refs/card.png', PNG);
      // For "another run": a first, admitted run whose handles the second run's answer reuses.
      let first: Shown | undefined;
      if (c.refusal === 'unknown_handle') {
        const prior = fakeModel(async (x) => { first = x.shown; return citesTwo(x); });
        const { ws: ws0 } = make(root, prior.client);
        await observeQualified(ws0);
      }
      let raw = '';
      const script = c.script(first);
      const fake = fakeModel(async (x) => { raw = await script(x); return raw; });
      const { ws, sealed, chain } = make(root, fake.client);
      const { outcome } = await observeQualified(ws);
      const record = readRecord(root, outcome.file);
      expect(record.tiers).toEqual(['deterministic computation']);
      expect(record.qualified).toMatchObject({ status: 'refused', refusal: c.refusal, raw_output: raw, source_revision: PNG_SHA, model: MODEL });
      expect(record.qualified.answer).toBeUndefined();
      expect(record.qualified.cites).toBeUndefined();
      expect(typeof record.qualified.cost_usd).toBe('number');
      if (raw === 'UNKNOWN') expect(record.qualified.reason).toMatch(/replied UNKNOWN/);
      expect((sealed.at(-1)!.observation as Record<string, any>).qualified).toMatchObject({ status: 'refused', refusal: c.refusal, raw_output_sha256: sha(raw), cites: [] });
      expect(sealed.at(-1)!.cost_usd).toBe(record.qualified.cost_usd);
      // A refused answer is a faithful record: its measurements stay verified; the refusal is not a claim.
      expect(check(root, outcome.file, chain())).toMatchObject({ status: 'verified' });
    });
  }

  it('a raw output longer than 64 KB is kept up to 64 KB and flagged', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const long = 'x'.repeat(70 * 1024);
    const { ws } = make(root, fakeModel(async () => long).client);
    const { outcome } = await observeQualified(ws);
    const q = readRecord(root, outcome.file).qualified;
    expect(q).toMatchObject({ status: 'refused', refusal: 'invalid_output', raw_output_truncated: true, raw_output_bytes: long.length });
    expect(Buffer.byteLength(q.raw_output)).toBe(64 * 1024);
  });
});

describe('/observe --qualify: lifecycle', () => {
  it('/stop mid-call: cancelled, no admission, the cost unknown (sent), sealed as cost_measured: false', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    // A fake that cites, then never answers and ignores its signal: the stop must not wait for it.
    const fake = fakeModel(async ({ shown, cite }) => { await cite(handleOf(shown, 'mean_color')); return new Promise<string>(() => undefined); });
    const { ws, sealed } = make(root, fake.client);
    const started = await ws.observeFile('refs/card.png', 'What is it?', undefined, { qualify: true });
    if (!started.ok) throw new Error(started.error);
    await fake.called;
    expect(text(ws.jobsView(''))).toMatch(/measured; interpreting with fake\/vision-model/);
    const stopped = text(await ws.stop(started.job.id));
    expect(stopped).toContain(`${started.job.id} stopped the model interpretation; the measurement had completed`);
    expect(stopped).toMatch(/may still be charged/);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    const q = readRecord(root, outcome.file).qualified;
    expect(q).toMatchObject({ status: 'cancelled', cost_usd: null, reason: expect.stringMatching(/may still be charged/) });
    expect(q.cites).toBeUndefined();
    expect(q.answer).toBeUndefined();
    expect(readRecord(root, outcome.file).tiers).toEqual(['deterministic computation']);
    const receipt = sealed.at(-1)!;
    expect(receipt).toMatchObject({ cost_measured: false, observation: { qualified: { status: 'cancelled', cost_usd: null } } });
    expect(receipt.cost_usd).toBeUndefined();
  });

  it('/stop all reaches a qualified exchange in flight', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const fake = fakeModel(({ signal }) => new Promise<string>((_r, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
    const { ws } = make(root, fake.client);
    const started = await ws.observeFile('refs/card.png', 'What is it?', undefined, { qualify: true });
    if (!started.ok) throw new Error(started.error);
    await fake.called;
    expect(text(await ws.stop('all'))).toMatch(/Stopped 1 model interpretation; its measurement had completed/);
    const outcome = await started.done;
    expect(outcome.ok && outcome.qualified).toMatchObject({ status: 'cancelled', cost_usd: null });
  });

  it('a stop before the request goes out: nothing sent, no cost recorded at all', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const fake = fakeModel(citesTwo);
    const slow = modelsList({ hang: true });
    const { ws, sealed } = make(root, fake.client, { fetch: slow.fn });
    const started = await ws.observeFile('refs/card.png', 'What is it?', undefined, { qualify: true });
    if (!started.ok) throw new Error(started.error);
    await slow.asked;
    await ws.stop(started.job.id);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    const q = readRecord(root, outcome.file).qualified;
    expect(q).toMatchObject({ status: 'cancelled', reason: expect.stringMatching(/nothing was asked/) });
    expect('cost_usd' in q).toBe(false);
    expect(fake.requests).toHaveLength(0);
    expect(sealed.at(-1)!.cost_usd).toBeUndefined();
    expect(sealed.at(-1)!.cost_measured).toBeUndefined();
  });

  it('the image changes while the model answers: rejected (stale), raw output and the reported cost kept and sealed', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    let raw = '';
    const fake = fakeModel(async (x) => { raw = await citesTwo(x); appendFileSync(join(root, 'refs/card.png'), Buffer.from([9])); return raw; });
    const { ws, sealed, notes } = make(root, fake.client);
    const { outcome } = await observeQualified(ws);
    const record = readRecord(root, outcome.file);
    expect(record.tiers).toEqual(['deterministic computation']);
    expect(record.qualified).toMatchObject({ status: 'rejected', refusal: 'stale_context', raw_output: raw, cost_usd: 0.003, reason: expect.stringContaining('changed between Look and the answer') });
    expect(record.qualified.cites).toBeUndefined();
    expect(sealed.at(-1)).toMatchObject({ cost_usd: 0.003, observation: { qualified: { status: 'rejected', cost_usd: 0.003, raw_output_sha256: sha(raw) } } });
    expect(notes.join('\n')).toMatch(/no admitted answer: rejected \(stale_context\)/);
  });

  it('the image changed before the model was asked: rejected, nothing sent, no cost', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const fake = fakeModel(citesTwo);
    const { ws, sealed } = make(root, fake.client, { env: { TIMMY_VISION_PYTHON: fakePython({ touch: true }), OPENROUTER_API_KEY: 'test-key-not-real' } });
    const { outcome } = await observeQualified(ws);
    const q = readRecord(root, outcome.file).qualified;
    expect(q).toMatchObject({ status: 'rejected', refusal: 'stale_context', raw_output: '', image_sent: false, reason: expect.stringContaining('nothing was sent') });
    expect('cost_usd' in q).toBe(false);
    expect(fake.requests).toHaveLength(0);
    expect(sealed.at(-1)!.cost_usd).toBeUndefined();
  });

  it('a failed exchange (the client throws after sending): failed, cost unknown, nothing admitted', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const { ws, sealed } = make(root, fakeModel(async () => { throw new Error('upstream 502'); }).client);
    const { outcome } = await observeQualified(ws);
    const q = readRecord(root, outcome.file).qualified;
    expect(q).toMatchObject({ status: 'failed', refusal: 'execution_failed', cost_usd: null, reason: expect.stringContaining('upstream 502') });
    expect(sealed.at(-1)).toMatchObject({ cost_measured: false });
  });

  it('a question it cannot ask (over 2000 characters): not asked, the measurement still recorded', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const fake = fakeModel(citesTwo);
    const { ws, sealed } = make(root, fake.client);
    const { outcome } = await observeQualified(ws, 'x'.repeat(2001));
    const q = readRecord(root, outcome.file).qualified;
    expect(q).toMatchObject({ status: 'not asked', reason: expect.stringContaining('1–2000') });
    expect(fake.requests).toHaveLength(0);
    expect(sealed.at(-1)).toMatchObject({ kind: 'observe', status: 'ok' });
  });

  it('no deterministic value to cite (an empty Look): not asked, no request, no cost', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const dir = temp('fake-python-empty-');
    const js = join(dir, 'look.mjs');
    writeFileSync(js, [
      "import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs';",
      "const a = process.argv.slice(2); if (a[0] === '-c') { console.log('5.0.0-fake'); process.exit(0); }",
      "const b = readFileSync(a[1]); const as = a[a.indexOf('--as') + 1];",
      "console.log(JSON.stringify({ ok: true, worker: { name: 'timmy-look', version: 'fake' }, opencv: 'fake', python: 'fake', source: { path: as, sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length }, image: { width: 4, height: 2, channels: 3 }, measurements: [], uncertainty: [] }));",
    ].join('\n'));
    writeFileSync(join(dir, 'python'), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
    chmodSync(join(dir, 'python'), 0o755);
    const fake = fakeModel(citesTwo);
    const { ws } = make(root, fake.client, { env: { TIMMY_VISION_PYTHON: join(dir, 'python'), OPENROUTER_API_KEY: 'test-key-not-real' } });
    const { outcome } = await observeQualified(ws);
    const q = readRecord(root, outcome.file).qualified;
    expect(q).toMatchObject({ status: 'not asked', refusal: 'no_observations' });
    expect('cost_usd' in q).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('/board and observation-check: admitted vs refused vs tampered', () => {
  async function admittedFile() {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const { ws, chain } = make(root, fakeModel(citesTwo).client);
    const { outcome } = await observeQualified(ws);
    return { root, ws, chain, file: outcome.file };
  }
  const card = (root: string, file: string, chain: Receipt[], record?: Record<string, unknown>) => {
    const json = record ?? readRecord(root, file);
    const bytes = record ? Buffer.from(JSON.stringify(record)) : readFileSync(join(root, file));
    const o = readObservationRecord(file, json, { fileSha256: sha(bytes), currentSourceSha256: sha(readFileSync(join(root, 'refs/card.png'))), receipts: chain });
    return renderBoard({ project: 'p', madeAt: 'now', base: '../../', references: [], workflows: [], jobs: [], outputs: [], observations: [o!] });
  };

  it('an admitted answer on a verified card: "model answer, cites …" with the cited values as measured, still a claim', async () => {
    const { root, chain, file, ws } = await admittedFile();
    const html = card(root, file, chain());
    expect(html).toContain('model answer, cites mean_color, qr_codes_decoded (measured)');
    expect(html).toMatch(/class="qualified"/);
    expect(html).toMatch(/#070707.*measured · cited as ev:/s);
    expect(html).toContain('the answer itself is not a measurement');
    expect(html).toContain('semantic correctness not verified');
    expect(html).toContain('cost $0.0030');
    // The board the REPL writes shows the same.
    text(ws.board(''));
    const page = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    expect(page).toContain('model answer, cites mean_color, qr_codes_decoded (measured)');
    expect(page).toContain('status-verified');
  });

  it('a refused answer: "no admitted model answer", the reason, and the raw output labelled not a claim', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const { ws, chain } = make(root, fakeModel(async ({ shown }) => envelope(shown, [handleOf(shown, 'mean_color')])).client);
    const { outcome } = await observeQualified(ws);
    const html = card(root, outcome.file, chain());
    expect(html).toContain('no admitted model answer');
    expect(html).toContain('refused (uncited_handle)');
    expect(html).toContain('raw output, kept exactly as returned; not a claim');
    expect(html).not.toContain('model answer, cites');
    expect(html).not.toMatch(/class="claim"/);
  });

  it('an edited record whose citation values no longer match: not verified, with the reasons, nothing drawn as measured', async () => {
    const { root, chain, file } = await admittedFile();
    const record = readRecord(root, file);
    record.qualified.cites[0].value = { r: 200, g: 0, b: 0, hex: '#c80000' };
    writeFileSync(join(root, file), JSON.stringify(record, null, 2));
    const c = check(root, file, chain());
    expect(c.status).toBe('unverified');
    expect(c.reasons.join('\n')).toMatch(/the file changed after it was sealed/);
    expect(c.reasons.join('\n')).toMatch(/cites mean_color with a value this record's measurement does not have/);
    const html = card(root, file, chain());
    expect(html).toContain('model answer, cites mean_color, qr_codes_decoded (not verified)');
    expect(html).toContain('as recorded, not verified');
    expect(html).not.toContain('(measured)');
  });

  // The qualified checks hold on their own, even for a file whose receipt (self-consistent) seals its exact bytes.
  describe('checkObservation on a record its receipt seals exactly', () => {
    async function resealed(edit: (q: Record<string, any>, record: Record<string, any>) => void, sealEdit?: (s: Record<string, any>, observation: Record<string, any>) => void) {
      const { root, chain, file } = await admittedFile();
      const record = readRecord(root, file);
      edit(record.qualified, record);
      const bytes = JSON.stringify(record);
      const original = chain().at(-1)! as unknown as Record<string, any>;
      const body: Record<string, any> = structuredClone({ ...original, outputs: [{ path: file, sha256: sha(bytes), bytes: bytes.length }] });
      delete body.hash;
      sealEdit?.(body.observation.qualified, body.observation);
      const receipt = { ...body, hash: hashOf({ ...body, hash: '' }) } as unknown as Receipt;
      return checkObservation({ record, file, fileSha256: sha(bytes), currentSourceSha256: PNG_SHA, receipts: [receipt] });
    }
    it('unchanged: verified', async () => {
      expect(await resealed(() => undefined)).toMatchObject({ status: 'verified', reasons: [] });
    });
    it('a citation that is not in the raw output it was admitted from', async () => {
      const c = await resealed((q) => { q.cites.reverse(); }, (s) => { s.cites.reverse(); });
      expect(c.status).toBe('unverified');
      expect(c.reasons.join('\n')).toMatch(/citations, run or image are not those of the raw output/);
    });
    it('bound to another image revision', async () => {
      const c = await resealed((q) => { q.source_revision = 'cd'.repeat(32); }, (s) => { s.source_revision = 'cd'.repeat(32); });
      expect(c.reasons.join('\n')).toMatch(/bound to image sha256 cdcdcdcdcdcd, not the record's/);
    });
    it('a claim that its correctness was verified', async () => {
      const c = await resealed((q) => { q.semantic_correctness_verified = true; });
      expect(c.reasons.join('\n')).toMatch(/says its correctness was verified/);
    });
    it('a cite naming a value that is not a deterministic measurement', async () => {
      const c = await resealed((q) => { q.cites[0].measurement = 'depth_guess'; });
      expect(c.reasons.join('\n')).toMatch(/cites depth_guess, which is not a deterministic measurement/);
    });
    it('a receipt that sealed different citations', async () => {
      const c = await resealed(() => undefined, (s) => { s.cites = [s.cites[0]]; });
      expect(c.reasons.join('\n')).toMatch(/is not the one its receipt sealed/);
    });
    it('a receipt that sealed no qualified answer', async () => {
      const c = await resealed(() => undefined, (_s, observation) => { delete observation.qualified; });
      expect(c.status).toBe('unverified');
      expect(c.reasons.join('\n')).toMatch(/sealed no qualified model answer, but the file records one/);
    });
    it('a qualified answer the file no longer records', async () => {
      const c = await resealed((_q, record) => { delete record.qualified; });
      expect(c.reasons.join('\n')).toMatch(/sealed a qualified model answer that the file no longer records/);
    });
  });
});

describe('the agent tool: describe_image with qualify', () => {
  it('runs the qualified route through the workspace and returns the admitted answer with its cites, a claim', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const { ws } = make(root, fakeModel(citesTwo).client);
    const tools = createVisionTools({ root: () => root, observe: async (rel, question, model, opts) => { const s = await ws.observeFile(rel, question, model, opts); return s.ok ? s.done : s; }, model: () => MODEL });
    const exec = (name: string, args: Record<string, unknown>) => (tools.find((t) => t.function.name === name)!.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, any>> }).execute(args);
    const r = await exec('describe_image', { path: 'refs/card.png', question: 'What does the card say?', qualify: true });
    expect(r).toMatchObject({ ok: true, qualified: true, model: MODEL, semantic_correctness_verified: false, cost_usd: 0.003, recorded: true });
    expect(r.cites.map((c: { measurement: string }) => c.measurement)).toEqual(['mean_color', 'qr_codes_decoded']);
    const refused = createVisionTools({ root: () => root, model: () => MODEL });
    const r2 = await (refused.find((t) => t.function.name === 'describe_image')!.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, any>> }).execute({ path: 'refs/card.png', question: 'q', qualify: true });
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('--qualify') });
  });
});
