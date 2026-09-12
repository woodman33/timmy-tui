import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';

// Minimal MCP stdio client (newline-delimited JSON-RPC). Timmy consumes MCP
// servers as DATA sources (spec §2.9): the server exposes tools; timmy calls
// them and seals what happened. Open Design ships a Cursor-SDK-style daemon —
// the same stdio protocol works for timmy.

export interface McpServerCfg { command: string; args: string[]; env?: Record<string, string> }

export const OPEN_DESIGN_MCP: McpServerCfg = {
  command: process.env.OD_MCP_COMMAND ?? '/Applications/Open Design.app/Contents/Frameworks/Open Design Helper.app/Contents/MacOS/Open Design Helper',
  args: process.env.OD_MCP_ARGS
    ? process.env.OD_MCP_ARGS.split('|')
    : ['/Applications/Open Design.app/Contents/Resources/app/prebundled/daemon/daemon-cli.mjs', 'mcp'],
  env: {
    OD_DATA_DIR: process.env.OD_DATA_DIR ?? '<home>/Library/Application Support/Open Design/namespaces/release-stable/data',
    OD_SIDECAR_IPC_PATH: process.env.OD_SIDECAR_IPC_PATH ?? '/tmp/open-design/ipc/release-stable/daemon.sock',
    ELECTRON_RUN_AS_NODE: '1'
  }
};

export const openDesignInstalled = (): boolean => existsSync(OPEN_DESIGN_MCP.command);

interface JsonRpcRes { id?: number; result?: any; error?: { message?: string } }

class McpStdio {
  private child: ChildProcess;
  private buf = '';
  private pending = new Map<number, (r: JsonRpcRes) => void>();
  private nextId = 1;

  constructor(cfg: McpServerCfg) {
    this.child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcRes;
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const fn = this.pending.get(msg.id) as (r: JsonRpcRes) => void;
            this.pending.delete(msg.id);
            fn(msg);
          }
        } catch { /* non-JSON stdout line */ }
      }
    });
  }

  request(method: string, params?: unknown): Promise<JsonRpcRes> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`mcp timeout: ${method}`)); }, 15000);
      this.pending.set(id, r => { clearTimeout(t); resolve(r); });
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close(): void {
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

export interface McpTool { name: string; description?: string; inputSchema?: { properties?: Record<string, { type?: string }> } }

export interface McpSession {
  tools: McpTool[];
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
  close: () => void;
}

export async function mcpSession(cfg: McpServerCfg): Promise<McpSession> {
  const s = new McpStdio(cfg);
  const init = await s.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'timmy', version: '1' }
  });
  if (init.error) { s.close(); throw new Error(init.error.message ?? 'initialize failed'); }
  s.notify('notifications/initialized');
  const list = await s.request('tools/list');
  const tools = (list.result?.tools ?? []) as McpTool[];
  return {
    tools,
    call: async (name, args) => (await s.request('tools/call', { name, arguments: args })).result,
    close: () => s.close()
  };
}

// Map a prompt onto the tool's input schema: prefer prompt-ish string props.
export function pickArgs(tool: McpTool, prompt: string): Record<string, unknown> {
  const props = tool.inputSchema?.properties ?? {};
  const keys = Object.keys(props);
  const hit = keys.find(k => /prompt|text|input|message|query/i.test(k)) ?? keys.find(k => props[k]?.type === 'string');
  return hit ? { [hit]: prompt } : { prompt };
}
