import React, { useState, useEffect, useRef } from 'react';
import type { Agent } from '../../agent/core.js';
import type { AgentConfig } from '../../types/index.js';
import { redactTelemetryPayload, safeStringify } from '../../utils/redact.js';
import type {
  TelemetryStatus,
  TelemetryPriority,
  TelemetryEventName,
  TelemetryQueueItem
} from '../types/telemetry.js';
import fs from 'fs';
import path from 'path';

interface UseTelemetryBridgeProps {
  agent: Agent;
  mode: string;
  model: string;
  totalCost: number;
  config: AgentConfig;
  activeRunId?: string;
  activeReceiptUrl?: string;
  operator?: string;
}

function getEventPriority(event: TelemetryEventName): TelemetryPriority {
  switch (event) {
    case 'tmux.command.sent':
    case 'command.finished':
    case 'approval.required':
    case 'approval.granted':
    case 'run.created':
    case 'receipt.generated':
    case 'agent.intent':
    case 'simulation.started':
    case 'simulation.finished':
      return 'critical';
    case 'simulation.plan.created':
    case 'simulation.score.created':
    case 'tool.call':
    case 'tool.result':
    case 'cost.update':
    case 'model.switch':
    case 'mode.change':
    case 'error':
      return 'high';
    case 'thinking.start':
    case 'thinking.end':
    case 'stream.start':
    case 'stream.end':
      return 'medium';
    default:
      return 'low';
  }
}

