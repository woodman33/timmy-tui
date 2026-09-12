// warroom-t3b1: the commander is the durable Cloudflare agent (Claude Code's
// MIND+SHIP order). We CONNECT to its WebSocket and render its events — the
// loop is never reimplemented here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CommanderEvent { kind?: string; model?: string; spend?: number; text?: string; ts?: string }

// Writes (think/handoff/…) are operator-gated on the worker. Same source order
// as lanes/commander/cli.mjs: env first, then the worker's .dev.vars (never printed).
export const edgeToken = (): string | null => {
  if (process.env.TIMMY_EDGE_TOKEN) return process.env.TIMMY_EDGE_TOKEN;
  try {
    const p = join(process.cwd(), 'workers', 'ai-proxy', '.dev.vars');
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (line.startsWith('TIMMY_EDGE_TOKEN=')) return line.slice('TIMMY_EDGE_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no token, reads stay open */ }
  return null;
};

export class CommanderClient {
  private ws: WebSocket | null = null;
  constructor(private url: string | null, private onEvent: (e: CommanderEvent) => void) {}
  connect(): void {
    if (!this.url) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onmessage = m => {
        try { this.onEvent(JSON.parse(String(m.data)) as CommanderEvent); } catch { /* ignore non-json */ }
      };
      this.ws.onclose = () => { this.ws = null; };
      this.ws.onerror = () => { this.ws = null; };
    } catch { this.ws = null; }
  }
  get online(): boolean { return this.ws?.readyState === 1; }
  send(x: unknown): void { if (this.online) this.ws?.send(JSON.stringify(x)); }
  close(): void { try { this.ws?.close(); } catch { /* already closed */ } }
}
