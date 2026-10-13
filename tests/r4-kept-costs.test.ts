// H30 (round R4): what R4 keeps, shown on the board, and costs shown honestly everywhere.
//
// 1. An observation whose file could not be written keeps its whole record (src/vision/kept.ts) and its failure
//    receipt seals it: the board gives it a result card of its own ("kept", never a verified measurement), checked
//    against that receipt; /results checks it the same way.
// 2. The receipt page: an unknown cost is "cost unknown (…)", never a number; a reported one is never shown as zero.
// 3. The turn's spend line counts what a describe_image call reported (a number, or unknown), each call once; the
//    turn's receipt seals only its own spend and names the observe receipt that sealed the tool's.
// 4. /results lists results/flows/*.json with the board's Flows check.
//
// FAKES, each labelled: Look's Python is fakePython (a test double run as a real child process); OpenRouter is
// fakeOpenRouter (a mocked fetch: no network, no paid call); the agent of a turn is FakeAgent (it replays items).
// The files, folders, records and receipts are real, in os.tmpdir(); receipts sealed through appendReceipt are signed
// into a temporary store.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVisionTools } from '../src/agent/vision-tools.js';
import { DOCTRINE_15, writeFlowRecord, type FlowRecord } from '../src/flows/iterate.js';
import { folderProject, projectId } from '../src/project/index.js';
import { checkKeptRecord, keptObservations } from '../src/repl/board-kept.js';
import { sealTurn } from '../src/repl/seal.js';
import { Transcript } from '../src/repl/transcript.js';
import { runTurn, toolSpent } from '../src/repl/turn.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { receiptFacts, receiptText, spendText } from '../src/studio/receipt-page.js';
import { startStudioServer } from '../src/studio/server.js';
import { detectCapabilities } from '../src/term/capabilities.js';
import { glyphSet } from '../src/term/glyphs.js';
import { LiveRegion } from '../src/term/live-region.js';
import { buildTheme } from '../src/term/theme.js';
import { appendReceipt, hashOf, readChain, verifyChain, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { resetLookChecks } from '../src/vision/look.js';
import { resetImageModelCache } from '../src/vision/route.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const MODEL = 'fake/vision-model';
const dirs: string[] = [];
const spaces: Workspace[] = [];
const closers: Array<() => Promise<void>> = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const lines = (l: { text: string }[][]): string => l.map((x) => x.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
afterEach(async () => {
  resetLookChecks();
  resetImageModelCache();
  for (const c of closers.splice(0)) await c();
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A LABELLED TEST DOUBLE for a Python with OpenCV: prints a Look observation with three deterministic values. */
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

/** A LABELLED FAKE of OpenRouter (a mocked fetch): the models list says MODEL takes images; a chat answers with `usage`. */
function fakeOpenRouter(usage: Record<string, unknown>) {
  const posts: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: MODEL, architecture: { input_modalities: ['text', 'image'] } }] }), { status: 200 });
    posts.push(String(init?.body));
    return new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content: 'A grey test card.' } }], usage }), { status: 200 });
  }) as typeof fetch;
  return { fn, posts };
}

/** A Workspace on a real project folder; receipts as the runs chain keeps them (each hashes to its own body). */
function make(root: string, fetch: typeof globalThis.fetch) {
  const sealed: ReceiptInput[] = [];
  const jobsDir = join(temp('jobs-'), 'jobs');
  const chain = (): Receipt[] => sealed.map((input, i) => {
    const body = { v: 1, id: `r${i}`, stream: 'runs', ts: `2026-10-09T10:00:${String(i).padStart(2, '0')}.000Z`, ...input } as Record<string, unknown>;
    return { ...body, hash: hashOf({ ...body, hash: '' }) } as unknown as Receipt;
  });
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true), env: { TIMMY_VISION_PYTHON: fakePython(), OPENROUTER_API_KEY: 'test-key-not-real' }, onPath: () => null,
    notify: () => {}, openWeb: (url) => url, link: (t) => t, seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir, chdir: () => {}, receipts: chain, model: () => MODEL, fetch,
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, sealed, chain, jobsDir };
}

