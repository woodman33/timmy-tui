import { describe, it, expect, afterAll } from 'vitest';
import { startLogServer } from '../src/utils/logserver.js';
import { companion4310Available } from './service-gate.js';

// Companion arming gateway integration: the survey surface compiles and
// emits hash-bound store requests; arming without an operator token is
// denied by the controller; path escapes on theatre state fail closed.
let port = 0;
const up = async (): Promise<number> => {
  if (!port) port = await startLogServer({ port: 4399 });
  return port;
};

const DOC = {
  nodes: [
    { id: 'cap', kind: 'capsule', objective: 'companion gateway probe' },
    { id: 'h', kind: 'harness', harness: 'hyperframes' }
  ],
  edges: [{ from: 'h', to: 'cap', kind: 'harness' }]
};

afterAll(() => { /* server lives for the process; tests share one instance */ });

describe.skipIf(!companion4310Available())('mission studio gateway (:4310)', () => {
  it('serves the studio page', async () => {
    const p = await up();
    const r = await fetch(`http://127.0.0.1:${p}/mission`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('MISSION STUDIO');
    expect(html).toContain('send to controller');
  });

  it('compiles docs and stores plans with immutable hashes', async () => {
    const p = await up();
    const c = await (await fetch(`http://127.0.0.1:${p}/mission/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: DOC }) })).json();
    expect(c.ok).toBe(true);
    expect(c.plans).toHaveLength(1);
    const s = await (await fetch(`http://127.0.0.1:${p}/mission/store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: c.plans[0].plan }) })).json();
    expect(s.ok).toBe(true);
    expect(s.id).toMatch(/^dp_/);
    expect(s.plan_hash).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('denies arming without an operator token (J-BANG boundary)', async () => {
    const p = await up();
    const c = await (await fetch(`http://127.0.0.1:${p}/mission/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: DOC }) })).json();
    const s = await (await fetch(`http://127.0.0.1:${p}/mission/store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: c.plans[0].plan }) })).json();
    const a = await (await fetch(`http://127.0.0.1:${p}/dispatch/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id, action: 'arm', token: 'garbage' }) })).json();
    expect(a.ok).toBe(false);
  });

  it('fails closed on theatre-state path escapes', async () => {
    const p = await up();
    const r = await (await fetch(`http://127.0.0.1:${p}/mission/theatre?folder=${encodeURIComponent('../../etc')}`)).json();
    expect(r.sheets).toBeUndefined();
    expect(r.error).toBeTruthy();
  });
});
