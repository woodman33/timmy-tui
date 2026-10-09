// "References in, observations out" in the REPL workspace (round R2, look): /add, /observe with a question
// (a model's interpretation, through a mocked fetch: no network, no spend), and Results.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { COMMANDS } from '../src/repl/commands.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { resetLookChecks } from '../src/vision/look.js';
import { resetImageModelCache } from '../src/vision/route.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
afterEach(async () => {
  resetLookChecks();
  resetImageModelCache();
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A labelled test double for a Python with OpenCV (see tests/look.test.ts). With `touch`, the image
 *  changes once it has been measured (another program saving over it), so the model sees other bytes. */
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
    "console.log(JSON.stringify({ ok: true, worker: { name: 'timmy-look', version: 'fake' }, opencv: '5.0.0-fake', python: 'fake', source: { path: as, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, image: { width: 4, height: 2, channels: 3 }, measurements: [], uncertainty: ['test double'] }));",
  ].join('\n'));
  const sh = join(dir, 'python');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

function openRouter(cost?: number) {
  const posts: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [
        { id: 'anthropic/claude-haiku-4.5', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'deepseek/deepseek-chat', architecture: { input_modalities: ['text'] } },
      ] }), { status: 200 });
    }
    posts.push(String(init?.body));
    return new Response(JSON.stringify({ model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: 'A grey test card.' } }], ...(cost === undefined ? {} : { usage: { cost } }) }), { status: 200 });
  }) as typeof fetch;
  return { fn, posts };
}

/** OpenRouter with a chosen reply to the chat request: its answer text, its usage, or an HTTP error. */
function openRouterWith(o: { content?: string; usage?: Record<string, unknown>; status?: number; body?: unknown }) {
  const posts: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-haiku-4.5', architecture: { input_modalities: ['text', 'image'] } }] }), { status: 200 });
    posts.push(String(init?.body));
    const body = o.body ?? { model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: o.content ?? '' } }], ...(o.usage ? { usage: o.usage } : {}) };
    return new Response(JSON.stringify(body), { status: o.status ?? 200 });
  }) as typeof fetch;
  return { fn, posts };
}

/** OpenRouter whose chat request never answers until its signal aborts; with slowList its models list never does. */
function silentOpenRouter(o: { slowList?: boolean } = {}) {
  const posts: string[] = [];
  let posted: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => { posted = resolve; });
  let listed: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => { listed = resolve; });
  const never = (signal?: AbortSignal | null): Promise<Response> => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      listed();
      if (o.slowList) return never(null);
      return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-haiku-4.5', architecture: { input_modalities: ['text', 'image'] } }] }), { status: 200 });
    }
    posts.push(String(init?.body));
    posted();
    return never(init?.signal);
  }) as typeof fetch;
  return { fn, posts, sent, asked };
}

function make(root: string, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { TIMMY_VISION_PYTHON: fakePython(), OPENROUTER_API_KEY: 'test-key' },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

describe('/add', () => {
  it('copies files into refs/, seals one intake receipt without the source path, and says what comes next', () => {
    const root = temp('proj-');
    const out = temp('outside-');
    writeFileSync(join(out, 'board.png'), PNG);
    writeFileSync(join(out, 'brief.md'), '# Brief\n');
    const { ws, sealed } = make(root);
    const lines = text(ws.add(`${join(out, 'board.png')} "${join(out, 'brief.md')}"`));
    expect(lines).toMatch(/refs\/board\.png\s+image/);
    expect(lines).toMatch(/refs\/brief\.md\s+document/);
    expect(lines).toContain('read_project_file');
    expect(lines).toContain('/observe refs/board.png');
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ kind: 'intake', project_id: expect.stringMatching(/^[0-9a-f]{16}$/), files: [{ path: 'refs/board.png', kind: 'image', bytes: PNG.length }, { path: 'refs/brief.md', kind: 'document' }] });
    expect(JSON.stringify(sealed)).not.toContain(out);
    expect(readFileSync(join(out, 'board.png'))).toEqual(PNG);
    expect(text(ws.files('references'))).toContain('refs/board.png');
    expect(text(ws.results(''))).toMatch(/refs\/board\.png\s+added/);
  });

  it('refuses private names and seals nothing when nothing was added', () => {
    const root = temp('proj-');
    const out = temp('outside-');
    writeFileSync(join(out, '.env'), 'K=1');
    const { ws, sealed } = make(root);
    expect(text(ws.add(join(out, '.env')))).toContain('private');
    expect(text(ws.add(''))).toContain('Usage');
    expect(sealed).toEqual([]);
  });

  it('is in the WORK group and /observe in LOOK, with /help lines within 60 columns', () => {
    const add = COMMANDS.find((c) => c.name === 'add');
    const observe = COMMANDS.find((c) => c.name === 'observe');
    expect(add?.group).toBe('work');
    expect(observe?.group).toBe('look');
    for (const c of COMMANDS) expect(`  /${c.name.padEnd(11)} ${c.description}`.length).toBeLessThanOrEqual(60);
  });
});