async function observe(ws: Workspace) {
  const started = await ws.observeFile('refs/card.png', 'What does the card say?');
  if (!started.ok) throw new Error(started.error);
  return { id: started.job.id, outcome: await started.done };
}
const boardHtml = (ws: Workspace, root: string): string => { ws.board(''); return readFileSync(join(root, '.timmy/board/index.html'), 'utf8'); };
/** The result cards of one kind on the board. */
const cards = (html: string, kind: string): string[] => [...html.matchAll(new RegExp(`<article class="card result result-${kind}">([\\s\\S]*?)</article>`, 'g'))].map((m) => m[1]);
const shortOf = (r: Receipt): string => r.hash.slice(7, 15);

// ── 1. what R4 keeps, on the board and in /results ─────────────────────────────────────────────────────────────

describe('H30 (1): a kept observation record is a result card of its own, checked against the receipt that sealed it', () => {
  it('kept in the project, bytes as sealed: "kept", its receipt and cost, no values as measurements; tampered: unverified with why; gone: said so', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'a file where the folder should be');
    const { ws, sealed, chain } = make(root, fakeOpenRouter({ cost: 0.0021, total_tokens: 900 }).fn);
    const { id, outcome } = await observe(ws);
    expect(outcome.ok).toBe(false);
    const rel = `.timmy/kept/observations/${id}.json`;
    expect((sealed.at(-1)!.observation as Record<string, any>).kept).toMatchObject({ path: rel });
    const receipt = shortOf(chain().at(-1)!);
    const keptSha = sha(readFileSync(join(root, rel)));

    let [card] = cards(boardHtml(ws, root), 'kept');
    expect(card).toContain('<strong class="label">refs/card.png</strong> <span class="kind">kept</span>');
    expect(card).toMatch(/<div class="rstatus rstatus-attention"><strong>kept<\/strong> the observation file could not be written: [^<]*a file is in the way of its folder/);
    expect(card).toContain(`its whole record is kept at ${rel}, exactly the bytes its receipt sealed (sha256 ${keptSha.slice(0, 12)})`);
    expect(card).toContain('not verified measurements');
    expect(card).toContain(`receipt ${receipt} (observe, failed: it sealed the kept copy)`);
    expect(card).toContain('<dt>cost</dt><dd>$0.0021 <span class="tier">as the response reported it, sealed on its receipt</span></dd>');
    expect(card).toContain(`<dt>model</dt><dd>${MODEL} <span class="tier">as its receipt sealed it; a model&#39;s answer (a claim)</span></dd>`);
    expect(card).toContain('it holds Look&#39;s 3 values (as recorded), the model&#39;s answer (a claim)');
    expect(card).toContain(`<a class="file" href="../../${rel}">${rel}</a> <span class="tier">the kept record, as its receipt sealed it</span>`);
    expect(card).toContain(`data-cmd="/open ${rel}"`);
    // Never a verified measurement: no ok status, no values, not the model's answer itself.
    expect(card).not.toMatch(/rstatus-ok|class="measured"|#070707|CARD-0042|A grey test card/);
    expect(lines(ws.results(''))).toContain(`its record is kept at ${rel}, as its receipt sealed it`);

    // Changed after it was sealed: unverified, with the reason; /results says the same.
    writeFileSync(join(root, rel), `${readFileSync(join(root, rel), 'utf8')} `);
    const now = sha(readFileSync(join(root, rel)));
    [card] = cards(boardHtml(ws, root), 'kept');
    expect(card).toContain(`<strong>kept · unverified</strong> not verified: the kept record at ${rel} is not the one its receipt sealed: it is sha256 ${now.slice(0, 12)}, the receipt sealed ${keptSha.slice(0, 12)}`);
    expect(card).toContain('the kept record, not verified');
    expect(card).not.toContain('it holds');
    expect(card).not.toContain(`data-cmd="/open ${rel}"`);
    expect(lines(ws.results(''))).toContain(`its record is kept at ${rel} (not verified: the kept record at ${rel} is not the one its receipt sealed`);

    // Gone.
    unlinkSync(join(root, rel));
    [card] = cards(boardHtml(ws, root), 'kept');
    expect(card).toContain(`not verified: the kept record is no longer at ${rel}`);
  });

  it("kept in Timmy's own folder: named relative to it, never by an absolute path, and checked there", async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'in the way');
    put(root, '.timmy', 'also in the way');
    const { ws, sealed, jobsDir } = make(root, fakeOpenRouter({ cost: 0.0021 }).fn);
    const { id } = await observe(ws);
    expect((sealed.at(-1)!.observation as Record<string, any>).kept).toMatchObject({ store: 'timmy', path: `observations/${id}.json` });
    // The board is written into the project's .timmy/: the file in the way goes first (the kept record stays where it is).
    unlinkSync(join(root, '.timmy'));
    const html = boardHtml(ws, root);
    const [card] = cards(html, 'kept');
    expect(card).toContain('<strong>kept</strong>');
    expect(card).toContain(`kept outside the project, in Timmy&#39;s own kept folder (observations/${id}.json)`);
    expect(card).not.toMatch(/href="[^"]*observations\/j/);
    for (const p of [jobsDir, tmpdir(), root]) expect(html).not.toContain(p);
  });

  it('kept nowhere: "not kept", why, and what was spent as the receipt sealed it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'in the way');
    put(root, '.timmy', 'in the way');
    const { ws, sealed, jobsDir } = make(root, fakeOpenRouter({ cost: 0.0021 }).fn);
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(join(jobsDir, 'kept'), 'in the way too');
    await observe(ws);
    expect((sealed.at(-1)!.observation as Record<string, any>).kept.error).toMatch(/in the project.*in Timmy's own folder/);
    unlinkSync(join(root, '.timmy'));
    const [card] = cards(boardHtml(ws, root), 'kept');
    expect(card).toMatch(/<div class="rstatus rstatus-failed"><strong>not kept<\/strong> the observation file could not be written: [^<]*, and its record could not be kept either: in the project/);
    expect(card).toContain('<dt>cost</dt><dd>$0.0021');
  });

  it('a request went out and no cost came back: the card says unknown, never a number', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'in the way');
    const { ws, sealed } = make(root, fakeOpenRouter({}).fn);
    await observe(ws);
    expect(sealed.at(-1)).toMatchObject({ cost_measured: false });
    const [card] = cards(boardHtml(ws, root), 'kept');
    expect(card).toContain('<dt>cost</dt><dd>unknown <span class="tier">a request went out; no cost was reported (sealed as cost_measured: false)</span></dd>');
    expect(card).not.toContain('$');
  });

  it('a kept record no receipt names (its receipt could not be sealed): unverified, with why; a link there is not followed', () => {
    const root = temp('proj-');
    put(root, '.timmy/kept/observations/j0a0b0c.json', '{"observation":1}\n');
    const outside = temp('outside-');
    writeFileSync(join(outside, 'elsewhere.json'), '{}');
    symlinkSync(join(outside, 'elsewhere.json'), join(root, '.timmy/kept/observations/link.json'));
    const { ws } = make(root, fakeOpenRouter({}).fn);
    const found = cards(boardHtml(ws, root), 'kept');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('<strong class="label">.timmy/kept/observations/j0a0b0c.json</strong>');
    expect(found[0]).toContain('<strong>kept · unverified</strong> not verified: no observe receipt names this kept record (its receipt could not be sealed, or it is not in this store)');
  });

  it('the check itself: an edited receipt, a place Timmy does not keep records, a size that differs', () => {
    const root = temp('proj-');
    put(root, '.timmy/kept/observations/j1.json', 'kept bytes');
    const read = (ref: { path: string; store?: string }): Buffer | null => (existsSync(join(root, ref.path)) ? readFileSync(join(root, ref.path)) : null);
    const body = { v: 1, id: 'r0', stream: 'runs', ts: '2026-10-09T10:00:00.000Z', kind: 'observe', status: 'failed', project_id: 'p', observation: { tiers: [], kept: { path: '.timmy/kept/observations/j1.json', sha256: sha('kept bytes'), bytes: 10 } } };
    const r = { ...body, hash: hashOf({ ...body, hash: '' }) } as unknown as Receipt;
    const place = { path: '.timmy/kept/observations/j1.json', sha256: sha('kept bytes'), bytes: 10 };
    expect(checkKeptRecord(place, r, read)).toMatchObject({ status: 'matches', reasons: [] });
    const edited = { ...r, subject: 'changed after sealing' } as Receipt;
    expect(checkKeptRecord(place, edited, read).reasons).toEqual([expect.stringMatching(/does not match its contents: it was edited after it was sealed/)]);
    expect(checkKeptRecord({ ...place, path: 'notes/j1.json' }, r, read).reasons).toEqual(['the receipt names notes/j1.json for the kept record, which is not a place Timmy keeps one']);
    expect(checkKeptRecord({ ...place, bytes: 11 }, r, read).reasons).toEqual(['the kept record at .timmy/kept/observations/j1.json is 10 bytes, not the 11 its receipt sealed']);
    // keptObservations reads only this project's receipts: another project's receipt does not vouch for the file.
    const elsewhere = keptObservations({ root, chain: [r], projectId: 'other', read });
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0]).not.toHaveProperty('receipt');
    expect(elsewhere[0].check).toMatchObject({ status: 'unverified', reasons: [expect.stringContaining('no observe receipt names this kept record')] });
    // This project's: the file once, checked against the receipt that sealed it.
    expect(keptObservations({ root, chain: [r], projectId: 'p', read })).toMatchObject([{ receipt: shortOf(r), check: { status: 'matches' } }]);
  });
});

