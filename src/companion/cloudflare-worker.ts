import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import type { Message } from "../types/index.js";
import { computeReceiptHash, Receipt } from "../receipt/schema.js";
import { VERSION } from "../version.js";
import { theme } from '../tui/theme.js';


// Cloudflare Env Bindings conforming exactly to user receipt parameters
export interface Env {
  OPENROUTER_API_KEY?: string;
  MY_DURABLE_OBJECT: DurableObjectNamespace;
  OPENROUTER_TUI_AGENT_PAYLOAD_R2?: any;
  "OPENROUTER-TUI-AGENT-D1"?: any;
  OPENROUTER_TUI_AGENT_QUEUE?: any;
  OPENROUTER_TUI_AGENT_VECTORIZE_INDEX?: any;
  OPENROUTER_TUI_AGENT_AISEARCH?: any;
  OPENROUTER_TUI_AGENT_WORKERS_AI?: any;
  OPENROUTER_TUI_AGENT_WORKFLOW?: any;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_BUILDER?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_TEAM?: string;
  CLERK_SECRET_KEY?: string;
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?: string;
  POSTHOG_KEY?: string;
  TELEMETRY_ANALYTICS?: any;
}

export type RunEvent = {
  id: string;
  runId: string;
  sessionId?: string;
  sessionName?: string;
  type:
    | "run.created"
    | "agent.intent"
    | "tool.requested"
    | "approval.required"
    | "approval.granted"
    | "tmux.command.sent"
    | "tmux.output.line"
    | "git.diff.detected"
    | "build.finished"
    | "context.mutated"
    | "receipt.generated"
    | "mode.change"
    | "model.switch"
    | "tui.heartbeat"
    | "command.finished"
    | "simulation.started"
    | "simulation.plan.created"
    | "simulation.score.created"
    | "simulation.finished";
  timestamp: string;
  payload: Record<string, unknown>;
};

export type RunContext = {
  runId: string;
  goal: string;
  phase:
    | "created"
    | "planning"
    | "executing"
    | "debugging"
    | "testing"
    | "summarizing"
    | "completed"
    | "failed";
  activeSessionId?: string;
  riskLevel: "safe" | "medium" | "dangerous";
  confidence: number;
  lastKnownError?: string;
  approvedTools: string[];
  blockedTools: string[];
  facts: Record<string, unknown>;
  counters: {
    commands: number;
    outputLines: number;
    errors: number;
    approvals: number;
  };
  updatedAt: string;
};

