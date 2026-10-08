#!/usr/bin/env node
// timmy — the shipped bin (package.json "bin": dist/timmy.js).
//
// It answers two things itself: `version` prints the package version, and `demo` writes the legacy
// demo receipt (README + tests/receipt.test.ts). A bare `timmy` is `timmy repl`, the inline REPL
// (fourth order, step 6: it moved there once LIVE-01 passed on the operator's Mac, ledger row 71);
// the full-screen monitor, the old Command Post, is `timmy watch`.
// EVERY other verb is forwarded to src/cli.ts, the modern CLI surface, run as a child process that
// signals sent to `timmy` reach — there is no verb whitelist here any more (ui-v3-t9r2 C0 audit:
// `timmy cockpit|privacy|engine|clip|status|swarm` never reached the installed command; Will,
// 2026-09-14). A verb the CLI learns is reachable from the installed command the moment it exists;
// tests/bin-verbs.test.ts enumerates the CLI's verbs and asserts each one reaches it through this bin,
// and tests/bin-signals.test.ts that a signal sent to the bin reaches the CLI. TIMMY_BIN_DRY_RUN=1
// prints the routing decision as one JSON line instead of booting or spawning.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
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

// Bare `timmy` opens the REPL: it goes on to the CLI as `timmy repl`.
const forwarded = args.length === 0 ? ['repl'] : args;
const command = args.length === 0 ? 'repl' : cleanArgs[0];

if (command === 'version' || args.includes('--version') || args.includes('-v')) {
  decide({ native: 'version', argv: args });
  const metadata = getPackageMetadata();
  console.log(`${metadata.name} v${metadata.version}`);
  process.exit(0);
}

// Every verb the bin does not answer itself — help included — goes to the CLI untouched. The CLI runs as
// a child process, and the bin waits for it without blocking, so a SIGTERM or SIGHUP sent to `timmy`
// reaches it: in spawnSync the bin died at once and left the REPL running, orphaned. SIGINT is not passed
// on: the terminal sends it to both already (and in raw mode Ctrl+C is a key the REPL reads), so passing
// it would deliver it twice. The bin exits with the CLI's status, or 128 plus the signal that ended it.
if (command !== 'demo') {
  // linked bin runs from dist/; dev runs from source — resolve accordingly
  const compiled = import.meta.url.endsWith('.js');
  const cliPath = fileURLToPath(new URL(compiled ? './src/cli.js' : './src/cli.ts', import.meta.url));
  decide({ forward: 'src/cli', cli: path.relative(process.cwd(), cliPath), argv: forwarded });
  const loader = compiled ? [] : ['--import', (await import('node:module')).createRequire(import.meta.url).resolve('tsx')];
  const child = spawn(process.execPath, [...loader, cliPath, ...forwarded], { stdio: 'inherit' });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGHUP', () => child.kill('SIGHUP'));
  process.on('SIGINT', () => {});
  const status = await new Promise<number>((resolve) => {
    child.on('error', (err) => { process.stderr.write(`timmy: could not start the CLI (${err.message}).\n`); resolve(69); });
    // The bin's only modules are schema and version (tests/runtime-package.test.ts), so the status is computed here.
    child.on('exit', (code, signal) => {
      const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
      resolve(code ?? (n ? 128 + n : 1));
    });
  });
  process.exit(status);
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