// ── 2. the receipt page ────────────────────────────────────────────────────────────────────────────────────────

describe('H30 (2): the receipt page says a cost as it was sealed', () => {
  it('a reported amount to four places, never a nonzero one as zero; unknown with no number when cost_measured is false; nothing when no request went out', () => {
    expect(spendText({ cost_usd: 0.0021 })).toBe('$0.0021');
    expect(spendText({ cost_usd: 0.00002 })).toBe('$0.000020');
    expect(spendText({ cost_usd: 0 })).toBe('$0.0000');
    expect(spendText({ cost_measured: false })).toBe('cost unknown (a request went out; no cost was reported)');
    expect(spendText({ cost_usd: 0, cost_measured: false })).toBe('cost unknown (a request went out; no cost was reported)');
    expect(spendText({ cost_usd: 0.012, cost_measured: false })).toBe('cost unknown (a request went out; its full cost was not reported)');
    expect(spendText({ cost_usd: null })).toBe('cost unknown (a request went out; no cost was reported)');
    expect(spendText({})).toBeUndefined();
  });

  it('served from real signed receipts: an unknown cost has its row and no number; a turn names the receipt that sealed its tool\'s cost', async () => {
    const dir = temp('store-');
    const observeUnknown = appendReceipt('runs', { kind: 'observe', subject: 'observe · refs/card.png · failed', policy: 'human-gated', status: 'failed', model_requested: MODEL, cost_measured: false }, dir);
    const turnLowerBound = appendReceipt('runs', { kind: 'turn', subject: 'repl · cancelled · 1 step', policy: 'human-gated', status: 'cancelled', cost_usd: 0.012, cost_measured: false }, dir);
    // The real sealer, as the REPL seals a turn whose describe_image call was sealed on observe receipt 0a1b2c3d.
    sealTurn({ prompt: 'what is on the card', answer: 'A grey card.', steps: 1, spend: 0.0042, costMeasured: true, ms: 1500, status: 'ok', model: MODEL, tools: [{ tool: 'describe_image', outcome: 'completed', receipt: '0a1b2c3d' }] }, dir);
    const turn = readChain('runs', dir).at(-1)!;
    expect(turn).toMatchObject({ cost_usd: 0.0042, cost_measured: true, tool_outcomes: [{ name: 'describe_image', outcome: 'completed', receipt: '0a1b2c3d' }] });
    const server = await startStudioServer(0, { receipts: { read: () => readChain('runs', dir), verify: () => verifyChain('runs', dir) } });
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = async (r: Receipt, text = true) => (await fetch(`${base}/receipts/${r.hash.slice(7, 15)}${text ? '?format=text' : ''}`)).text();

    const unknown = await page(observeUnknown);
    expect(unknown).toContain('spend     cost unknown (a request went out; no cost was reported)');
    expect(unknown).not.toMatch(/spend\s+\$/);
    const html = await page(observeUnknown, false);
    expect(html).toContain('<dt>spend</dt><dd>cost unknown (a request went out; no cost was reported)</dd>');
    const lower = await page(turnLowerBound);
    expect(lower).toContain('spend     cost unknown (a request went out; its full cost was not reported)');
    expect(lower).not.toContain('0.012');
    const named = await page(turn);
    expect(named).toContain('tools     describe_image completed (receipt 0a1b2c3d seals its own cost)');
    expect(named).toContain('spend     $0.0042; not counting the tools sealed on their own receipts (see tools)');
    // The same words without a server.
    expect(Object.fromEntries(receiptFacts(turn)).spend).toBe('$0.0042; not counting the tools sealed on their own receipts (see tools)');
    expect(receiptText(observeUnknown, true)).toContain('cost unknown (a request went out; no cost was reported)');
  });
});