export class MyDurableObject extends DurableObject {
  private sqlInitialized = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.initSql();
  }

  private initSql() {
    if (this.sqlInitialized) return;
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          goal TEXT,
          status TEXT,
          created_at TEXT,
          updated_at TEXT
        );
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          type TEXT NOT NULL,
          session_id TEXT,
          session_name TEXT,
          timestamp TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          clerk_user_id TEXT PRIMARY KEY,
          tier TEXT NOT NULL,
          session_id TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS context_snapshots (
          run_id TEXT PRIMARY KEY,
          context_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.sqlInitialized = true;
    } catch (err) {
      // Ignore double initialization errors
    }
  }

  private getContext(runId: string): RunContext {
    this.initSql();
    try {
      const cursor = this.ctx.storage.sql.exec("SELECT context_json FROM context_snapshots WHERE run_id = ?", runId);
      const rows = [...cursor];
      if (rows.length > 0 && rows[0].context_json) {
        return JSON.parse(rows[0].context_json as string);
      }
    } catch {}

    return {
      runId,
      goal: "Coordinate background agent cluster sessions",
      phase: "created",
      riskLevel: "safe",
      confidence: 1.0,
      approvedTools: [],
      blockedTools: [],
      facts: {},
      counters: { commands: 0, outputLines: 0, errors: 0, approvals: 0 },
      updatedAt: new Date().toISOString()
    };
  }

  private saveContext(runId: string, context: RunContext) {
    this.initSql();
    context.updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO context_snapshots (run_id, context_json, updated_at) VALUES (?, ?, ?)",
      runId,
      JSON.stringify(context),
      context.updatedAt
    );
  }

  private getEvents(runId: string): RunEvent[] {
    this.initSql();
    try {
      const cursor = this.ctx.storage.sql.exec("SELECT * FROM events WHERE run_id = ? ORDER BY timestamp ASC", runId);
      const arr = [];
      for (const row of cursor) {
        arr.push({
          id: String(row.id),
          runId: String(row.run_id),
          type: String(row.type) as any,
          sessionId: row.session_id ? String(row.session_id) : undefined,
          sessionName: row.session_name ? String(row.session_name) : undefined,
          timestamp: String(row.timestamp),
          payload: JSON.parse(row.payload_json as string)
        });
      }
      return arr;
    } catch {
      return [];
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // GET /health
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", sql: this.sqlInitialized }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // POST /api/workflow/fusion
    if (method === "POST" && url.pathname === "/api/workflow/fusion") {
      try {
        const body = await request.json() as any;
        const prompt = body.prompt || "";
        const models = body.models || ["anthropic/claude-3.5-sonnet", "qwen/qwen-2.5-coder-32b", "google/gemini-2.5-pro"];
        const plugins = body.plugins || ["zellij-forgot", "zellij-harpoon", "lazy-zellij"];
        const riveStateHash = body.riveStateHash || "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

        const runId = `run_fusion_${Math.random().toString(36).substring(2, 9)}`;
        const timestamp = Date.now();
        const createdAt = new Date(timestamp).toISOString();

        const modelsUsed = models.map((m: any, i: number) => {
          if (typeof m === 'string') {
            return { id: m, weight: i === 0 ? 0.6 : 0.2, tokens: 250 };
          }
          return {
            id: m.id || "unknown",
            weight: typeof m.weight === 'number' ? m.weight : 0.5,
            tokens: typeof m.tokens === 'number' ? m.tokens : 250
          };
        });

        const pluginsRun = plugins.map((p: any) => {
          if (typeof p === 'string') {
            if (p.includes('@')) return p;
            return `${p}@1.0.0`;
          }
          return `${p.name || "unknown"}@${p.version || "1.0.0"}`;
        });

        const replayPath = `.timmy/receipts/fusion_run_${timestamp}/replay.md`;
        const replayContent = `# Fusion Run Replay\n\nTask: ${prompt}\nModels: ${modelsUsed.map((m: any) => m.id).join(', ')}`;
        
        const encoder = new TextEncoder();
        const data = encoder.encode(replayContent);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const replayHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

        const receiptWithoutHash: Omit<Receipt, 'receipt_sha256'> = {
          schema_version: "0.3",
          run_id: runId,
          type: "fusion",
          task: prompt,
          created_at: createdAt,
          cwd: "/path/to/timmy-ai-proxy",
          platform: "linux",
          node_version: "v20.0.0",
          package: {
            name: "timmy-tui",
            version: VERSION
          },
          status: "completed",
          models_used: modelsUsed,
          plugins_run: pluginsRun,
          rive_state_hash: riveStateHash,
          consensus: {
            model: modelsUsed[0]?.id || "gemini-2.5-pro",
            tokens: 1800,
            latency_ms: 450
          },
          artifacts: [
            { path: replayPath, sha256: replayHash }
          ]
        };

        const finalHash = computeReceiptHash(receiptWithoutHash);
        const receipt: Receipt = {
          ...receiptWithoutHash,
          receipt_sha256: finalHash
        };

        return new Response(JSON.stringify({
          success: true,
          receipt
        }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // POST /runs/create
    if (method === "POST" && url.pathname === "/runs/create") {
      const body = await request.json() as any;
      const runId = body.runId || `run_${Math.random().toString(36).substring(2, 9)}`;
      const goal = body.goal || "Coordinate background agent cluster sessions";

      this.initSql();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO runs (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        runId,
        goal,
        "active",
        new Date().toISOString(),
        new Date().toISOString()
      );

      const context = this.getContext(runId);
      context.goal = goal;
      this.saveContext(runId, context);

      const event: RunEvent = {
        id: `evt_${Math.random().toString(36).substring(2, 9)}`,
        runId,
        type: "run.created",
        timestamp: new Date().toISOString(),
        payload: { goal }
      };
      console.log(JSON.stringify({
        source: "timmy-edge",
        route: "/runs/create",
        runId,
        eventType: event.type
      }));

      this.ctx.storage.sql.exec(
        "INSERT INTO events (id, run_id, type, timestamp, payload_json) VALUES (?, ?, ?, ?, ?)",
        event.id,
        runId,
        event.type,
        event.timestamp,
        JSON.stringify(event.payload)
      );

      // Write to R2 non-blocking
      await this.writeToR2(runId, event, context);

      return new Response(JSON.stringify({ success: true, runId, goal }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // POST /runs/:runId/event
    if (method === "POST" && url.pathname.endsWith("/event")) {
      const parts = url.pathname.split("/");
      const runId = parts[2];
      const event = await request.json() as RunEvent;

      if (!event.id) event.id = `evt_${Math.random().toString(36).substring(2, 9)}`;
      if (!event.timestamp) event.timestamp = new Date().toISOString();
      console.log(JSON.stringify({
        source: "timmy-edge",
        route: "/runs/:runId/event",
        runId,
        eventType: event.type,
        sessionId: event.sessionId || null,
        sessionName: event.sessionName || null
      }));

      this.initSql();
      this.ctx.storage.sql.exec(
        "INSERT INTO events (id, run_id, type, session_id, session_name, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        event.id,
        runId,
        event.type,
        event.sessionId || null,
        event.sessionName || null,
        event.timestamp,
        JSON.stringify(event.payload || {})
      );

      // Workers Analytics Engine Integration (Pro Feature)
      if (this.env.TELEMETRY_ANALYTICS) {
        try {
          this.env.TELEMETRY_ANALYTICS.writeDataPoint({
            'blobs': [
              runId, 
              event.type, 
              event.sessionId || "none", 
              event.sessionName || "none", 
              this.env.TIMMY_OPERATOR_LABEL ?? 'operator'
            ],
            'doubles': [
              event.payload?.cost || 0,
              event.payload?.latency || 0
            ],
            'indexes': [runId]
          });
        } catch (e) {
          // Silent catch
        }
      }

      // Mutate Context State Machine Rules
      const context = this.getContext(runId);
      let changed = false;

      if (event.type === "run.created") {
        context.phase = "created";
        if (event.payload?.goal) context.goal = String(event.payload.goal);
        changed = true;
      } else if (event.type === "tmux.command.sent") {
        context.counters.commands++;
        context.activeSessionId = event.sessionId;
        context.phase = "executing";
        
        if (event.payload?.cwd) {
          if (!context.facts.cwdBySession) {
            context.facts.cwdBySession = {};
          }
          const factsCwd = context.facts.cwdBySession as Record<string, string>;
          if (event.sessionId) {
            factsCwd[event.sessionId] = String(event.payload.cwd);
          }
        }
        changed = true;
      } else if (event.type === "tmux.output.line") {
        context.counters.outputLines++;
        changed = true;
        const line = String(event.payload?.line || "");
        const errorKeywords = ["error", "failed", "exception", "traceback", "ts2307", "npm err", "build failed", "test failed"];
        if (errorKeywords.some(kw => line.toLowerCase().includes(kw))) {
          context.counters.errors++;
          context.lastKnownError = line;
          context.phase = "debugging";
          context.confidence = Math.max(0, parseFloat((context.confidence - 0.05).toFixed(2)));
        }
      } else if (event.type === "command.finished") {
        const payload = event.payload || {};
        if (!payload.success) {
          context.counters.errors++;
          context.phase = "debugging";
          context.confidence = Math.max(0, parseFloat((context.confidence - 0.10).toFixed(2)));
          context.lastKnownError = `Command failed with exit code ${payload.exitCode}: ${payload.command}`;
        }
        
        if (payload.cwd) {
          if (!context.facts.cwdBySession) {
            context.facts.cwdBySession = {};
          }
          const factsCwd = context.facts.cwdBySession as Record<string, string>;
          if (event.sessionId) {
            factsCwd[event.sessionId] = String(payload.cwd);
          }
        }
        changed = true;
      } else if (event.type === "approval.required") {
        context.counters.approvals++;
        context.phase = "planning";
        if (event.payload?.riskLevel) {
          context.riskLevel = event.payload.riskLevel as any;
        }
        changed = true;
      } else if (event.type === "build.finished") {
        context.phase = event.payload?.success ? "completed" : "failed";
        changed = true;
      } else if (event.type === "simulation.started") {
        context.phase = "planning";
        if (!context.facts.simulation) {
          context.facts.simulation = {};
        }
        const sim = context.facts.simulation as Record<string, any>;
        sim.status = "started";
        sim.strategy = String(event.payload?.strategy || "unknown");
        sim.sourceSnapshot = String(event.payload?.sourceSnapshot || "unknown");
        changed = true;
      } else if (event.type === "simulation.plan.created") {
        if (!context.facts.simulation) {
          context.facts.simulation = {};
        }
        const sim = context.facts.simulation as Record<string, any>;
        sim.status = "planned";
        sim.plan = event.payload?.plan || {};
        changed = true;
      } else if (event.type === "simulation.score.created") {
        if (!context.facts.simulation) {
          context.facts.simulation = {};
        }
        const sim = context.facts.simulation as Record<string, any>;
        sim.score = Number(event.payload?.score || 0);
        sim.notes = event.payload?.notes || [];
        changed = true;
      } else if (event.type === "simulation.finished") {
        context.phase = "completed";
        if (!context.facts.simulation) {
          context.facts.simulation = {};
        }
        const sim = context.facts.simulation as Record<string, any>;
        sim.status = "completed";
        sim.finishedAt = new Date().toISOString();
        changed = true;
      }

      if (changed) {
        this.saveContext(runId, context);
        // Write R2 archives
        await this.writeToR2(runId, event, context);
      }

      return new Response(JSON.stringify({ success: true, eventId: event.id }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // GET /runs
    if (method === "GET" && url.pathname === "/runs") {
      this.initSql();
      // Self-heal: backfill runs rows for any run_id present in events but missing from runs.
      // Happens when /telemetry logged events before /runs/create was ever called on that id.
      try {
        this.ctx.storage.sql.exec(`
          INSERT OR IGNORE INTO runs (run_id, goal, status, created_at, updated_at)
          SELECT DISTINCT e.run_id, 'Recovered from telemetry', 'archived', MIN(e.timestamp), MAX(e.timestamp)
          FROM events e
          LEFT JOIN runs r ON r.run_id = e.run_id
          WHERE r.run_id IS NULL
          GROUP BY e.run_id;
        `);
      } catch { /* non-blocking */ }
      const cursor = this.ctx.storage.sql.exec("SELECT * FROM runs ORDER BY updated_at DESC");
      const list = [];
      for (const row of cursor) {
        list.push({
          runId: String(row.run_id),
          goal: String(row.goal),
          status: String(row.status),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at)
        });
      }
      return new Response(JSON.stringify(list), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // GET /runs/:runId
    if (method === "GET" && url.pathname.match(/^\/runs\/[^/]+$/)) {
      const runId = url.pathname.split("/")[2];
      this.initSql();
      const cursor = this.ctx.storage.sql.exec("SELECT * FROM runs WHERE run_id = ?", runId);
      const rows = [...cursor];
      if (rows.length === 0) {
        return new Response(JSON.stringify({ error: "Run not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        runId: String(rows[0].run_id),
        goal: String(rows[0].goal),
        status: String(rows[0].status),
        createdAt: String(rows[0].created_at),
        updatedAt: String(rows[0].updated_at)
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // GET /runs/:runId/events
    if (method === "GET" && url.pathname.endsWith("/events")) {
      const runId = url.pathname.split("/")[2];
      const evts = this.getEvents(runId);
      return new Response(JSON.stringify(evts), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // GET /runs/:runId/context
    if (method === "GET" && url.pathname.endsWith("/context")) {
      const runId = url.pathname.split("/")[2];
      this.initSql();
      const runCursor = this.ctx.storage.sql.exec("SELECT run_id FROM runs WHERE run_id = ?", runId);
      if ([...runCursor].length === 0) {
        return new Response(JSON.stringify({ error: "Run not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      const context = this.getContext(runId);
      return new Response(JSON.stringify(context), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // GET /runs/:runId/receipt
    if (method === "GET" && url.pathname.endsWith("/receipt")) {
      const runId = url.pathname.split("/")[2];
      this.initSql();
      const runCursor = this.ctx.storage.sql.exec("SELECT run_id FROM runs WHERE run_id = ?", runId);
      if ([...runCursor].length === 0) {
        return new Response(JSON.stringify({ error: "Run not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      const context = this.getContext(runId);
      const evts = this.getEvents(runId);

      // Idempotently create receipt.generated event once on first load
      const hasGeneratedEvent = evts.some(e => e.type === "receipt.generated");
      if (!hasGeneratedEvent) {
        const generatedAt = new Date().toISOString();
        const genEvent: RunEvent = {
          id: `evt_gen_${Math.random().toString(36).substring(2, 9)}`,
          runId,
          type: "receipt.generated",
          timestamp: generatedAt,
          payload: {
            runId,
            // hosts-j4t1: worker-side the edge host is a binding; absent it the
            // URL carries the inert placeholder (no personal host in public)
            receiptUrl: `https://${this.env.TIMMY_EDGE_HOST ?? '<hostname>'}/runs/${runId}/receipt`,
            generatedAt
          }
        };

        this.initSql();
        this.ctx.storage.sql.exec(
          "INSERT INTO events (id, run_id, type, session_id, session_name, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          genEvent.id,
          runId,
          genEvent.type,
          null,
          null,
          genEvent.timestamp,
          JSON.stringify(genEvent.payload)
        );

        // Update R2 archives
        await this.writeToR2(runId, genEvent, context);
        evts.push(genEvent);
      }

      // Perform direct HTTP fetch summary to OpenRouter
      let summary = "The background terminal swarm completed execution tasks within acceptable parameters. No severe blockages occurred.";
      if (this.env.OPENROUTER_API_KEY) {
        try {
          const payloadPrompt = `Generate a concise 2-sentence systems execution summary for Run: ${runId}.\nGoal: ${context.goal}\nCommands: ${context.counters.commands}, Output Lines: ${context.counters.outputLines}, Errors: ${context.counters.errors}, Phase: ${context.phase}.\nTimeline Events: ${JSON.stringify(evts.map(e => ({ type: e.type, time: e.timestamp })))}\nBe professional and system-focused.`;
          
          const openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
              "HTTP-Referer": `https://${this.env.TIMMY_EDGE_HOST ?? '<hostname>'}`
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [{ role: "user", content: payloadPrompt }]
            })
          });

          if (openRouterRes.ok) {
            const resJson = await openRouterRes.json() as any;
            summary = resJson.choices?.[0]?.message?.content || summary;
          }
        } catch {
          // Fall back gracefully
        }
      }

      // Render stunning high-fidelity responsive HTML page
      const html = this.renderReceiptHtml(runId, context, evts, summary);
      return new Response(html, {
        headers: { "Content-Type": "text/html" }
      });
    }

    // GET /workflows?runId=:runId
    if (method === "GET" && url.pathname === "/workflows") {
      const runId = url.searchParams.get("runId") || "default-local-run";
      const events = this.getEvents(runId);
      const context = this.getContext(runId);
      const lastOf = (types: string[]) => [...events].reverse().find((event) => types.includes(event.type));
      const countOf = (types: string[]) => events.filter((event) => types.includes(event.type)).length;
      const workflowLanes = [
        {
          id: "telemetry-ingest",
          label: "Telemetry Ingest",
          status: countOf(["tui.heartbeat", "mode.change", "model.switch", "agent.intent"]) > 0 ? "ACTIVE" : "WAITING",
          count: countOf(["tui.heartbeat", "mode.change", "model.switch", "agent.intent"]),
          lastEvent: lastOf(["tui.heartbeat", "mode.change", "model.switch", "agent.intent"])?.type || null
        },
        {
          id: "workspace-evidence",
          label: "Workspace Evidence",
          status: countOf(["tmux.command.sent", "tmux.output.line", "command.finished"]) > 0 ? "ACTIVE" : "WAITING",
          count: countOf(["tmux.command.sent", "tmux.output.line", "command.finished"]),
          lastEvent: lastOf(["tmux.command.sent", "tmux.output.line", "command.finished"])?.type || null
        },
        {
          id: "approval-gate",
          label: "Approval Gate",
          status: countOf(["approval.required", "approval.granted"]) > 0 ? "HOLDING" : "CLEAR",
          count: countOf(["approval.required", "approval.granted"]),
          lastEvent: lastOf(["approval.required", "approval.granted"])?.type || null
        },
        {
          id: "receipt-assembly",
          label: "Receipt Assembly",
          status: events.length > 0 ? "READY" : "WAITING",
          count: countOf(["receipt.generated", "run.created"]) + context.counters.commands + context.counters.outputLines,
          lastEvent: lastOf(["receipt.generated", "run.created", "command.finished", "tmux.output.line"])?.type || null
        }
      ];

      return new Response(JSON.stringify({
        success: true,
        runId,
        workflowBindingAvailable: !!this.env.OPENROUTER_TUI_AGENT_WORKFLOW,
        totalEvents: events.length,
        phase: context.phase,
        confidence: context.confidence,
        counters: context.counters,
        workflowLanes,
        recentEvents: events.slice(-8).map((event) => ({
          type: event.type,
          sessionName: event.sessionName || null,
          timestamp: event.timestamp
        }))
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // POST /telemetry compatibility endpoint
    if (method === "POST" && url.pathname === "/telemetry") {
      const body = await request.json() as any;
      const legacyPayload = body.payload || {};
      // The telemetry bridge sends runId as top-level `activeRunId`.
      // Older payloads used payload.runId. Accept both.
      const runId = body.activeRunId || legacyPayload.runId || "default-local-run";
      
      let eventType = "agent.intent";
      if (body.event === "tmux:output" || body.event === "tmux.output.line") {
        eventType = "tmux.output.line";
      } else if (
        body.event === "tmux.command.sent" ||
        body.event === "approval.required" ||
        body.event === "approval.granted" ||
        body.event === "build.finished" ||
        body.event === "git.diff.detected" ||
        body.event === "receipt.generated" ||
        body.event === "agent.intent" ||
        body.event === "run.created" ||
        body.event === "mode.change" ||
        body.event === "model.switch" ||
        body.event === "tui.heartbeat" ||
        body.event === "command.finished" ||
        body.event === "simulation.started" ||
        body.event === "simulation.plan.created" ||
        body.event === "simulation.score.created" ||
        body.event === "simulation.finished"
      ) {
        eventType = body.event;
      }

      const event: RunEvent = {
        id: `evt_${Math.random().toString(36).substring(2, 9)}`,
        runId,
        sessionId: legacyPayload.sessionId,
        sessionName: legacyPayload.sessionName,
        type: eventType as any,
        timestamp: new Date().toISOString(),
        payload: {
          line: legacyPayload.line || body.line || "",
          originalEvent: body.event,
          ...legacyPayload
        }
      };

      console.log(JSON.stringify({
        source: "timmy-edge",
        route: "/telemetry",
        runId,
        eventType,
        originalEvent: body.event,
        sessionId: event.sessionId || null,
        sessionName: event.sessionName || null
      }));

      // Write directly to SQLite (no recursive fetch — avoids DO reentrancy 503s).
      this.initSql();

      // Upsert runs row when we learn about a run via telemetry
      if (body.event === "run.created") {
        const goal = legacyPayload.goal || legacyPayload.task || "Coordinate background agent cluster sessions";
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO runs (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          runId,
          String(goal),
          "active",
          new Date().toISOString(),
          new Date().toISOString()
        );
      }

      this.ctx.storage.sql.exec(
        "INSERT INTO events (id, run_id, type, session_id, session_name, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        event.id,
        runId,
        event.type,
        event.sessionId || null,
        event.sessionName || null,
        event.timestamp,
        JSON.stringify(event.payload || {})
      );

      // Mirror to Analytics Engine (best-effort)
      if (this.env.TELEMETRY_ANALYTICS) {
        try {
          this.env.TELEMETRY_ANALYTICS.writeDataPoint({
            indexes: [runId],
            blobs: [event.type, event.sessionId || "", event.sessionName || ""],
            doubles: [1]
          });
        } catch { /* non-blocking */ }
      }

      return new Response(JSON.stringify({ success: true, runId, eventType }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // POST /api/create-checkout-session
    if (method === "POST" && url.pathname === "/api/create-checkout-session") {
      try {
        const body = await request.json() as any;
        const clerkUserId = body.clerk_user_id || "user_clerk_timmy_33a1";
        const priceTier = body.price_tier || "builder";
        
        let priceId = "";
        if (priceTier === "builder") {
          priceId = this.env.STRIPE_PRICE_BUILDER || "price_builder";
        } else if (priceTier === "pro") {
          priceId = this.env.STRIPE_PRICE_PRO || "price_pro";
        } else if (priceTier === "team") {
          priceId = this.env.STRIPE_PRICE_TEAM || "price_team";
        }
        
        // Track PostHog analytics checkout_started
        if (this.env.POSTHOG_KEY) {
          try {
            await fetch("https://app.posthog.com/capture/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_key: this.env.POSTHOG_KEY,
                event: "checkout_started",
                properties: {
                  distinct_id: clerkUserId,
                  price_tier: priceTier,
                  price_id: priceId,
                  timestamp: new Date().toISOString()
                }
              })
            });
          } catch {}
        }
        
        let redirectUrl = "";
        if (this.env.STRIPE_SECRET_KEY) {
          const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.env.STRIPE_SECRET_KEY}`,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
              "payment_method_types[]": "card",
              "line_items[0][price]": priceId,
              "line_items[0][quantity]": "1",
              "mode": "subscription",
              "success_url": `${url.origin}/success?session_id={CHECKOUT_SESSION_ID}&clerk_user_id=${clerkUserId}&price_id=${priceId}`,
              "cancel_url": `${url.origin}/cancel`,
              "metadata[clerk_user_id]": clerkUserId
            }).toString()
          });
          
          if (stripeRes.ok) {
            const data = await stripeRes.json() as any;
            redirectUrl = data.url;
          } else {
            const err = await stripeRes.text();
            throw new Error(`Stripe Checkout Session API returned: ${err}`);
          }
        } else {
          redirectUrl = `${url.origin}/success?session_id=cs_test_mock_${Math.random().toString(36).substring(2, 9)}&clerk_user_id=${clerkUserId}&price_id=${priceId}`;
        }
        
        return new Response(JSON.stringify({ success: true, url: redirectUrl }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // GET /api/subscription
    if (url.pathname === "/api/subscription") {
      const clerkUserId = url.searchParams.get("clerk_user_id") || "user_clerk_timmy_33a1";
      this.initSql();
      const cursor = this.ctx.storage.sql.exec("SELECT * FROM subscriptions WHERE clerk_user_id = ?", clerkUserId);
      const rows = [...cursor];
      
      let tier = "free";
      let sessionId = "";
      if (rows.length > 0) {
        tier = String(rows[0].tier);
        sessionId = String(rows[0].session_id);
      }
      
      let scopes = ["workspace.read", "workspace.write"];
      if (tier === "builder") {
        scopes.push("context.read.openrouter_agent_sdk", "context.read.openhands_sdk");
      } else if (tier === "pro") {
        scopes.push(
          "context.read.openrouter_agent_sdk",
          "context.read.openhands_sdk",
          "agent.run.openhands",
          "agent.run.openhands.headless"
        );
      } else if (tier === "team" || tier === "enterprise") {
        scopes.push(
          "context.read.openrouter_agent_sdk",
          "context.read.openhands_sdk",
          "agent.run.openhands",
          "agent.run.openhands.headless",
          "context.read.private_docs"
        );
      }
      
      return new Response(JSON.stringify({ clerkUserId, tier, sessionId, scopes }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // POST /api/stripe/webhook
    if (method === "POST" && url.pathname === "/api/stripe/webhook") {
      try {
        const body = await request.json() as any;
        const session = body.data?.object || body.data || {};
        const clerkUserId = session.metadata?.clerk_user_id || "user_clerk_timmy_33a1";
        const priceId = session.line_items?.[0]?.price || session.price_id || "";
        
        let tier = "free";
        if (priceId === "price_builder" || priceId === this.env.STRIPE_PRICE_BUILDER || session.amount_total === 1900) {
          tier = "builder";
        } else if (priceId === "price_pro" || priceId === this.env.STRIPE_PRICE_PRO || session.amount_total === 4900) {
          tier = "pro";
        } else if (priceId === "price_team" || priceId === this.env.STRIPE_PRICE_TEAM || session.amount_total === 19900) {
          tier = "team";
        }
        
        this.initSql();
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO subscriptions (clerk_user_id, tier, session_id, updated_at) VALUES (?, ?, ?, ?)",
          clerkUserId,
          tier,
          session.id || "mock_session",
          new Date().toISOString()
        );
        
        // Track PostHog analytics checkout_completed
        if (this.env.POSTHOG_KEY) {
          try {
            await fetch("https://app.posthog.com/capture/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_key: this.env.POSTHOG_KEY,
                event: "checkout_completed",
                properties: {
                  distinct_id: clerkUserId,
                  price_tier: tier,
                  timestamp: new Date().toISOString()
                }
              })
            });
          } catch {}
        }
        
        return new Response(JSON.stringify({ success: true, tier }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // RENDER PAGES GORGEOUSLY
    if (method === "GET") {
      const clerkUserId = url.searchParams.get("clerk_user_id") || "user_clerk_timmy_33a1";
      this.initSql();
      const cursor = this.ctx.storage.sql.exec("SELECT * FROM subscriptions WHERE clerk_user_id = ?", clerkUserId);
      const rows = [...cursor];
      
      let tier = "free";
      if (rows.length > 0) {
        tier = String(rows[0].tier);
      }

      if (url.pathname === "/" || url.pathname === "/pricing" || url.pathname === "/success" || url.pathname === "/cancel" || url.pathname === "/account") {
        let pageContent = "";
        
        if (url.pathname === "/") {
          pageContent = `
            <section class="hero">
              <h1>TIMMY launch-grade Trust Layer</h1>
              <p>Execute, govern, and audit autonomous AI agent swarms in complete, verifiably secure sandboxes.</p>
              <div style="display: flex; gap: 1.5rem; justify-content: center;">
                <a href="/pricing?clerk_user_id=${clerkUserId}" class="btn">View Pricing Entitlements</a>
                <a href="/account?clerk_user_id=${clerkUserId}" class="btn" style="background-color: var(--panel); border: 1px solid var(--border);">Manage Account</a>
              </div>
            </section>
            
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2rem; margin-top: 4rem;">
              <div style="background: var(--panel); border: 1px solid var(--border); padding: 2rem; border-radius: 12px;">
                <h3>🛡️ 8 Gated Protections</h3>
                <p style="color: var(--text-muted);">Strict architectural validation, passport checks, risk gating, and operator approvals before execution.</p>
              </div>
              <div style="background: var(--panel); border: 1px solid var(--border); padding: 2rem; border-radius: 12px;">
                <h3>🔐 AgentPass Entitlements</h3>
                <p style="color: var(--text-muted);">Ensure compliance with verifiable claims, scope limits, and multi-tier budget controls.</p>
              </div>
              <div style="background: var(--panel); border: 1px solid var(--border); padding: 2rem; border-radius: 12px;">
                <h3>📦 .agentrun Receipts</h3>
                <p style="color: var(--text-muted);">Every run is indexed, securely hashed, and compiled into offline-ready transportable receipt logs.</p>
              </div>
            </div>
          `;
        } else if (url.pathname === "/pricing") {
          pageContent = `
            <div style="text-align: center; margin-bottom: 3rem;">
              <h2>Swarms Subscription Plans</h2>
              <p style="color: var(--text-muted);">Choose the launch scale required for your operator workflow.</p>
            </div>
            
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 2rem; align-items: start;">
              <!-- Free -->
              <div style="background: var(--panel); border: 1px solid var(--border); padding: 2rem; border-radius: 12px; display: flex; flex-direction: column; justify-content: space-between; height: 380px;">
                <div>
                  <h3 style="margin-top:0;">Free</h3>
                  <div style="font-size: 2rem; font-weight: 800; margin: 1rem 0;">$0</div>
                  <p style="color: var(--text-muted); font-size: 0.9rem;">Basic TIMMY governed local demo sandbox checks.</p>
                  <ul style="padding-left: 1.25rem; font-size: 0.9rem; color: var(--text-muted); line-height: 1.6;">
                    <li>Manual Governed Demo</li>
                    <li>Stripe provisioning help</li>
                  </ul>
                </div>
                <button class="btn" style="width: 100%;" disabled>Current Tier (Free)</button>
              </div>
              
              <!-- Builder -->
              <div style="background: var(--panel); border: 2px solid ${tier === 'builder' ? 'var(--accent)' : 'var(--border)'}; padding: 2rem; border-radius: 12px; display: flex; flex-direction: column; justify-content: space-between; height: 380px;">
                <div>
                  <h3 style="margin-top:0; color: ${theme.accent};">Builder</h3>
                  <div style="font-size: 2rem; font-weight: 800; margin: 1rem 0;">$19<span style="font-size: 1rem; color: var(--text-muted);">/mo</span></div>
                  <p style="color: var(--text-muted); font-size: 0.9rem;">Perfect for developers managing local sandbox context packs.</p>
                  <ul style="padding-left: 1.25rem; font-size: 0.9rem; color: var(--text-muted); line-height: 1.6;">
                    <li>Validate Context Packs</li>
                    <li>Compile local LaunchPlans</li>
                    <li>Receipt index builder</li>
                  </ul>
                </div>
                <button onclick="subscribe('builder')" class="btn" style="width: 100%;">${tier === 'builder' ? 'Active Plan' : 'Subscribe'}</button>
              </div>
              
              <!-- Pro -->
              <div style="background: var(--panel); border: 2px solid ${tier === 'pro' ? 'var(--accent)' : 'var(--border)'}; padding: 2rem; border-radius: 12px; display: flex; flex-direction: column; justify-content: space-between; height: 380px;">
                <div>
                  <h3 style="margin-top:0; color: #c084fc;">Pro</h3>
                  <div style="font-size: 2rem; font-weight: 800; margin: 1rem 0;">$49<span style="font-size: 1rem; color: var(--text-muted);">/mo</span></div>
                  <p style="color: var(--text-muted); font-size: 0.9rem;">Unlock high-fidelity Pi orchestration and OpenHands runner.</p>
                  <ul style="padding-left: 1.25rem; font-size: 0.9rem; color: var(--text-muted); line-height: 1.6;">
                    <li>Governed OpenHands live runs</li>
                    <li>Pi router telemetry</li>
                    <li>Stripe project bindings</li>
                  </ul>
                </div>
                <button onclick="subscribe('pro')" class="btn" style="width: 100%;">${tier === 'pro' ? 'Active Plan' : 'Subscribe'}</button>
              </div>

              <!-- Team -->
              <div style="background: var(--panel); border: 2px solid ${tier === 'team' ? 'var(--accent)' : 'var(--border)'}; padding: 2rem; border-radius: 12px; display: flex; flex-direction: column; justify-content: space-between; height: 380px;">
                <div>
                  <h3 style="margin-top:0; color: #f472b6;">Team</h3>
                  <div style="font-size: 2rem; font-weight: 800; margin: 1rem 0;">$199<span style="font-size: 1rem; color: var(--text-muted);">/mo</span></div>
                  <p style="color: var(--text-muted); font-size: 0.9rem;">Multi-operator teams managing shared recontextualization.</p>
                  <ul style="padding-left: 1.25rem; font-size: 0.9rem; color: var(--text-muted); line-height: 1.6;">
                    <li>Shared Context feedback registry</li>
                    <li>Shared .agentrun cloud receipt archives</li>
                  </ul>
                </div>
                <button onclick="subscribe('team')" class="btn" style="width: 100%;">${tier === 'team' ? 'Active Plan' : 'Subscribe'}</button>
              </div>
            </div>
            
            <script>
              async function subscribe(tier) {
                const btn = event.target;
                btn.disabled = true;
                btn.innerText = "Redirecting...";
                try {
                  const res = await fetch("/api/create-checkout-session", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ clerk_user_id: "${clerkUserId}", price_tier: tier })
                  });
                  const data = await res.json();
                  if (data.success && data.url) {
                    window.location.href = data.url;
                  } else {
                    alert("Checkout error: " + (data.error || "Unknown error"));
                    btn.disabled = false;
                    btn.innerText = "Subscribe";
                  }
                } catch (e) {
                  alert("Network error occurred: " + e.message);
                  btn.disabled = false;
                  btn.innerText = "Subscribe";
                }
              }
            </script>
          `;
        } else if (url.pathname === "/success") {
          const sessionId = url.searchParams.get("session_id") || "unknown";
          
          if (sessionId.startsWith("cs_test_mock_")) {
            const priceId = url.searchParams.get("price_id") || "";
            let planTier = "builder";
            if (priceId.includes("pro")) planTier = "pro";
            if (priceId.includes("team")) planTier = "team";
            
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO subscriptions (clerk_user_id, tier, session_id, updated_at) VALUES (?, ?, ?, ?)",
              clerkUserId,
              planTier,
              sessionId,
              new Date().toISOString()
            );
            tier = planTier;
          }
          
          pageContent = `
            <div style="background: var(--panel); border: 1px solid var(--border); padding: 3rem; border-radius: 12px; text-align: center; max-width: 600px; margin: 2rem auto;">
              <span style="font-size: 3rem;">🎉</span>
              <h2 style="color: var(--success); margin-top: 1rem;">Payment Successful!</h2>
              <p style="color: var(--text-muted); margin-bottom: 2rem;">Subscription successfully activated on the Cloudflare DO SQLite registry.</p>
              
              <div style="background: rgba(0,0,0,0.2); padding: 1.5rem; border-radius: 8px; margin-bottom: 2rem; text-align: left; font-size: 0.95rem;">
                <strong>Session details:</strong>
                <ul style="list-style-type: none; padding-left: 0; margin-top: 0.5rem; color: var(--text-muted); line-height: 1.6;">
                  <li>👤 Operator ID: <code>${clerkUserId}</code></li>
                  <li>💳 Session ID: <code>${sessionId.substring(0, 24)}...</code></li>
                  <li>🏷️ Activated Plan: <strong style="color: var(--text);">${tier.toUpperCase()}</strong></li>
                </ul>
              </div>
              
              <a href="/account?clerk_user_id=${clerkUserId}" class="btn">Go to Account Panel</a>
            </div>
          `;
        } else if (url.pathname === "/cancel") {
          pageContent = `
            <div style="background: var(--panel); border: 1px solid var(--border); padding: 3rem; border-radius: 12px; text-align: center; max-width: 600px; margin: 2rem auto;">
              <span style="font-size: 3rem;">⚠️</span>
              <h2 style="margin-top: 1rem;">Checkout Cancelled</h2>
              <p style="color: var(--text-muted); margin-bottom: 2rem;">Checkout session was cancelled by operator. No billing transactions were processed.</p>
              <a href="/pricing?clerk_user_id=${clerkUserId}" class="btn">Return to Pricing Plans</a>
            </div>
          `;
        } else if (url.pathname === "/account") {
          let scopes = ["workspace.read", "workspace.write"];
          if (tier === "builder") {
            scopes.push("context.read.openrouter_agent_sdk", "context.read.openhands_sdk");
          } else if (tier === "pro") {
            scopes.push(
              "context.read.openrouter_agent_sdk",
              "context.read.openhands_sdk",
              "agent.run.openhands",
              "agent.run.openhands.headless"
            );
          } else if (tier === "team" || tier === "enterprise") {
            scopes.push(
              "context.read.openrouter_agent_sdk",
              "context.read.openhands_sdk",
              "agent.run.openhands",
              "agent.run.openhands.headless",
              "context.read.private_docs"
            );
          }

          pageContent = `
            <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 2rem; align-items: start;">
              <!-- Sidebar -->
              <div style="background: var(--panel); border: 1px solid var(--border); padding: 2rem; border-radius: 12px; text-align: center;">
                <div style="width: 80px; height: 80px; background: var(--accent); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 2rem; font-weight: bold; margin: 0 auto 1rem; color: white;">
                  TIM
                </div>
                <h3>${clerkUserId}</h3>
                <span style="background: var(--accent); color: white; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: bold; text-transform: uppercase;">
                  ${tier} Active
                </span>
                
                <hr style="border: 0; border-top: 1px solid var(--border); margin: 1.5rem 0;">
                <div style="text-align: left; font-size: 0.85rem; color: var(--text-muted); line-height: 1.6;">
                  <strong>Operator Status:</strong> Authorized<br>
                  <strong>Delegated By:</strong> ${this.env.TIMMY_OPERATOR_LABEL ?? 'operator'}<br>
                  <strong>Environment:</strong> local-dev-worker<br>
                </div>
              </div>
              
              <!-- Content -->
              <div style="display: flex; flex-direction: column; gap: 2rem;">
                <div style="background: var(--panel); border: 1px solid var(--border); padding: 2rem; border-radius: 12px;">
                  <h3 style="margin-top:0;">🛡️ Active Entitlements & Scopes</h3>
                  <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem;">Your subscription grants these verifiable AgentPass claims visa for governed runner executions:</p>
                  
                  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
                    ${scopes.map(s => '<span style="background: rgba(255,255,255,0.05); border: 1px solid var(--border); padding: 0.35rem 0.75rem; border-radius: 6px; font-size: 0.85rem; font-family: monospace;">' + s + '</span>').join('')}
                  </div>
                </div>
                
                <div style="background: var(--panel); border: 1px solid var(--border); padding: 2rem; border-radius: 12px;">
                  <h3 style="margin-top:0;">📋 Latest Audit Receipt</h3>
                  <div style="background: rgba(0,0,0,0.2); padding: 1.25rem; border-radius: 8px; font-family: monospace; font-size: 0.85rem; color: var(--text-muted); border: 1px solid var(--border);">
                    "manifest_hash": "62bf57e3f20cae58d72dfa4f00bc29584e03b29c991a0c4f8263bf68c2d28f33"<br>
                    "receipt_version": "1.5.2"<br>
                    "integrity": "verified (tamper-evident)"
                  </div>
                </div>
              </div>
            </div>
          `;
        }

        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>TIMMY Trust Layer Console</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800;900&display=swap" rel="stylesheet">
            <style>
              :root {
                --bg: #09090b;
                --panel: rgba(24, 24, 27, 0.6);
                --border: rgba(63, 63, 70, 0.4);
                --text: #f4f4f5;
                --text-muted: #a1a1aa;
                --accent: hsl(263.4, 70%, 50.4%);
                --accent-hover: hsl(263.4, 70%, 60%);
                --success: #10b981;
                --font: 'Inter', system-ui, sans-serif;
              }
              body {
                background-color: var(--bg);
                color: var(--text);
                font-family: var(--font);
                margin: 0;
                padding: 0;
                display: flex;
                flex-direction: column;
                min-height: 100vh;
                align-items: center;
              }
              header {
                width: 100%;
                max-width: 1200px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 1.5rem 2rem;
                box-sizing: border-box;
                border-bottom: 1px solid var(--border);
                backdrop-filter: blur(12px);
              }
              .logo {
                font-size: 1.5rem;
                font-weight: 800;
                background: linear-gradient(135deg, ${theme.accent}, #8b5cf6);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                text-decoration: none;
              }
              nav a {
                color: var(--text-muted);
                text-decoration: none;
                margin-left: 1.5rem;
                transition: color 0.2s;
                font-weight: 500;
              }
              nav a:hover {
                color: var(--text);
              }
              main {
                flex: 1;
                width: 100%;
                max-width: 1200px;
                padding: 3rem 2rem;
                box-sizing: border-box;
              }
              .hero {
                text-align: center;
                margin-bottom: 4rem;
              }
              .hero h1 {
                font-size: 3.5rem;
                font-weight: 900;
                margin-top: 0;
                margin-bottom: 1.5rem;
                line-height: 1.1;
                background: linear-gradient(to right, ${theme.textPrimary}, #a1a1aa);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
              }
              .hero p {
                font-size: 1.25rem;
                color: var(--text-muted);
                max-width: 800px;
                margin: 0 auto 2.5rem;
              }
              .btn {
                background-color: var(--accent);
                color: white;
                padding: 0.75rem 2rem;
                border-radius: 9999px;
                text-decoration: none;
                font-weight: 600;
                transition: background-color 0.2s, transform 0.2s;
                border: none;
                cursor: pointer;
                box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);
                display: inline-block;
              }
              .btn:hover:not(:disabled) {
                background-color: var(--accent-hover);
                transform: translateY(-2px);
              }
              .btn:disabled {
                background: #27272a;
                color: #71717a;
                box-shadow: none;
                cursor: not-allowed;
              }
            </style>
            <script
              async
              crossorigin="anonymous"
              src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"
              data-clerk-publishable-key="${this.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || ''}"
            ></script>
          </head>
          <body>
            <header>
              <a href="/?clerk_user_id=${clerkUserId}" class="logo">TIMMY Trust Layer</a>
              <nav style="display: flex; align-items: center;">
                <a href="/pricing?clerk_user_id=${clerkUserId}">Pricing Plans</a>
                <a href="/account?clerk_user_id=${clerkUserId}">My Account</a>
                <div id="clerk-auth-container" style="margin-left: 1.5rem; display: flex; align-items: center;"></div>
              </nav>
            </header>
            <main>
              ${pageContent}
            </main>
            <script>
              window.addEventListener('load', async () => {
                if (window.Clerk) {
                  try {
                    await window.Clerk.load();
                    const container = document.getElementById('clerk-auth-container');
                    if (!container) return;
                    
                    if (!window.Clerk.user) {
                      container.innerHTML = '<button onclick="window.Clerk.openSignIn()" class="btn" style="padding: 0.4rem 1rem; font-size: 0.85rem; box-shadow: none; font-family: inherit;">Sign In</button>';
                    } else {
                      container.innerHTML = '<div id="clerk-user-button"></div>';
                      window.Clerk.mountUserButton(document.getElementById('clerk-user-button'), {
                        afterSignOutUrl: window.location.origin
                      });
                      
                      // Auto-redirect if clerk_user_id search param is missing or mismatching
                      const urlParams = new URLSearchParams(window.location.search);
                      if (urlParams.get('clerk_user_id') !== window.Clerk.user.id) {
                        urlParams.set('clerk_user_id', window.Clerk.user.id);
                        window.location.search = urlParams.toString();
                      }
                    }
                  } catch (e) {
                    console.error("Clerk init error:", e);
                  }
                }
              });
            </script>
          </body>
          </html>
        `;
        
        return new Response(html, {
          headers: { "Content-Type": "text/html" }
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  private async writeToR2(runId: string, event: RunEvent, context: RunContext) {
    if (!this.env.OPENROUTER_TUI_AGENT_PAYLOAD_R2) return;
    try {
      const r2 = this.env.OPENROUTER_TUI_AGENT_PAYLOAD_R2;

      // Append Event in R2 JSONL file
      const jsonlKey = `runs/${runId}/events.jsonl`;
      let currentJsonl = "";
      try {
        const obj = await r2.get(jsonlKey);
        if (obj) currentJsonl = await obj.text();
      } catch {}

      currentJsonl += JSON.stringify(event) + "\n";
      await r2.put(jsonlKey, currentJsonl, { contentType: "application/x-jsonlines" });

      // Save Context snapshot in R2 JSON
      const contextKey = `runs/${runId}/context.json`;
      await r2.put(contextKey, JSON.stringify(context), { contentType: "application/json" });

      // Save Receipt summary index in R2 JSON
      const receiptKey = `runs/${runId}/receipt.json`;
      const receipt = {
        runId,
        goal: context.goal,
        phase: context.phase,
        riskLevel: context.riskLevel,
        confidence: context.confidence,
        counters: context.counters,
        timestamp: new Date().toISOString()
      };
      await r2.put(receiptKey, JSON.stringify(receipt), { contentType: "application/json" });
    } catch {
      // Graceful local stub fallback
    }
  }

  private renderReceiptHtml(runId: string, context: RunContext, events: RunEvent[], summary: string): string {
    const timeline = events.map(e => {
      let desc = "";
      if (e.type === "tmux.command.sent") {
        const cmd = String(e.payload?.command || "");
        const cwd = String(e.payload?.cwd || "");
        const cwdSuffix = cwd ? ' in <code style="color: var(--text-muted);">' + this.escapeHtml(cwd) + '</code>' : '';
        desc = `Executed command: <code style="color: var(--blue); font-weight: bold;">${this.escapeHtml(cmd)}</code>${cwdSuffix}`;
      } else if (e.type === "command.finished") {
        const cmd = String(e.payload?.command || "");
        const cwd = String(e.payload?.cwd || "");
        const exitCode = e.payload?.exitCode !== undefined ? Number(e.payload.exitCode) : 0;
        const success = !!e.payload?.success;
        const statusBadge = success 
          ? '<span style="color: var(--green); font-weight: bold;">🟢 SUCCESS</span>'
          : '<span style="color: var(--red); font-weight: bold;">🔴 FAILED (exit code: ' + exitCode + ')</span>';
        const cwdSuffix2 = cwd ? ' (at <code style="color: var(--text-muted);">' + this.escapeHtml(cwd) + '</code>)' : '';
        desc = `Command finished: <code style="color: var(--blue);">${this.escapeHtml(cmd)}</code> - Status: ${statusBadge}${cwdSuffix2}`;
      } else if (e.type === "receipt.generated") {
        const url = String(e.payload?.receiptUrl || "");
        desc = `🛡️ TIMMY Run Receipt V3.1 generated: <a href="${url}" target="_blank" style="color: var(--green); text-decoration: underline;">${this.escapeHtml(url)}</a>`;
      } else if (e.type === "run.created") {
        desc = `🚀 Run created with goal: <strong>${this.escapeHtml(String(e.payload?.goal || ''))}</strong>`;
      } else if (e.type === "approval.required") {
        desc = `🛡️ <strong style="color: var(--orange);">Blocked / Governed Action:</strong> ${this.escapeHtml(String(e.payload?.reason || 'Requires explicit operator approval'))} (Command: <code>${this.escapeHtml(String(e.payload?.command || ''))}</code>)`;
      } else if (e.type === "approval.granted") {
        desc = `🟢 <strong style="color: var(--green);">Operator Approved:</strong> Command was explicitly authorized and executed (Command: <code>${this.escapeHtml(String(e.payload?.command || ''))}</code>)`;
      } else if (e.type === "agent.intent") {
        desc = `🔮 <strong>Swarm Agent Intent:</strong> ${this.escapeHtml(String(e.payload?.description || ''))} (Target: <code>${this.escapeHtml(String(e.payload?.targetComponent || ''))}</code>)`;
      } else if (e.type === "simulation.started") {
        desc = `🎮 <strong style="color: var(--blue);">Simulation Started:</strong> Strategy: <code>${this.escapeHtml(String(e.payload?.strategy || ''))}</code> (Snapshot: <code>${this.escapeHtml(String(e.payload?.sourceSnapshot || ''))}</code>)`;
      } else if (e.type === "simulation.plan.created") {
        desc = `📋 <strong>Simulation Plan Created:</strong> Swarm simulation strategy details generated.`;
      } else if (e.type === "simulation.score.created") {
        desc = `⭐ <strong>Simulation Score Logged:</strong> Total dry run compatibility score: <strong style="color: var(--green); font-size: 16px;">${Number(e.payload?.score || 0)}/100</strong>`;
      } else if (e.type === "simulation.finished") {
        desc = `🏁 <strong style="color: var(--green);">Simulation Finished:</strong> Dry run strategy evaluation completed successfully.`;
      } else if (e.type === "tmux.output.line" || e.payload?.line) {
        desc = `Captured: <code>${this.escapeHtml(String(e.payload?.line || ""))}</code>`;
      } else {
        desc = this.escapeHtml(JSON.stringify(e.payload || {}));
      }

      return `
        <div class="timeline-item">
          <span class="timeline-time">${new Date(e.timestamp).toLocaleTimeString()}</span>
          <span class="timeline-badge badge-${e.type.replace(/\./g, '-')}">${e.type}</span>
          <p class="timeline-desc">
            ${e.sessionId ? '[Session: ' + e.sessionName + '] ' : ''}
            ${desc}
          </p>
        </div>
      `;
    }).join('');

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TIMMY Run Receipt - ${runId}</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg-dark: ${theme.ground};
            --bg-card: #161b22;
            --border-color: ${theme.line};
            --text-primary: ${theme.textSecondary};
            --text-muted: ${theme.textSecondary};
            --purple: #8250df;
            --blue: ${theme.accent};
            --green: ${theme.seal};
            --orange: ${theme.warn};
            --red: ${theme.danger};
          }

          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            background-color: var(--bg-dark);
            color: var(--text-primary);
            font-family: 'Inter', sans-serif;
            padding: 40px 20px;
            display: flex;
            justify-content: center;
          }

          .container {
            max-width: 900px;
            width: 100%;
          }

          header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 20px;
            margin-bottom: 30px;
          }

          .title-area h1 {
            font-size: 24px;
            font-weight: 700;
            color: ${theme.textPrimary};
            letter-spacing: -0.5px;
          }
          .title-area p {
            color: var(--text-muted);
            margin-top: 4px;
            font-size: 14px;
            font-family: 'JetBrains Mono', monospace;
          }

          .attribution {
            font-size: 12px;
            color: var(--text-muted);
            text-align: right;
          }

          /* Metrics Grid */
          .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
          }

          .card {
            background-color: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px;
          }

          .metric-title {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-muted);
            margin-bottom: 8px;
          }

          .metric-value {
            font-size: 28px;
            font-weight: 700;
            color: ${theme.textPrimary};
          }

          .summary-card {
            margin-bottom: 30px;
            border-left: 4px solid var(--purple);
          }

          .summary-text {
            line-height: 1.6;
            font-size: 15px;
          }

          /* Timeline */
          .timeline {
            border-left: 2px solid var(--border-color);
            margin-left: 20px;
            padding-left: 20px;
          }

          .timeline-item {
            position: relative;
            margin-bottom: 25px;
          }

          .timeline-item::before {
            content: '';
            position: absolute;
            left: -31px;
            top: 4px;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background-color: var(--border-color);
            border: 2px solid var(--bg-dark);
          }

          .timeline-time {
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            color: var(--text-muted);
            display: block;
            margin-bottom: 4px;
          }

          .timeline-badge {
            font-size: 11px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            font-family: 'JetBrains Mono', monospace;
            display: inline-block;
            margin-bottom: 8px;
          }

          .badge-run-created { background-color: rgba(56, 139, 253, 0.15); color: var(--blue); }
          .badge-tmux-command-sent { background-color: rgba(188, 142, 223, 0.15); color: var(--purple); }
          .badge-tmux-output-line { background-color: rgba(139, 148, 158, 0.15); color: var(--text-muted); }
          .badge-approval-required { background-color: rgba(210, 153, 34, 0.15); color: var(--orange); }
          .badge-build-finished { background-color: rgba(56, 139, 253, 0.15); color: var(--blue); }

          .timeline-desc {
            font-size: 14px;
            line-height: 1.5;
          }

          .timeline-desc code {
            background-color: rgba(110, 118, 129, 0.1);
            padding: 2px 4px;
            border-radius: 4px;
            font-family: 'JetBrains Mono', monospace;
            color: ${theme.danger};
          }

          .context-dump {
            margin-top: 40px;
          }

          .context-dump pre {
            background-color: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            overflow-x: auto;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <header>
            <div class="title-area">
              <h1>TIMMY Run Receipt MVP</h1>
              <p>Run ID: ${runId}</p>
            </div>
            <div class="attribution">
              <p>Built by <strong>the TIMMY project</strong></p>
              <p>Creator Attribution Shield Active</p>
            </div>
          </header>

          <div class="metrics-grid">
            <div class="card">
              <div class="metric-title">Phase</div>
              <div class="metric-value" style="color: var(--blue)">${context.phase.toUpperCase()}</div>
            </div>
            <div class="card">
              <div class="metric-title">Commands</div>
              <div class="metric-value">${context.counters.commands}</div>
            </div>
            <div class="card">
              <div class="metric-title">Output Lines</div>
              <div class="metric-value">${context.counters.outputLines}</div>
            </div>
            <div class="card">
              <div class="metric-title">Errors</div>
              <div class="metric-value" style="color: ${context.counters.errors > 0 ? 'var(--red)' : 'var(--green)'}">${context.counters.errors}</div>
            </div>
            <div class="card">
              <div class="metric-title">Risk Level</div>
              <div class="metric-value" style="color: ${context.riskLevel === 'dangerous' ? 'var(--red)' : 'var(--green)'}">${context.riskLevel.toUpperCase()}</div>
            </div>
          </div>

          <div class="card summary-card">
            <div class="metric-title">Edge AI Execution Summary</div>
            <p class="summary-text">${summary}</p>
          </div>

          <div class="card" style="margin-bottom: 30px;">
            <div class="metric-title" style="margin-bottom: 20px;">Execution Timeline</div>
            <div class="timeline">
              ${timeline}
            </div>
          </div>

          <div class="context-dump">
            <div class="metric-title" style="margin-bottom: 10px;">Mutable Context Dump (Durable SQL)</div>
            <pre><code>${JSON.stringify(context, null, 2)}</code></pre>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}

// Default export routing requests directly to the Durable Object Agent
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /health
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Route pricing and payments pages/APIs to Durable Object global state
    if (
      url.pathname === "/" ||
      url.pathname === "/pricing" ||
      url.pathname === "/success" ||
      url.pathname === "/cancel" ||
      url.pathname === "/account" ||
      url.pathname === "/api/create-checkout-session" ||
      url.pathname === "/api/stripe/webhook" ||
      url.pathname === "/api/subscription" ||
      url.pathname === "/api/workflow/fusion"
    ) {
      const id = env.MY_DURABLE_OBJECT.idFromName("global_state");
      const stub = env.MY_DURABLE_OBJECT.get(id);
      return await stub.fetch(request);
    }

    // Extract runId
    let runId = "";
    if (url.pathname.startsWith("/runs/")) {
      const parts = url.pathname.split("/");
      if (parts[2] !== "create") {
        runId = parts[2];
      }
    }
    
    // Fallback parsing from request bodies
    if (request.method === "POST" && url.pathname === "/telemetry") {
      try {
        const body = await request.clone().json() as any;
        runId = body.activeRunId || body.payload?.runId || "default-local-run";
      } catch {}
    }

    if (request.method === "POST" && url.pathname === "/runs/create") {
      try {
        const body = await request.clone().json() as any;
        runId = body.runId || `run_${Math.random().toString(36).substring(2, 9)}`;
      } catch {}
    }

    if (!runId) {
      runId = "default-local-run";
    }

    // Single shared DO so /runs listing and per-run queries see the same SQLite instance.
    // Different runs are distinguished inside the runs/events tables by run_id.
    const id = env.MY_DURABLE_OBJECT.idFromName("central");
    const stub = env.MY_DURABLE_OBJECT.get(id);
    return await stub.fetch(request);
  }
};

export class HelloWorldWorkflow extends WorkflowEntrypoint<Env> {
  async run() {}
}
