import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  buildVolumeContextPack, readSealedContextPack, readSpatialBytes, resolveSpatialAuthority,
  sealContextPack, validateSpatialCamera, type SpatialArtifactSeal,
} from './context-pack.js';
import { proposeSpatialEdit, type SpatialEditRequest } from './edit-proposal.js';

const HELP = [
  'timmy vision spatial pack <manifest.json> --camera <camera.json> --out <directory> [--json]',
  'timmy vision spatial propose <pack.descriptor.json> --request <request.json> --out <directory> [--json]',
  'Paths are relative to the working directory, which is the local source authority root.',
  'Camera and request arguments name JSON files. Outputs include a separate signed descriptor.',
  'Proposals inspect current source bytes and retain a dry-run diff. They never edit the document.',
].join('\n');

export function spatialCliOutputDirectory(path: string, dir: string): string {
  const lexicalRoot = resolve(dir), root = realpathSync(dir), lexicalOutput = resolve(lexicalRoot, path), part = relative(lexicalRoot, lexicalOutput), output = resolve(root, part);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Evidence output must remain within the local source authority root.');
  let ancestor = output;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error('Evidence output must not traverse symlink directories.');
  mkdirSync(output, { recursive: true });
  if (realpathSync(output) !== output) throw new Error('Evidence output must not traverse symlink directories.');
  return lexicalOutput;
}

export function readSpatialPackDescriptor(path: string, dir: string): SpatialArtifactSeal {
  const raw: unknown = JSON.parse(readSpatialBytes(resolve(dir, path), 128 * 1024).toString('utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !['artifact', 'receipt'].includes(key)) ||
      !('artifact' in raw) || !('receipt' in raw)) throw new Error('Expected a full spatial descriptor containing artifact and receipt.');
  const seal = raw as SpatialArtifactSeal;
  readSealedContextPack(seal, dir);
  return seal;
}

/** Keep the signed payload unchanged: this sidecar contains the full seal. */
export function retainSpatialDescriptor(seal: SpatialArtifactSeal, dir: string): string {
  const artifact = resolveSpatialAuthority(dir, seal.artifact.path);
  const descriptor = artifact + '.descriptor.json';
  writeFileSync(descriptor, JSON.stringify({ artifact: seal.artifact, receipt: seal.receipt }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  return relative(realpathSync(dir), descriptor);
}

export async function runContextOrderCli(args: string[], out: (text: string) => void = console.log, dir = process.cwd()) {
  if (!args.length || args.includes('--help')) { out(HELP); return 0; }
  const operation = args[0], source = args[1];
  if (!['pack', 'propose'].includes(operation) || !source || source.startsWith('-')) { out(HELP); return 2; }
  const flags: Record<string, string | boolean> = {}, required = operation === 'pack' ? '--camera' : '--request';
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    if (![required, '--out', '--json'].includes(key) || key in flags) { out('Unknown or duplicate spatial context option.'); return 2; }
    if (key === '--json') flags[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) { out('Missing option value.'); return 2; } flags[key] = args[++i]; }
  }
  if (typeof flags[required] !== 'string' || typeof flags['--out'] !== 'string') { out(`Requires ${required} and --out.`); return 2; }
  try {
    const outputDir = spatialCliOutputDirectory(flags['--out'], dir), options = { outputDir, sourceRoot: dir, receiptDir: dir };
    const input: unknown = JSON.parse(readSpatialBytes(resolve(dir, flags[required] as string), 64 * 1024).toString('utf8'));
    if (operation === 'pack') {
      const pack = buildVolumeContextPack(resolve(dir, source), { camera: validateSpatialCamera(input), sourceRoot: dir });
      const seal = sealContextPack(pack, options), descriptorPath = retainSpatialDescriptor(seal, dir);
      out(JSON.stringify({ ok: true, descriptorPath, ...seal, scope: pack.scope }, null, 2)); return 0;
    }
    const packSeal = readSpatialPackDescriptor(source, dir);
    const request = input && typeof input === 'object' && !Array.isArray(input) && 'documentPath' in input && typeof input.documentPath === 'string'
      ? { ...input, documentPath: resolve(dir, input.documentPath) } : input;
    const proposed = proposeSpatialEdit(packSeal, request as SpatialEditRequest, options), descriptorPath = retainSpatialDescriptor(proposed, dir);
    out(JSON.stringify({ ok: proposed.result.status === 'proposed', descriptorPath, ...proposed }, null, 2));
    return proposed.result.status === 'proposed' ? 0 : 1;
  } catch (error) { out(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Spatial context operation failed.' })); return 1; }
}
