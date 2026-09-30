// warroom-v2-c4m8 — the second war-room slide reads Claude Code's artifacts
// and renders them inside the width budget. PRIVACY GATE (privacy-d5n9): the
// reader tests run against a PLACEHOLDER fixture tree (no real hostnames,
// ips, paths or names in this file); the render gates assert structure only.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { shellOnKey, initialShell } from '../src/tui/shell-mode.js';

// ui-cockpit-k7m3 C5: rows are bounded now — a 120-column content check needs the
// 120x40 reference grid, or the rail folds cards it can no longer fit
Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
import { footerHintsShellShort } from '../src/tui/keymap.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 20000): Promise<string> {
  const t0 = Date.now();
  let f = '';
  for (;;) {
    f = view.lastFrame() ?? '';
    if (pred(f) || Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}
const cardBlock = (f: string, title: string): string[] => {
  const lines = f.split('\n');
  const start = lines.findIndex(l => l.includes(title));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.includes('╰'));
  return lines.slice(start, end === -1 ? lines.length : end + 1);
};

/** placeholder fixture tree: presets, a run, a node, a sandbox, an ability, a project */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'warroom2-'));
  const w = (p: string, s: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), s); };
  w('lanes/swarm/presets/fixture-3.cue', `package swarm\n\nswarm: {\n\tid: "fixture-3"\n\tpreset: "fixture-3"\n\ttopology: "council"\n\trounds: 2\n\tmembers: [\n\t\t{id: "seat-1", kind: "model", model: "placeholder/one", provider: "openrouter"},\n\t\t{id: "seat-2", kind: "harness", harness: "harn-a", node: "mac"},\n\t]\n\tsize: 2\n\tbudget: {usd: 0.4, max_calls: 12}\n\tjudge: {tier: "edge", model: "placeholder/two"}\n\tnetwork: {policy: "open"}\n}\n`);
  w('lanes/swarm/presets/fixture-2.cue', `package swarm\n\nswarm: {\n\tid: "fixture-2"\n\tpreset: "fixture-2"\n\ttopology: "fanout"\n\tmembers: [\n\t\t{id: "slot-1", kind: "model", model: "placeholder/one", provider: "openrouter"},\n\t]\n\tsize: 1\n\tbudget: {usd: 0, max_calls: 4}\n\tjudge: {tier: "local"}\n\tnetwork: {policy: "closed"}\n}\n`);
  w('lanes/swarm/runs/swarm_fix0001_aaaa.json', JSON.stringify({
    where: 'edge', room: 'fixture-room', worker: 'https://placeholder.example',
    spec: { v: 1, id: 'fixture-3', preset: 'fixture-3', topology: 'council', size: 2, members: [{ id: 'seat-1', kind: 'model', sandbox: 'none' }, { id: 'seat-2', kind: 'harness', harness: 'harn-a', sandbox: 'sbx' }], budget: { usd: 0.4, max_calls: 12 }, judge: { tier: 'edge', model: 'placeholder/two' }, network: { policy: 'closed' } },
    task: 'placeholder task', result: { ok: true, run_id: 'swarm_fix0001_aaaa', usd: 0.01, ms: 900, calls: [{ member: 'seat-1', tokens_reasoning: 42 }] }, receipt: 'fix',
  }));
  w('fleet/nodes.json', JSON.stringify({ v: 1, note: 'fixture', nodes: [{ id: 'node-a', tailnet_name: 'node-a', tailnet_ip: '0.0.0.0', kind: 'fixture', ssh: 'ssh node-a', status: 'joined', role: ['ollama'] }] }));
  w('lanes/sandbox/runs/sb_fix0001_bbbb.json', JSON.stringify({ id: 'sb_fix0001_bbbb', label: 'seed:fixture', image: 'placeholder/img:1', model: 'placeholder/one', platform: 'linux/arm64', files: 2, driver_exit: 0, result: { ok: true } }));
  w('lanes/abilities/results/harn-a.json', JSON.stringify({ harness: 'harn-a', abilities: { one_shot: { value: true } }, isolation: 'private home', mcp_setup_files: [{ path: '/placeholder/mcp.json' }] }));
  w('projects/proj-a/profile.cue', `package profile\n\nprofile: {\n\tname: "proj-a"\n\towner: "placeholder"\n\tbudget: max_spend_usd: 2\n\tharnesses: allowed: ["harn-a"]\n}\n`);
  w('projects/proj-a/drop/input.txt', 'placeholder input');
  return root;
}

