// H20 (round R4; review of 07f37ec, findings 1 and 2, item M8): a paid answer and its cost survive an observation
// file that cannot be written; the complete raw model output is kept when the record keeps only its first 64 KiB;
// responses without ids are not counted twice by the cost meter.
//
// Every model here is a LABELLED FAKE (fakeModel, plainOpenRouter): no network, no paid call. Look is a labelled
// fake Python (fakePython), run as a real child process. The files, folders and permissions are real, in os.tmpdir().
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkObservation } from '../src/evidence/observation-check.js';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import type { InterpretationRequest } from '../src/vision/evidence.js';
import { keepPrivate } from '../src/vision/kept.js';
import { resetLookChecks } from '../src/vision/look.js';
import { meteredQualifyClient, type QualifyClient } from '../src/vision/qualify-route.js';
import { describeImage, resetImageModelCache } from '../src/vision/route.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
const MODEL = 'fake/vision-model';
const PLAIN = 'anthropic/claude-haiku-4.5';
const KB64 = 64 * 1024;
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const mode = (p: string): number => statSync(p).mode & 0o777;
afterEach(async () => {
  resetLookChecks();
  resetImageModelCache();
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) {
    // A test may leave a folder read-only: make it writable again so it can be removed.
    try { chmodSync(join(d, 'results'), 0o755); } catch { /* none */ }
    rmSync(d, { recursive: true, force: true });
  }
});

/** A labelled test double for a Python with OpenCV: prints a Look observation with deterministic values. */
function fakePython(): string {
  const dir = temp('fake-python-');
  const js = join(dir, 'fake-look.mjs');
  writeFileSync(js, [
    "import { createHash } from 'node:crypto';",
    "import { readFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "if (args[0] === '-c') { console.log('5.0.0-fake'); process.exit(0); }",
    "const bytes = readFileSync(args[1]); const as = args[args.indexOf('--as') + 1];",
    "const D = 'deterministic computation';",
    'const measurements = [',
    "  { name: 'mean_color', value: { r: 7, g: 7, b: 7, hex: '#070707' }, unit: 'sRGB 8-bit, uncalibrated', tier: D, note: '' },",
    "  { name: 'sharpness', value: 0, unit: 'variance of the Laplacian', tier: D, note: '' },",
    "  { name: 'qr_codes_decoded', value: [{ text: 'CARD-0042' }], unit: 'decoded text', tier: D, note: '' },",
    '];',
    "console.log(JSON.stringify({ ok: true, worker: { name: 'timmy-look', version: 'fake' }, opencv: '5.0.0-fake', python: 'fake', source: { path: as, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, image: { width: 4, height: 2, channels: 3 }, measurements, uncertainty: ['test double'] }));",
  ].join('\n'));
  const sh = join(dir, 'python');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

/**
 * A LABELLED FAKE of OpenRouter (a fetch): its models list says both fake models take images; a chat request (the
 * plain interpretation) answers `content` with `usage`. Nothing leaves the process.
 */
function plainOpenRouter(o: { content?: string; usage?: Record<string, unknown> } = {}) {
  const posts: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [MODEL, PLAIN].map((id) => ({ id, architecture: { input_modalities: ['text', 'image'] } })) }), { status: 200 });
    }
    posts.push(String(init?.body));
    return new Response(JSON.stringify({ model: PLAIN, choices: [{ message: { content: o.content ?? 'A grey test card.' } }], usage: o.usage ?? { cost: 0.0021, total_tokens: 900 } }), { status: 200 });
  }) as typeof fetch;
  return { fn, posts };
}

interface Shown { question: string; run_id: string; source_revision: string; observations: Array<{ handle_id: string; measurement: string }> }
interface Ctx { req: InterpretationRequest; shown: Shown; cite: (id: string) => Promise<unknown>; round: (response: Record<string, unknown>) => Promise<void> }
type Script = (c: Ctx) => Promise<string>;

