// The agent's vision tools (round R2, look): observe_image gives any agent, a text-only one included, Look's
// structured measurements of a project image; describe_image asks an image-capable model (it spends, so the
// REPL asks every time). Look runs as a labelled fake worker here; every request goes to a mocked fetch.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVisionTools } from '../src/agent/vision-tools.js';
import { resetLookChecks } from '../src/vision/look.js';
import { resetImageModelCache } from '../src/vision/route.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const dirs: string[] = [];
const temp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { resetLookChecks(); resetImageModelCache(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Exec = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const caller = (tools: ReturnType<typeof createVisionTools>) => (name: string, args: Record<string, unknown>) =>
  ((tools.find((t) => t.function.name === name)!.function as unknown as { execute: Exec }).execute(args));

function fakePython(): string {
  const dir = temp('fake-python-');
  const js = join(dir, 'fake-look.mjs');
  writeFileSync(js, [
    "import { createHash } from 'node:crypto';",
    "import { readFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "if (args[0] === '-c') { console.log('5.0.0-fake'); process.exit(0); }",
    "const bytes = readFileSync(args[1]); const as = args[args.indexOf('--as') + 1];",
    "console.log(JSON.stringify({ ok: true, worker: { name: 'timmy-look', version: 'fake' }, opencv: '5.0.0-fake', python: 'fake', source: { path: as, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, image: { width: 4, height: 2, channels: 3 }, measurements: [{ name: 'edge_density', value: 0.1, unit: 'fraction of pixels', tier: 'deterministic computation', note: 'test double' }], uncertainty: ['test double'] }));",
  ].join('\n'));
  const sh = join(dir, 'python');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('observe_image', () => {
  it('runs Look on a project image and returns its measurements, marked as computations, with no path outside the project', async () => {
    const root = temp('proj-');
    mkdirSync(join(root, 'refs'));
    writeFileSync(join(root, 'refs/a.png'), PNG);
    const call = caller(createVisionTools({ root: () => root, env: { TIMMY_VISION_PYTHON: fakePython() } }));
    const r = await call('observe_image', { path: 'refs/a.png' });
    expect(r).toMatchObject({ ok: true, path: 'refs/a.png', tier: 'deterministic computation', recorded: false, image: { width: 4, height: 2 } });
    expect(JSON.stringify(r)).not.toContain(root);
    expect(await call('observe_image', { path: '../out.png' })).toMatchObject({ ok: false });
  });

  it('through the workspace, names the observation file and its receipt', async () => {
    const root = temp('proj-');
    mkdirSync(join(root, 'results/observations'), { recursive: true });
    writeFileSync(join(root, 'results/observations/a-1.json'), JSON.stringify({ source: { path: 'refs/a.png' }, tiers: ['deterministic computation'], look: { image: { width: 9, height: 9, channels: 3 }, measurements: [], uncertainty: ['u'] } }));
    const seen: string[] = [];
    const call = caller(createVisionTools({ root: () => root, observe: async (rel) => { seen.push(rel); return { ok: true, file: 'results/observations/a-1.json', receipt: 'abc12345', tiers: ['deterministic computation'] }; } }));
    const r = await call('observe_image', { path: 'refs/a.png' });
    expect(seen).toEqual(['refs/a.png']);
    expect(r).toMatchObject({ ok: true, recorded: true, observation_file: 'results/observations/a-1.json', receipt: 'abc12345', image: { width: 9 } });
  });
});

describe('describe_image', () => {
  it('refuses a model that does not take images and names some that do; nothing is sent', async () => {
    const root = temp('proj-');
    mkdirSync(join(root, 'refs'));
    writeFileSync(join(root, 'refs/a.png'), PNG);
    const posts: string[] = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-haiku-4.5', architecture: { input_modalities: ['text', 'image'] } }, { id: 'text/only', architecture: { input_modalities: ['text'] } }] }));
      posts.push(String(init?.body));
      return new Response(JSON.stringify({ model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: 'a card' } }], usage: { cost: 0.001 } }));
    }) as typeof fetch;
    const call = caller(createVisionTools({ root: () => root, env: { OPENROUTER_API_KEY: 'k' }, fetch: fetchMock, model: () => 'text/only' }));
    const refused = await call('describe_image', { path: 'refs/a.png', question: 'What is it?' });
    expect(refused).toMatchObject({ ok: false, alternatives: ['anthropic/claude-haiku-4.5'] });
    expect(posts).toEqual([]);
    const answered = await call('describe_image', { path: 'refs/a.png', question: 'What is it?', model: 'anthropic/claude-haiku-4.5' });
    expect(answered).toMatchObject({ ok: true, tier: 'model interpretation', answer: 'a card', cost_usd: 0.001, recorded: false });
    expect(posts).toHaveLength(1);
  });
});
