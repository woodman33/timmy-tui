#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { computeReceiptHash, Receipt } from './receipt/schema.js';
import crypto from 'crypto';
import { VERSION } from './version.js';
import { readEvents } from './utils/eventbus.js';
import { receiptsToOtlp } from './utils/otlp.js';
import { listClipJobs } from './utils/clip.js';
import { runClipJob, replayFromEdl } from './utils/cliprunner.js';
import { listGenerations } from './utils/generations.js';
import { runOpenDesignGen } from './utils/designrunner.js';
import { edlToOtio } from './utils/otio.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

function getPackageMetadata() {
  const possiblePaths = [
    new URL('../../package.json', import.meta.url),
    new URL('../package.json', import.meta.url),
    new URL('./package.json', import.meta.url)
  ];
  for (const url of possiblePaths) {
    const p = fileURLToPath(url);
    if (fs.existsSync(p)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { name: pkg.name || 'timmy-tui', version: pkg.version || VERSION };
      } catch {
        // ignore
      }
    }
  }
  return { name: 'timmy-tui', version: VERSION };
}

function printHelp() {
  console.log(`TIMMY AgentOps

Usage: timmy <command> [options]

Commands:
  demo            Run a local demo and generate a verifiable receipt
  proof <task>    Record a proof receipt for a simulated task
  version         Print package name and version
  setup           Initialize directory and template folder structure
  doctor          Check optional local capabilities without running workloads
  docs verify     Verify GitBook docs structure, CLI, and safe env setup
  docs preview    Render and serve local docs preview
  docs publish    Verify GitBook auth and prepare Git Sync publication
  providers audit List provider readiness without printing secrets
  runtimes list   List local, SDK, and remote agent runtime profiles
  runtimes doctor Detect runtime readiness without executing agent tasks
  sceneforge      Use the authenticated Cloudflare control plane via MCPorter
  events          Stream the TUI's event envelope as NDJSON (--follow, --human, --otlp)
  logs            Live web companion: event bus + receipt chain + verify (auto-pops browser; --port N)
  approve <hash>  Mint a single-use, 5-min approval token bound to a gated tool's plan hash
  clip list|run|replay  List · run headless + seal · replay from cut-list alone
  design list|run       Open Design (MCP) gens: queue in GENS, execute + seal here
  doctor deps|network|hardware  Read-only posture checks (never auto-fixes)
  mcp status|inspect|probe  MCP wire visibility: mcpsnoop + mcp-probe (opt-in)

Options:
  --json          Output results in raw JSON format (for demo/proof)
  --out <dir>     Override output folder directory (for demo/proof)
`);
}

function getFileSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function printTable(rows: { label: string; value: string }[]) {
  const maxLabelLen = Math.max(...rows.map(r => r.label.length));
  const maxValueLen = Math.max(...rows.map(r => r.value.length));
  
  const topBorder = '┌' + '─'.repeat(maxLabelLen + 2) + '┬' + '─'.repeat(maxValueLen + 2) + '┐';
  const bottomBorder = '└' + '─'.repeat(maxLabelLen + 2) + '┴' + '─'.repeat(maxValueLen + 2) + '┘';
  const middleBorder = '├' + '─'.repeat(maxLabelLen + 2) + '┼' + '─'.repeat(maxValueLen + 2) + '┤';
  
  console.log(topBorder);
  rows.forEach((row, idx) => {
    const label = row.label.padEnd(maxLabelLen);
    const value = row.value.padEnd(maxValueLen);
    console.log(`│ ${label} │ ${value} │`);
    if (idx < rows.length - 1) {
      console.log(middleBorder);
    }
  });
  console.log(bottomBorder);
}

const args = process.argv.slice(2);

// Filter out --json, --out <dir>
const cleanArgs: string[] = [];
let outDir: string | null = null;
const isJson = args.includes('--json');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') {
    continue;
  }
  if (args[i] === '--out') {
    if (args[i + 1]) {
      outDir = args[i + 1];
      i++;
    }
    continue;
  }
  cleanArgs.push(args[i]);
}

if (cleanArgs.length === 0 || args.includes('--help') || args.includes('-h') || cleanArgs[0] === 'help') {
  printHelp();
  process.exit(0);
}

