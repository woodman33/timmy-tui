// Registry: tags → units, keysets, fixtures. Reads the pilot fixtures; a
// production build swaps the JSON for KV/D1 reads behind the same functions.
import tagsJson from '../data/tags.json';
import unitsJson from '../data/units.json';
import cardsJson from '../data/cards.json';
import relicsJson from '../data/relics.json';
import seriesJson from '../data/series.json';
import logJson from '../data/log.json';
import manufacturerJson from '../data/manufacturer.json';
import { hex, type SunKeys } from './sun.js';
import { deriveBatchMetaKey, deriveTagFileKey, type BatchMaster } from './divkey.js';

export type TimelineKind = 'sealed' | 'opened' | 'pack';
export interface TimelineEntry { kind: TimelineKind; title: string; meta: string }

export interface Unit {
  serial: string;
  series: string;
  product: string;
  state: 'sealed' | 'opened';
  sealTag: string;
  revealTag?: string;
  contentsHash: string;
  sealed: { at: string; where: string; by: string; band: string; photos: number };
  seal?: { signature: string; taps: number; loop: string };
  sold?: { at: string; posReceipt: string; counter: number };
  claimed?: { at: string; ownerInitials: string; city: string; tap: number };
  opened?: { at: string; city: string; byClaimedOwner: boolean; sealLoop: string; revealTag: string };
  packs?: { opened: number; total: number; first: string; last: string };
  cards?: { attached: number; hits: number; numbered: number };
  event?: string;
  timeline: TimelineEntry[];
}

export interface TagRecord {
  serial: string;
  role: 'seal' | 'reveal';
  type: string;
  batch: string;
  keyset: string;
  lastCounter: number;
  /** Published test-vector tag: fixed URL, recorded but never refused as replay. */
  demo?: boolean;
}

export const EPOCH: number = unitsJson.epoch;
export const units = unitsJson.units as Record<string, Unit>;
export const cards = cardsJson.cards;
export const relics = relicsJson.relics;
export const series = seriesJson.series;
export const log = logJson;
export const manufacturer = manufacturerJson;
export const tags = tagsJson.tags as Record<string, TagRecord>;

export function unitFor(serial: string): Unit | undefined {
  return units[serial];
}

export function tagFor(uidHex: string): TagRecord | undefined {
  return tags[uidHex.toLowerCase()];
}

/**
 * A keyset is either a literal pair (the pilot fixtures, the published AN12196
 * demo keys) or a diversified batch: two masters plus a label, from which
 * `divkey.ts` derives one meta-read key per batch and one file-read key per
 * tag. Programmed tags use the diversified form; the same module derived the
 * keys that were written to the chip.
 */
export type KeysetEntry =
  | { kind?: 'static'; metaReadKey: string; fileReadKey: string }
  | ({ kind: 'diversified' } & BatchMaster);

export function isDiversified(k: KeysetEntry): k is { kind: 'diversified' } & BatchMaster {
  return (k as { kind?: string }).kind === 'diversified';
}

/** The keyset table: fixtures, extended and overridden by the CUSTODY_KEYS env JSON. */
export function keyTable(overrides?: string): Record<string, KeysetEntry> {
  const table = { ...(tagsJson.keys as unknown as Record<string, KeysetEntry>) };
  if (overrides) {
    try {
      Object.assign(table, JSON.parse(overrides) as Record<string, KeysetEntry>);
    } catch {
      /* bad override JSON: fall through to fixtures */
    }
  }
  return table;
}

/** Resolve the keyset for a tag. `overrides` is the CUSTODY_KEYS env JSON, when present. */
export function keysFor(tag: TagRecord | undefined, overrides?: string): SunKeys {
  const table = keyTable(overrides);
  const k = table[tag?.keyset ?? 'demo'] ?? table.demo;
  if (isDiversified(k)) {
    throw new Error(`keyset ${tag?.keyset} is diversified; use keysForAsync (the file-read key depends on the UID)`);
  }
  return { metaReadKey: hex.from(k.metaReadKey), fileReadKey: hex.from(k.fileReadKey) };
}

/**
 * Resolve a tag's keys, deriving them when the keyset is diversified. The UID
 * is required: the file-read key is per tag.
 */
export async function keysForAsync(tag: TagRecord | undefined, uidHex: string, overrides?: string): Promise<SunKeys> {
  const table = keyTable(overrides);
  const k = table[tag?.keyset ?? 'demo'] ?? table.demo;
  if (!isDiversified(k)) {
    return { metaReadKey: hex.from(k.metaReadKey), fileReadKey: hex.from(k.fileReadKey) };
  }
  return {
    metaReadKey: await deriveBatchMetaKey(k),
    fileReadKey: await deriveTagFileKey(k, uidHex),
  };
}

/**
 * Every meta-read key a reader could need before it knows which tag it holds.
 * With encrypted PICC mirroring the UID is inside the ciphertext, so the
 * verifier tries each batch's meta key until one decrypts to a registered UID.
 * Static keysets contribute their literal key; diversified ones contribute the
 * batch key derived from their master.
 */
export async function candidateMetaKeys(overrides?: string): Promise<{ keyset: string; metaReadKey: Uint8Array }[]> {
  const table = keyTable(overrides);
  const out: { keyset: string; metaReadKey: Uint8Array }[] = [];
  for (const [name, k] of Object.entries(table)) {
    try {
      out.push({ keyset: name, metaReadKey: isDiversified(k) ? await deriveBatchMetaKey(k) : hex.from(k.metaReadKey) });
    } catch {
      /* a malformed keyset must not take the whole reader down */
    }
  }
  // 'demo' first: the published vectors are the common case on the preview.
  return out.sort((a, b) => (a.keyset === 'demo' ? -1 : b.keyset === 'demo' ? 1 : a.keyset.localeCompare(b.keyset)));
}

/** Default keys used to verify a tag whose UID is not yet in the registry (unknown tag → still verify against demo keys, then refuse as unregistered). */
export function defaultKeys(overrides?: string): SunKeys {
  return keysFor(undefined, overrides);
}

export const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' });
};