describe('warroom2 readers over placeholder fixtures', () => {
  it('presets, runs, nodes, sbx, abilities, projects parse with schema fields', async () => {
    const root = fixtureRoot();
    process.env.TIMMY_REPO_ROOT = root;
    process.env.TIMMY_PROJECTS_ROOT = join(root, 'projects');
    const w2 = await import('../src/harness/warroom2.js');
    const presets = w2.swarmPresets();
    expect(presets.map(p => p.name).sort()).toEqual(['fixture-2', 'fixture-3']);
    const council = presets.find(p => p.name === 'fixture-3');
    expect(council?.topology).toBe('council');
    expect(council?.size).toBe(2);
    expect(council?.policy).toBe('open');
    expect(council?.judge.tier).toBe('edge');
    expect(council?.members.some(m => m.kind === 'harness' && m.harness === 'harn-a')).toBe(true);
    const runs = w2.swarmRuns([]);
    expect(runs.length).toBe(1);
    expect(runs[0].tokensThinking).toBe(42);
    expect(runs[0].closed).toBe(true);
    expect(runs[0].judge.startsWith('edge')).toBe(true);
    const nodes = w2.nodeStats([
      { subject: 'node.join x', node: 'node-a', mem_total_gb: 128 },
      { subject: 'chat.turn x', node: 'node-a', model: 'placeholder/one', eval_tok_per_s: 18 },
    ]);
    expect(nodes[0].reachable).toBe(true);
    expect(nodes[0].memGb).toBe(128);
    expect(nodes[0].tokPerS).toBe(18);
    expect(nodes[0].models).toContain('placeholder/one');
    const sbx = w2.sbxRuns();
    expect(sbx.length).toBe(1);
    expect(sbx[0].ok).toBe(true);
    const ab = w2.abilities();
    expect(ab[0].harness).toBe('harn-a');
    expect(ab[0].mcpMode).toBe('stdio');
    expect(ab[0].skills).toContain('one_shot');
    const pj = w2.projects();
    expect(pj.map(p => p.name)).toContain('proj-a');
    expect(pj.find(p => p.name === 'proj-a')?.drop).toContain('drop/input.txt');
    delete process.env.TIMMY_REPO_ROOT;
    delete process.env.TIMMY_PROJECTS_ROOT;
  });
});

describe('warroom2 keys', () => {
  it('COMMAND NORMAL owns the swarm keys and the footer names them', () => {
    const s0 = { ...initialShell(), tab: 'COMMAND' as const };
    expect(shellOnKey(s0, 'w').actions).toContain('swarm-toggle');
    expect(shellOnKey(s0, 'l').actions).toContain('sw-launch');
    expect(shellOnKey(s0, 'T').actions).toContain('sw-topology');
    expect(shellOnKey(s0, ']').actions).toContain('sw-preset-next');
    expect(footerHintsShellShort('NORMAL', 'COMMAND')).toContain('[w] swarm');
  });
});

describe('warroom2 render gates', { timeout: 90000 }, () => {
  for (const width of [120, 80]) {
    it(`COMMAND (swarm + engine + bulkheads) fits ${width} with no ellipsis in any new cell`, async () => {
      const view = render(React.createElement(ShellV2, { width }));
      await until(view, x => x.includes('YOUR JOURNEY') || x.includes('TIMMY'));
      view.stdin.write('6');
      await until(view, x => /COMMANDER ·/i.test(x));
      view.stdin.write('w');
      const f = await until(view, x => x.includes('SWARM'));
      const lines = f.split('\n');
      const rule = lines.findIndex(l => /^─+$/.test(l.trim()));
      const hdr = lines.slice(0, rule === -1 ? 2 : rule);
      expect(hdr.length).toBeLessThanOrEqual(2);
      expect(hdr.join('\n')).toContain('TIMMY');
      for (const title of ['SWARM', 'ENGINE ROOM', 'BULKHEADS', 'HARNESS PANES']) {
        const block = cardBlock(f, title);
        if (width === 80 && (title === 'ENGINE ROOM' || title === 'BULKHEADS' || title === 'HARNESS PANES')) continue; // rail hidden when narrow
        expect(block.length, `${title} card rendered`).toBeGreaterThan(0);
        expect(block.join('\n'), `${title} has no ellipsis cell`).not.toContain('…');
        expect(f.split('\n').filter(l => l.includes(title)).length).toBeGreaterThanOrEqual(1);
      }
      view.unmount();
    });
    it(`LIBRARY (skills tree) fits ${width}`, async () => {
      const view = render(React.createElement(ShellV2, { width }));
      await until(view, x => x.includes('YOUR JOURNEY') || x.includes('TIMMY'));
      view.stdin.write('4');
      const f = await until(view, x => x.includes('MODELS'));
      if (width === 120) {
        const skills = cardBlock(f, 'SKILLS');
        expect(skills.length).toBeGreaterThan(0);
        expect(skills.join('\n')).not.toContain('…');
      }
      for (const l of f.split('\n')) expect(l.length).toBeLessThanOrEqual(width + 1);
      view.unmount();
    });
  }
});
