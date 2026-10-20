/**
 * R6 (H143): what Timmy knows of a Rerun recording (.rrd) a VoxVision record names, read by Timmy from the file's own bytes in
 * plain TypeScript (nothing run, no Rerun SDK): its header (the RRF2 magic, the Rerun version that wrote it, its compression
 * and serializer), its messages counted by kind (store info, data chunks, blueprint activations), each store's kind,
 * application id and recording id (from the store-info messages, plain protobuf), and whether it ends with a footer.
 *
 * What it does not read: the chunks themselves are compressed Arrow data, which Timmy does not decode, so a recording's
 * entities, frames and time range are not known to this reader: they are said to be unknown, with why, never guessed. Rerun's
 * own viewer shows them (`/vox view <record id>`, src/vox/layers.ts), where it is installed. R9 (H159): src/vox/rrd-cli.ts reads
 * them through the installed Rerun CLI (rrd verify, stats and print, bounded, its version checked), and tab 6 shows that
 * reading beside these facts; this reader's own words stay as they are.
 *
 * The layout read (Rerun 0.2x to 0.38's .rrd: its header, then messages of a little-endian u64 kind and a u64 length, kind 0
 * ending the stream; an optional footer ending in "RRF2FOOT"): a file that does not follow it is said to be unreadable, with
 * where it stopped.
 */

export const RRD_MAGIC = 'RRF2';
const FOOTER_MAGIC = 'RRF2FOOT';
/** The most of a recording read here. */
export const RRD_MAX_BYTES = 256 * 1024 * 1024;

export interface RecordingStore {
  kind: 'recording' | 'blueprint' | 'unknown';
  application?: string;
  recording?: string;
}

export interface RecordingFacts {
  format: 'rrd';
  bytes: number;
  /** the Rerun version the header names (major.minor.patch) */
  writer: string;
  compression: string;
  serializer: string;
  messages: { storeInfo: number; chunks: number; blueprint: number; other: number };
  stores: RecordingStore[];
  /** the stream's end marker was read; a footer follows it (RRF2FOOT) */
  ended: boolean;
  footer: boolean;
  /** where the read stopped early, when it did */
  stopped?: string;
  /** what Timmy does not read here, in words */
  unknown: { entities: string; frames: string; timeRange: string };
}

/** Whether a file's first bytes are a Rerun recording's. */
export const isRecording = (head: Buffer): boolean => head.length >= 4 && head.subarray(0, 4).toString('latin1') === RRD_MAGIC;

const UNKNOWN_WHY = "inside the recording's data chunks (compressed Arrow), which Timmy does not decode; Rerun's viewer shows it";

function varint(b: Buffer, at: number): { v: number; at: number } | null {
  let v = 0;
  let mul = 1;
  for (let i = 0; i < 10 && at < b.length; i++) {
    const x = b[at++];
    v += (x & 0x7f) * mul;
    if (!(x & 0x80)) return { v, at };
    mul *= 128;
  }
  return null;
}

/** A protobuf message's fields, as (field, wire type, value): length-delimited values as bytes. */
function fields(b: Buffer): Array<{ f: number; wt: number; n?: number; bytes?: Buffer }> | null {
  const out: Array<{ f: number; wt: number; n?: number; bytes?: Buffer }> = [];
  let at = 0;
  while (at < b.length) {
    const tag = varint(b, at);
    if (!tag) return null;
    at = tag.at;
    const f = Math.floor(tag.v / 8);
    const wt = tag.v % 8;
    if (wt === 0) { const x = varint(b, at); if (!x) return null; at = x.at; out.push({ f, wt, n: x.v }); }
    else if (wt === 2) {
      const len = varint(b, at);
      if (!len || len.at + len.v > b.length) return null;
      out.push({ f, wt, bytes: b.subarray(len.at, len.at + len.v) });
      at = len.at + len.v;
    } else if (wt === 1) at += 8;
    else if (wt === 5) at += 4;
    else return null;
  }
  return out;
}

const printable = (b: Buffer | undefined): string | undefined => {
  if (!b || !b.length || b.length > 256) return undefined;
  const s = b.toString('utf8');
  return /^[\x20-\x7e]+$/.test(s) ? s : undefined;
};

/** A store-info message's store: its kind (1 recording, 2 blueprint), recording id and application id. */
function storeOf(payload: Buffer): RecordingStore | null {
  const top = fields(payload);
  const info = top?.find((x) => x.f === 2 && x.bytes)?.bytes;
  const inner = info ? fields(info) : null;
  const id = inner?.find((x) => x.f === 2 && x.bytes)?.bytes;
  const sid = id ? fields(id) : null;
  if (!sid) return null;
  const kind = sid.find((x) => x.f === 1 && x.wt === 0)?.n;
  const app = sid.find((x) => x.f === 3 && x.bytes)?.bytes;
  const appId = app ? printable(fields(app)?.find((x) => x.f === 1 && x.bytes)?.bytes) : undefined;
  const rec = printable(sid.find((x) => x.f === 2 && x.bytes)?.bytes);
  return { kind: kind === 1 ? 'recording' : kind === 2 ? 'blueprint' : 'unknown', ...(appId ? { application: appId } : {}), ...(rec ? { recording: rec } : {}) };
}

/** What a recording's bytes say, as far as Timmy reads them; or why they are not a recording it reads. */
export function readRecording(b: Buffer): RecordingFacts | { error: string } {
  if (!isRecording(b)) return { error: 'its first bytes are not a Rerun recording\'s (RRF2)' };
  if (b.length < 12) return { error: `${b.length} bytes: too short for a Rerun recording's header (12 bytes)` };
  // the header's version bytes are major, minor, patch and a suffix (00 25 02 00 is 0.37.2); then the encoding options
  const compression = b[8] === 0 ? 'off' : b[8] === 1 ? 'LZ4' : `option ${b[8]}`;
  const serializer = b[9] === 1 ? 'MsgPack' : b[9] === 2 ? 'Protobuf' : `option ${b[9]}`;
  const facts: RecordingFacts = {
    format: 'rrd', bytes: b.length, writer: `Rerun ${b[4]}.${b[5]}.${b[6]}`, compression, serializer,
    messages: { storeInfo: 0, chunks: 0, blueprint: 0, other: 0 }, stores: [], ended: false, footer: false,
    unknown: { entities: UNKNOWN_WHY, frames: UNKNOWN_WHY, timeRange: UNKNOWN_WHY },
  };
  let at = 12;
  const seen = new Set<string>();
  while (at < b.length) {
    if (at + 16 > b.length) { facts.stopped = `${b.length - at} bytes after the last whole message`; break; }
    const kind = Number(b.readBigUInt64LE(at));
    const len = Number(b.readBigUInt64LE(at + 8));
    at += 16;
    if (!Number.isSafeInteger(len) || at + len > b.length) { facts.stopped = `a message at byte ${at - 16} says ${len} bytes, more than the file holds`; break; }
    const payload = b.subarray(at, at + len);
    at += len;
    if (kind === 0) { facts.ended = true; break; }
    if (kind === 1) {
      facts.messages.storeInfo++;
      const s = storeOf(payload);
      const key = s ? `${s.kind}|${s.application ?? ''}|${s.recording ?? ''}` : '';
      if (s && !seen.has(key)) { seen.add(key); facts.stores.push(s); }
    } else if (kind === 2) facts.messages.chunks++;
    else if (kind === 3) facts.messages.blueprint++;
    else facts.messages.other++;
  }
  facts.footer = b.length >= 12 && b.subarray(b.length - 12, b.length - 4).toString('latin1') === FOOTER_MAGIC;
  return facts;
}
