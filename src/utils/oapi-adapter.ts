// TIMMY oapi lane — any OpenAPI spec becomes invocable tools via
// @mcpc/oapi-invoker-mcp. The deno bridge (scripts/oapi-bridge.ts) runs the
// orthodox MCP SDK client; we spawn it with the request on stdin and read one
// JSON line back. Sensitive fields masked by the invoker's x-sensitive
// extensions AND our redact() on the way out.
// KNOWN UPSTREAM BEHAVIOR (2026-08-17): the invoker is silent:true — a spec
// its parser can't digest (e.g. api.github.com/openapi.json, ~10MB) yields a
// zero-tool server and tools/list then 404s (-32601). Parseable specs work
// end-to-end (verified: file:// spec -> live github /users call, receipted).
// Remedy for mega-specs: trim first (apisnip-style) or use SPEC_EXTENSION patches.
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { appendReceipt } from './receipts.js';
import { publish as appendEvent } from '../bus/index.js';

export interface OapiReq {
  spec_url: string;
  tool?: string;
  args?: Record<string, unknown>;
  list?: boolean;
}

export function oapiRun(req: OapiReq, dir?: string): Promise<{ ok: boolean; state?: string; note?: string; tools?: string[]; result?: unknown; receipt?: string }> {
  const cwd = dir ?? process.cwd();
  return new Promise(resolve => {
    // stable isolated cwd: deno's auto node_modules caches deps across calls
    const iso = join(homedir(), '.timmy-oapi');
    mkdirSync(iso, { recursive: true });
    const child = spawn('deno', ['run', '--allow-all', '--node-modules-dir=auto', join(cwd, 'scripts', 'oapi-bridge.ts')], {
      cwd: iso,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const done = (r: { ok: boolean; state?: string; note?: string; tools?: string[]; result?: unknown }) => {
      if (settled) return;
      settled = true;
      const rec = appendReceipt('runs', {
        kind: 'run', subject: `oapi ${req.list ? 'list' : req.tool} · ${req.spec_url}`, policy: 'auto',
        status: r.ok ? 'ok' : 'failed',
        ...(r.ok ? {} : { error_class: (r.state === 'not_configured' ? 'not_configured' : 'exec') as string }),
        spans: [{ name: `oapi-invoker.${req.tool ?? 'list'}`, kind: 'execute_tool' }],
        artifacts: []
      }, cwd);
      appendEvent(r.ok ? 'oapi.done' : 'oapi.failed', { spec: req.spec_url, tool: req.tool ?? 'list' }, cwd);
      child.kill();
      resolve({ ...r, receipt: rec.hash });
    };
    const timer = setTimeout(() => done({ ok: false, note: 'oapi bridge timeout (180s)' }), 180000);
    child.on('error', e => { clearTimeout(timer); done({ ok: false, state: 'not_configured', note: `deno unavailable: ${e.message}` }); });
    child.stdout!.on('data', d => { out += d.toString(); });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out.trim().split('\n').pop() ?? '');
        done(r);
      } catch {
        done({ ok: false, note: `bridge produced no JSON: ${out.slice(0, 200)}` });
      }
    });
    child.stdin!.write(JSON.stringify(req));
    child.stdin!.end();
  });
}
