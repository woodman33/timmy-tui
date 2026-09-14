import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';

async function generateSnapshot() {
  const args = process.argv.slice(2);
  let runId = '';
  let receiptUrl = '';
  let defaultTelemetryUrl = process.env.TIMMY_AI_PROXY ?? 'https://<hostname>'; // blank-slate: READ, never literalized

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runId' && args[i + 1]) {
      runId = args[i + 1];
    }
    if (args[i] === '--receiptUrl' && args[i + 1]) {
      receiptUrl = args[i + 1];
    }
  }

  // Fallback to recent receipt if not provided
  if (!runId) {
    const indexPath = path.join(process.cwd(), '.timmy', 'receipts', 'index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const last = indexData.receipts[indexData.receipts.length - 1];
        if (last) {
          runId = last.runId;
          receiptUrl = last.receiptUrl;
          console.log(`\x1b[33mℹ️ No --runId provided. Defaulting to most recent indexed run: "${runId}"\x1b[0m`);
        }
      } catch {}
    }
  }

  if (!runId) {
    console.error(`\x1b[31m✕ Error: --runId is required to generate a team snapshot.\x1b[0m`);
    console.error(`  Example: npm run timmy:snapshot -- --runId test_run_45ve3l6 --receiptUrl https://<hostname>/runs/test_run_45ve3l6/receipt`);
    process.exit(1);
  }

  let telemetryUrl = defaultTelemetryUrl;
  if (receiptUrl) {
    try {
      telemetryUrl = new URL(receiptUrl).origin;
    } catch {}
  } else {
    receiptUrl = `${telemetryUrl}/runs/${runId}/receipt`;
  }

  console.log(`\n================================================================================`);
  console.log(`🛸 TIMMY TEAM SNAPSHOT EXPORTER V1`);
  console.log(`================================================================================`);
  console.log(`Target Run ID: \x1b[36m${runId}\x1b[0m`);
  console.log(`Receipt URL:   ${receiptUrl}`);
  console.log(`Telemetry origin: ${telemetryUrl}\n`);

  // 1. Fetch data from Cloudflare Worker
  let cloudflareContext: any = null;
  let cloudflareEvents: any[] = [];
  let fetchWarning: string | null = null;

  try {
    const contextRes = await fetch(`${telemetryUrl}/runs/${runId}/context`);
    if (contextRes.ok) {
      cloudflareContext = await contextRes.json();
      console.log(`✓ Context fetched successfully from Edge.`);
    } else {
      fetchWarning = `Failed context fetch: HTTP ${contextRes.status}`;
    }
  } catch (err: any) {
    fetchWarning = `Context fetch network error: ${err.message}`;
  }

  try {
    const eventsRes = await fetch(`${telemetryUrl}/runs/${runId}/events`);
    if (eventsRes.ok) {
      cloudflareEvents = await eventsRes.json();
      console.log(`✓ Telemetry events list fetched successfully from Edge.`);
    }
  } catch {}

  if (fetchWarning) {
    console.log(`\x1b[33m⚠️ Warning: ${fetchWarning}. Proceeding with local fallbacks.\x1b[0m`);
  }

  // 2. Resolve Host Tmux Sessions & logs
  const teamEntries = [];
  const sessionConfig = [
    { id: '1', name: 'ortui-1', role: 'Agent 1' },
    { id: '2', name: 'ortui-2', role: 'Agent 2' },
    { id: '3', name: 'ortui-3', role: 'Agent 3' },
    { id: '4', name: 'ortui-4', role: 'Agent 4' }
  ];

  for (const s of sessionConfig) {
    const sName = s.name;
    let cwd = process.cwd();
    let recentCommands: string[] = [];
    let recentOutput: string[] = [];
    const warnings = [];

    // Filter exact commands sent from Cloudflare events
    if (cloudflareEvents && cloudflareEvents.length > 0) {
      recentCommands = cloudflareEvents
        .filter(e => e.type === 'tmux.command.sent' && e.sessionId === s.id && e.payload?.command)
        .map(e => String(e.payload.command));
    }

    try {
      // Check if session exists
      execFileSync('tmux', ['has-session', '-t', sName], { stdio: 'ignore' });
      
      // Capture CWD
      cwd = execFileSync('tmux', ['display-message', '-p', '-t', sName, '-F', '#{pane_current_path}'], { encoding: 'utf8', stdio: 'pipe' }).trim();

      // Capture output
      const rawOutput = execFileSync('tmux', ['capture-pane', '-pt', sName], { encoding: 'utf8', stdio: 'pipe' });
      const rawLines = rawOutput.split('\n').map(l => l.trim()).filter(Boolean);
      recentOutput = rawLines.slice(-15); // Capture last 15 output lines
    } catch {
      warnings.push(`Tmux session container "${sName}" not active or capture pane failed.`);
    }

    teamEntries.push({
      sessionId: s.id,
      sessionName: s.name,
      role: s.role,
      cwd,
      recentCommands,
      recentOutput,
      context: cloudflareContext ? { active: cloudflareContext.activeSessionId === s.id } : {},
      receiptRefs: [receiptUrl],
      warnings
    });
  }

  // 3. Compile Shared Context heuristics
  const summary = cloudflareContext 
    ? `TIMMY agent swarm is currently executing the goal: "${cloudflareContext.goal}" in phase: "${cloudflareContext.phase}".` 
    : `TIMMY local swarm is running under offline fallbacks for Run: ${runId}.`;

  const openQuestions = [
    `Are all 4 specialized agent panes executing commands properly?`,
    `Do safety classification triggers require manual administrative privilege overrides?`
  ];

  const knownRisks = [];
  if (cloudflareContext && cloudflareContext.counters.errors > 0) {
    knownRisks.push(`Edge detected ${cloudflareContext.counters.errors} execution error(s) during telemetry. Check receipt timeline.`);
  }
  if (fetchWarning) {
    knownRisks.push(`Edge telemetry sync was interrupted: ${fetchWarning}`);
  }

  const nextBestActions = [
    `1. Inspect the live edges-sync receipt URL: ${receiptUrl}`,
    `2. Execute "npm run timmy:receipt-index" to view the local indexed entries.`,
    `3. Spin up TIMMY TUI using "npm start" to monitor live swarm telemetry.`
  ];

  const snapshot = {
    snapshotId: `snap_${Math.random().toString(36).substring(2, 9)}`,
    createdAt: new Date().toISOString(),
    source: "timmy-v3.1",
    telemetryUrl,
    workspace: {
      name: "TIMMY Hyper-Grid",
      cwd: process.cwd()
    },
    run: {
      runId,
      receiptUrl,
      phase: cloudflareContext ? cloudflareContext.phase : 'executing',
      riskLevel: cloudflareContext ? cloudflareContext.riskLevel : 'safe',
      confidence: cloudflareContext ? cloudflareContext.confidence : 1.0,
      counters: {
        commands: cloudflareContext ? cloudflareContext.counters.commands : 0,
        outputLines: cloudflareContext ? cloudflareContext.counters.outputLines : 0,
        errors: cloudflareContext ? cloudflareContext.counters.errors : 0,
        approvals: cloudflareContext ? cloudflareContext.counters.approvals : 0
      },
      eventCount: cloudflareEvents.length
    },
    team: teamEntries,
    sharedContext: {
      summary,
      openQuestions,
      knownRisks,
      nextBestActions
    }
  };

  // 4. Save file
  const snapshotDir = path.join(process.cwd(), '.snapshots');
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(snapshotDir, `team_snapshot_${timestamp}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  console.log(`\n================================================================================`);
  console.log(`🎉 TEAM STATE SNAPSHOT GENERATED SUCCESSFULLY!`);
  console.log(`Snapshot file: \x1b[32;4m${snapshotPath}\x1b[0m`);
  console.log(`================================================================================\n`);
}

generateSnapshot().catch(err => {
  console.error(`✕ Snapshot generation failed:`, err.message);
  process.exit(1);
});
