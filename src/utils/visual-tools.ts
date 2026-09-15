import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiptsDir } from './receipts.js';
import { receiptsToOtlp } from './otlp.js';
import { readStrictJsonFile } from './strict-json-file.js';
import { renderStudioComposition, type StudioComposition } from './studio-composition.js';
import { buildGaussianPlyContext, GaussianPlyError } from '../vision/spatial/gaussian-ply-context.js';
import { runIntegration } from '../vision/integrations/runner.js';
import { integrationCatalog } from '../vision/integrations/registry.js';
import { videoAvailability, renderVisualVideo } from './visual-video.js';
import { chafaExecutable, renderTerminalImage } from './terminal-image.js';

export type VisualOperation = 'camera-fit' | 'opensplat-inspect' | 'motion-html' | 'otlp-export' | 'mcap-roundtrip' | 'motion-mp4' | 'chafa-preview';
export interface VisualResult {
  toolId: VisualOperation;
  status: 'completed' | 'refused' | 'failed';
  summary: string;
  artifactPath?: string;
  artifactHash?: string;
  receiptId?: string;
  ansiPreview?: string;
}

export function visualToolsAvailability(dir = process.cwd()) {
  let camera = false, mcap = false;
  try { const catalog = integrationCatalog(dir); camera = !!catalog.find(x => x.id === 'camera-fit')?.installedAdapter; mcap = !!catalog.find(x => x.id === 'mcap')?.installedAdapter; } catch { /* Invalid runtime configuration stays unavailable. */ }
  const dmux = (process.env.PATH ?? '').split(':').filter(Boolean).some(p => existsSync(join(p, 'dmux')));
  return {
    'camera-fit': camera ? 'available' : 'unavailable',
    'opensplat-inspect': 'available', 'motion-html': 'available', 'otlp-export': 'available',
    'mcap-roundtrip': mcap ? 'available' : 'unavailable',
    'motion-mp4': videoAvailability().available ? 'available' : 'unavailable',
    'chafa-preview': chafaExecutable() ? 'available' : 'unavailable',
    dmux: dmux ? 'available' : 'not-installed',
  } as const;
}

export function visualToolsSetup(): Partial<Record<VisualOperation, string>> {
  return {
    'camera-fit': 'Set TIMMY_VISUAL_PYTHON to an existing Python with NumPy and OpenCV.',
    'mcap-roundtrip': 'Set TIMMY_TELEMETRY_PYTHON to an existing Python with mcap, zstandard and jsonschema.',
    'motion-mp4': videoAvailability().reason,
    'chafa-preview': 'Set TIMMY_CHAFA_BIN to an existing Chafa executable, or add it to PATH.',
  };
}

/** Resolve shipped examples independently of the working directory. Never starts a tool. */
export function visualToolExamples(): Partial<Record<VisualOperation, string>> {
  const files = { 'camera-fit': 'camera-fit.json', 'opensplat-inspect': 'parameters.ply',
    'motion-html': 'storyboard.json', 'motion-mp4': 'storyboard.json', 'mcap-roundtrip': 'simulation.json', 'chafa-preview': 'preview.png' };
  return Object.fromEntries(Object.entries(files).map(([id, name]) => {
    const candidates = ['../../', '../../../'].map(prefix => fileURLToPath(new URL(`${prefix}examples/visual-tools/${name}`, import.meta.url)));
    return [id, candidates.find(existsSync) ?? candidates[0]];
  }));
}

function composition(value: unknown): StudioComposition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('composition');
  const v = value as StudioComposition;
  if (typeof v.id !== 'string' || v.id.length > 128 || typeof v.title !== 'string' || v.title.length > 200
    || !Number.isFinite(v.duration) || v.duration <= 0 || v.duration > 300
    || !Array.isArray(v.beats) || v.beats.length < 1 || v.beats.length > 32
    || v.beats.some(b => !b || typeof b.label !== 'string' || b.label.length > 100 || typeof b.text !== 'string' || b.text.length > 2000)
    || (v.width !== undefined && (!Number.isInteger(v.width) || v.width < 1 || v.width > 3840))
    || (v.height !== undefined && (!Number.isInteger(v.height) || v.height < 1 || v.height > 2160))) throw new Error('composition');
  return v;
}