/**
 * A LABELLED FAKE model client shaped like @openrouter/sdk's callModel (as in tests/observe-qualify.test.ts): it
 * calls the controller's real cite tool, reports tool rounds through the request's stop condition, then answers.
 * `final` is what getResponse() gives: by default a final response with an id and a reported cost.
 */
function fakeModel(script: Script, final: () => Record<string, unknown> = () => ({ id: 'fake-final', model: MODEL, usage: { cost: 0.002, totalTokens: 300 } })) {
  const requests: InterpretationRequest[] = [];
  const client: QualifyClient = {
    callModel(req) {
      requests.push(req);
      const textPart = typeof req.input === 'string' ? req.input : String(req.input[0].content.find((c) => c.type === 'input_text')!.text);
      const shown = JSON.parse(textPart) as Shown;
      const cite = (handle_id: string): Promise<unknown> => req.tools[0].function.execute({ handle_id }, undefined as never) as Promise<unknown>;
      const rounds: Array<Record<string, unknown>> = [];
      const round = async (response: Record<string, unknown>): Promise<void> => { rounds.push(response); await req.stopWhen({ steps: rounds.map((r) => ({ response: r })) as never }); };
      const out = script({ req, shown, cite, round });
      return { getText: () => out, getResponse: async () => { await out; return final(); } };
    },
  };
  return { client, requests };
}
const handleOf = (shown: Shown, name: string): string => shown.observations.find((o) => o.measurement === name)!.handle_id;
const ANSWER = 'A dark grey card with the QR code CARD-0042.';
const envelope = (shown: Shown, handles: string[]): string =>
  JSON.stringify({ run_id: shown.run_id, source_revision: shown.source_revision, evidence: { answer: handles }, payload: { answer: ANSWER } });
/** Cites two handles in one tool round (cost 0.001), then answers with the exact envelope (final cost 0.002). */
const citesTwo: Script = async ({ shown, cite, round }) => {
  await cite(handleOf(shown, 'mean_color'));
  await cite(handleOf(shown, 'qr_codes_decoded'));
  await round({ id: 'fake-round-1', usage: { cost: 0.001, totalTokens: 200 } });
  return envelope(shown, [handleOf(shown, 'mean_color'), handleOf(shown, 'qr_codes_decoded')]);
};

/** Receipts as the runs chain keeps them: each hashes to its own body, so checkObservation can match them. */
function make(root: string, o: { client?: QualifyClient; fetch?: typeof fetch; model?: string } = {}, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const jobsDir = join(temp('jobs-'), 'jobs');
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
    jobsDir,
    chdir: () => {},
    receipts: chain,
    model: () => o.model ?? MODEL,
    fetch: o.fetch ?? plainOpenRouter().fn,
    ...(o.client ? { qualifyClient: () => o.client! } : {}),
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed, chain, jobsDir };
}

async function observe(ws: Workspace, o: { question?: string; qualify?: boolean } = {}) {
  const started = await ws.observeFile('refs/card.png', o.question ?? 'What does the card say?', undefined, o.qualify ? { qualify: true } : undefined);
  if (!started.ok) throw new Error(started.error);
  return { id: started.job.id, outcome: await started.done };
}
const json = (p: string): Record<string, any> => JSON.parse(readFileSync(p, 'utf8'));
/** What /board's check reads of a kept file: a project file under .timmy/kept/ (null when it is not there). */
const projectReader = (root: string) => (ref: { path: string; store?: string }): Buffer | null | undefined =>
  ref.store ? undefined : existsSync(join(root, ref.path)) ? readFileSync(join(root, ref.path)) : null;
const check = (root: string, file: string, chain: Receipt[], readKept?: ReturnType<typeof projectReader>) => checkObservation({
  record: json(join(root, file)), file, fileSha256: sha(readFileSync(join(root, file))), currentSourceSha256: sha(readFileSync(join(root, 'refs/card.png'))), receipts: chain,
  ...(readKept ? { readKept } : {}),
} as Parameters<typeof checkObservation>[0]);

