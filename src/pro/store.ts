// Where the Pro service remembers subscriptions. One record per Stripe
// subscription; the license key is never stored, only its SHA-256.

export interface SubscriptionRecord {
  subscriptionId: string;
  customerId: string | null;
  email: string | null;
  status: string;
  currentPeriodEnd: number | null;
  keyVersion: number;
  keyHash: string;
  checkoutSessionId: string | null;
  /** When this subscription was first recorded; bounds the key-reveal window. */
  createdAt: number;
  /** Set while Stripe reports past_due; Pro ends 14 days after it. */
  pastDueSince: number | null;
  updatedAt: number;
}

export interface LicenseStore {
  getBySubscription(subscriptionId: string): Promise<SubscriptionRecord | null>;
  getByKeyHash(keyHash: string): Promise<SubscriptionRecord | null>;
  getByCheckoutSession(sessionId: string): Promise<SubscriptionRecord | null>;
  upsert(record: SubscriptionRecord): Promise<void>;
  hasProcessedEvent(eventId: string): Promise<boolean>;
  markEventProcessed(eventId: string, at: number): Promise<void>;
}

export class MemoryLicenseStore implements LicenseStore {
  private readonly records = new Map<string, SubscriptionRecord>();
  private readonly events = new Set<string>();

  async getBySubscription(id: string) { return this.records.get(id) ?? null; }
  async getByKeyHash(hash: string) { return [...this.records.values()].find((r) => r.keyHash === hash) ?? null; }
  async getByCheckoutSession(id: string) { return [...this.records.values()].find((r) => r.checkoutSessionId === id) ?? null; }
  async upsert(record: SubscriptionRecord) { this.records.set(record.subscriptionId, { ...record }); }
  async hasProcessedEvent(id: string) { return this.events.has(id); }
  async markEventProcessed(id: string) { this.events.add(id); }
}

/** The slice of Durable Object `SqlStorage` the store needs; node:sqlite is adapted to it in tests. */
export interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export class SqlLicenseStore implements LicenseStore {
  constructor(private readonly sql: SqlExec) {
    sql.exec(`CREATE TABLE IF NOT EXISTS pro_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      customer_id TEXT,
      email TEXT,
      status TEXT NOT NULL,
      current_period_end INTEGER,
      key_version INTEGER NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      checkout_session_id TEXT,
      created_at INTEGER NOT NULL,
      past_due_since INTEGER,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS pro_subscriptions_session ON pro_subscriptions (checkout_session_id)');
    sql.exec('CREATE TABLE IF NOT EXISTS pro_events (event_id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL)');
  }

  private one(query: string, ...bindings: unknown[]): SubscriptionRecord | null {
    const row = this.sql.exec(query, ...bindings).toArray()[0];
    return row ? toRecord(row) : null;
  }

  async getBySubscription(id: string) { return this.one('SELECT * FROM pro_subscriptions WHERE subscription_id = ?', id); }
  async getByKeyHash(hash: string) { return this.one('SELECT * FROM pro_subscriptions WHERE key_hash = ?', hash); }
  async getByCheckoutSession(id: string) { return this.one('SELECT * FROM pro_subscriptions WHERE checkout_session_id = ?', id); }

  async upsert(r: SubscriptionRecord) {
    this.sql.exec(
      `INSERT INTO pro_subscriptions (subscription_id, customer_id, email, status, current_period_end, key_version, key_hash,
         checkout_session_id, created_at, past_due_since, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscription_id) DO UPDATE SET customer_id = excluded.customer_id, email = excluded.email,
         status = excluded.status, current_period_end = excluded.current_period_end, key_version = excluded.key_version,
         key_hash = excluded.key_hash, checkout_session_id = excluded.checkout_session_id,
         past_due_since = excluded.past_due_since, updated_at = excluded.updated_at`,
      r.subscriptionId, r.customerId, r.email, r.status, r.currentPeriodEnd, r.keyVersion, r.keyHash, r.checkoutSessionId,
      r.createdAt, r.pastDueSince, r.updatedAt,
    );
  }

  async hasProcessedEvent(id: string) {
    return this.sql.exec('SELECT 1 AS hit FROM pro_events WHERE event_id = ?', id).toArray().length > 0;
  }

  async markEventProcessed(id: string, at: number) {
    this.sql.exec('INSERT OR IGNORE INTO pro_events (event_id, processed_at) VALUES (?, ?)', id, at);
  }
}

function toRecord(row: Record<string, unknown>): SubscriptionRecord {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    subscriptionId: String(row.subscription_id),
    customerId: str(row.customer_id),
    email: str(row.email),
    status: String(row.status),
    currentPeriodEnd: num(row.current_period_end),
    keyVersion: Number(row.key_version),
    keyHash: String(row.key_hash),
    checkoutSessionId: str(row.checkout_session_id),
    createdAt: Number(row.created_at),
    pastDueSince: num(row.past_due_since),
    updatedAt: Number(row.updated_at),
  };
}