// ── 3. the turn's spend line ───────────────────────────────────────────────────────────────────────────────────

class Sink { writes: string[] = []; isTTY = false; write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }
/** A LABELLED FAKE agent: replays the items it is given, then answers. */
class FakeAgent extends EventEmitter {
  constructor(private readonly script: (a: FakeAgent) => void) { super(); }
  async send(_text: string): Promise<string> { this.script(this); return 'ok'; }
}
const transcriptOf = () => {
  const out = new Sink(), err = new Sink();
  const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
  return { out, transcript: new Transcript(buildTheme(caps), new LiveRegion({ out, err }, { live: false }), { columns: 120 }) };
};
let t = 0;
const clock = () => (t += 1500);
/** The real describe_image tool, through the real Workspace (its observe receipt sealed there). */
async function describeImage(ws: Workspace, root: string, path = 'refs/card.png'): Promise<Record<string, unknown>> {
  const tools = createVisionTools({ root: () => root, model: () => MODEL, observe: async (rel, question, model, opts) => { const s = await ws.observeFile(rel, question, model, opts); return s.ok ? s.done : s; } });
  const exec = (tools.find((x) => x.function.name === 'describe_image')!.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
  return exec({ path, question: 'What does the card say?' });
}
/** A turn in which the agent called describe_image (its real result as `output`), then reported its own cost. */
async function turnWith(output: Record<string, unknown> | undefined, o: { agentCost?: number; repeat?: boolean } = {}) {
  const { out, transcript } = transcriptOf();
  const seen: Array<Record<string, unknown>> = [];
  const agent = new FakeAgent((a) => {
    a.emit('item:update', { type: 'function_call', callId: 'c1', name: 'describe_image', arguments: '{"path":"refs/card.png","question":"What does the card say?"}', status: 'completed' });
    if (output) a.emit('item:update', { type: 'function_call_output', callId: 'c1', output: JSON.stringify(output) });
    if (output && o.repeat) a.emit('item:update', { type: 'function_call_output', callId: 'c1', output: JSON.stringify(output) });
    a.emit('cost:update', o.agentCost ?? 0.0042, o.agentCost ?? 0.0042);
    a.emit('item:update', { type: 'message', id: 'm1', content: [{ text: 'The model says it is a grey card.' }] });
  });
  t = 0;
  await runTurn(agent, transcript, 'what is on the card', clock, undefined, undefined, (f) => { seen.push(f as unknown as Record<string, unknown>); return { id: '1fb6eb93', hash: 'sha256_1fb6eb93', verified: true }; });
  return { text: out.text, facts: seen[0] };
}

describe("H30 (3): the turn's spend line counts describe_image, once, and the turn seals only its own spend", () => {
  it('a reported cost: in the line once (a repeated result is not counted again); the receipt seals the agent\'s own spend and names the observe receipt', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = fakeOpenRouter({ cost: 0.0021, total_tokens: 900 });
    const { ws, sealed } = make(root, api.fn);
    const output = await describeImage(ws, root);
    expect(output).toMatchObject({ ok: true, cost_usd: 0.0021, receipt: 'id1' });
    expect(api.posts).toHaveLength(1);
    const { text, facts } = await turnWith(output, { repeat: true });
    expect(text).toContain('  1 step · $0.006 (describe_image $0.002) · 1.5s');
    expect(facts).toMatchObject({ spend: 0.0042, costMeasured: true, tools: [{ tool: 'describe_image', outcome: 'completed', receipt: 'id1' }] });
    // The tool's charge is sealed once, on its observe receipt.
    expect(sealed.filter((r) => r.cost_usd === 0.0021)).toEqual([expect.objectContaining({ kind: 'observe', status: 'ok' })]);
  });

  it('no cost came back: the line says the total is a lower bound and the tool\'s cost unknown, never a sum that hides it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const { ws, sealed } = make(root, fakeOpenRouter({}).fn);
    const output = await describeImage(ws, root);
    expect(output).toMatchObject({ ok: true, cost_usd: null });
    expect(sealed.at(-1)).toMatchObject({ kind: 'observe', cost_measured: false });
    const { text, facts } = await turnWith(output);
    expect(text).toContain('  1 step · at least $0.004 (describe_image cost unknown) · 1.5s');
    expect(facts).toMatchObject({ spend: 0.0042, costMeasured: true });
  });

  it('the observation file could not be written: the failure still reports its cost, and the line counts it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    put(root, 'results/observations', 'in the way');
    const { ws } = make(root, fakeOpenRouter({ cost: 0.0021 }).fn);
    const output = await describeImage(ws, root);
    expect(output).toMatchObject({ ok: false, cost_usd: 0.0021, receipt: 'id1' });
    const { text } = await turnWith(output);
    expect(text).toContain('  1 step · $0.006 (describe_image $0.002) · 1.5s');
  });

  it('nothing was sent (a path outside the project): nothing is added; no result before the end: unknown', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = fakeOpenRouter({ cost: 0.0021 });
    const { ws } = make(root, api.fn);
    const refused = await describeImage(ws, root, '../outside.png');
    expect(refused).toMatchObject({ ok: false });
    expect(refused).not.toHaveProperty('cost_usd');
    expect(api.posts).toHaveLength(0);
    expect((await turnWith(refused)).text).toContain('  1 step · $0.004 · 1.5s');
    const pending = await turnWith(undefined);
    expect(pending.text).toContain('at least $0.004 (describe_image cost unknown)');
  });

  it("toolSpent reads only the tool's own field: a number, null when unknown, absent when nothing was sent; anything else is unknown", () => {
    expect(toolSpent('{"ok":true,"cost_usd":0.002,"receipt":"0a1b2c3d"}')).toEqual({ cost: 0.002, receipt: '0a1b2c3d' });
    expect(toolSpent({ ok: false, cost_usd: null })).toEqual({ cost: null });
    expect(toolSpent({ ok: false, error: 'denied' })).toEqual({});
    expect(toolSpent({ cost_usd: '0.002' })).toEqual({ cost: null });
    expect(toolSpent({ cost_usd: -1 })).toEqual({ cost: null });
    expect(toolSpent('not json')).toEqual({});
  });
});

