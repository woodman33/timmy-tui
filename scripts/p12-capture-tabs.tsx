// p12 — deterministic 120x40 PTY-frame captures of the merged ShellV2 tabs.
// One live mount, navigated with real keys. NOTE (shell-mode.ts l.105): on the
// COMMAND tab digits 1-6 are hijacked to focus-pane, so tabs are switched from
// a non-COMMAND tab. Visit order: HOME(1) -> RUN(2) -> LIBRARY(4) -> COMMAND(6).
// Run: npx tsx scripts/p12-capture-tabs.tsx  (exit 0; frames to stdout)
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROUNDS_MD = `# ROUNDS — ui-next-2 cohort

| hand | tool | worktree | order | round | state | last_seal |
| --- | --- | --- | --- | --- | --- | --- |
| claude | claude | wt-claude | ui-next-2 | R2 | HOLD | sha256_00aa11bb22cc33dd |
| codex | codex-cli | wt-codex | ui-next-2 | R1 | running | sha256_22cc33dd44ee55ff |
| observer | external | — | obs | R0 | idle | — |

## prompt claude R2
Rebase order/ui-next-2 onto the new main and remove the wizard write logic.

## prompt codex R1
Run the privacy gate over the staged set and report every finding.
`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'p12-cap-root-'));
  const store = mkdtempSync(join(tmpdir(), 'p12-cap-store-'));
  process.env.TIMMY_REPO_ROOT = root;
  process.env.TIMMY_STORE = store;
  mkdirSync(join(root, 'lanes'), { recursive: true });
  writeFileSync(join(root, 'ROUNDS.md'), ROUNDS_MD);

  mkdirSync(join(root, 'lanes', 'unreal'), { recursive: true }); // unrealRow.present
  mkdirSync(join(root, 'fleet'), { recursive: true });
  writeFileSync(join(root, 'fleet', 'nodes.json'), JSON.stringify({ nodes: [
    { id: 'spark-a', role: 'dgx-flash', state: 'live', models: 2, tps: 41 },
    { id: 'spark-b', role: 'dgx-flash', state: 'live', models: 1, tps: 38 },
  ]}, null, 2));

  mkdirSync(join(root, 'lanes', 'engines'), { recursive: true });
  writeFileSync(join(root, 'lanes', 'engines', 'engines.json'), JSON.stringify({ engines: [
    { id: 'houdini', version: 'Houdini 22.0.653', installed: true },
  ]}, null, 2));
  writeFileSync(join(root, 'lanes', 'engines', 'inventory.json'), JSON.stringify({ engines: [
    { id: 'houdini', dropRuns: [1, 2, 3], templates: [1, 2, 3, 4, 5], proven: [1, 2] },
  ]}, null, 2));

  mkdirSync(join(root, 'lanes', 'schema'), { recursive: true });
  writeFileSync(join(root, 'lanes', 'schema', 'model-strictness.json'), JSON.stringify({ rows: [
    { model: 'kimi-k3:cloud', tool_schema: 'strict' },
    { model: 'qwen3-coder',   tool_schema: 'never' },
    { model: 'llama3.1-8b',   tool_schema: 'lenient' },
  ]}, null, 2));

  const ue = mkdtempSync(join(tmpdir(), 'p12-ue-'));
  mkdirSync(join(ue, 'Engine'), { recursive: true });
  process.env.UNREAL_ENGINE_ROOT = ue;

  const sig = mkdtempSync(join(tmpdir(), 'p12-sig-'));
  mkdirSync(join(sig, 'out'), { recursive: true });
  writeFileSync(join(sig, 'out', 'latest-checkpoint.json'), JSON.stringify({ id: 'cp-0417', step: 41, budget_usd: 2.5 }));
  writeFileSync(join(sig, 'out', 'opening-state.json'), JSON.stringify({ budget_usd: 3.0 }));
  mkdirSync(join(sig, 'res'), { recursive: true });
  writeFileSync(join(sig, 'res', 'reservations.jsonl'), JSON.stringify({ kind: 'reserve', usd: 0.5 }) + '\n');
  process.env.TIMMY_SIGNAL_DIR = sig;
}

async function main() {
  seed();
  const React = await import('react');
  const { render } = await import('ink-testing-library');
  const { ShellV2 } = await import('../src/tui/components/ShellV2.js');
  const ck = await import('../src/harness/cockpit.js');

  const imp = ck.importRounds(join(process.env.TIMMY_REPO_ROOT as string, 'ROUNDS.md'));
  if (!imp.ok) { console.error('importRounds failed', imp); process.exit(2); }

  const width = 120; const ROWS = 40;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  let view: any = null;
  const frame = async (pred: (f: string) => boolean, ms = 15000): Promise<string> => {
    const t0 = Date.now(); let f = '';
    for (;;) { f = view.lastFrame() ?? ''; if (pred(f) || Date.now() - t0 > ms) return f; await sleep(50); }
  };
  const bounds = (f: string) => f.split('\n').slice(0, ROWS).join('\n');
  const banner = (l: string) => `\n${'='.repeat(24)} ${l}  [120x40] ${'='.repeat(24)}`;
  const goTab = async (digit: string, mark: string, ms = 15000) => {
    view.stdin.write(digit);
    return frame(f => f.trim().split('\n').length > 4 && f.includes(mark), ms);
  };

  view = render(React.createElement(ShellV2 as any, { width }));
  await frame(f => f.trim().length > 0 && f.includes('TIMMY'), 15000); // warm-up

  await goTab('1', 'HOME');
  const t1 = await frame(f => f.includes('YOUR JOURNEY') || f.includes('HOME'), 12000);
  console.log(banner('TAB 1/4 — HOME · journey ladder (default tab)'));
  console.log(bounds(t1));

  await goTab('2', 'RUN');
  await sleep(400);
  console.log(banner('TAB 2/4 — RUN · SignalPane rail bounded'));
  console.log(bounds(await frame(f => /\bRUN\b/.test(f) && f.trim().split('\n').length > 6, 8000)));

  await goTab('4', 'LIBRARY');
  await sleep(400);
  console.log(banner('TAB 3/4 — LIBRARY · OllamaPane rail bounded'));
  console.log(bounds(await frame(f => /\bLIBRARY\b/.test(f) && f.trim().split('\n').length > 6, 8000)));

  await goTab('6', 'COMMAND');
  await frame(f => f.includes('[h] hands') || f.includes('HARNESS PANES'), 12000);
  view.stdin.write('h');
  const t4 = await frame(f => f.includes('HANDS') && f.includes('ENGINE ROOM') && f.includes('claude'), 15000);
  console.log(banner('TAB 4/4 — COMMAND · HANDS beside SWARM + ENGINE ROOM (unreal/houdini rows)'));
  console.log(bounds(t4));

  view.unmount();
  process.exit(0);
}
main().catch(e => { console.error('capture failed:', e); process.exit(1); });
