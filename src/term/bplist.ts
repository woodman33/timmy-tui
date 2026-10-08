/**
 * A small binary property list writer ("bplist00"), enough for macOS Terminal's profile files (round
 * R1): a `.terminal` profile keeps each color and its font as an NSKeyedArchiver archive, which is a
 * binary plist. Strings, integers, reals, booleans, data, UIDs, arrays and dictionaries; no dates.
 */

/** An NSKeyedArchiver object reference. */
export class Uid {
  constructor(readonly value: number) {}
}

/** A number written as a real even when it is whole (a font size of 14 is the real 14.0). */
export class Real {
  constructor(readonly value: number) {}
}

export type PlistValue = string | number | boolean | Uint8Array | Uid | Real | PlistValue[] | { [key: string]: PlistValue };

const isDict = (v: PlistValue): v is { [key: string]: PlistValue } =>
  typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && !(v instanceof Uid) && !(v instanceof Real) && !Array.isArray(v);

function uintBytes(n: number, size: number): number[] {
  const out: number[] = [];
  for (let i = size - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) % 256);
  return out;
}

function intObject(n: number): number[] {
  if (n >= 0 && n < 256) return [0x10, n];
  if (n >= 0 && n < 65536) return [0x11, ...uintBytes(n, 2)];
  if (n >= 0 && n < 2 ** 32) return [0x12, ...uintBytes(n, 4)];
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(n));
  return [0x13, ...b];
}

/** A marker with a length: in its low nibble when under 15, else 0xF and an integer object. */
const sized = (marker: number, length: number): number[] => (length < 15 ? [marker | length] : [marker | 0xf, ...intObject(length)]);

/** The binary plist for `root`. */
export function bplist(root: PlistValue): Uint8Array {
  const objects: PlistValue[] = [];
  const refs: number[][] = [];
  const add = (v: PlistValue): number => {
    const index = objects.length;
    objects.push(v);
    refs.push([]);
    if (Array.isArray(v)) refs[index] = v.map(add);
    else if (isDict(v)) {
      const keys = Object.keys(v);
      refs[index] = [...keys.map(add), ...keys.map((k) => add(v[k]))];
    }
    return index;
  };
  add(root);
  const refSize = objects.length < 256 ? 1 : 2;
  const encoded = objects.map((v, i): number[] => {
    if (typeof v === 'boolean') return [v ? 0x09 : 0x08];
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return intObject(v);
      v = new Real(v);
    }
    if (v instanceof Real) {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v.value);
      return [0x23, ...b];
    }
    if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) return [...sized(0x50, v.length), ...Array.from(v, (c) => c.charCodeAt(0))];
      const units = Array.from({ length: v.length }, (_, k) => v.charCodeAt(k) as number);
      return [...sized(0x60, units.length), ...units.flatMap((u) => [u >> 8, u & 0xff])];
    }
    if (v instanceof Uint8Array) return [...sized(0x40, v.length), ...v];
    if (v instanceof Uid) {
      const size = v.value < 256 ? 1 : v.value < 65536 ? 2 : 4;
      return [0x80 | (size - 1), ...uintBytes(v.value, size)];
    }
    const r = refs[i].flatMap((ref) => uintBytes(ref, refSize));
    return Array.isArray(v) ? [...sized(0xa0, v.length), ...r] : [...sized(0xd0, refs[i].length / 2), ...r];
  });
  const header = Array.from('bplist00', (c) => c.charCodeAt(0));
  const offsets: number[] = [];
  let at = header.length;
  for (const e of encoded) {
    offsets.push(at);
    at += e.length;
  }
  const offsetSize = at < 256 ? 1 : at < 65536 ? 2 : 4;
  const table = offsets.flatMap((o) => uintBytes(o, offsetSize));
  const trailer = [0, 0, 0, 0, 0, 0, offsetSize, refSize, ...uintBytes(objects.length, 8), ...uintBytes(0, 8), ...uintBytes(at, 8)];
  return Uint8Array.from([...header, ...encoded.flat(), ...table, ...trailer]);
}

/** An NSKeyedArchiver archive of `objects`, whose root is object 1 (object 0 is "$null"). */
export const keyedArchive = (objects: PlistValue[]): Uint8Array =>
  bplist({ $archiver: 'NSKeyedArchiver', $objects: ['$null', ...objects], $top: { root: new Uid(1) }, $version: 100000 });