/** Fixed local operations. Native adapter/video execution writes receipts; simple exports are unsealed.
 * No model, provider fallback, subprocess command from user text, or new job database.
 */
export async function runVisualTool(toolId: VisualOperation, inputPath?: string, dir = process.cwd()): Promise<VisualResult> {
  const refuse = (summary: string): VisualResult => ({ toolId, status: 'refused', summary });
  if (!['camera-fit', 'opensplat-inspect', 'motion-html', 'otlp-export', 'mcap-roundtrip', 'motion-mp4', 'chafa-preview'].includes(toolId)) return refuse('Unknown visual operation.');
  if (toolId !== 'otlp-export' && !inputPath?.trim()) return refuse('Choose a local input file first.');
  const path = inputPath ? resolve(dir, inputPath.trim()) : '';
  let body: string, filename: string, summary: string;
  let nativeInvoked = false;
  try {
    if (toolId === 'chafa-preview') return { toolId, ...await renderTerminalImage(path, dir) };
    if (toolId === 'motion-mp4') {
      const storyboard = composition(await readStrictJsonFile(path));
      nativeInvoked = true;
      return { toolId, ...await renderVisualVideo(storyboard, dir) };
    }
    if (toolId === 'mcap-roundtrip') {
      nativeInvoked = true;
      const r = await runIntegration('mcap', { operation: 'export', input: path }, dir);
      return { toolId, status: r.ok ? 'completed' : 'failed', artifactPath: r.reportPath, receiptId: r.receiptId,
        summary: r.ok ? 'MCAP + CSV saved beside report. Payload and simulation time replayed exactly; missing penetration stays unknown.'
          : 'MCAP conversion failed. Retained report explains the failure.' };
    }
    if (toolId === 'camera-fit') {
      const request = await readStrictJsonFile(path) as { operation?: unknown };
      if (request?.operation !== 'fit') return refuse('Camera alignment requires operation: fit. Use the CLI for a runtime probe.');
      nativeInvoked = true;
      const r = await runIntegration('camera-fit', request, dir);
      return { toolId, status: r.ok ? 'completed' : 'failed',
        summary: r.ok ? 'Camera proposal computed; inspect fit and held-out residuals. Geometry is not certified.' : 'Camera adapter failed. Retained report explains the failure.',
        artifactPath: r.reportPath, receiptId: r.receiptId };
    }
    if (toolId === 'opensplat-inspect') {
      const context = buildGaussianPlyContext(path);
      body = JSON.stringify(context, null, 2) + '\n'; filename = 'gaussian-context.json';
      const count = context.facts.find(f => f.key === 'vertexCount')?.value;
      summary = `${count} Gaussian rows inspected. Center bounds only; units, interiors and solid fill unknown. Export is unsealed.`;
    } else if (toolId === 'motion-html') {
      body = renderStudioComposition(composition(await readStrictJsonFile(path))); filename = 'index.html';
      summary = 'Seekable HTML created. No video rendered; no receipt sealed.';
    } else {
      body = JSON.stringify(receiptsToOtlp(undefined, dir), null, 2) + '\n'; filename = 'receipt-events.otlp.json';
      summary = 'Metadata-only receipt events exported locally. No telemetry sent; export is unsealed.';
    }
  } catch (error) {
    if (nativeInvoked) return { toolId, status: 'failed', summary: 'Operation failed; it may have run before its result could be saved.' };
    return refuse(error instanceof GaussianPlyError ? error.message : 'Input or runtime refused. Check file format, bounds and runtime configuration; no successful result claimed.');
  }
  try {
    const out = resolve(receiptsDir(dir), 'visual-tools', randomUUID());
    await mkdir(out, { recursive: true, mode: 0o700 });
    const artifactPath = join(out, filename);
    await writeFile(artifactPath, body, { flag: 'wx', mode: 0o600 });
    return { toolId, status: 'completed', summary, artifactPath,
      artifactHash: createHash('sha256').update(body).digest('hex') };
  } catch {
    return { toolId, status: 'failed', summary: 'Could not retain the export. No successful result claimed.' };
  }
}
