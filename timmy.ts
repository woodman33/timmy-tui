#!/usr/bin/env node
// timmy — the shipped bin (package.json "bin": dist/timmy.js).
//
// It answers three things itself: a bare `timmy` boots the Command Post, `version` prints the
// package version, and `demo` writes the legacy demo receipt (README + tests/receipt.test.ts).
// EVERY other verb is forwarded to src/cli.ts, the modern CLI surface — there is no verb
// whitelist here any more (ui-v3-t9r2 C0 audit: `timmy cockpit|privacy|engine|clip|status|swarm`
// never reached the installed command; Will, 2026-09-14). A verb the CLI learns is reachable
// from the installed command the moment it exists; tests/bin-verbs.test.ts enumerates the CLI's
// verbs and asserts each one reaches it through this bin. TIMMY_BIN_DRY_RUN=1 prints the routing
// decision as one JSON line instead of booting or spawning.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { computeReceiptHash, Receipt } from './src/receipt/schema.js';
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

const DRY_RUN = process.env.TIMMY_BIN_DRY_RUN === '1';
/** With TIMMY_BIN_DRY_RUN=1: print where this invocation goes and stop before it goes there. */
function decide(decision: Record<string, unknown>): void {
  if (!DRY_RUN) return;
  console.log(JSON.stringify(decision));
  process.exit(0);
}

// zero-config (v1.0.0-rc1): bare `timmy` boots the Tokyo Night Command Post
if (args.length === 0) {
  decide({ native: 'boot', argv: args });
  const jsEntry = fileURLToPath(new URL('./cli.js', import.meta.url));      // packaged (dist siblings)
  const tsEntry = fileURLToPath(new URL('./cli.tsx', import.meta.url));    // repo run
  const r = fs.existsSync(jsEntry)
    ? spawnSync(process.execPath, [jsEntry], { stdio: 'inherit' })
    : spawnSync('npx', ['tsx', tsEntry], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

const command = cleanArgs[0];

if (command === 'version' || args.includes('--version') || args.includes('-v')) {
  decide({ native: 'version', argv: args });
  const metadata = getPackageMetadata();
  console.log(`${metadata.name} v${metadata.version}`);
  process.exit(0);
}

// Every verb the bin does not answer itself — help included — goes to the CLI untouched.
if (command !== 'demo') {
  // linked bin runs from dist/; dev runs from source — resolve accordingly
  const cliPath = fileURLToPath(new URL(import.meta.url.includes('/dist/') ? './src/cli.js' : './src/cli.ts', import.meta.url));
  decide({ forward: 'src/cli', cli: path.relative(process.cwd(), cliPath), argv: args });
  const r = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

// `timmy demo` — the legacy local demo receipt (kept native: README documents it and
// tests/receipt.test.ts pins it; src/cli.ts's own `demo` is the chain-views cast).
decide({ native: 'demo', argv: args });
{
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
