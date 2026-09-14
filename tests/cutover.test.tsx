// tui-redesign-p6a3 CUTOVER (ui.cutover-plan C1-C5): v2 shell is the DEFAULT;
// legacy stays behind TIMMY_SHELL=v1 for one release; the root dispatcher's
// nav globals are v1-only (digit-shadowing dead at the root). FIX 3 policy
// seed, STEP 8 chat.turn seal and FIX 1 row budget assert on direct ShellV2
// renders (App-level mounts are probe-slow in CI-less environments).
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { readChain } from '../src/utils/receipts.js';
import { readPolicy } from '../src/harness/policy.js';
import { dirname, join } from 'path';

process.env.TIMMY_TELEMETRY_URL = 'off';
delete process.env.TIMMY_SHELL; // default = v2 after cutover
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 30000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f)) return f;
    if (Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

describe('cutover: v2 default vs v1 legacy at the root', { timeout: 150000 }, () => {
  it('default env renders the v2 shell and digits switch tabs at the root', async () => {
    const view = render(React.createElement(App, { config: { onboarded: true } as never }));
    let f = await until(view, x => x.includes('YOUR JOURNEY'), 90000);
    expect(f).not.toContain('MODE:NAV'); // legacy footer gone by default
    view.stdin.write('3');
    f = await until(view, x => x.includes('RECEIPTS'), 90000);
    expect(f).toContain('RECEIPTS');
    view.unmount();
  }, 140000);

  it('TIMMY_SHELL=v1 keeps the legacy nine-view shell for one release', async () => {
    process.env.TIMMY_SHELL = 'v1';
    const view = render(React.createElement(App, { config: { onboarded: true } as never }));
    const f = await until(view, x => x.includes('MODE:NAV'), 90000);
    expect(f).toContain('MODE:NAV');
    view.stdin.write('2');
    const f2 = await until(view, x => x.includes('SLATE DAG'), 90000);
    expect(f2).toContain('SLATE DAG');
    view.unmount();
    delete process.env.TIMMY_SHELL;
  }, 140000);
});

describe('cutover companions on the shell directly', { timeout: 60000 }, () => {
  it('FIX 3: first run seeds the policy default and seals model.policy', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    const pdir = dirname(process.env.TIMMY_STORE as string);
    const t0 = Date.now();
    while (!readPolicy(pdir).default && Date.now() - t0 < 10000) await sleep(100);
    expect(readPolicy(pdir).default).toBeTruthy();
    expect(readChain('runs').some(r => String(r.subject).startsWith('model.policy'))).toBe(true);
    view.unmount();
  });

  it('STEP 8: chat drawer opens with [c]; Enter seals chat.turn with model + cost', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('c');
    const f = await until(view, x => x.includes('SOVEREIGN CHAT'));
    expect(f).toContain('sovereign ·'); // footer names the policy model
    view.stdin.write('hello world');
    view.stdin.write('\r');
    const t1 = Date.now();
    let turn;
    while (!(turn = readChain('runs').find(r => r.kind === 'chat')) && Date.now() - t1 < 10000) await sleep(100);
    expect(turn).toBeTruthy();
    expect(String(turn?.subject)).toContain('chat.turn ·');
    expect(typeof turn?.cost_usd).toBe('number');
    view.unmount();
  });

  it('FIX 1: MODELS rows carry no ellipsis and fit the 74-col column', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('4');
    const f = await until(view, x => x.includes('◇ MODELS'));
    const rows = f.split('\n').filter(l => l.includes('$') && l.trimStart().startsWith('│')
      && !l.includes('notes:') && !l.includes('[Enter]'))
      .map(l => l.slice(0, 74)); // left column only; the rail fuses onto the line
    expect(rows.length).toBeGreaterThan(0);
    for (const ln of rows) {
      expect(ln, `ellipsis in cell: ${ln}`).not.toContain('…');
      expect(ln.trimEnd().length, `row over column: ${ln}`).toBeLessThanOrEqual(74);
    }
    // FLEET rail routes carry the (policy)/(harness) suffix without ellipsis
    expect(f).toContain('(policy)');
    expect(f.split('\n').filter(l => l.includes('(policy)')).every(l => !l.includes('…'))).toBe(true);
    // FIX 2 (close): fleet ids are never cut mid-token — full ids present
    for (const id of ['webcontainers', 'anythingllm', 'houdini-mcp', 'hyperframes']) {
      expect(f, `fleet id cut: ${id}`).toContain(id);
    }
    expect(f.split('\n').filter(l => l.includes('●') || l.includes('○')).every(l => !l.includes('…'))).toBe(true);
    // FIX 1+3 (close): catalog-listed models carry ctx + $in/$out + caps, not dashes
    const qwen = f.split('\n').find(l => l.includes('qwen/qwen3-coder'));
    expect(qwen).toBeTruthy();
    expect(qwen, `qwen row still dashed: ${qwen}`).not.toContain('—/—');
    expect(qwen).toMatch(/\d+k/);
    expect(qwen).toMatch(/[T·][V·][R·]/);
    view.unmount();
  });
});
