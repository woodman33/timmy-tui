// ORDER factory-f1d0 C2b: the privacy gate runs before the transport exists; forecasts are written first;
// every take is hashed with a status; the documented transport fails closed; the stub is deterministic.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = () => mkdtempSync(join(tmpdir(), 'factory-'));
const spy = (status = 'GENERATED') => { const calls: unknown[] = []; return { name: 'spy', status, calls, async send(req: unknown) { calls.push(req); return { output: '<!doctype html><html><body><section data-page="p"><h1>p</h1></section></body></html>', contentType: 'text/html', cost: { usd: 0.01, credits: 1, model: 'spy' } }; } }; };

describe('factory-f1d0 · omma.build lane', () => {
  it('negative control: a prompt with a personal string is refused before any transport is called', async () => {
    const { build } = await import('../lanes/factory/omma.mjs');
    const out = tmp(); const t = spy();
    const home = ['', 'Users', 'someone', 'notes.md'].join('/');
    const mail = ['someone.private', 'gmail.com'].join('@');
    const r = await build({ intent: `Build a landing page that shows ${home} and mails ${mail}`, takes: 2, out, seal: false, transport: t });
    expect(r.status).toBe('REFUSED');
    expect(r.gate.ok).toBe(false);
    expect(r.gate.findings.map((f: { pattern: string }) => f.pattern)).toEqual(expect.arrayContaining(['pii.home_path', 'pii.email']));
    expect(t.calls.length).toBe(0);
    expect(readdirSync(join(out, 'takes')).length).toBe(0);
    expect(existsSync(join(out, 'predictions.json'))).toBe(true); // the forecast is written before the gate, never after a send
    rmSync(out, { recursive: true, force: true });
  });

  it('a site address is refused too; the hashed identity path is asserted once the pattern set carries hashed terms (#48)', async () => {
    const { gatePrompt, patterns } = await import('../lanes/factory/gate.mjs');
    const ip = ['100', '101', '7', '8'].join('.'); // a tailnet address, assembled so this file carries no literal
    const g = gatePrompt(`deploy the site to ${ip}`);
    expect(g.ok).toBe(false);
    expect(g.findings[0].pattern).toBe('net.tailnet_ip');
    if (patterns().hashed?.size) {
      const term = ['planted', 'identity', 'term'].join('-');
      expect(gatePrompt(`make a site about ${term}`).findings[0]?.pattern).toBe('identity.fixture');
    }
    expect(gatePrompt('make a three page site for a bakery').ok).toBe(true);
  });

  it('a clean prompt reaches the transport once per take; takes are hashed and carry the transport status', async () => {
    const { build } = await import('../lanes/factory/omma.mjs');
    const out = tmp(); const t = spy();
    const r = await build({ intent: 'pages: Home, Menu, Contact. A bakery site with "Fresh every morning"', takes: 3, out, seal: false, transport: t });
    expect(t.calls.length).toBe(3);
    expect(r.status).toBe('GENERATED');
    expect(r.takes.map((x: { status: string }) => x.status)).toEqual(['GENERATED', 'GENERATED', 'GENERATED']);
    for (const x of r.takes) { expect(x.sha256).toMatch(/^sha256_[0-9a-f]{64}$/); expect(typeof x.latency_ms).toBe('number'); expect(x.measured.pages).toBe(1); }
    const rec = JSON.parse(readFileSync(join(out, 'takes.json'), 'utf8'));
    expect(rec.prediction_sha256).toMatch(/^sha256_/);
    rmSync(out, { recursive: true, force: true });
  });

  it('the documented transport fails closed while omma.tools is unsealed', async () => {
    const { build, ROOT } = await import('../lanes/factory/omma.mjs');
    expect(existsSync(join(ROOT, 'lanes', 'factory', 'omma.tools.json'))).toBe(false);
    const out = tmp();
    const r = await build({ intent: 'a one page site', takes: 1, out, seal: false });
    expect(r.status).toBe('REFUSED');
    expect(r.takes[0].reason).toBe('OMMA_CONTRACT_UNAVAILABLE');
    rmSync(out, { recursive: true, force: true });
  });

  it('the stub is explicit, deterministic and never GENERATED', async () => {
    const { build } = await import('../lanes/factory/omma.mjs');
    const dir = tmp(); const csv = join(dir, 'menu.csv'); writeFileSync(csv, 'name,price\ncroissant,3\nbaguette,4\n');
    const a = await build({ intent: 'pages: Home, Menu. "Fresh every morning"', inputsPath: csv, takes: 2, out: join(dir, 'a'), seal: false, stub: true });
    const b = await build({ intent: 'pages: Home, Menu. "Fresh every morning"', inputsPath: csv, takes: 2, out: join(dir, 'b'), seal: false, stub: true });
    expect(a.status).toBe('STUB');
    expect(a.takes.map((t: { sha256: string }) => t.sha256)).toEqual(b.takes.map((t: { sha256: string }) => t.sha256));
    expect(a.takes[0].sha256).not.toBe(a.takes[1].sha256);
    expect(a.takes[0].matches_forecast).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('predict: pages from the intent, named text from quotes, GLB → scene; parseInputs checks the GLB magic', async () => {
    const { predict } = await import('../lanes/factory/predict.mjs');
    const { parseInputs } = await import('../lanes/factory/omma.mjs');
    const p = predict('pages: Home, About, Pricing. Say "Hello there" and "Buy now"', null, { takes: 4 });
    expect([p.target, p.pages, p.named_text, p.take_count]).toEqual(['site', 3, ['Hello there', 'Buy now'], 4]);
    const dir = tmp(); const glb = join(dir, 'part.glb');
    const buf = Buffer.alloc(20); buf.write('glTF', 0, 'ascii'); buf.writeUInt32LE(2, 4); buf.writeUInt32LE(20, 8);
    writeFileSync(glb, buf);
    const inputs = parseInputs(glb);
    expect(inputs.kind).toBe('glb'); expect(inputs.glb.version).toBe(2);
    expect(predict('place the part in a scene', inputs).target).toBe('scene');
    writeFileSync(join(dir, 'bad.glb'), 'nope');
    expect(() => parseInputs(join(dir, 'bad.glb'))).toThrow(/glTF magic/);
    rmSync(dir, { recursive: true, force: true });
  });
});
