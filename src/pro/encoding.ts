// Byte helpers shared by the CLI (Node 22+) and the Pro Worker. Web Crypto only:
// no Node-specific APIs, so the same file bundles into Cloudflare Workers.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Web Crypto wants ArrayBuffer-backed views; copying into a fresh Uint8Array guarantees that type.
export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text));
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Crockford base32: no I, L, O or U, so a key read aloud or retyped survives.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function toCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export const isCrockford = (text: string): boolean => /^[0-9A-HJKMNP-TV-Z]+$/.test(text);

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', utf8(text)));
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(message)));
}

/** Constant-time comparison for equal-length strings; unequal lengths fail without early exit on content. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
