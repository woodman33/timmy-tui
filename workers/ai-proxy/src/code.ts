// Code Mode: one generated script per agent task against every edge tool.
// POST /code { script } runs an agent-authored script; POST /code { task,
// approval, model? } asks a model to write the script first (paid → gated).
// Either way the run seals ONE receipt: script hash, output hash, the exact
// tool calls, model, timing, error. The executor is injected so the route is
// testable without a Worker Loader; production passes DynamicWorkerExecutor.
import { type Connector, type Env, type ToolCall, allowlist, connectorFor, edgeTools, isAllowed, openrouterHeaders, toolTypes } from './tools.js';
import { type EdgeReceipt, appendEdgeReceipt, sha256Hex } from './chain.js';

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export interface Executor {
  execute(code: string, connectors: Connector[]): Promise<ExecuteResult>;
}

export interface CodeRequest {
  script?: string;
  task?: string;
  model?: string;
  approval?: string;
}

export interface CodeRunReceiptData {
  run_id: string;
  generated: boolean;
  model: string | null;
  script_sha256: string;
  output_sha256: string | null;
  tool_calls: ToolCall[];
  error: string | null;
  logs: number;
  ms: number;
  approval_present: boolean;
  [k: string]: unknown;
}

export interface CodeResponse {
  ok: boolean;
  run_id: string;
  result?: unknown;
  error?: string;
  logs?: string[];
  script: string;
  tool_calls: ToolCall[];
  receipt: EdgeReceipt;
  chain: EdgeReceipt[];
}

const SYSTEM = `You write ONE JavaScript async arrow function and nothing else. It runs in a sandbox where a global \`timmy\` object exposes the tools below. Call tools with \`await timmy.<name>(args)\`. Return a JSON-serialisable value. No imports, no fetch, no eval, no comments outside the function. Output exactly: async () => { ... }`;

export async function generateScript(task: string, model: string, env: Env, f: typeof fetch = fetch): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set on worker');
  const r = await f('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openrouterHeaders(env, 'TIMMY code mode'),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `${SYSTEM}\n\nTOOLS:\n${toolTypes()}` },
        { role: 'user', content: task }
      ],
      max_tokens: 2048
    })
  });
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[]; error?: unknown };
  if (!r.ok) throw new Error(`upstream ${r.status}: ${JSON.stringify(j.error ?? j)}`);
  return extractScript(j.choices?.[0]?.message?.content ?? '');
}

/** Pull the async arrow function out of a model reply (tolerates code fences). */
export function extractScript(text: string): string {
  const fenced = text.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const i = body.indexOf('async');
  if (i < 0) throw new Error('model did not return an async function');
  return body.slice(i).trim();
}

export function validateScript(script: string): void {
  if (script.length > 20000) throw new Error('script too long');
  if (!/^async\s*\(/.test(script.trim()) && !/^async\s+function/.test(script.trim())) throw new Error('script must be an async function');
  for (const bad of [/\bimport\s*\(/, /\brequire\s*\(/, /\beval\s*\(/, /\bnew\s+Function\b/]) {
    if (bad.test(script)) throw new Error(`script uses a forbidden construct: ${bad.source}`);
  }
}

export interface CodeDeps {
  executor: Executor;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function runCode(req: CodeRequest, env: Env, deps: CodeDeps): Promise<CodeResponse> {
  const started = (deps.now ?? Date.now)();
  const runId = `run_${started.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const chain: EdgeReceipt[] = [];
  const calls: ToolCall[] = [];
  let script = req.script ?? '';
  let model: string | null = null;
  let generated = false;

  if (!script) {
    if (!req.task) throw new HttpError(400, 'need script or task');
    if (!req.approval) throw new HttpError(403, 'task mode generates the script with a paid model: operator approval token required');
    model = req.model ?? allowlist(env)[0];
    if (!isAllowed(allowlist(env), model)) throw new HttpError(403, `model not on allowlist: ${model}`);
    script = await generateScript(req.task, model, env, deps.fetch);
    generated = true;
  }
  validateScript(script);

  const ctx = { env, approval: req.approval, calls, chain, runId, fetch: deps.fetch };
  const connector = connectorFor(ctx, edgeTools());
  let res: ExecuteResult;
  try {
    res = await deps.executor.execute(script, [connector]);
  } catch (e) {
    res = { result: null, error: e instanceof Error ? e.message : String(e) };
  }

  const outputJson = res.error ? null : JSON.stringify(res.result ?? null);
  const data: CodeRunReceiptData = {
    run_id: runId,
    generated,
    model,
    script_sha256: await sha256Hex(script),
    output_sha256: outputJson == null ? null : await sha256Hex(outputJson),
    tool_calls: calls,
    error: res.error ?? null,
    logs: res.logs?.length ?? 0,
    ms: (deps.now ?? Date.now)() - started,
    approval_present: !!req.approval
  };
  const receipt = await appendEdgeReceipt(chain, { kind: 'code.run', subject: runId, data });
  // One chain per run (subject = run id), so every stored chain verifies from
  // its own genesis and the daily head lists each run as its own subject.
  if (env.CUSTODY_KV) await env.CUSTODY_KV.put(`chain:code:${runId}`, JSON.stringify(chain));
  return { ok: !res.error, run_id: runId, result: res.result, error: res.error, logs: res.logs, script, tool_calls: calls, receipt, chain };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
