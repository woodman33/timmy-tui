import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { SqlLicenseStore, type SqlExec, type SubscriptionRecord } from '../src/pro/store.js';

// The Worker runs this store on Durable Object SQLite; node:sqlite (Node 22.5+)
// stands in here so the real SQL is exercised, not a mock.
const require = createRequire(import.meta.url);
let DatabaseSync: (new (path: string) => any) | null = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = null;
}

function sqlite(): SqlExec {
  const db = new DatabaseSync!(':memory:');
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...bindings) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

const record = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  subscriptionId: 'sub_1', customerId: 'cus_1', email: null, status: 'active', currentPeriodEnd: 1_800_000_000,
  keyVersion: 1, keyHash: 'a'.repeat(64), checkoutSessionId: 'cs_test_1', createdAt: 1, pastDueSince: null, updatedAt: 1, ...over,
});

describe.skipIf(!DatabaseSync)('SqlLicenseStore on SQLite', () => {
  it('upserts by subscription and finds by key hash and checkout session', async () => {
    const store = new SqlLicenseStore(sqlite());
    await store.upsert(record());
    await store.upsert(record({ status: 'past_due', keyVersion: 2, keyHash: 'b'.repeat(64), email: 'x@example.com', pastDueSince: 7 }));
    expect(await store.getBySubscription('sub_1')).toEqual(record({ status: 'past_due', keyVersion: 2, keyHash: 'b'.repeat(64), email: 'x@example.com', pastDueSince: 7 }));
    expect(await store.getByKeyHash('a'.repeat(64))).toBeNull();
    expect((await store.getByKeyHash('b'.repeat(64)))?.subscriptionId).toBe('sub_1');
    expect((await store.getByCheckoutSession('cs_test_1'))?.keyVersion).toBe(2);
    expect(await store.getBySubscription('sub_missing')).toBeNull();
  });

  it('remembers processed events and survives a second constructor on the same database', async () => {
    const db = sqlite();
    const store = new SqlLicenseStore(db);
    expect(await store.hasProcessedEvent('evt_1')).toBe(false);
    await store.markEventProcessed('evt_1', 5);
    await store.markEventProcessed('evt_1', 6);
    expect(await new SqlLicenseStore(db).hasProcessedEvent('evt_1')).toBe(true);
  });
});
