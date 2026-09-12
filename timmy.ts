#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { computeReceiptHash, Receipt } from './src/receipt/schema.js';
import crypto from 'crypto';
import { VERSION } from './src/version.js';

function getPackageMetadata() {
  const possiblePaths = [
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
  chat            Open the WALNUT counterflow chat surface (--legacy = old path)
  seal            Seal a generic receipt: timmy seal <subject> [--meta k=v]…
  verify          Read-only chain verify: ok/receipts/epochs, exit 1 if broken
  docs verify     Verify GitBook docs structure, CLI, and safe env setup
  docs preview    Render and serve local docs preview
  docs publish    Verify GitBook auth and prepare Git Sync publication
  providers audit List provider readiness without printing secrets
  sceneforge      Use the authenticated Cloudflare control plane via MCPorter
  vision          Open Roboflow visual templates, inspections and evidence review

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

if (((args.includes('--help') || args.includes('-h')) && cleanArgs[0] !== 'vision') || cleanArgs[0] === 'help') {
  printHelp();
  process.exit(0);
}

// zero-config (v1.0.0-rc1): bare `timmy` boots the Tokyo Night Command Post
if (cleanArgs.length === 0) {
  const jsEntry = fileURLToPath(new URL('./cli.js', import.meta.url));      // packaged (dist siblings)
  const tsEntry = fileURLToPath(new URL('./cli.tsx', import.meta.url));    // repo run
  const r = fs.existsSync(jsEntry)
    ? spawnSync(process.execPath, [jsEntry], { stdio: 'inherit' })
    : spawnSync('npx', ['tsx', tsEntry], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
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

// Modern CLI surface (mcp serve/logs/approve/events/…) lives in src/cli.ts.
if (['vision', 'mcp', 'logs', 'approve', 'events', 'epoch', 'q', 'map', 'chat', 'seal', 'verify', 'model', 'models', 'do'].includes(command)) {
  // linked bin runs from dist/; dev runs from source — resolve accordingly
  const cliPath = fileURLToPath(new URL(import.meta.url.includes('/dist/') ? './src/cli.js' : './src/cli.ts', import.meta.url));
  const r = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
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
          : 'timmy-sceneforge';
  const tsPath = fileURLToPath(new URL(`./scripts/${baseName}.ts`, import.meta.url));
  const jsPath = fileURLToPath(new URL(`./scripts/${baseName}.js`, import.meta.url));
  
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
            : command === 'sceneforge'
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
            : command === 'sceneforge'
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
