/**
 * Agent stream items to turn events. The agent emits OpenRouter items through `item:update`: message
 * snapshots keyed by id (so later messages are never cut short by one global cursor, playbook §17.4),
 * function calls and their outputs keyed by call id. Errors keep their cause and next step.
 */
import { sanitize } from '../term/sanitize.js';
import type { TurnEvent } from './transcript.js';

export interface AgentEmitter {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

const PREVIEW_CAP = 200;

const textOf = (item: any): string =>
  Array.isArray(item?.content) ? sanitize(item.content.filter((c: any) => typeof c?.text === 'string').map((c: any) => c.text).join('')) : '';

/** Every string in tool arguments is cleaned too: the model wrote them. */
function cleanArgs(value: unknown): any {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(cleanArgs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k), cleanArgs(v)]));
  return value;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** A tool's result as one line: its own message or error when it has one, else the result itself. */
function preview(output: unknown): string {
  let said: unknown = output;
  if (typeof said === 'string') {
    try {
      said = JSON.parse(said);
    } catch {
      // plain text: shown as it is
    }
  }
  const o = said && typeof said === 'object' && !Array.isArray(said) ? (said as Record<string, unknown>) : null;
  const words = o && typeof o.message === 'string' && o.message ? o.message : o && typeof o.error === 'string' && o.error ? o.error : null;
  // A Timmy Canvas answer names its job and revision, then the page's result or its error (round R1).
  if (o && typeof o.jobId === 'string' && o.jobId && typeof o.ok === 'boolean') {
    // Round R1: a failed call says whether the page undid it, so nobody looks for half a drawing.
    const undone = o.ok === false && o.rolledBack === true ? (o.restarted === true ? ', nothing kept, page restarted' : ', nothing kept') : '';
    const where = `Timmy Canvas job ${o.jobId}${typeof o.revision === 'number' ? `, revision ${o.revision}` : ''}${undone}`;
    const said = words ?? (o.ok === true && 'result' in o ? (typeof o.result === 'string' ? o.result : JSON.stringify(o.result) ?? '') : '');
    const text = sanitize(said ? `${where}: ${said}` : where);
    return text.length > PREVIEW_CAP ? `${text.slice(0, PREVIEW_CAP)}...` : text;
  }
  const text = sanitize(words ?? (typeof output === 'string' ? output : JSON.stringify(output) ?? ''));
  // ASCII on purpose: the bridge does not know the terminal, and `...` is safe everywhere.
  return text.length > PREVIEW_CAP ? `${text.slice(0, PREVIEW_CAP)}...` : text;
}

/**
 * Round R1: whether a tool's own result says it failed. Timmy's tools answer `success: false` or
 * `ok: false`; the SDK turns a thrown error (a denial included) into `{"error": "..."}`. A result that
 * says it succeeded, or says nothing either way, counts as done.
 */
export function failedOutput(output: unknown): boolean {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (o.success === false || o.ok === false) return true;
  if (o.success === true || o.ok === true) return false;
  return typeof o.error === 'string' && o.error.length > 0;
}

/** `OpenRouter request failed…\nReason: …\nNext: …` becomes message, cause and fix. */
function errorEvent(err: unknown): TurnEvent {
  const lines = sanitize(err instanceof Error ? err.message : String(err)).split('\n').map((l) => l.trim()).filter(Boolean);
  const cause = lines.find((l) => /^Reason:/i.test(l))?.replace(/^Reason:\s*/i, '');
  const said = lines.find((l) => /^(Next|Try):/i.test(l))?.replace(/^(Next|Try):\s*/i, '');
  // A key problem needs a key fix; and the REPL has no `/model fallback`, so never suggest it.
  const fix = cause && /\b401\b|unauthori[sz]ed|authentication|api key/i.test(cause)
    ? 'timmy init, or export OPENROUTER_API_KEY=<your key>'
    : said?.replace(/ or run \/model fallback\.?$/i, ': /model <id>');
  return { type: 'error', message: lines[0] ?? 'The turn failed.', ...(cause ? { cause } : {}), ...(fix ? { fix } : {}) };
}

const SYSTEM_PREFIX = /^\s*⚙️?\s*\*\*\[SYSTEM\]\*\*\s*/u;

/** Notice ids count across every bridge, so a later turn's notice never collides with an earlier one. */
let noticeSeq = 0;

export function bridgeAgent(agent: AgentEmitter, emit: (event: TurnEvent) => void): () => void {
  const started = new Set<string>();
  let lastError: unknown = null;
  const handlers: Record<string, (...args: any[]) => void> = {
    'thinking:start': () => emit({ type: 'thinking' }),
    'item:update': (item: any) => {
      if (item?.type === 'message') {
        const text = textOf(item);
        if (text) emit({ type: 'text', id: String(item.id || 'message'), text });
      } else if (item?.type === 'function_call' && item.status === 'completed') {
        const id = String(item.callId || item.id || '');
        if (started.has(id)) return;
        started.add(id);
        emit({ type: 'tool-start', id, tool: sanitize(String(item.name || 'tool')), args: cleanArgs(parseArgs(item.arguments)) });
      } else if (item?.type === 'function_call_output') {
        emit({ type: 'tool-end', id: String(item.callId || ''), ok: !failedOutput(item.output), preview: preview(item.output) });
      }
    },
    // The agent emits the same error from an inner and an outer catch; show it once.
    error: (err: unknown) => {
      if (err === lastError) return;
      lastError = err;
      emit(errorEvent(err));
    },
    // Model-fallback notices arrive as assistant messages on `message:user`.
    'message:user': (message: any) => {
      if (message?.role !== 'assistant' || typeof message.content !== 'string') return;
      emit({ type: 'text', id: `notice-${++noticeSeq}`, text: sanitize(message.content.replace(SYSTEM_PREFIX, '')) });
    },
  };
  for (const [event, fn] of Object.entries(handlers)) agent.on(event, fn);
  return () => {
    for (const [event, fn] of Object.entries(handlers)) agent.off(event, fn);
  };
}