// ── Finding 1 ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('H20 finding 1: a paid answer and its cost survive an observation file that cannot be written', () => {
  it('qualified, results/observations is a regular file: a failed receipt seals the cost, the model and the hashes; the whole record is kept in the project (0600)', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'a file where the folder should be');
    let raw = '';
    const fake = fakeModel(async (c) => { raw = await citesTwo(c); return raw; });
    const { ws, sealed, notes } = make(root, { client: fake.client });
    const { id, outcome } = await observe(ws, { qualify: true });
    expect(outcome.ok).toBe(false);
    expect(fake.requests).toHaveLength(1);

    // The receipt: failed, with the storage error, what was spent and who answered, and the hashes of what came back.
    const receipt = sealed.at(-1)! as Record<string, any>;
    expect(receipt).toMatchObject({ kind: 'observe', status: 'failed', cost_usd: 0.003, model_requested: MODEL, model_resolved: MODEL, tokens: 500 });
    expect(receipt).not.toHaveProperty('cost_measured');
    expect(receipt.observation.error).toMatch(/could not be written.*a file is in the way of its folder/);
    expect(receipt.observation.qualified).toMatchObject({ status: 'admitted', model: MODEL, raw_output_sha256: sha(raw), answer_sha256: sha(ANSWER), cost_usd: 0.003 });
    // Where the whole record is kept, and its bytes.
    const kept = receipt.observation.kept;
    expect(kept).toMatchObject({ path: `.timmy/kept/observations/${id}.json` });
    const bytes = readFileSync(join(root, kept.path));
    expect(kept.sha256).toBe(sha(bytes));
    expect(kept.bytes).toBe(bytes.length);
    expect(mode(join(root, kept.path))).toBe(0o600);
    // The kept record holds the measurements, the answer, the raw output, the cites and the cost.
    const record = JSON.parse(bytes.toString('utf8'));
    expect(record.look.measurements).toHaveLength(3);
    expect(record.qualified).toMatchObject({ status: 'admitted', answer: ANSWER, raw_output: raw, raw_output_sha256: sha(raw), cost_usd: 0.003, tokens: 500 });
    expect(record.qualified.cites.map((c: { measurement: string }) => c.measurement)).toEqual(['mean_color', 'qr_codes_decoded']);
    expect(record.not_written.reason).toMatch(/a file is in the way of its folder/);

    // The notice says plainly that the file could not be written, why, and where the answer and its cost are.
    const said = notes.join('\n');
    expect(said).toMatch(new RegExp(`${id} not observed`));
    expect(said).toMatch(/the observation file could not be written \(.*a file is in the way of its folder\)/);
    expect(said).toContain(`kept at .timmy/kept/observations/${id}.json`);
    expect(said).toMatch(/the model's answer and its cost \(\$0\.0030\)/);
    if (!outcome.ok) expect(outcome.error).toContain(`.timmy/kept/observations/${id}.json`);
    // The file in the way is left exactly as it was.
    expect(readFileSync(join(root, 'results/observations'), 'utf8')).toBe('a file where the folder should be');
    // /results finds the kept record from the receipt.
    expect(text(ws.results(''))).toContain(`.timmy/kept/observations/${id}.json`);
  });

  it('plain interpretation, results/observations is a regular file: the answer, the model and the cost are kept and sealed', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'in the way');
    const api = plainOpenRouter({ usage: { cost: 0.0021, total_tokens: 900 } });
    const { ws, sealed, notes } = make(root, { fetch: api.fn, model: PLAIN });
    const { id, outcome } = await observe(ws, { question: 'What is on the card?' });
    expect(outcome.ok).toBe(false);
    expect(api.posts).toHaveLength(1);
    const receipt = sealed.at(-1)! as Record<string, any>;
    expect(receipt).toMatchObject({ kind: 'observe', status: 'failed', cost_usd: 0.0021, model_requested: PLAIN, model_resolved: PLAIN, tokens: 900 });
    expect(receipt.observation.interpretation).toMatchObject({ status: 'answered', model: PLAIN, cost_usd: 0.0021, answer_sha256: sha('A grey test card.') });
    const record = json(join(root, receipt.observation.kept.path));
    expect(record.interpretation).toMatchObject({ status: 'answered', answer: 'A grey test card.', cost_usd: 0.0021, model: PLAIN });
    expect(sha(readFileSync(join(root, receipt.observation.kept.path)))).toBe(receipt.observation.kept.sha256);
    expect(notes.join('\n')).toContain(`kept at .timmy/kept/observations/${id}.json`);
  });

  it('the project\'s results folder is read-only (chmod 0555): the record is kept in the project\'s .timmy/kept instead', async (ctx) => {
    ctx.skip(process.getuid?.() === 0, 'running as root: chmod does not stop root from writing, so a read-only folder cannot be made here');
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    mkdirSync(join(root, 'results'));
    chmodSync(join(root, 'results'), 0o555);
    const { ws, sealed } = make(root, { client: fakeModel(citesTwo).client });
    const { id, outcome } = await observe(ws, { qualify: true });
    expect(outcome.ok).toBe(false);
    const receipt = sealed.at(-1)! as Record<string, any>;
    expect(receipt).toMatchObject({ status: 'failed', cost_usd: 0.003, observation: { kept: { path: `.timmy/kept/observations/${id}.json` } } });
    expect(receipt.observation.error).toMatch(/EACCES/);
    expect(json(join(root, receipt.observation.kept.path)).qualified.status).toBe('admitted');
  });

  it("the project cannot hold the copy either (.timmy is a regular file): it is kept in Timmy's own jobs folder, and said so", async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'in the way');
    put(root, '.timmy', 'also in the way');
    const { ws, sealed, notes, jobsDir } = make(root, { client: fakeModel(citesTwo).client });
    const { id, outcome } = await observe(ws, { qualify: true });
    expect(outcome.ok).toBe(false);
    const receipt = sealed.at(-1)! as Record<string, any>;
    expect(receipt).toMatchObject({ status: 'failed', cost_usd: 0.003 });
    const kept = receipt.observation.kept;
    expect(kept).toMatchObject({ store: 'timmy', path: `observations/${id}.json` });
    const at = join(jobsDir, 'kept', kept.path);
    expect(sha(readFileSync(at))).toBe(kept.sha256);
    expect(mode(at)).toBe(0o600);
    expect(json(at).qualified).toMatchObject({ status: 'admitted', answer: ANSWER, cost_usd: 0.003 });
    expect(notes.join('\n')).toContain(`kept at ${at}`);
    // Nothing was written over the project's files.
    expect(readFileSync(join(root, '.timmy'), 'utf8')).toBe('also in the way');
  });

  it('nowhere to keep it: the receipt still seals the cost and the hashes, and says no copy could be kept', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'in the way');
    put(root, '.timmy', 'in the way');
    const { ws, sealed, notes, jobsDir } = make(root, { client: fakeModel(citesTwo).client });
    // The jobs folder is made with the first job; a file where Timmy's kept folder would go blocks it.
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(join(jobsDir, 'kept'), 'in the way too');
    const { outcome } = await observe(ws, { qualify: true });
    expect(outcome.ok).toBe(false);
    const receipt = sealed.at(-1)! as Record<string, any>;
    expect(receipt).toMatchObject({ status: 'failed', cost_usd: 0.003, model_requested: MODEL, observation: { qualified: { status: 'admitted', answer_sha256: sha(ANSWER) } } });
    expect(receipt.observation.kept).not.toHaveProperty('path');
    expect(receipt.observation.kept.error).toMatch(/in the project.*in Timmy's own folder/);
    expect(notes.join('\n')).toMatch(/could not be kept either/);
    expect(notes.join('\n')).toMatch(/\$0\.0030/);
  });
});

