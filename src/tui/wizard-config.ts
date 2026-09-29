import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir as overlayDirectory } from '../../lanes/privacy/overlay.mjs';
import { receiptsDir } from '../utils/receipts.js';
import { policyPath } from '../harness/policy.js';

const MAX_CONFIG = 256 * 1024;
const unsafeText = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
type ObjectData = Record<string, unknown>;
export type WizardField = 'operator' | 'edge' | 'commander' | 'policy';
export interface WizardValues { operator: string; edge: string; commander: string; policy: string }
export interface WizardSettings extends WizardValues { store: string; operatorId: string }
const fail = (): never => { throw new Error('Settings must use stable, regular private files and valid values.'); };
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

function checkDirectories(path: string): void {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { const s = lstatSync(current); if (!s.isDirectory() || s.isSymbolicLink()) fail(); }
    catch (e) { if (missing(e)) return; throw e; }
  }
}
function readPrivateObject(path: string): ObjectData {
  checkDirectories(dirname(path));
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (missing(e)) return {}; return fail(); }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_CONFIG)) fail();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino) fail();
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail();
    return data as ObjectData;
  } catch { return fail(); } finally { closeSync(fd); }
}
function privateDirectory(path: string): void {
  checkDirectories(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { if (!fstatSync(fd).isDirectory()) fail(); fchmodSync(fd, 0o700); } finally { closeSync(fd); }
}
function serializePrivateObject(data: ObjectData): string {
  const body = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(body) > MAX_CONFIG) fail();
  return body;
}
function replacePrivateObject(path: string, body: string): void {
  privateDirectory(dirname(path));
  // Refuse a linked/nonregular target even though rename itself would replace it.
  readPrivateObject(path);
  const temp = join(dirname(path), `.wizard-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd, 0o600); writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    checkDirectories(dirname(path)); readPrivateObject(path); renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch (e) { if (!missing(e)) throw e; } }
}
export const wizardConfigPaths = (cwd = process.cwd()) => ({
  overlay: join(overlayDirectory(), 'config.json'),
  // Explicit policy override wins; otherwise settings apply to the caller project.
  policy: policyPath(process.env.TIMMY_POLICY_DIR ?? cwd),
});
const value = (overlay: unknown, env: string | undefined, fallback = ''): string => {
  const v = typeof overlay === 'string' && overlay.trim() && !/^<[a-z-]+>$/.test(overlay.trim()) ? overlay : env || fallback;
  if (unsafeText.test(v) || v.length > 4096) fail();
  return v.trim();
};
export function validateWizardValue(field: WizardField, input: string): string {
  if (unsafeText.test(input) || input.length > 256) fail();
  const v = input.trim();
  if (field === 'operator' && (!v || v.length > 128)) fail();
  if (field === 'edge' && v) {
    const u = new URL(`https://${v}`);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || u.host !== v || !u.hostname) fail();
  }
  if (field === 'commander' && v) {
    const u = new URL(v);
    if (!['ws:', 'wss:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash) fail();
  }
  if (field === 'policy' && v && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v)) fail();
  return v;
}
export function loadWizardSettings(cwd = process.cwd()): WizardSettings {
  const paths = wizardConfigPaths(cwd), overlay = readPrivateObject(paths.overlay), policy = readPrivateObject(paths.policy);
  // Match the existing receipt-store resolver, checking pins before it reads them.
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    checkDirectories(join(dir, '.timmy'));
    const pin = join(dir, '.timmy', 'store-pin');
    try { const s = lstatSync(pin); if (!s.isFile() || s.isSymbolicLink() || s.size > 4096) fail(); } catch (e) { if (!missing(e)) throw e; }
    if (dirname(dir) === dir) break;
  }
  for (const key of ['operator_label', 'operator_id', 'edge_host', 'commander_ws']) if (overlay[key] !== undefined && typeof overlay[key] !== 'string') fail();
  if (policy.default !== undefined && policy.default !== null && typeof policy.default !== 'string') fail();
  const result = {
    store: value(receiptsDir(resolve(cwd)), undefined),
    operator: value(overlay.operator_label, process.env.TIMMY_OPERATOR_LABEL, 'operator'),
    operatorId: value(overlay.operator_id, process.env.TIMMY_OPERATOR_ID, 'unknown'),
    edge: value(overlay.edge_host, process.env.TIMMY_EDGE_HOST),
    commander: value(overlay.commander_ws, process.env.TIMMY_COMMANDER_WS),
    policy: value(policy.default, undefined),
  };
  for (const field of ['operator', 'edge', 'commander', 'policy'] as const) validateWizardValue(field, result[field]);
  return result;
}
export function saveWizardSettings(values: WizardValues, cwd = process.cwd(), dry = false): { dry: boolean } {
  const checked = Object.fromEntries(Object.entries(values).map(([field, text]) => [field, validateWizardValue(field as WizardField, text)])) as unknown as WizardValues;
  const paths = wizardConfigPaths(cwd);
  // Fresh reads preserve unrelated fields changed after the screen was opened.
  const overlay = readPrivateObject(paths.overlay), policy = readPrivateObject(paths.policy);
  if (policy.scopes !== undefined && (!policy.scopes || typeof policy.scopes !== 'object' || Array.isArray(policy.scopes))) fail();
  if (dry || process.env.TIMMY_DEMO === '1' || process.env.TIMMY_WIZARD_DRY === '1') return { dry: true };
  // Preflight both serialized results before any mutation. Compact input can
  // fit the read bound while its expanded output exceeds the write bound.
  const overlayBody = serializePrivateObject({ ...overlay, operator_label: checked.operator, edge_host: checked.edge, commander_ws: checked.commander });
  const policyBody = serializePrivateObject({ ...policy, default: checked.policy || null, scopes: policy.scopes ?? {} });
  // Validate both destinations before the first write. Each file replacement is atomic;
  // the two settings files are not a cross-file transaction.
  privateDirectory(dirname(paths.policy));
  replacePrivateObject(paths.overlay, overlayBody);
  replacePrivateObject(paths.policy, policyBody);
  return { dry: false };
}
