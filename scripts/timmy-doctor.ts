import { getWorkspaceEvidenceStatus } from '../src/utils/workspace-evidence.js';
import { depsDoctor, networkDoctor, hardwareDoctor, printRows } from '../src/utils/doctors.js';
import { readiness, readinessLines, runDoctor, NODE_MAJOR } from '../src/utils/doctor.js';
import { modelKeySource } from '../src/utils/model-key.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { VERSION } from '../src/version.js';

function parseArgs(argv: string[]) {
  const command = argv.find((arg) => !arg.startsWith('-')) || 'doctor';
  const json = argv.includes('--json');
  return { command, json };
}

async function printDoctor(json = false): Promise<void> {
  const workspace = getWorkspaceEvidenceStatus();
  const pre = await runDoctor();
  // SPEC §00 journey step 1: doctor is a receipt, not just output — the HOME
  // ladder reads doctor.pass off the chain. FIX B (director): copy is
  // "N ok · M skipped"; a pass never says blocked, and a genuine required-check
  // failure seals doctor.fail (status failed) so the ladder row is never ✓.
  try {
    const okN = pre.checks.filter(c => c.state === 'ok').length;
    const skippedN = pre.checks.filter(c => !c.required && c.state !== 'ok').length;
    const failed = pre.checks.filter(c => c.required && c.state !== 'ok');
    appendReceipt('runs', {
      kind: 'run',
      subject: pre.ok
        ? `doctor.pass · ${okN} ok · ${skippedN} skipped`
        : `doctor.fail · ${okN} ok · ${skippedN} skipped · ${failed.length} failed (${failed.map(f => f.name).join(', ')})`,
      policy: 'auto',
      status: pre.ok ? 'ok' : 'failed'
    });
  } catch { /* chain unwritable: doctor still reports */ }
  // What works here: the REPL apart from the optional lanes; the exit code is the REPL's (0, 78 or 1).
  const ready = readiness(pre, { node: process.versions.node, key: modelKeySource() !== null });
  process.exitCode = ready.exit;
  const rmux = workspace.rmux;
  const tmuxSessions = workspace.tmux.sessions;
  const palette = workspace.palette;
  const zellij = workspace.zellij;

  if (json) {
    console.log(JSON.stringify({ ...workspace, preflight: pre, readiness: ready }, null, 2));
    return;
  }

  console.log('TIMMY Doctor');
  // shadow-purge proof header (2026-08-26): true version + true ledger path
  console.log(`v${VERSION} · ledger ${process.cwd()}/.timmy`);
  console.log('');
  console.log(`RMUX Installed: ${rmux.installed ? 'YES' : 'NO'}`);
  console.log(`RMUX Version: ${rmux.version || 'not detected'}`);
  console.log('Required for launch: NO');
  console.log('Role: optional Workspace Evidence Backend');
  console.log('');
  console.log(`tmux Version: ${workspace.tmux.version || 'not detected'}`);
  console.log(`tmux Sessions: ${tmuxSessions.length}`);
  console.log(`tmux-palette Installed: ${palette.installed ? 'YES' : 'NO'}`);
  console.log(`tmux-palette TIMMY Palette: ${palette.timmyPaletteInstalled ? 'YES' : 'NO'}`);
  console.log(`tmux-palette Bindings: ${palette.bindingHint}`);
  console.log('');
  console.log(`zellij Installed: ${zellij.installed ? 'YES' : 'NO'}`);
  console.log(`zellij Version: ${zellij.version || 'not detected'}`);
  console.log(`zellij CLI: ${zellij.cliPath || 'not detected'}`);
  console.log('zellij Required for launch: NO');
  console.log(`zellij Role: ${zellij.role}`);
  console.log('');
  console.log('Preflight (v1.0.0-rc1):');
  for (const c of pre.checks) {
    console.log(`  ${c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '✗'} ${c.name}${c.required ? ' (required by the lanes)' : ''}${c.note ? ' — ' + c.note : ''}`);
  }
  console.log(pre.ok ? 'Preflight READY: the lanes may arm' : "Preflight BLOCKED: the lanes' required checks are missing");
  console.log('');
  // The operator's 22:23 order: no "Ready for demo: YES" beside a blocked preflight. Each capability says
  // what it can do here, and the exit code is documented in the output itself.
  for (const line of readinessLines(ready)) console.log(line);
  // Works from an installed package (the 20:14 order): there is no `npm start` outside a checkout.
  const wait = pre.ok ? '' : '; the lanes wait for the required checks above';
  console.log(ready.repl.state === 'unsupported' ? `Next step: install Node ${NODE_MAJOR} or later, then run \`timmy doctor\` again.`
    : ready.repl.state === 'no-key' ? `Next step: \`timmy\` opens the REPL, where /setup says how to add the model key${wait}.`
      : `Next step: \`timmy\` opens the REPL${wait}.`);
}

const { command, json } = parseArgs(process.argv.slice(2));

if (command === 'deps') {
  const rows = depsDoctor();
  if (json) console.log(JSON.stringify(rows, null, 2));
  else printRows('dependency posture', rows);
  process.exit(0);
}

if (command === 'network') {
  const rows = await networkDoctor();
  if (json) console.log(JSON.stringify(rows, null, 2));
  else printRows('network layers (dns → tcp → tls → http)', rows);
  process.exit(0);
}

if (command === 'hardware') {
  const rows = hardwareDoctor();
  if (json) console.log(JSON.stringify(rows, null, 2));
  else printRows('compute inventory', rows);
  process.exit(0);
}

if (command === 'preflight') {
  const rep = await runDoctor();
  if (json) console.log(JSON.stringify(rep, null, 2));
  else {
    console.log('TIMMY Doctor · preflight');
    for (const c of rep.checks) {
      console.log(`${c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '✗'} ${c.name}${c.required ? ' (required)' : ''}${c.note ? ' — ' + c.note : ''}`);
    }
    console.log(rep.ok ? 'preflight: READY' : 'preflight: BLOCKED');
  }
  process.exit(rep.ok ? 0 : 1);
}

if (command !== 'doctor') {
  console.error('Usage: timmy doctor [deps|network|hardware|preflight] [--json]');
  process.exit(2);
}

await printDoctor(json);