export function useTelemetryBridge({
  agent,
  mode,
  model,
  totalCost,
  config,
  activeRunId,
  activeReceiptUrl,
  operator = 'William Meldman',
  enabled = true
}: UseTelemetryBridgeProps & { enabled?: boolean }) {
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatus>('online');
  const [queue, setQueue] = useState<TelemetryQueueItem[]>([]);
  const [lastTelemetryError, setLastTelemetryError] = useState<string | undefined>(undefined);

  // References to prevent closures in listeners
  const modeRef = useRef(mode);
  const modelRef = useRef(model);
  const costRef = useRef(totalCost);
  const runIdRef = useRef(activeRunId);
  const receiptUrlRef = useRef(activeReceiptUrl);
  const queueRef = useRef(queue);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { costRef.current = totalCost; }, [totalCost]);
  useEffect(() => { runIdRef.current = activeRunId; }, [activeRunId]);
  useEffect(() => { receiptUrlRef.current = activeReceiptUrl; }, [activeReceiptUrl]);
  useEffect(() => { queueRef.current = queue; }, [queue]);

  // Resolve telemetry endpoint URL by priority
  const resolveEndpoint = (): string => {
    if (config.telemetryUrl) return config.telemetryUrl;
    if (process.env.TIMMY_TELEMETRY_URL === 'off') return '';
    if (process.env.TIMMY_TELEMETRY_URL) return process.env.TIMMY_TELEMETRY_URL;
    return 'https://timmy-ai-proxy.wmeldman33.workers.dev';
  };

  const writeToOfflineSpool = (item: TelemetryQueueItem) => {
    try {
      const spoolDir = path.join(process.cwd(), '.timmy');
      if (!fs.existsSync(spoolDir)) {
        fs.mkdirSync(spoolDir, { recursive: true });
      }
      const spoolPath = path.join(spoolDir, 'offline-telemetry.jsonl');
      const redactedItem = redactTelemetryPayload(item);
      fs.appendFileSync(spoolPath, safeStringify(redactedItem) + '\n', 'utf8');
    } catch {
      // Fail silently in background to prevent TUI crashes
    }
  };

  // Drain the offline spool once the endpoint is reachable again: replay a
  // bounded batch per cycle, stop on first failure, rewrite the remainder.
  const lastDrainAtRef = useRef(0);

  const drainOfflineSpool = async (endpoint: string) => {
    try {
      if (!endpoint) return; // telemetry disabled
      if (Date.now() - lastDrainAtRef.current < 10000) return; // throttle: max 1 drain/10s
      const spoolPath = path.join(process.cwd(), '.timmy', 'offline-telemetry.jsonl');
      if (!fs.existsSync(spoolPath)) return;
      const content = fs.readFileSync(spoolPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length === 0) return;

      lastDrainAtRef.current = Date.now();
      const batch = lines.slice(0, 50);
      const rest = lines.slice(50);
      let sent = 0;

      for (const line of batch) {
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed.event !== 'string') { sent++; continue; } // drop malformed
          const wirePayload = {
            event: parsed.event,
            operator: parsed.operator || operator,
            timestamp: parsed.timestamp,
            mode: parsed.mode,
            model: parsed.model,
            totalCost: parsed.totalCost,
            activeRunId: parsed.activeRunId,
            activeReceiptUrl: parsed.activeReceiptUrl,
            payload: parsed.payload ?? parsed
          };
          const res = await fetch(`${endpoint}/telemetry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Operator': wirePayload.operator },
            body: safeStringify(wirePayload)
          });
          if (!res.ok) break; // endpoint unhappy — keep everything for later
          sent++;
        } catch {
          break;
        }
      }

      const remaining = [...batch.slice(sent), ...rest];
      fs.writeFileSync(spoolPath, remaining.length > 0 ? remaining.join('\n') + '\n' : '', 'utf8');

      if (sent > 0) {
        try {
          fs.appendFileSync(
            path.join(process.cwd(), 'logs', 'agent-events.log'),
            `[${new Date().toISOString()}] Telemetry spool drain: ${sent} offline events replayed, ${remaining.length} remaining\n`,
            'utf8'
          );
        } catch { /* ignore */ }
      }
    } catch {
      // Never let background draining crash the TUI
    }
  };

  const pushToQueue = (event: TelemetryEventName, payload: any) => {
    const priority = getEventPriority(event);
    const item: TelemetryQueueItem = {
      id: `tele_evt_${Math.random().toString(36).substring(2, 9)}`,
      event,
      operator,
      timestamp: Date.now(),
      mode: modeRef.current,
      model: modelRef.current,
      totalCost: costRef.current,
      activeRunId: runIdRef.current,
      activeReceiptUrl: receiptUrlRef.current,
      payload,
      priority,
      retries: 0
    };

    setQueue(prev => {
      const newQueue = [...prev, item];
      if (newQueue.length > 500) {
        const priorityScore: Record<TelemetryPriority, number> = {
          low: 0,
          medium: 1,
          high: 2,
          critical: 3
        };
        // Find index of lowest-priority item to drop
        let lowestIdx = 0;
        let lowestScore = Infinity;
        for (let i = 0; i < newQueue.length; i++) {
          const score = priorityScore[newQueue[i].priority];
          if (score < lowestScore) {
            lowestScore = score;
            lowestIdx = i;
          }
        }
        // Write the dropped item to local spool fallback
        writeToOfflineSpool(newQueue[lowestIdx]);
        newQueue.splice(lowestIdx, 1);
      }
      return newQueue;
    });
  };

  const sendTelemetry = (event: TelemetryEventName, payload: any) => {
    // Redact payload immediately
    const redactedPayload = redactTelemetryPayload(payload);
    pushToQueue(event, redactedPayload);
  };

  const flushTelemetry = async () => {
    const currentQueue = queueRef.current;
    if (currentQueue.length === 0) return;

    setTelemetryStatus('syncing');
    const endpoint = resolveEndpoint();
    if (!endpoint) {
      // telemetry disabled (TIMMY_TELEMETRY_URL=off) — keep items queued, stay local
      setTelemetryStatus('offline');
      return;
    }

    const itemsToProcess = [...currentQueue];
    setQueue([]); // Clear active queue during processing

    const failedItems: TelemetryQueueItem[] = [];

    for (const item of itemsToProcess) {
      try {
        const telemetryPayload = {
          event: item.event,
          operator: item.operator,
          timestamp: item.timestamp,
          mode: item.mode,
          model: item.model,
          totalCost: item.totalCost,
          activeRunId: item.activeRunId,
          activeReceiptUrl: item.activeReceiptUrl,
          payload: item.payload
        };

        const res = await fetch(`${endpoint}/telemetry`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Operator': item.operator,
          },
          body: safeStringify(telemetryPayload)
        });

        // Safe telemetry event logging
        const logFilePath = path.join(process.cwd(), 'logs', 'agent-events.log');
        try {
          fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] Telemetry sync: Endpoint=${endpoint}/telemetry Event=${item.event} Status=${res.ok ? 'SUCCESS' : 'FAILED'} HTTP_Status=${res.status}\n`, 'utf8');
        } catch {
          // ignore
        }

        if (!res.ok) {
          throw new Error(`Edge telemetry rejected: HTTP ${res.status}`);
        }
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : String(err);
        
        // Safe telemetry error logging
        const logFilePath = path.join(process.cwd(), 'logs', 'agent-events.log');
        try {
          fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] Telemetry sync: Endpoint=${endpoint}/telemetry Event=${item.event} Status=ERROR Error=${errMsg}\n`, 'utf8');
        } catch {
          // ignore
        }

        setLastTelemetryError(errMsg);
        item.retries++;
        if (item.retries < 5) {
          failedItems.push(item);
        } else {
          // Permanently spooled to offline logs
          writeToOfflineSpool(item);
        }
      }
    }

    if (failedItems.length > 0) {
      setQueue(prev => [...failedItems, ...prev]);
      setTelemetryStatus('degraded');
    } else {
      setTelemetryStatus('online');
      setLastTelemetryError(undefined);
      // Endpoint is healthy — opportunistically replay spooled offline events
      void drainOfflineSpool(endpoint);
    }
  };

  // Heartbeat loop every 30 seconds
  useEffect(() => {
    const heartbeatTimer = setInterval(() => {
      const status = telemetryStatus;
      if (status === 'online' || status === 'syncing') {
        sendTelemetry('tui.heartbeat', {
          mode: modeRef.current,
          model: modelRef.current,
          activeRunId: runIdRef.current,
          activeReceiptUrl: receiptUrlRef.current,
          telemetryStatus: status,
          queuedTelemetryCount: queueRef.current.length,
          totalCost: costRef.current
        });
      }
    }, 30000);

    return () => clearInterval(heartbeatTimer);
  }, [telemetryStatus]);

  // Queue retry loop every 2 seconds
  useEffect(() => {
    if (!enabled) return; // BOOT: no network probes before first frame
    const retryTimer = setInterval(() => {
      if (queueRef.current.length > 0) {
        flushTelemetry();
      } else {
        // Idle: keep draining the offline spool so it never strands
        void drainOfflineSpool(resolveEndpoint());
      }
    }, 2000);

    return () => clearInterval(retryTimer);
  }, [enabled]);

  // Event listener registration and normalization mapping
  useEffect(() => {
    if (!enabled) return; // BOOT: listeners attach after first frame
    // Normalization mapping maps legacy emitter events to canonical types
    const handleEvent = (legacyEvent: string, payload: any) => {
      let canonicalEvent: TelemetryEventName = legacyEvent as any;
      
      if (legacyEvent === 'thinking:start') canonicalEvent = 'thinking.start';
      else if (legacyEvent === 'thinking:end') canonicalEvent = 'thinking.end';
      else if (legacyEvent === 'stream:start') canonicalEvent = 'stream.start';
      else if (legacyEvent === 'stream:delta') canonicalEvent = 'stream.delta';
      else if (legacyEvent === 'stream:end') canonicalEvent = 'stream.end';
      else if (legacyEvent === 'tool:call') canonicalEvent = 'tool.call';
      else if (legacyEvent === 'tool:result') canonicalEvent = 'tool.result';
      else if (legacyEvent === 'cost:update') canonicalEvent = 'cost.update';
      else if (legacyEvent === 'model:switch') canonicalEvent = 'model.switch';
      else if (legacyEvent === 'mode:change') canonicalEvent = 'mode.change';
      else if (legacyEvent === 'tmux.output.line') canonicalEvent = 'tmux.output.line';
      else if (legacyEvent === 'run.created') canonicalEvent = 'run.created';
      else if (legacyEvent === 'receipt.generated') canonicalEvent = 'receipt.generated';

      sendTelemetry(canonicalEvent, payload);
    };

    const listeners = {
      'thinking:start': () => handleEvent('thinking:start', { status: 'thinking' }),
      'thinking:end': () => handleEvent('thinking:end', { status: 'idle' }),
      'stream:start': () => handleEvent('stream:start', {}),
      'stream:delta': (delta: string, full: string) => handleEvent('stream:delta', { delta, length: full.length }),
      'stream:end': (fullText: string) => handleEvent('stream:end', { length: fullText.length }),
      'tool:call': (name: string, args: any) => {
        // Secure summary stringification helper
        let summaryArgs = {};
        try {
          summaryArgs = typeof args === 'string' ? JSON.parse(args) : args;
        } catch {
          summaryArgs = { raw: String(args) };
        }
        handleEvent('tool:call', { name, args: summaryArgs });
      },
      'tool:result': (name: string, result: any) => {
        let resultSummary = '';
        try {
          resultSummary = typeof result === 'string' ? result : safeStringify(result);
        } catch {
          resultSummary = String(result);
        }
        handleEvent('tool:result', { name, resultSummary: resultSummary.slice(0, 100) });
      },
      'cost:update': (cost: number, total: number) => handleEvent('cost:update', { cost, total }),
      'error': (err: any) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        handleEvent('error', { message: errMsg });
      },
      'model:switch': (modelName: string) => handleEvent('model:switch', { model: modelName }),
      'mode:change': (modeName: string) => handleEvent('mode:change', { mode: modeName }),
      'tmux.command.sent': (data: any) => handleEvent('tmux.command.sent', data),
      'tmux.output.line': (data: any) => {
        // Double emit for telemetry legacy compatibility path
        handleEvent('tmux.output.line', data);
        handleEvent('tmux:output', data);
      },
      'approval.required': (data: any) => handleEvent('approval.required', data),
      'approval.granted': (data: any) => handleEvent('approval.granted', data),
      'command.finished': (data: any) => handleEvent('command.finished', data),
      'run.created': (data: any) => handleEvent('run.created', data),
      'receipt.generated': (data: any) => handleEvent('receipt.generated', data),
      'simulation.started': (data: any) => handleEvent('simulation.started', data),
      'simulation.plan.created': (data: any) => handleEvent('simulation.plan.created', data),
      'simulation.score.created': (data: any) => handleEvent('simulation.score.created', data),
      'simulation.finished': (data: any) => handleEvent('simulation.finished', data),
    };

    for (const [event, handler] of Object.entries(listeners)) {
      agent.on(event as any, handler as any);
    }

    return () => {
      for (const [event, handler] of Object.entries(listeners)) {
        agent.off(event as any, handler as any);
      }
    };
  }, [agent]);

  return {
    telemetryStatus,
    queuedTelemetryCount: queue.length,
    lastTelemetryError,
    flushTelemetry,
    sendTelemetry
  };
}
