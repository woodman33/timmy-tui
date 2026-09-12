import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { formatVolumeReport, inspectVolume, validateVolumeCells, validateVolumeManifest, VolumeValidationError, type VolumeVec3 } from './volume.js';

const HELP = [
  'timmy vision spatial volume inspect <manifest.json> [--cell i,j,k] [--json]',
  'Read-only bounded-volume inspection. Local artifact bytes are checked against the manifest.',
  'Does not run OpenVDB, contact providers, change material assignments, or write receipts.',
].join('\n');
function boundedRead(file: string, max: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > max) throw new VolumeValidationError('invalid_file_size', 'A source file exceeds the finite inspection limit or is not a regular file.');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (n === 0) break; length += n; }
    if (length !== stat.size) throw new VolumeValidationError('file_changed', 'A source file changed while being read.');
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function parse(bytes: Buffer): unknown { try { return JSON.parse(bytes.toString('utf8')); } catch { throw new VolumeValidationError('invalid_json', 'A volume source is not valid JSON.'); } }
/** Verifies local bytes only. A matching native artifact is not a native OpenVDB read. */
export function readVolumePackage(manifestPath: string, address?: VolumeVec3) {
  const canonicalManifest = realpathSync(resolve(manifestPath)), directory = dirname(canonicalManifest);
  const manifestBytes = boundedRead(canonicalManifest, 1024 * 1024), manifest = validateVolumeManifest(parse(manifestBytes));
  const verified: Record<string, { sha256: string; bytes: number }> = {};
  let cellBytes: Buffer | undefined;
  for (const name of ['cells', 'native', 'mesh', 'obj', 'roundtrip'] as const) {
    const expected = manifest.artifacts[name];
    if (!expected) continue;
    const path = realpathSync(resolve(directory, expected.path)), rel = relative(directory, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new VolumeValidationError('artifact_escape', 'An artifact resolves outside the manifest directory.');
    const bytes = boundedRead(path, name === 'cells' ? 64 * 1024 * 1024 : 256 * 1024 * 1024);
    if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw new VolumeValidationError('artifact_mismatch', 'An artifact does not match its declared byte length and SHA-256.');
    verified[name] = { sha256: expected.sha256, bytes: bytes.length };
    if (name === 'cells') cellBytes = bytes;
  }
  const cells = validateVolumeCells(parse(cellBytes!), manifest), report = inspectVolume(manifest, cells, address);
  report.scope.artifactVerification = 'sha256-bytes-checked';
  return { ...report, verification: { manifestSha256: digest(manifestBytes), artifacts: verified, producerAuthenticated: false, nativeArtifactParsed: false } };
}
export async function runVolumeCli(args: string[], out: (text: string) => void = console.log): Promise<number> {
  if (!args.length || args[0] === '--help' || args[0] === '-h' || (args[0] === 'inspect' && args.length === 2 && ['--help', '-h'].includes(args[1]))) { out(HELP); return 0; }
  if (args[0] !== 'inspect' || !args[1] || args[1].startsWith('-')) { out(HELP); return 2; }
  let address: VolumeVec3 | undefined, json = false;
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key) || !['--cell', '--json'].includes(key)) { out('Unknown or duplicate volume option.'); return 2; }
    seen.add(key);
    if (key === '--json') json = true;
    else {
      const value = args[++i];
      if (!value || !/^\d+,\d+,\d+$/u.test(value)) { out('Cell must contain three nonnegative integer indices: i,j,k.'); return 2; }
      address = value.split(',').map(Number) as VolumeVec3;
      if (address.some(n => !Number.isSafeInteger(n))) { out('Cell indices exceed the supported range.'); return 2; }
    }
  }
  try { const report = readVolumePackage(args[1], address); out(json ? JSON.stringify(report, null, 2) : formatVolumeReport(report)); return 0; }
  catch (error) {
    const code = error instanceof VolumeValidationError ? error.code : 'volume_read_error';
    const note = error instanceof VolumeValidationError ? error.message : 'The volume package could not be read. Check its local manifest and artifacts.';
    out(JSON.stringify({ ok: false, code, note })); return 1;
  }
}
