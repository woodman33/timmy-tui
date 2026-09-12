// The tap: verify the SUN message, check replay, seal a custody.tap receipt,
// decide where the phone goes next. Pure function over (query, deps) so it is
// testable without Astro or Workers.
import { appendCustodyReceipt } from './chain.js';
import { keysForAsync, candidateMetaKeys, defaultKeys, tagFor, unitFor, type TagRecord } from './registry.js';
import { type CustodyStore } from './store.js';
import { decryptPiccData, hex, type SunOk } from './sun.js';
import { parseTapParams, verifyTap } from './url.js';

export interface TapDeps {
  store: CustodyStore;
  keyOverrides?: string;
  now?: () => string;
}

export type TapOutcome =
  | {
      ok: true;
      serial: string;
      uid: string;
      counter: number;
      tag: TagRecord;
      sun: SunOk;
      receiptHash: string;
      receiptId: string;
      replayChecked: boolean;
      redirect: string;
    }
  | {
      ok: false;
      reason: 'bad_cmac' | 'bad_hex' | 'bad_length' | 'bad_tag' | 'missing_param' | 'unregistered' | 'replay';
      detail?: string;
      uid?: string;
      counter?: number;
      redirect: string;
    };

/**
 * Best-effort UID for a tap, used only to choose which keys to verify against.
 * Returns undefined when nothing decrypts to anything usable. Never throws, and
 * never implies the tap is genuine — that is the CMAC's job.
 */
async function identifyTag(search: URLSearchParams, overrides?: string): Promise<string | undefined> {
  let params;
  try {
    params = parseTapParams(search);
  } catch {
    return undefined;
  }
  if (params.mode === 'plain') return params.u.toLowerCase();
  let firstDecoded: string | undefined;
  for (const c of await candidateMetaKeys(overrides)) {
    try {
      const picc = await decryptPiccData(c.metaReadKey, hex.from(params.e));
      if (!picc.uid) continue;
      const uid = hex.to(picc.uid);
      firstDecoded ??= uid;
      if (tagFor(uid)) return uid;
    } catch {
      /* wrong key for this batch: keep looking */
    }
  }
  // Nothing matched the registry. Report whatever the first key decoded so an
  // unregistered tag can be refused by UID instead of anonymously.
  return firstDecoded;
}

export async function handleTap(search: URLSearchParams, deps: TapDeps): Promise<TapOutcome> {
  // 1. Which tag is this? Identification and verification are separate steps,
  //    because the file-read key that authenticates the CMAC is per tag: we
  //    cannot pick it until we know the UID.
  //
  //    Plain mirror: the UID is in the URL. Encrypted mirror: the UID is inside
  //    the ciphertext, so try each batch's meta-read key until one decrypts to
  //    a UID the registry knows. Meta keys are per batch for exactly this
  //    reason — a meta key diversified per tag would be underivable here.
  //
  //    Nothing is trusted yet. Identification only chooses which keys to check
  //    against; the CMAC in step 1b is what decides.
  const uidOf = await identifyTag(search, deps.keyOverrides);
  const tag: TagRecord | undefined = uidOf ? tagFor(uidOf) : undefined;

  // 1b. Verify for real, with that tag's own keys. Unknown tag → default keys,
  //     so a bad CMAC is still reported as a bad CMAC rather than as unknown.
  const keys = tag ? await keysForAsync(tag, uidOf as string, deps.keyOverrides) : defaultKeys(deps.keyOverrides);
  const r = await verifyTap(search, keys);
  if (!r.ok) {
    return { ok: false, reason: r.reason, detail: r.detail, redirect: refusal(r.reason, r.detail) };
  }
  if (!tag) {
    return { ok: false, reason: 'unregistered', uid: r.ok ? r.uid : uidOf, counter: r.ok ? r.readCounter : undefined, redirect: refusal('unregistered', `uid ${r.uid} is not in any batch`) };
  }

  // 2. Replay: the counter must move forward. The tag increments it on every
  //    read, so an old URL (a screenshot, a copy) fails here.
  //    Demo tags (the published AN12196 vectors on the deck and the QR) are
  //    fixed URLs by nature, so they record the tap but are never refused as
  //    replay; the receipt says so. Production tags never carry `demo`.
  const last = (await deps.store.getLastCounter(r.uid)) ?? tag.lastCounter;
  const replayed = r.readCounter <= last;
  if (replayed && !tag.demo) {
    return { ok: false, reason: 'replay', uid: r.uid, counter: r.readCounter, redirect: refusal('replay', `counter ${r.readCounter} already seen (last ${last})`) };
  }
  if (!replayed) await deps.store.setLastCounter(r.uid, r.readCounter);

  // 3. Seal the tap into the unit's chain.
  const chain = await deps.store.getChain(tag.serial);
  const rec = await appendCustodyReceipt(chain, {
    kind: 'custody.tap',
    subject: tag.serial,
    ts: deps.now?.() ?? new Date().toISOString(),
    data: {
      uid: r.uid,
      counter: r.readCounter,
      role: tag.role,
      mode: r.mode,
      sig: 'valid',
      tt: r.tagTamper?.raw ?? null,
      loop: r.tagTamper ? (r.tagTamper.permanent === 'open' ? 'broken' : 'intact') : 'unreported',
      replay_checked: deps.store.persistent,
      replay: replayed ? 'demo-vector' : 'fresh'
    }
  });
  await deps.store.putChain(tag.serial, chain);

  // 4. Where the phone goes: the receipt page, or the Custody Companion when
  //    the tag address carries app=1 (HTML5 Defold + Rive, served at /companion/).
  const unit = unitFor(tag.serial);
  const app = search.get('app') === '1';
  const to = new URL(app ? '/companion/' : `/r/${tag.serial}`, 'https://x');
  if (app) to.searchParams.set('serial', tag.serial);
  to.searchParams.set('tap', rec.hash.slice(0, 8));
  to.searchParams.set('n', String(r.readCounter));
  if (r.tagTamper) to.searchParams.set('tt', r.tagTamper.raw);
  if (!unit && !app) to.pathname = '/verify';
  return {
    ok: true,
    serial: tag.serial,
    uid: r.uid,
    counter: r.readCounter,
    tag,
    sun: r,
    receiptHash: rec.hash,
    receiptId: rec.id,
    replayChecked: deps.store.persistent,
    redirect: to.pathname + to.search
  };
}

function refusal(reason: string, detail?: string): string {
  const u = new URL('/verify', 'https://x');
  u.searchParams.set('refused', reason);
  if (detail) u.searchParams.set('detail', detail);
  return u.pathname + u.search;
}