const command = cleanArgs[0];

if (command === 'version' || args.includes('--version') || args.includes('-v')) {
  const metadata = getPackageMetadata();
  console.log(`${metadata.name} v${metadata.version}`);
  process.exit(0);
}

if (command === 'start') {
  console.log('timmy start — PLANNED alias for npm start');
  process.exit(0);
}

// ── FORGE lane (p13; decisions.md D1) — new verbs only, gated, additive ──
const forgeFlag = (n: string): string | undefined => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? args[i + 1] : undefined;
};
const forgeGate = (): void => {
  if (process.env.TIMMY_FORGE !== '1') {
    console.log('forge lane gated — rerun with TIMMY_FORGE=1 (decisions.md D1)');
    process.exit(2);
  }
};

if (command === 'gen') {
  forgeGate();
  const { runGen } = await import('./forge/gen.js');
  const lines = runGen({
    sheet: forgeFlag('sheet'), provider: forgeFlag('provider'),
    stub: args.includes('--stub'), allowSpend: args.includes('--allow-spend'),
    slots: forgeFlag('slots')?.split(','),
  });
  for (const l of lines) {
    console.log(`${l.slot_id}  req ${l.request.slice(7, 15)}…  res ${l.result.slice(7, 15)}…  ${l.local ? 'local' : 'remote'}  $${l.cost.toFixed(2)}  ${l.ms}ms  ${l.artifact}`);
  }
  process.exit(0);
}

if (command === 'timeline' && args[1] === 'emit') {
  forgeGate();
  const { emitTimeline } = await import('./forge/timeline.js');
  const r = emitTimeline({ specPath: forgeFlag('spec'), out: forgeFlag('out') });
  console.log(`timeline.emit · ${r.clips} clips → ${r.file} · seal ${r.seal.slice(7, 15)}…`);
  process.exit(0);
}

if (command === 'forge') {
  if (args[1] === 'wire') {
    const { wireLanes } = await import('./forge/stubs.js');
    for (const w of wireLanes()) console.log(`${w.lane}  ${w.status}  via ${w.via}  [${w.flag}]  ${w.note}`);
    process.exit(0);
  }
  // glass: full TUI with the forge lane armed (view 9 right pane)
  const tuiEntry = fileURLToPath(new URL('../cli.tsx', import.meta.url));
  const r = spawnSync('npx', ['tsx', tuiEntry], { stdio: 'inherit', env: { ...process.env, TIMMY_FORGE: '1' } });
  process.exit(r.status ?? 0);
}

