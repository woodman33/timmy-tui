/**
 * Timmy's identity key (round R4, H98): an ed25519 private key, made here or read from what a person gives. One parser for
 * the setup's identity question (src/setup/questions.ts checks an answer with it as soon as it is typed, so a file Timmy
 * cannot read is refused there, never after "Proceed?") and for the writer (src/utils/init.ts applySetup). Node only, like
 * the rest of src/setup (`timmy init` runs it from an installed package before anything else is resolved).
 *
 * Accepted: nothing, g or generate (a new key); a 64-hex ed25519 seed; or the path of a file holding a PEM ed25519 private
 * key or a 64-hex seed. Its words never repeat what was given: it may be a secret.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

export interface Identity { operatorId: string; publicKeyHex: string; privatePem: string; source: 'generated' | 'imported' }

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const HEX_SEED = /^[0-9a-fA-F]{64}$/;
/** A key file is small: a PEM ed25519 key is about 120 bytes. */
const MAX_KEY_FILE = 64 * 1024;

/** The answer that makes a new key: nothing, g or generate. */
export const isNewKey = (v: string | undefined): boolean => !v || v === 'generate' || v === 'g';

/** The words for each refusal (never the value given). */
export const IDENTITY_WORDS = {
  missing: 'No such file, and not a 64-hex seed. Enter makes a new key.',
  unreadable: 'That file is not a key Timmy can read: a PEM ed25519 private key, or a 64-hex seed.',
  notFile: 'That is a folder, or a file too large to be a key.',
  notEd25519: 'That key is not an ed25519 key; Timmy\'s identity is one.',
} as const;

const fromSeed = (hex: string): KeyObject => createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'pkcs8' });

function fromFile(path: string): KeyObject {
  let size = 0;
  try { const st = statSync(path); if (!st.isFile()) throw new Error(IDENTITY_WORDS.notFile); size = st.size; } catch (e) {
    throw new Error(e instanceof Error && e.message === IDENTITY_WORDS.notFile ? e.message : IDENTITY_WORDS.unreadable);
  }
  if (size > MAX_KEY_FILE) throw new Error(IDENTITY_WORDS.notFile);
  let body: string;
  try { body = readFileSync(path, 'utf8'); } catch { throw new Error(IDENTITY_WORDS.unreadable); }
  const t = body.trim();
  if (HEX_SEED.test(t)) return fromSeed(t);
  try { return createPrivateKey(body); } catch { throw new Error(IDENTITY_WORDS.unreadable); }
}

/**
 * The identity a given answer stands for: a new key, a seed, or a key file read now. Throws, in IDENTITY_WORDS, when it
 * cannot be one.
 */
export function seedIdentity(seed: string | undefined): Identity {
  let priv: KeyObject;
  let source: Identity['source'] = 'generated';
  if (isNewKey(seed)) priv = generateKeyPairSync('ed25519').privateKey;
  else if (HEX_SEED.test(seed!)) { priv = fromSeed(seed!); source = 'imported'; }
  else if (existsSync(seed!)) { priv = fromFile(seed!); source = 'imported'; }
  else throw new Error(IDENTITY_WORDS.missing);
  if (priv.asymmetricKeyType !== 'ed25519') throw new Error(IDENTITY_WORDS.notEd25519);
  const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  return { operatorId: 'op_' + createHash('sha256').update(pubDer).digest('hex').slice(0, 16), publicKeyHex: pubDer.toString('hex'), privatePem: priv.export({ format: 'pem', type: 'pkcs8' }) as string, source };
}

/** Why an answer cannot be an identity (in IDENTITY_WORDS), or null when it can: the same parser as the writer's. */
export function identityProblem(given: string): string | null {
  try { seedIdentity(given); return null; } catch (e) { return e instanceof Error ? e.message : IDENTITY_WORDS.unreadable; }
}