// ── Finding 2 ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('H20 finding 2: the complete model output is kept when the record keeps only its first 64 KiB', () => {
  it('a refused raw output over 64 KiB: the excerpt in the record, the whole in .timmy/kept/model-output (0600), its hashes sealed, and the check reads it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const long = `${'x'.repeat(70 * 1024)}TAIL-OF-THE-RAW-OUTPUT`;
    const { ws, sealed, chain } = make(root, { client: fakeModel(async () => long).client });
    const { id, outcome } = await observe(ws, { qualify: true });
    if (!outcome.ok) throw new Error(outcome.error);
    const q = json(join(root, outcome.file)).qualified;
    const excerpt = long.slice(0, KB64);
    expect(q).toMatchObject({
      status: 'refused', refusal: 'invalid_output', raw_output: excerpt, raw_output_truncated: true, raw_output_bytes: long.length,
      raw_output_sha256: sha(long), raw_output_full: { path: `.timmy/kept/model-output/${id}-raw.txt`, sha256: sha(long), bytes: long.length },
    });
    const at = join(root, q.raw_output_full.path);
    expect(readFileSync(at).equals(Buffer.from(long))).toBe(true);
    expect(mode(at)).toBe(0o600);
    // The receipt seals the whole raw output's sha256, and the cut part's.
    expect((sealed.at(-1)!.observation as Record<string, any>).qualified).toMatchObject({ raw_output_sha256: sha(long), raw_output_excerpt_sha256: sha(excerpt) });

    // The check: verified when the whole output is there with its sealed sha256; otherwise unverified, with the reason.
    expect(check(root, outcome.file, chain(), projectReader(root))).toMatchObject({ status: 'verified', reasons: [] });
    expect(check(root, outcome.file, chain()).reasons.join('\n')).toMatch(/whole raw output kept at .*was not checked here/);
    writeFileSync(at, `${long}!`);
    expect(check(root, outcome.file, chain(), projectReader(root)).reasons.join('\n')).toMatch(/whole raw output at .* is not the one recorded/);
    unlinkSync(at);
    const gone = check(root, outcome.file, chain(), projectReader(root));
    expect(gone.status).toBe('unverified');
    expect(gone.reasons.join('\n')).toMatch(/whole raw output is no longer at \.timmy\/kept\/model-output/);
  });

  it('the board shows the excerpt and says where the whole output is kept, and how big, without inlining it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const long = `${'y'.repeat(70 * 1024)}TAIL-OF-THE-RAW-OUTPUT`;
    const { ws } = make(root, { client: fakeModel(async () => long).client });
    const { id, outcome } = await observe(ws, { qualify: true });
    if (!outcome.ok) throw new Error(outcome.error);
    ws.board('');
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).toContain('status-verified');
    expect(html).toContain(`.timmy/kept/model-output/${id}-raw.txt`);
    expect(html).toMatch(/the whole of it \(70\.0 KB\) is kept at/);
    expect(html).not.toContain('TAIL-OF-THE-RAW-OUTPUT');
  });

  it('an admitted answer whose raw output runs past 64 KiB: admitted, the whole raw output kept, and the check compares the citations with the whole of it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    let raw = '';
    // Valid JSON padded with whitespace past the cap: the admission controller parses it, so it is admitted.
    const fake = fakeModel(async (c) => { raw = `${await citesTwo(c)}${' '.repeat(70 * 1024)}`; return raw; });
    const { ws, sealed, chain } = make(root, { client: fake.client });
    const { id, outcome } = await observe(ws, { qualify: true });
    if (!outcome.ok) throw new Error(outcome.error);
    const q = json(join(root, outcome.file)).qualified;
    expect(q).toMatchObject({ status: 'admitted', answer: ANSWER, answer_sha256: sha(ANSWER), raw_output_truncated: true, raw_output_sha256: sha(raw), raw_output_full: { path: `.timmy/kept/model-output/${id}-raw.txt`, bytes: raw.length } });
    expect(readFileSync(join(root, q.raw_output_full.path), 'utf8')).toBe(raw);
    expect((sealed.at(-1)!.observation as Record<string, any>).qualified).toMatchObject({ status: 'admitted', raw_output_sha256: sha(raw), answer_sha256: sha(ANSWER) });
    expect(check(root, outcome.file, chain(), projectReader(root))).toMatchObject({ status: 'verified', reasons: [] });
  });

  it('a plain answer over 64 KiB: the excerpt in the record, the whole answer kept, its sha256 sealed, the check verified with it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const huge = `${'é'.repeat(40_000)}THE-END`; // 80,007 bytes
    const api = plainOpenRouter({ content: huge, usage: { cost: 0.002 } });
    const { ws, sealed, chain, notes } = make(root, { fetch: api.fn, model: PLAIN });
    const { id, outcome } = await observe(ws, { question: 'Describe it.' });
    if (!outcome.ok) throw new Error(outcome.error);
    const i = json(join(root, outcome.file)).interpretation;
    expect(i).toMatchObject({ status: 'answered', answer_truncated: true, answer_bytes: Buffer.byteLength(huge), answer_sha256: sha(huge), answer_full: { path: `.timmy/kept/model-output/${id}-answer.txt`, sha256: sha(huge), bytes: Buffer.byteLength(huge) } });
    expect(Buffer.byteLength(i.answer)).toBeLessThanOrEqual(KB64);
    expect(huge.startsWith(i.answer)).toBe(true);
    const at = join(root, i.answer_full.path);
    expect(readFileSync(at).equals(Buffer.from(huge))).toBe(true);
    expect(mode(at)).toBe(0o600);
    expect((sealed.at(-1)!.observation as Record<string, any>).interpretation).toMatchObject({ status: 'answered', cost_usd: 0.002, answer_sha256: sha(huge), answer_excerpt_sha256: sha(i.answer) });
    expect(notes.join('\n')).toContain(`.timmy/kept/model-output/${id}-answer.txt`);
    expect(check(root, outcome.file, chain(), projectReader(root))).toMatchObject({ status: 'verified', reasons: [] });
    writeFileSync(at, 'something else');
    expect(check(root, outcome.file, chain(), projectReader(root)).reasons.join('\n')).toMatch(/whole model answer at .* is not the one recorded/);
    // The board shows the start of it and where the whole is.
    writeFileSync(at, huge);
    ws.board('');
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).toContain('status-verified');
    expect(html).toContain(`.timmy/kept/model-output/${id}-answer.txt`);
    expect(html).not.toContain('THE-END');
  });

  it('a record whose raw output was cut and names no file keeping the whole of it (written before H20) is unverified, with the reason', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const { ws, chain } = make(root, { client: fakeModel(async () => 'x'.repeat(70 * 1024)).client });
    const { outcome } = await observe(ws, { qualify: true });
    if (!outcome.ok) throw new Error(outcome.error);
    // As /observe wrote it before H20: the cut text, with neither the whole text's sha256 nor a file keeping it, sealed as such.
    const file = outcome.file;
    const record = json(join(root, file));
    delete record.qualified.raw_output_full;
    delete record.qualified.raw_output_sha256;
    const bytes = JSON.stringify(record);
    const original = chain().at(-1)! as unknown as Record<string, any>;
    const body: Record<string, any> = structuredClone({ ...original, outputs: [{ path: file, sha256: sha(bytes), bytes: bytes.length }] });
    delete body.hash;
    body.observation.qualified.raw_output_sha256 = sha(record.qualified.raw_output);
    delete body.observation.qualified.raw_output_excerpt_sha256;
    const receipt = { ...body, hash: hashOf({ ...body, hash: '' }) } as unknown as Receipt;
    const c = checkObservation({ record, file, fileSha256: sha(bytes), currentSourceSha256: PNG_SHA, receipts: [receipt], readKept: projectReader(root) } as Parameters<typeof checkObservation>[0]);
    expect(c.status).toBe('unverified');
    expect(c.reasons).toEqual([expect.stringMatching(/raw output was cut at 64 KB in the file, and the record names no file that keeps the whole of it/)]);
  });

  it('the refusal code and reason stay exactly as decided when the output is cut', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const { ws } = make(root, { client: fakeModel(async () => 'z'.repeat(70 * 1024)).client });
    const { outcome } = await observe(ws, { qualify: true });
    if (!outcome.ok) throw new Error(outcome.error);
    const q = json(join(root, outcome.file)).qualified;
    expect(q.refusal).toBe('invalid_output');
    expect(q.reason).toBe('the answer was not exactly the JSON envelope asked for (valid JSON, those fields and no others)');
  });
});