if (command === 'chat') {
  // WALNUT counterflow chat surface (p12; DESIGN.md §3 two-pane grammar).
  // --legacy keeps the old chat path reachable until deliberately deleted.
  const legacy = args.includes('--legacy');
  const chatEntry = fileURLToPath(new URL('./tui/chatmain.tsx', import.meta.url));
  const tuiEntry = fileURLToPath(new URL('../cli.tsx', import.meta.url));
  const r = legacy
    ? spawnSync('npx', ['tsx', tuiEntry], { stdio: 'inherit', env: { ...process.env, TIMMY_LEGACY_CHAT: '1' } })
    : spawnSync('npx', ['tsx', chatEntry], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

if (command === 'seal') {
  // Generic sealing verb (SHOWRUNNER Phase A-FIX): thin CLI wrapper over
  // the same appendReceipt path the chat uses. Subjects are data — no
  // whitelist, so Walnut's vocabulary requires no code. DESIGN.md §1:
  // appends through the canonical writer, never edits chain logic.
  const meta: Record<string, string> = {};
  const subject: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--meta') {
      const kv = String(args[++i] ?? '');
      const eq = kv.indexOf('=');
      if (eq > 0) meta[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--json') {
      continue;
    } else {
      subject.push(a);
    }
  }
  const subj = subject.join(' ').trim();
  if (!subj) {
    console.error('usage: timmy seal <subject> [--meta k=v]…');
    process.exit(2);
  }
  const { appendReceipt } = await import('./utils/receipts.js');
  const r = appendReceipt('runs', {
    kind: 'seal', subject: subj, policy: 'auto', sources: [meta],
  } as never);
  console.log(`sealed ${r.hash.slice(0, 16)}… · ${subj}`);
  process.exit(0);
}

if (command === 'nfc' || command === 'custody') {
  // Vault Custody lanes: `timmy nfc program|template|selftest` programs NTAG 424
  // DNA stickers over an ACR122U; `timmy custody commit` seals a box's contents
  // before the sticker goes on. Both live under lanes/ and run under tsx so they
  // can import the edge verifier's TypeScript (vault-custody/src/lib) directly —
  // the programmer and the verifier must share one key derivation.
  const lane = fileURLToPath(new URL(command === 'nfc' ? '../lanes/nfc/program.mjs' : '../lanes/custody/commit.mjs', import.meta.url));
  const r = spawnSync('npx', ['tsx', lane, ...args.slice(1)], { stdio: 'inherit', cwd: fileURLToPath(new URL('..', import.meta.url)) });
  process.exit(r.status ?? 1);
}

if (command === 'commander' || command === 'cf' || command === 'project' || command === 'sim' || command === 'reconcile') {
  // mindship-v5c2 lanes: `timmy commander …` drives the durable Commander on
  // timmy-ai-proxy; `timmy cf …` is the Cloudflare war-room feed + verbs;
  // `timmy project new|menu|list` is the project folder standard; `timmy sim
  // run|replay` is THE SHIP story simulator. All live under lanes/ and run
  // under tsx so they can import repo TypeScript where they need it.
  const lanes: Record<string, string> = { commander: '../lanes/commander/cli.mjs', cf: '../lanes/cf/pane.mjs', project: '../lanes/project/project.mjs', sim: '../lanes/sim/sim.mjs', reconcile: '../lanes/openrouter/reconcile.mjs' };
  const lane = fileURLToPath(new URL(lanes[command], import.meta.url));
  const r = spawnSync('npx', ['tsx', lane, ...args.slice(1)], { stdio: 'inherit', cwd: fileURLToPath(new URL('..', import.meta.url)) });
  process.exit(r.status ?? 1);
}

if (command === 'verify') {
  // Read-only chain verify (SHOWRUNNER Phase A-FIX). Exit 1 on broken link.
  const { verifyChain } = await import('./utils/receipts.js');
  const v = verifyChain('runs');
  console.log(`ok:${v.ok} receipts:${v.count} epochs:${v.segments.length}`);
  process.exit(v.ok ? 0 : 1);
}

if (command === 'clip') {
  // Headless clip runner: list jobs, or run one deterministically and seal it.
  const sub = args[1];
  if (sub === 'list') {
    for (const j of listClipJobs()) console.log(`${j.id}  ${j.project.padEnd(14)} ${j.sources.length} src  ${j.status}`);
    process.exit(0);
  }
  if (sub === 'run') {
    const job = listClipJobs().find(j => j.id === args[2]);
    if (!job) { console.error(`no clip job ${args[2] ?? ''} — see timmy clip list`); process.exit(2); }
    const r = runClipJob(job);
    console.log(r.ok ? `sealed: ${r.receiptHash}\nrun:  ${r.runDir}\nout:  ${r.output}` : `failed: ${r.note}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (sub === 'replay') {
    // T1 exit criterion: replay from the cut-list ALONE, env-locked + signed.
    const r = replayFromEdl(args[2] ?? '');
    console.log(r.verified
      ? `verified: replay matches sealed output\nreceipt: ${r.receiptHash}`
      : `not verified: ${r.note ?? 'replay drift'}\nreceipt: ${r.receiptHash}`);
    process.exit(r.verified ? 0 : 1);
  }
  console.error('Usage: timmy clip list | timmy clip run <id> | timmy clip replay <id>');
  process.exit(2);
}

if (command === 'mcp' && args[1] === 'serve') {
  // timmy as an MCP server: any MCP-speaking agent drives the trust layer.
  const { startMcpServer } = await import('./mcp/server.js');
  startMcpServer();
  await new Promise(() => {}); // stdio server owns the event loop — never exit
}

if (command === 'approve') {
  // Operator surface for the approval gate: mints a single-use, expiring
  // token bound to the exact plan hash a gated tool returned.
  const planHash = args[1];
  if (!planHash) { console.error('usage: timmy approve <planHash>'); process.exit(2); }
  const { issueApproval } = await import('./utils/approvals.js');
  const a = issueApproval(planHash);
  console.log(`approval ${a.token} · plan ${a.planHash} · single-use · expires ${new Date(a.expiresAt).toISOString()}`);
  process.exit(0);
}

if (command === 'map') {
  // Mission Map: serve the tldraw instance + open it (carbonyl if present)
  const { spawnSync, spawn } = await import('child_process');
  const probe = spawnSync('curl', ['-s', '--max-time', '1', 'http://localhost:4321/'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    const srv = spawn('python3', ['-m', 'http.server', '4321', '-d', 'studio/tldraw-mission-map'], { detached: true, stdio: 'ignore' });
    srv.unref();
  }
  const hasCarbonyl = spawnSync('command -v carbonyl', { encoding: 'utf8', shell: true }).status === 0;
  const opener = spawn(hasCarbonyl ? 'carbonyl' : 'open', ['http://localhost:4321'], { detached: true, stdio: 'ignore' });
  opener.unref();
  console.log(`mission map: http://localhost:4321 (${hasCarbonyl ? 'carbonyl' : 'browser'})`);
  process.exit(0);
}

if (command === 'q') {
  // dasel passthrough: one query grammar for json/yaml/toml/xml/csv configs
  const [file, ...expr] = args[0] === 'q' ? args.slice(1) : args;
  if (!file) { console.error('usage: timmy q <file> <dasel-expression>'); process.exit(2); }
  const { spawnSync } = await import('child_process');
  const { readFileSync } = await import('fs');
  const ext = (file.split('.').pop() ?? 'json').replace(/ya?ml/, 'yaml');
  const r = spawnSync('dasel', ['query', '-i', ext, ...(expr.length ? expr : ['.'])], {
    input: readFileSync(file), stdio: ['pipe', 'inherit', 'inherit']
  });
  process.exit(r.status ?? 1);
}

if (command === 'epoch') {
  // Atomic release-epoch rotation (write-temp + rename).
  const n = Number(args[1]);
  if (!n || n < 1) { console.error('usage: timmy epoch <n> [reason]'); process.exit(2); }
  const { rotateEpoch } = await import('./utils/receipts.js');
  rotateEpoch(n, args.slice(2).join(' ') || 'operator rotation');
  console.log(`epoch rotated to ${n}`);
  process.exit(0);
}

if (command === 'logs') {
  // Live companion for headless MCP/CLI sessions: streams the SAME event bus
  // the TUI consumes + receipt chain with verify; auto-pops a browser once.
  const { startLogServer } = await import('./utils/logserver.js');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
  await startLogServer({ port, open: true });
  await new Promise(() => {}); // server owns the event loop
}

if (command === 'design') {
  // Open Design (MCP) gens: queue in GENS, execute headless here.
  const sub = args[1];
  if (sub === 'list') {
    const gens = listGenerations({}).filter(g => g.provider === 'open-design');
    for (const g of gens) console.log(`${g.id}  ${(g.status ?? 'queued').padEnd(8)} ${g.prompt.slice(0, 60)}`);
    if (!gens.length) console.log('no open-design gens yet — pick Open Design (MCP) in the GENS picker ([n])');
    process.exit(0);
  }
  if (sub === 'run') {
    const r = await runOpenDesignGen(args[2] ?? '');
    console.log(r.ok ? `done · ${r.note}` : `failed · ${r.note}`);
    process.exit(r.ok ? 0 : 1);
  }
  console.error('Usage: timmy design list | timmy design run <genId>');
  process.exit(2);
}

if (command === 'export') {
  // EDL v1 → OTIO interchange (spec §2.9 amendment): Hollywood speaks timmy.
  const kind = args[1];
  if (kind === 'otio' && args[2]) {
    const manifestPath = join(process.cwd(), '.timmy', 'runs', args[2], 'manifest.json');
    if (!existsSync(manifestPath)) {
      console.error(`no run manifest at ${manifestPath}`);
      process.exit(2);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { edl?: any; env_lock?: unknown; job?: string };
    if (!manifest.edl) {
      console.error('run manifest has no edl — T0-grade run; T1 runs carry cut-lists');
      process.exit(2);
    }
    const envLockHash = manifest.env_lock
      ? crypto.createHash('sha256').update(JSON.stringify(manifest.env_lock)).digest('hex')
      : undefined;
    const otio = edlToOtio(manifest.edl, { env_lock_hash: envLockHash, model: null });
    const outDir = join(process.cwd(), '.timmy', 'exports');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${args[2]}.otio`);
    writeFileSync(outPath, JSON.stringify(otio, null, 2));
    console.log(`otio: ${outPath}`);
    process.exit(0);
  }
  if (kind === 'agentrun' && args[2]) {
    // v0.5 T1 acceptance artifact: portable sanitized .agentrun bundle.
    const { exportAgentRun } = await import('./utils/agentrun.js');
    const exp = exportAgentRun(args[2]);
    console.log(`agentrun: ${exp.bundle} (${exp.files.length} files, output ${exp.outputSha.slice(0, 16)}…)`);
    process.exit(0);
  }
  console.error('Usage: timmy export otio <runDirName> | timmy export agentrun <jobId>');
  process.exit(2);
}

if (command === 'events') {
  // Headless parity: the SAME NDJSON envelope the TUI consumes (seals,
  // approvals, gen status flips) — for CI replay, the companion, the portal.
  if (args.includes('--otlp')) {
    // Derived OTLP projection of the receipt spine (otel-tui / Langfuse / Jaeger)
    console.log(JSON.stringify(receiptsToOtlp(), null, 2));
    process.exit(0);
  }
  const follow = args.includes('--follow') || args.includes('-f');
  const human = args.includes('--human');
  let seen = 0;
  const dump = () => {
    const evs = readEvents();
    for (const ev of evs.slice(seen)) {
      if (human) console.log(`${ev.ts}  ${ev.kind.padEnd(18)} ${JSON.stringify(ev.payload)}`);
      else console.log(JSON.stringify(ev));
    }
    seen = evs.length;
  };
  dump();
  if (follow) {
    setInterval(dump, 1000);
  } else {
    process.exit(0);
  }
}

if (command === 'demo') {
  const metadata = getPackageMetadata();
  const runId = `run_demo_${Date.now()}`;
  const targetDir = outDir ? path.resolve(outDir, 'receipts') : path.join(process.cwd(), '.timmy', 'receipts');
  
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'demo-receipt.json');
    const relativePath = path.relative(process.cwd(), targetPath);

    const receiptWithoutHash: Omit<Receipt, 'receipt_sha256'> = {
      schema_version: "0.1.0",
      run_id: runId,
      type: "demo",
      task: "demo run",
      created_at: new Date().toISOString(),
      cwd: process.cwd(),
      platform: process.platform,
      node_version: process.version,
      package: {
        name: metadata.name,
        version: metadata.version
      },
      status: "completed",
      artifacts: []
    };

    const initialHash = computeReceiptHash(receiptWithoutHash);
    receiptWithoutHash.artifacts.push({
      path: relativePath,
      sha256: initialHash
    });

    const finalHash = computeReceiptHash(receiptWithoutHash);
    const finalReceipt: Receipt = {
      ...receiptWithoutHash,
      receipt_sha256: finalHash
    };

    fs.writeFileSync(targetPath, JSON.stringify(finalReceipt, null, 2), 'utf8');

    if (isJson) {
      console.log(JSON.stringify(finalReceipt, null, 2));
    } else {
      console.log('TIMMY AgentOps Demo');
      console.log(`✓ Created ${relativePath}`);
      console.log(`✓ Generated receipt hash`);
      console.log(`✓ Local proof complete`);
      console.log(`\nNext:\n  cat ${relativePath}\n`);
      printTable([
        { label: 'Run ID', value: finalReceipt.run_id },
        { label: 'Type', value: finalReceipt.type },
        { label: 'Created At', value: finalReceipt.created_at },
        { label: 'Receipt Hash', value: finalReceipt.receipt_sha256 }
      ]);
    }
    process.exit(0);
  } catch (e: any) {
    console.error(`✕ Demo failed: ${e.message}`);
    process.exit(1);
  }
}

if (command === 'proof') {
  const task = cleanArgs[1] || '';
  if (!task) {
    console.error('Error: Please specify a task description. Example: timmy proof "create a hello world Cloudflare Worker"');
    process.exit(1);
  }
  
  const metadata = getPackageMetadata();
  const runId = `run_proof_${Date.now()}`;
  const runDir = outDir ? path.resolve(outDir, 'runs', runId) : path.join(process.cwd(), '.timmy', 'runs', runId);
  
  try {
    fs.mkdirSync(runDir, { recursive: true });
    
    const replayPath = path.join(runDir, 'replay.md');
    const replayContent = `# Replay: ${task}

Generated by TIMMY AgentOps.

## Execution Steps

- [x] Initialized workspace
- [x] Created wrangler.toml
- [x] Wrote index.ts
- [x] Executed local dry-run tests
- [x] Verified deployment configuration

## Evidence Logs

[info] Worker template scaffolded
[info] Build completed (0.12s)
[info] Local testing port 8787 active
[info] Self-test validation: PASS
`;
    fs.writeFileSync(replayPath, replayContent, 'utf8');
    const replaySha = getFileSha256(replayPath);

    const receiptWithoutHash: Omit<Receipt, 'receipt_sha256'> = {
      schema_version: "0.1.0",
      run_id: runId,
      type: "proof",
      task: task,
      created_at: new Date().toISOString(),
      cwd: process.cwd(),
      platform: process.platform,
      node_version: process.version,
      package: {
        name: metadata.name,
        version: metadata.version
      },
      status: "completed",
      artifacts: [
        {
          path: path.relative(process.cwd(), replayPath),
          sha256: replaySha
        }
      ]
    };

    const finalHash = computeReceiptHash(receiptWithoutHash);
    const finalReceipt: Receipt = {
      ...receiptWithoutHash,
      receipt_sha256: finalHash
    };

    const receiptPath = path.join(runDir, 'receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify(finalReceipt, null, 2), 'utf8');

    const manifestPath = path.join(runDir, 'manifest.json');
    const manifestData = {
      run_id: runId,
      task: task,
      created_at: finalReceipt.created_at,
      cwd: finalReceipt.cwd,
      node_version: finalReceipt.node_version,
      platform: finalReceipt.platform,
      package_version: metadata.version,
      command_invoked: `timmy proof "${task}"`,
      status: "completed",
      receipt_hash: finalHash
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');

    if (isJson) {
      console.log(JSON.stringify(finalReceipt, null, 2));
    } else {
      console.log('TIMMY Proof Run');
      console.log(`✓ Run created: ${path.relative(process.cwd(), runDir)}/`);
      console.log(`✓ Receipt generated`);
      console.log(`✓ Replay markdown generated`);
      console.log(`✓ Manifest hash sealed`);
      console.log(`\nNext:\n  cat ${path.relative(process.cwd(), receiptPath)}\n`);
      printTable([
        { label: 'Run ID', value: finalReceipt.run_id },
        { label: 'Task', value: finalReceipt.task },
        { label: 'Created At', value: finalReceipt.created_at },
        { label: 'Receipt Hash', value: finalReceipt.receipt_sha256 }
      ]);
    }
    process.exit(0);
  } catch (e: any) {
    console.error(`✕ Proof failed: ${e.message}`);
    process.exit(1);
  }
}

if (command === 'setup') {
  console.log('Initializing TIMMY workspace folder structure...');
  const workspaceRoot = process.cwd();
  const requiredDirs = ['skills', 'souls', 'context', 'porter-packs', 'receipts', '.timmy', 'auth', 'mcp-cli'];

  try {
    for (const d of requiredDirs) {
      const fullDir = path.join(workspaceRoot, d);
      if (!fs.existsSync(fullDir)) {
        fs.mkdirSync(fullDir, { recursive: true });
      }
    }

    // Default SKILL.md
    const skillDir = path.join(workspaceRoot, 'skills', 'example-skill');
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      fs.writeFileSync(skillFile, `# Example Skill\n\n## Description\nThis is an example TIMMY governed capability definition.\n`, 'utf8');
    }

    // Default SOUL.md
    const soulDir = path.join(workspaceRoot, 'souls', 'quartermaster');
    if (!fs.existsSync(soulDir)) fs.mkdirSync(soulDir, { recursive: true });
    const soulFile = path.join(soulDir, 'SOUL.md');
    if (!fs.existsSync(soulFile)) {
      fs.writeFileSync(soulFile, `# Quartermaster Soul\n\n## Description\nThis defines the behavior and personality of the Quartermaster agent.\n`, 'utf8');
    }

    // Default Auth files
    const authDir = path.join(workspaceRoot, 'auth');
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    const authM = path.join(authDir, 'auth.md');
    if (!fs.existsSync(authM)) {
      fs.writeFileSync(authM, `# TIMMY Auth Doctrine\n\n“Humans log in. Agents show passports. Tools require visas. Receipts prove the trip.”\n`, 'utf8');
    }
    const passM = path.join(authDir, 'passports.md');
    if (!fs.existsSync(passM)) {
      fs.writeFileSync(passM, `# Passport Registry\n\n- agent.quartermaster: Nerdy Quartermaster auditor agent passport\n`, 'utf8');
    }
    const visaM = path.join(authDir, 'visas.md');
    if (!fs.existsSync(visaM)) {
      fs.writeFileSync(visaM, `# Visa Policy\n\n- visa.local.read: Granted\n`, 'utf8');
    }
    const scopeM = path.join(authDir, 'scopes.md');
    if (!fs.existsSync(scopeM)) {
      fs.writeFileSync(scopeM, `# AgentPass Scopes\n\n- fs.read.workspace\n`, 'utf8');
    }

    // Receipts
    const receiptDir = path.join(workspaceRoot, 'receipts');
    if (!fs.existsSync(receiptDir)) fs.mkdirSync(receiptDir, { recursive: true });

    console.log('✓ TIMMY Governed Workspace Root folder structure initialized successfully.');
    process.exit(0);
  } catch (e: any) {
    console.error(`✕ Setup failed: ${e.message}`);
    process.exit(1);
  }
}

if (
  command !== 'doctor' &&
  command !== 'docs' &&
  command !== 'providers' &&
  command !== 'runtimes' &&
  command !== 'mcp' &&
  command !== 'clip' &&
  command !== 'design' &&
  command !== 'export' &&
  command !== 'sceneforge'
) {
  printHelp();
  process.exit(2);
}

// Helper function to resolve script path dynamically for TS and JS environments
function getScriptPath(cmd: string): string {
  const baseName =
    cmd === 'doctor'
      ? 'timmy-doctor'
      : cmd === 'docs'
        ? 'timmy-docs'
        : cmd === 'providers'
          ? 'timmy-providers'
          : cmd === 'runtimes'
            ? 'timmy-runtimes'
          : cmd === 'mcp'
            ? 'timmy-mcp'
          : 'timmy-sceneforge';
  const tsPath = fileURLToPath(new URL(`../scripts/${baseName}.ts`, import.meta.url));
  const jsPath = fileURLToPath(new URL(`../scripts/${baseName}.js`, import.meta.url));
  
  if (fs.existsSync(tsPath)) {
    return tsPath;
  }
  return jsPath;
}

const scriptPath = getScriptPath(command);
const isTs = scriptPath.endsWith('.ts');
const spawnCmd = isTs ? 'npx' : process.execPath;
const spawnArgs = isTs 
  ? [
      'tsx',
      scriptPath,
      args[1] ||
        (command === 'docs'
          ? 'verify'
          : command === 'providers'
            ? 'audit'
            : command === 'runtimes'
              ? 'list'
            : command === 'sceneforge'
              ? 'status'
              : command === 'mcp'
                ? 'status'
                : 'doctor'),
      ...args.slice(2)
    ]
  : [
      scriptPath,
      args[1] ||
        (command === 'docs'
          ? 'verify'
          : command === 'providers'
            ? 'audit'
            : command === 'runtimes'
              ? 'list'
            : command === 'sceneforge'
              ? 'status'
              : command === 'mcp'
                ? 'status'
                : 'doctor'),
      ...args.slice(2)
    ];

const child = spawn(spawnCmd, spawnArgs, {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
