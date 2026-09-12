import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildProofLadder, validateProofManifest, type ProofLadderManifest } from './proof-ladder.js';
import { runVisionInspection } from './runtime.js';
import { visionHash, imageHash } from './store.js';
import { appendReceipt } from '../utils/receipts.js';

/** No inference by default. --run is deliberately separate from reading/exporting existing receipts. */
export async function runProofLadderCli(args: string[]) {
  const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes('--help')) {
    console.log('timmy vision proof-ladder --manifest PATH --output PATH [--run --spec PATH --allow-hosted-inference]'); return;
  }
  const manifestPath = flag('--manifest'), outputPath = flag('--output');
  if (!manifestPath || !outputPath) throw new Error('Provide a native frame manifest and report output path.');
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as ProofLadderManifest;
  validateProofManifest(manifest);
  if (args.includes('--run')) {
    const specPath = flag('--spec');
    if (!specPath) throw new Error('Provide the previously validated Houdini-specific Workflow with --spec.');
    const specification = JSON.parse(readFileSync(resolve(specPath), 'utf8')) as Record<string, unknown>;
    if (visionHash(specification) !== manifest.workflow.specificationSHA256) throw new Error('Workflow definition differs from the pinned manifest.');
    const origin = new URL(process.env.TIMMY_VISION_SERVER_URL ?? 'http://localhost:9001');
    const local = ['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
    if (!local && !args.includes('--allow-hosted-inference')) throw new Error('The configured endpoint is remote. Review its image destination and inference allowance, then use --allow-hosted-inference only for an authorized run.');
    // Verify every selected frame before any inspection starts.
    for (const frame of manifest.frames) if (!existsSync(frame.imagePath) || imageHash(readFileSync(frame.imagePath)) !== frame.imageSHA256) throw new Error(`Frame ${frame.frame} is missing or has changed.`);
    const current = buildProofLadder(manifest);
    for (const frame of manifest.frames) {
      if (current.frames.find(row => row.frame === frame.frame)?.state === 'observed') continue;
      const result = await runVisionInspection({ imagePath: frame.imagePath, specification, imageInput: 'image',
        templateId: 'houdini-native-proof-ladder', sourceId: `${manifest.project}:frame:${frame.frame}`,
        metadata: { houdini: { project: manifest.project, sceneSHA256: manifest.sceneSHA256, frame: frame.frame, fps: manifest.fps } } });
      if (!result.ok) { console.log(JSON.stringify({ frame: frame.frame, state: result.state, note: result.note })); break; }
    }
  }
  const report = buildProofLadder(manifest);
  const output = resolve(outputPath); mkdirSync(dirname(output), { recursive: true });
  const receipt = appendReceipt('runs', { kind: 'vision.proof_ladder', subject: `Houdini native proof ladder · ${manifest.project}`,
    policy: 'auto', status: 'ok', artifacts: [resolve(manifestPath), output],
    output_sha256: visionHash(report), sources: [{ scene_sha256: manifest.sceneSHA256, manifest_sha256: visionHash(manifest),
      inspection_receipts: report.frames.flatMap(frame => 'receiptHash' in frame ? [frame.receiptHash] : []) }] });
  const published = { ...report, exportReceiptHash: receipt.hash };
  writeFileSync(output, JSON.stringify(published, null, 2) + '\n');
  console.log(JSON.stringify({ state: report.state, output, receiptHash: receipt.hash,
    frames: report.frames.map(frame => ({ frame: frame.frame, state: frame.state })) }, null, 2));
}