// ── The keeping itself ──────────────────────────────────────────────────────────────────────────────────────────

describe('H20: how a file is kept (real files)', () => {
  it('a name that is taken is never replaced: the kept file gets the next free name, and the file already there is untouched', () => {
    const root = temp('proj-');
    put(root, '.timmy/kept/observations/j0a0b0c.json', 'already here');
    const k = keepPrivate({ root }, 'observations', 'j0a0b0c.json', '{"new":1}\n');
    expect(k).toMatchObject({ ok: true, ref: { path: '.timmy/kept/observations/j0a0b0c-2.json', sha256: sha('{"new":1}\n'), bytes: 10 } });
    expect(readFileSync(join(root, '.timmy/kept/observations/j0a0b0c.json'), 'utf8')).toBe('already here');
    expect(readFileSync(join(root, '.timmy/kept/observations/j0a0b0c-2.json'), 'utf8')).toBe('{"new":1}\n');
    expect(mode(join(root, '.timmy/kept/observations/j0a0b0c-2.json'))).toBe(0o600);
    // No temporary file is left behind.
    expect(readdirSync(join(root, '.timmy/kept/observations')).sort()).toEqual(['j0a0b0c-2.json', 'j0a0b0c.json']);
  });

  it(".timmy is a link that leads out of the project: nothing is written through it; Timmy's own folder keeps the file", () => {
    const root = temp('proj-');
    const outside = temp('outside-');
    symlinkSync(outside, join(root, '.timmy'));
    const timmy = join(temp('timmy-'), 'kept');
    const k = keepPrivate({ root, timmy }, 'model-output', 'j0a0b0c-raw.txt', 'the whole output');
    expect(k).toMatchObject({ ok: true, ref: { store: 'timmy', path: 'model-output/j0a0b0c-raw.txt' } });
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(timmy, 'model-output/j0a0b0c-raw.txt'), 'utf8')).toBe('the whole output');
    // And with no Timmy folder either: kept nowhere, and said why.
    const none = keepPrivate({ root }, 'model-output', 'j0a0b0c-raw.txt', 'x');
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/in the project: .*leads outside the project.*in Timmy's own folder: none is known here/);
  });

  it('describeImage hands the whole of a long answer to keepWhole, says so when it is given none, and gives the sha256 either way', async () => {
    const dir = temp('route-');
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const huge = 'é'.repeat(40_000);
    const api = plainOpenRouter({ content: huge, usage: { cost: 0.01 } });
    const handed: string[] = [];
    const r = await describeImage({
      model: PLAIN, imagePath: image, question: 'q', apiKey: 'test-key-not-real', fetch: api.fn,
      keepWhole: (whole) => { handed.push(whole); return { path: '.timmy/kept/model-output/j0a0b0c-answer.txt', sha256: sha(whole), bytes: Buffer.byteLength(whole) }; },
    });
    if (!r.ok) throw new Error(r.error);
    expect(handed).toEqual([huge]);
    expect(r).toMatchObject({ answer_truncated: true, answer_bytes: 80_000, answer_sha256: sha(huge), answer_full: { path: '.timmy/kept/model-output/j0a0b0c-answer.txt', sha256: sha(huge) } });
    const none = await describeImage({ model: PLAIN, imagePath: image, question: 'q', apiKey: 'test-key-not-real', fetch: api.fn });
    expect(none.ok && none.answer_full).toEqual({ error: 'no place to keep the whole answer was given' });
    const brief = await describeImage({ model: PLAIN, imagePath: image, question: 'q', apiKey: 'test-key-not-real', fetch: plainOpenRouter({ content: 'brief' }).fn, keepWhole: () => { throw new Error('a short answer is not handed over'); } });
    expect(brief.ok && brief.answer_sha256).toBe(sha('brief'));
    expect(brief).not.toHaveProperty('answer_full');
  });
});

