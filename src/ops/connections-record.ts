/**
 * The connections record: <Timmy home>/state/connections.json (schema timmy.connections/1), what each check, a local
 * surface's own note or a chat turn last observed of a connection. R10 (H169; CI at 704d8510, run 39910190145): moved here,
 * unchanged, from src/ops/workspace-frame.ts (which re-exports all of it), so a chat turn keeps its observation as it ends,
 * in the Timmy home it ran under, without loading the frame (src/agent/chat-turn.ts): the frame's module loads the settings
 * store, and a note kept after a promise read the home from the environment as it was by then. Node and src/setup only.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConnectionId } from '../contracts/workspace.js';
import { timmyHome } from '../setup/home.js';

type Env = Record<string, string | undefined>;

export const CONNECTIONS_SCHEMA = 'timmy.connections/1' as const;

/** One observation: what a request was answered with, and when. */
export interface ConnectionCheck {
  /**
   * accepted: the service answered and took the request; refused: it answered no (a rejected key); no answer: nothing came
   * back, or something else answered; not running: a local surface Timmy starts on demand (Studio, the companion) refused
   * the connection, so it is simply not started. R6 (H140): listening: a local surface noted that it started listening,
   * which is no answer (nothing has asked it yet). R7 lead (H148's N4): no model: the service answered, but holds nothing
   * Timmy can use (Ollama listed no local model that passed its /api/show check): it is reachable, and not usable for chat
   */
  answer: 'accepted' | 'refused' | 'no answer' | 'not running' | 'not asked' | 'listening' | 'no model';
  /**
   * R6 (H140): the process that noted it, for a local surface's own note (noteAnswered, noteListening): its pid and when it
   * started (src/ops/process-proof.ts writerState), so a server killed before it could note its stop is seen gone at once
   */
  pid?: number;
  started?: string;
  at: string;
  /** words worth keeping: "3 models", "HTTP 200", "studio running, page connected" */
  detail?: string;
  /**
   * R5 lead (the QA round, defect 3; the operator's 22:32 order, item 1): what was asked, as it was set up then: the address
   * (Ollama's, the companion's, Studio's, the edge's) or, for OpenRouter and Ollama Cloud, the key's fingerprint ("key <12 hex>",
   * never the key). A check of another address or key than the one set up now says nothing about it (forNow).
   */
  asked?: string;
  /**
   * R10 (H169; H168's pass 2c, R2 and R4): who observed it: a chat turn (src/agent/chat-turn.ts: its route answered, or the
   * Ollama it asked did not answer), not a check; absent: a check or a surface's own note. The newest observation is the
   * connection's, whichever made it.
   */
  by?: 'turn';
}

export interface ConnectionsRecord {
  schema: typeof CONNECTIONS_SCHEMA;
  checks: Partial<Record<ConnectionId, ConnectionCheck>>;
}

export const connectionsPath = (env: Env = process.env): string => join(timmyHome(env), 'state', 'connections.json');

/** The last observations, or none when there is no readable record. */
export function readConnections(env: Env = process.env): ConnectionsRecord {
  try {
    const raw = JSON.parse(readFileSync(connectionsPath(env), 'utf8')) as ConnectionsRecord;
    if (raw?.schema === CONNECTIONS_SCHEMA && raw.checks && typeof raw.checks === 'object') return raw;
  } catch { /* none yet, or unreadable: nothing observed */ }
  return { schema: CONNECTIONS_SCHEMA, checks: {} };
}

/** Writes the observations atomically, mode 0600 (it names services, never a key). */
export function writeConnections(rec: ConnectionsRecord, env: Env = process.env): string {
  const file = connectionsPath(env);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, `${JSON.stringify(rec, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return file;
}

/**
 * R10 (H169; H168's pass 2c, R2: "Ollama stays '● live' (green) right after a send to it was refused"): a chat turn's
 * observation of its route's connection, kept as the connection's newest: it answered (accepted, `detail` the model), or the
 * Ollama it asked did not answer (the connection failed: it is no longer live until a check or a turn answers again). Named as
 * a turn's (`by`), for the address or the key it asked. A record that cannot be written changes nothing.
 */
export function noteTurnAnswer(id: 'ollama' | 'openrouter', o: { answer: 'accepted' | 'no answer'; detail: string; asked?: string }, env: Env = process.env, now = Date.now()): boolean {
  try {
    const rec = readConnections(env);
    writeConnections({ ...rec, checks: { ...rec.checks, [id]: { answer: o.answer, at: new Date(now).toISOString(), detail: o.detail, ...(o.asked ? { asked: o.asked } : {}), by: 'turn' } } }, env);
    return true;
  } catch {
    return false;
  }
}