// ── 4. /results Flows ──────────────────────────────────────────────────────────────────────────────────────────

describe('H30 (4): /results lists the flow records with the board\'s Flows check', () => {
  const record = (id: string, o: Partial<FlowRecord> = {}): FlowRecord => ({
    flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', recipe: 'enclosure.tray/1', instruction: `make it wider (${id})`, project: 'p',
    started_at: `2026-10-09T09:0${'abc'.indexOf(id.slice(-1)) + 1}:00.000Z`, outcome: 'succeeded', ended_in: 'readback', why: 'the readback matches',
    parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: 'a'.repeat(64), values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } } },
    receipts: {}, child_receipts: [], doctrine: DOCTRINE_15, ...o,
  }) as FlowRecord;

  it('verified only when a flow receipt of this project sealed exactly the record\'s bytes; otherwise as the file says, with why; the board agrees', () => {
    const root = temp('proj-');
    const { ws, sealed, chain } = make(root, fakeOpenRouter({}).fn);
    const pid = projectId(root);
    const sealFlow = (w: { path: string; sha256: string; bytes: number }) => sealed.push({ kind: 'flow', subject: 'flow · iterate · tray', policy: 'human-gated', status: 'ok', project: 'p', project_id: pid, outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }], cost_usd: 0 });
    const a = writeFlowRecord(root, record('f0000000a'));
    const b = writeFlowRecord(root, record('f0000000b', { outcome: 'stopped', ended_in: 'checks' }));
    const c = writeFlowRecord(root, record('f0000000c', { outcome: 'differs' }));
    if (!a.ok || !b.ok || !c.ok) throw new Error('a flow record could not be written');
    sealFlow(a);
    sealFlow(c);
    writeFileSync(join(root, c.path), readFileSync(join(root, c.path), 'utf8').replace('make it wider', 'make it narrower'));
    const out = lines(ws.results(''));
    const flowReceipt = shortOf(chain()[0]);
    expect(out).toContain("  Flows  newest first; verified only when a flow receipt sealed the record's exact bytes");
    expect(out).toContain(`    results/flows/f0000000a.json  f0000000a  succeeded · verified: receipt ${flowReceipt} sealed these bytes · make it wider (f0000000a)`);
    expect(out).toContain('    results/flows/f0000000b.json  f0000000b  stopped as the file says · not verified: no flow receipt names this file');
    expect(out).toContain('    results/flows/f0000000c.json  f0000000c  differs as the file says · not verified: the file changed after it was sealed');
    // Newest first, as the board orders them.
    expect(out.indexOf('f0000000c.json')).toBeLessThan(out.indexOf('f0000000b.json'));
    expect(out.indexOf('f0000000b.json')).toBeLessThan(out.indexOf('f0000000a.json'));
    // The board's Flows cards say the same.
    const html = boardHtml(ws, root);
    const flowCards = [...html.matchAll(/<article class="card flow">([\s\S]*?)<\/article>/g)].map((m) => m[1]);
    const status = (id: string) => flowCards.find((x) => x.includes(`<strong>${id}</strong>`))!.match(/<div class="status status-(\w+)">/)![1];
    expect([status('f0000000a'), status('f0000000b'), status('f0000000c')]).toEqual(['verified', 'unverified', 'unverified']);
  });

  it('none yet: says how to make one', () => {
    const root = temp('proj-');
    const { ws } = make(root, fakeOpenRouter({}).fn);
    expect(lines(ws.results(''))).toContain('  Flows\n    none yet: /iterate tray "<instruction>"');
  });
});
