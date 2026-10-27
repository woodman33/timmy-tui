import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface AttemptScope {
  principal: string;
  project: string;
  operation: string;
  sourceRevision: string;
}

export interface AttemptToken extends AttemptScope {
  generation: number;
  attemptId: string;
}

export interface AttemptResult {
  ok: boolean;
  patch: string;
  workdir: string;
  planHash: string;
  note?: string;
}

export type PublicationStatus = 'committed' | 'superseded' | 'cancelled' | 'failed';
export interface AttemptStaging {
  workdir: string;
  planHash: string;
}
export interface AttemptRecord extends AttemptToken {
  status: 'running' | PublicationStatus;
  staging?: AttemptStaging;
  result?: AttemptResult;
  artifactHash?: string;
}
export interface AttemptPublication {
  status: PublicationStatus;
  artifactHash: string;
}

interface Row {
  attempt_id: string;
  scope_key: string;
  principal: string;
  project: string;
  operation: string;
  source_revision: string;
  generation: number;
  status: AttemptRecord['status'];
  result_json: string | null;
  artifact_hash: string | null;
  staging_json?: string | null;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const scopeKey = (scope: AttemptScope) => JSON.stringify([scope.principal, scope.project, scope.operation]);

function validateScope(scope: AttemptScope): void {
  for (const key of ['principal', 'project', 'operation', 'sourceRevision'] as const) {
    if (typeof scope[key] !== 'string' || !scope[key].trim()) throw new Error(`Missing attempt ${key}`);
  }
}

function serializeResult(result: AttemptResult): string {
  if (typeof result.ok !== 'boolean') throw new Error('Invalid attempt result');
  for (const key of ['patch', 'workdir', 'planHash'] as const) {
    if (typeof result[key] !== 'string') throw new Error(`Invalid attempt result ${key}`);
  }
  if (result.note !== undefined && typeof result.note !== 'string') throw new Error('Invalid attempt result note');
  // Fixed order, explicit fields: identity never depends on JS object hash/order.
  return JSON.stringify({ ok: result.ok, patch: result.patch, workdir: result.workdir,
    planHash: result.planHash, ...(result.note === undefined ? {} : { note: result.note }) });
}

function record(row: Row): AttemptRecord {
  return { principal: row.principal, project: row.project, operation: row.operation,
    sourceRevision: row.source_revision, generation: row.generation, attemptId: row.attempt_id,
    status: row.status, ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) }),
    ...(row.staging_json == null ? {} : { staging: JSON.parse(row.staging_json) }),
    ...(row.artifact_hash === null ? {} : { artifactHash: row.artifact_hash }) };
}

/**
 * Controller-owned durable publication authority. Keep this database outside
 * worker mounts. Tokens identify issued attempts; they are not authentication.
 * The caller must supply its already verified principal/project scope. These
 * records are not signed Timmy receipts and hashes do not certify patch truth.
 */