// ── M8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('M8: the cost meter counts each response once, and an ambiguous count is unknown, never a sum', () => {
  /** A LABELLED FAKE client: one tool round reported through stopWhen, then the final response. */
  const client = (round: unknown, final: unknown): QualifyClient => ({
    callModel(req) {
      const done = (async () => { await req.stopWhen({ steps: [{ response: round }] } as never); return 'text'; })();
      return { getText: () => done, getResponse: async () => { await done; return final; } };
    },
  });
  const run = async (round: unknown, final: unknown) => {
    const meter = meteredQualifyClient(client(round, final));
    await meter.client.callModel({ stopWhen: () => false } as unknown as InterpretationRequest).getText();
    return meter.spend();
  };

  it('no ids, and the final response is the last round\'s response object: counted once', async () => {
    const same = { model: MODEL, usage: { cost: 0.002, totalTokens: 300 } };
    expect(await run(same, same)).toMatchObject({ sent: true, cost_usd: 0.002, tokens: 300, responses: 1 });
  });

  it('no ids, and two different responses: summed', async () => {
    const spend = await run({ usage: { cost: 0.001, totalTokens: 200 }, output: [{ type: 'function_call', name: 'cite' }] }, { model: MODEL, usage: { cost: 0.002, totalTokens: 300 }, output: [{ type: 'message' }] });
    expect(spend).toMatchObject({ sent: true, cost_usd: 0.003, tokens: 500, responses: 2 });
  });

  it('ids present: by id, as before (the same id is one response, two ids are two)', async () => {
    expect(await run({ id: 'r1', usage: { cost: 0.002 } }, { id: 'r1', model: MODEL, usage: { cost: 0.002 } })).toMatchObject({ cost_usd: 0.002, responses: 1 });
    expect(await run({ id: 'r1', usage: { cost: 0.001 } }, { id: 'r2', model: MODEL, usage: { cost: 0.002 } })).toMatchObject({ cost_usd: 0.003, responses: 2 });
  });

  it('no ids, two separate objects that report the same output and usage (they may be one response): cost unknown, with the reason', async () => {
    const spend = await run({ usage: { cost: 0.002, totalTokens: 300 }, output: [{ type: 'message' }] }, { usage: { cost: 0.002, totalTokens: 300 }, output: [{ type: 'message' }] });
    expect(spend.cost_usd).toBeNull();
    expect(spend).not.toHaveProperty('tokens');
    expect(String((spend as { reason?: string }).reason)).toMatch(/no id/);
  });

  it('in /observe --qualify: the record says the cost is unknown and why, and the receipt seals cost_measured: false, never a sum', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const copy = (): Record<string, unknown> => ({ model: MODEL, usage: { cost: 0.002, totalTokens: 300 } });
    const fake = fakeModel(async (c) => { await c.cite(handleOf(c.shown, 'mean_color')); await c.round(copy()); return envelope(c.shown, [handleOf(c.shown, 'mean_color')]); }, copy);
    const { ws, sealed, notes } = make(root, { client: fake.client });
    const { outcome } = await observe(ws, { qualify: true });
    if (!outcome.ok) throw new Error(outcome.error);
    const q = json(join(root, outcome.file)).qualified;
    expect(q.status).toBe('admitted');
    expect(q.cost_usd).toBeNull();
    expect(q.cost_unknown_reason).toMatch(/no id/);
    expect(sealed.at(-1)).toMatchObject({ cost_measured: false });
    expect(sealed.at(-1)!.cost_usd).toBeUndefined();
    expect(notes.join('\n')).toMatch(/cost unknown/);
  });
});