describe('/observe with a question', () => {
  it('adds the interpretation of an image-capable model, as a claim with its model and cost', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = openRouter(0.0021);
    const { ws, sealed } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5' });
    const started = await ws.observeFile('refs/card.png', 'What is on the card?');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toContain('data:image/png;base64,');
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    expect(written.tiers).toEqual(['deterministic computation', 'model interpretation']);
    expect(written.interpretation).toMatchObject({ tier: 'model interpretation', model: 'anthropic/claude-haiku-4.5', question: 'What is on the card?', answer: 'A grey test card.', cost_usd: 0.0021 });
    expect(sealed.at(-1)).toMatchObject({ kind: 'observe', status: 'ok', cost_usd: 0.0021, model_requested: 'anthropic/claude-haiku-4.5', observation: { tiers: ['deterministic computation', 'model interpretation'] } });
    expect(text(ws.results(''))).toMatch(/refs\/card\.png.*model interpretation/);
  });

  it('a model that does not take images is refused: the measurements stand alone and the refusal is recorded', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = openRouter();
    const { ws, sealed, notes } = make(root, { fetch: api.fn, model: () => 'deepseek/deepseek-chat' });
    const started = await ws.observeFile('refs/card.png', 'What is it?');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    expect(api.posts).toEqual([]);
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    expect(written.tiers).toEqual(['deterministic computation']);
    expect(written.interpretation).toMatchObject({ status: 'refused', model: 'deepseek/deepseek-chat', alternatives: ['anthropic/claude-haiku-4.5'] });
    expect(sealed.at(-1)?.cost_usd).toBeUndefined();
    expect(notes.join('\n')).toContain('does not take images');
  });

  // Round R3 (the independent review of 40022d9, finding 3): an image that changed between Look and the model
  // dropped a paid answer and its cost. Both are kept now, rejected: the answer is about other bytes.
  it('an image that changed after Look measured it: the paid answer and its cost are kept, rejected, not a claim about the measured bytes', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = openRouter(0.0021);
    const { ws, sealed, notes } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5', env: { TIMMY_VISION_PYTHON: fakePython({ touch: true }), OPENROUTER_API_KEY: 'test-key' } });
    const started = await ws.observeFile('refs/card.png', 'What is on the card?');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    expect(api.posts).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    const seen = createHash('sha256').update(readFileSync(join(root, 'refs/card.png'))).digest('hex');
    expect(written.source.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(seen).not.toBe(written.source.sha256);
    expect(written.tiers).toEqual(['deterministic computation']);
    expect(written.interpretation).toMatchObject({
      status: 'rejected', tier: 'model interpretation', model: 'anthropic/claude-haiku-4.5', model_requested: 'anthropic/claude-haiku-4.5',
      question: 'What is on the card?', answer: 'A grey test card.', cost_usd: 0.0021, image_sha256: seen,
      reason: expect.stringContaining('changed between Look and the model'),
    });
    expect(sealed.at(-1)).toMatchObject({ kind: 'observe', status: 'ok', cost_usd: 0.0021, model_requested: 'anthropic/claude-haiku-4.5', observation: { tiers: ['deterministic computation'], interpretation: { status: 'rejected', cost_usd: 0.0021 } } });
    expect(notes.join('\n')).toMatch(/changed between Look and the model/);
    expect(notes.join('\n')).toContain('$0.0021');
  });

  it('a 2xx reply with no answer text: the failure keeps the cost it reported, and the receipt seals it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = openRouterWith({ content: '', usage: { cost: 0.003, total_tokens: 700 } });
    const { ws, sealed } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5' });
    const started = await ws.observeFile('refs/card.png', 'What is it?');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    expect(written.tiers).toEqual(['deterministic computation']);
    expect(written.interpretation).toMatchObject({ status: 'failed', cost_usd: 0.003, tokens: 700, reason: 'the model returned no answer' });
    expect(sealed.at(-1)).toMatchObject({ cost_usd: 0.003, observation: { interpretation: { status: 'failed', cost_usd: 0.003 } } });
    expect(sealed.at(-1)).not.toHaveProperty('cost_measured');
  });

  it('a request that went out and reported no cost is sealed as an unknown cost (cost_measured: false), never as $0', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = openRouterWith({ status: 502, body: { error: { message: 'upstream down' } } });
    const { ws, sealed } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5' });
    const started = await ws.observeFile('refs/card.png', 'What is it?');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    expect(written.interpretation).toMatchObject({ status: 'failed', cost_usd: null });
    const receipt = sealed.at(-1)!;
    expect(receipt.cost_usd).toBeUndefined();
    expect(receipt.cost_measured).toBe(false);
    expect(receipt.observation?.interpretation).toMatchObject({ status: 'failed', cost_usd: null });
    expect(receipt.model_requested).toBe('anthropic/claude-haiku-4.5');
  });

  it('the observation file keeps the whole answer, not a display-sized slice of it', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const long = `${'A long and careful description. '.repeat(600)}The end.`; // ~19 KB
    const api = openRouterWith({ content: long, usage: { cost: 0.002 } });
    const { ws } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5' });
    const started = await ws.observeFile('refs/card.png', 'Describe it.');
    if (!started.ok) throw new Error(started.error);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    expect(written.interpretation.status).toBe('answered');
    expect(written.interpretation.answer).toBe(long);
    expect(written.interpretation).not.toHaveProperty('answer_truncated');
  });

  // Round R3 (the independent review of 40022d9, finding 2): the paid interpretation ran outside the observation
  // job's cancellation: /stop and /stop all could not reach it, and nothing told measuring from interpreting.
  it('/jobs shows the measurement completed and the model interpreting; /stop <job> stops it, and the file and receipt say cancelled, cost unknown', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = silentOpenRouter();
    const { ws, sealed, notes } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5' });
    const started = await ws.observeFile('refs/card.png', 'What is on the card?');
    if (!started.ok) throw new Error(started.error);
    const id = started.job.id;
    await api.sent;
    const jobs = text(ws.jobsView(''));
    expect(jobs).toMatch(new RegExp(`${id}\\s+completed\\s+look refs/card\\.png`));
    expect(jobs).toMatch(/measured; interpreting with anthropic\/claude-haiku-4\.5/);
    expect(text(ws.jobsView(id))).toMatch(/measured; interpreting with anthropic\/claude-haiku-4\.5/);
    expect(notes.join('\n')).toMatch(new RegExp(`${id} measured.*interpreting with anthropic/claude-haiku-4\\.5`));
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} stopped the model interpretation; the measurement had completed`);
    expect(stopped).toMatch(/may still be charged/);
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    expect(api.posts).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(root, outcome.file), 'utf8'));
    expect(written.tiers).toEqual(['deterministic computation']);
    expect(written.look.measurements).toEqual([]);
    expect(written.interpretation).toMatchObject({ status: 'cancelled', model: 'anthropic/claude-haiku-4.5', cost_usd: null, reason: expect.stringMatching(/may still be charged/) });
    const receipt = sealed.at(-1)!;
    expect(receipt).toMatchObject({ kind: 'observe', observation: { tiers: ['deterministic computation'], interpretation: { status: 'cancelled', cost_usd: null } }, cost_measured: false });
    expect(receipt.cost_usd).toBeUndefined();
    expect(text(ws.jobsView(''))).not.toMatch(/interpreting/);
    expect(text(await ws.stop(id))).toContain('already completed');
  });

  it('/stop all reaches an interpretation in flight, and says it stopped one', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = silentOpenRouter();
    const { ws } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5' });
    const started = await ws.observeFile('refs/card.png', 'What is it?');
    if (!started.ok) throw new Error(started.error);
    await api.sent;
    const all = text(await ws.stop('all'));
    expect(all).toMatch(/Stopped 1 model interpretation; its measurement had completed/);
    expect(all).not.toMatch(/Nothing this REPL started is running/);
    const outcome = await started.done;
    expect(outcome.ok && outcome.interpretation).toMatchObject({ status: 'cancelled', cost_usd: null });
  });

  it('a stop before the request goes out: nothing was sent, and no cost is recorded at all', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = silentOpenRouter({ slowList: true });
    const { ws, sealed } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5' });
    const started = await ws.observeFile('refs/card.png', 'What is it?');
    if (!started.ok) throw new Error(started.error);
    await api.asked;
    expect(text(ws.jobsView(''))).toMatch(/measured; about to ask anthropic\/claude-haiku-4\.5, nothing sent yet/);
    const stopped = text(await ws.stop(started.job.id));
    expect(stopped).toContain('stopped the model interpretation; the measurement had completed');
    expect(stopped).toContain('no request had been sent');
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.error);
    expect(api.posts).toEqual([]);
    expect(outcome.interpretation).toMatchObject({ status: 'cancelled' });
    expect(outcome.interpretation).not.toHaveProperty('cost_usd');
    expect(sealed.at(-1)).not.toHaveProperty('cost_usd');
    expect(sealed.at(-1)).not.toHaveProperty('cost_measured');
  });

  it('the REPL ending stops an interpretation in flight and still records the observation', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const api = silentOpenRouter();
    const { ws, sealed } = make(root, { fetch: api.fn, model: () => 'anthropic/claude-haiku-4.5' });
    const started = await ws.observeFile('refs/card.png', 'What is it?');
    if (!started.ok) throw new Error(started.error);
    await api.sent;
    await ws.close();
    expect(sealed.at(-1)).toMatchObject({ kind: 'observe', observation: { interpretation: { status: 'cancelled' } }, cost_measured: false });
    const outcome = await started.done;
    expect(outcome.ok && outcome.interpretation).toMatchObject({ status: 'cancelled' });
  });

  it('/observe says what it started, and refuses a file outside the project', async () => {
    const root = temp('proj-');
    put(root, 'refs/card.png', PNG);
    const { ws } = make(root);
    const lines = text(await ws.observe('refs/card.png'));
    expect(lines).toMatch(/Observing\s+j[0-9a-f]{6}\s+refs\/card\.png: measuring with Look/);
    expect(text(await ws.observe('../x.png'))).toContain('outside the project');
    expect(text(await ws.observe(''))).toContain('Usage');
    // A file larger than Look reads is refused before it is hashed or run (a sparse file: quick to make).
    put(root, 'refs/huge.png', PNG);
    truncateSync(join(root, 'refs/huge.png'), 65 * 1024 * 1024);
    expect(text(await ws.observe('refs/huge.png'))).toContain('larger than 64 MB');
    expect(ws.jobs.list()).toHaveLength(1);
  });
});