export class OpenHandsAttemptStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (!path || path === ':memory:') throw new Error('Attempt store requires a durable file path');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS oh_heads (
        scope_key TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        active_attempt TEXT,
        current_attempt TEXT
      );
      CREATE TABLE IF NOT EXISTS oh_attempts (
        attempt_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        principal TEXT NOT NULL,
        project TEXT NOT NULL,
        operation TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','committed','superseded','cancelled','failed')),
        result_json TEXT,
        artifact_hash TEXT,
        UNIQUE(scope_key, generation)
      );
      CREATE INDEX IF NOT EXISTS oh_attempt_scope ON oh_attempts(scope_key, source_revision, generation);
      CREATE TABLE IF NOT EXISTS oh_staging (
        attempt_id TEXT PRIMARY KEY,
        staging_json TEXT NOT NULL
      );
    `);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private issued(token: AttemptToken): Row {
    validateScope(token);
    const row = this.db.prepare('SELECT * FROM oh_attempts WHERE attempt_id = ?').get(token.attemptId) as unknown as Row | undefined;
    if (!row || row.scope_key !== scopeKey(token) || row.source_revision !== token.sourceRevision
      || row.generation !== token.generation) throw new Error('Unknown or mismatched attempt token');
    return row;
  }

  begin(scope: AttemptScope): AttemptToken {
    validateScope(scope);
    return this.transaction(() => {
      const key = scopeKey(scope);
      const head = this.db.prepare('SELECT generation FROM oh_heads WHERE scope_key = ?').get(key) as { generation: number } | undefined;
      const generation = (head?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error('Attempt generation exhausted');
      const attemptId = randomUUID();
      this.db.prepare("UPDATE oh_attempts SET status = 'superseded' WHERE scope_key = ? AND status = 'running'").run(key);
      this.db.prepare(`INSERT INTO oh_attempts
        (attempt_id, scope_key, principal, project, operation, source_revision, generation, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`).run(attemptId, key, scope.principal, scope.project, scope.operation, scope.sourceRevision, generation);
      this.db.prepare(`INSERT INTO oh_heads(scope_key, generation, active_attempt) VALUES (?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET generation = excluded.generation, active_attempt = excluded.active_attempt`).run(key, generation, attemptId);
      return { ...scope, generation, attemptId };
    });
  }

  /** Revokes publication authority; stopping the actual worker is the caller's job. */
  cancel(token: AttemptToken): boolean {
    return this.transaction(() => {
      const row = this.issued(token);
      if (row.status !== 'running') return false;
      const changed = this.db.prepare('UPDATE oh_heads SET active_attempt = NULL WHERE scope_key = ? AND generation = ? AND active_attempt = ?')
        .run(row.scope_key, token.generation, token.attemptId);
      if (Number(changed.changes) !== 1) return false;
      this.db.prepare("UPDATE oh_attempts SET status = 'cancelled' WHERE attempt_id = ?").run(token.attemptId);
      return true;
    });
  }

  /** Persist recovery coordinates before launch; this never restarts a worker. */
  stage(token: AttemptToken, staging: AttemptStaging): void {
    if (typeof staging.workdir !== 'string' || !staging.workdir.trim()
      || typeof staging.planHash !== 'string' || !staging.planHash.trim()) {
      throw new Error('Invalid attempt staging metadata');
    }
    const json = JSON.stringify({ workdir: staging.workdir, planHash: staging.planHash });
    this.transaction(() => {
      const row = this.issued(token);
      if (row.status !== 'running') throw new Error('Only running attempts may be staged');
      const existing = this.db.prepare('SELECT staging_json FROM oh_staging WHERE attempt_id = ?')
        .get(token.attemptId) as { staging_json: string } | undefined;
      if (existing) {
        if (existing.staging_json !== json) throw new Error('Conflicting attempt staging metadata');
        return;
      }
      this.db.prepare('INSERT INTO oh_staging(attempt_id, staging_json) VALUES (?, ?)').run(token.attemptId, json);
    });
  }

  complete(token: AttemptToken, result: AttemptResult): AttemptPublication {
    const json = serializeResult(result);
    const artifactHash = digest(result.patch);
    return this.transaction(() => {
      const row = this.issued(token);
      const staged = this.db.prepare('SELECT staging_json FROM oh_staging WHERE attempt_id = ?')
        .get(token.attemptId) as { staging_json: string } | undefined;
      if (staged) {
        const expected: AttemptStaging = JSON.parse(staged.staging_json);
        if (expected.workdir !== result.workdir || expected.planHash !== result.planHash) {
          throw new Error('Attempt completion does not match staging metadata');
        }
      }
      if (row.result_json !== null) {
        if (row.result_json !== json) throw new Error('Conflicting duplicate attempt completion');
        return { status: row.status as PublicationStatus, artifactHash: row.artifact_hash! };
      }
      const head = this.db.prepare('SELECT generation, active_attempt FROM oh_heads WHERE scope_key = ?').get(row.scope_key) as { generation: number; active_attempt: string | null };
      const current = head.generation === token.generation && head.active_attempt === token.attemptId;
      const status: PublicationStatus = row.status === 'cancelled' ? 'cancelled'
        : !current || row.status === 'superseded' ? 'superseded' : result.ok ? 'committed' : 'failed';
      // Retain actual patch bytes and publication decision in the same transaction.
      this.db.prepare('UPDATE oh_attempts SET status = ?, result_json = ?, artifact_hash = ? WHERE attempt_id = ?')
        .run(status, json, artifactHash, token.attemptId);
      if (current) {
        const updated = this.db.prepare(`UPDATE oh_heads SET active_attempt = NULL,
          current_attempt = CASE WHEN ? = 'committed' THEN ? ELSE current_attempt END
          WHERE scope_key = ? AND generation = ? AND active_attempt = ?`)
          .run(status, token.attemptId, row.scope_key, token.generation, token.attemptId);
        if (Number(updated.changes) !== 1) throw new Error('Attempt publication lost authority');
      }
      return { status, artifactHash };
    });
  }

  current(scope: AttemptScope): AttemptRecord | null {
    validateScope(scope);
    const row = this.db.prepare(`SELECT a.*, s.staging_json FROM oh_heads h JOIN oh_attempts a ON a.attempt_id = h.current_attempt
      LEFT JOIN oh_staging s ON s.attempt_id = a.attempt_id
      WHERE h.scope_key = ? AND a.source_revision = ?`).get(scopeKey(scope), scope.sourceRevision) as unknown as Row | undefined;
    return row ? record(row) : null;
  }

  attempts(scope: AttemptScope): AttemptRecord[] {
    validateScope(scope);
    const rows = this.db.prepare(`SELECT a.*, s.staging_json FROM oh_attempts a LEFT JOIN oh_staging s ON s.attempt_id = a.attempt_id
      WHERE a.scope_key = ? AND a.source_revision = ? ORDER BY a.generation`)
      .all(scopeKey(scope), scope.sourceRevision) as unknown as Row[];
    return rows.map(record);
  }

  close(): void { this.db.close(); }
}
