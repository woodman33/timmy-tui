import { spawn } from 'node:child_process';
import { constants, accessSync, statSync } from 'node:fs';
import { open, mkdir, writeFile, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { receiptsDir } from './receipts.js';

const MAX_INPUT = 8 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function chafaExecutable(): string | null {
  const explicit = process.env.TIMMY_CHAFA_BIN;
  const candidates = explicit ? [explicit] : (process.env.PATH ?? '').split(':').filter(isAbsolute).map(p => join(p, 'chafa'));
  for (const path of candidates) {
    try { if (isAbsolute(path) && statSync(path).isFile()) { accessSync(path, constants.X_OK); return path; } } catch { /* unavailable */ }
  }
  return null;
}

// Chafa is constrained to block/border/space symbols. ASCII and the known
// narrow drawing ranges count as one; all other codepoints conservatively
// count as two columns (including combining marks). This can refuse unusual
// valid text but does not undercount wide/supplementary glyphs.
const SINGLE_COLUMN = /^[\x20-\x7e\u2500-\u259f\u{1fb00}-\u{1fbff}]$/u;
const previewColumnUpperBound = (line: string) => [...line].reduce((n, char) => n + (SINGLE_COLUMN.test(char) ? 1 : 2), 0);

/** Only SGR color escapes are admitted inside Ink; no cursor, clipboard or title controls. */
export function checkedTerminalPreview(raw: string): string {
  const plain = raw.replace(/\x1b\[[0-9;]*m/g, '');
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(plain)) throw new Error('terminal_control');
  const lines = plain.replace(/\n$/, '').split('\n');
  if (!plain.trim() || lines.length > 10 || lines.some(line => previewColumnUpperBound(line) > 64)) throw new Error('terminal_dimensions');
  return raw.replace(/\n$/, '');
}

async function snapshot(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 33n || before.size > BigInt(MAX_INPUT)) throw new Error('png_size');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const r = await file.read(bytes, length, bytes.length - length, null);
      if (!r.bytesRead) break;
      length += r.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('input_changed');
    const named = await lstat(path, { bigint: true });
    if (!named.isFile() || named.dev !== after.dev || named.ino !== after.ino) throw new Error('input_changed');
    const data = bytes.subarray(0, length);
    if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.readUInt32BE(8) !== 13 || data.toString('ascii',12,16) !== 'IHDR') throw new Error('png_required');
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000) throw new Error('png_dimensions');
    return { data, width, height, dev: after.dev, ino: after.ino };
  } finally { await file.close(); }
}

export interface TerminalImageResult {
  status: 'completed' | 'refused' | 'failed'; summary: string;
  artifactPath?: string; artifactHash?: string; ansiPreview?: string;
}

/** Finite local PNG conversion. Native work is asynchronous; this is an unsealed display export. */
export async function renderTerminalImage(path: string, dir = process.cwd()): Promise<TerminalImageResult> {
  const executable = chafaExecutable();
  if (!executable) return { status: 'refused', summary: 'Chafa is unavailable. Set TIMMY_CHAFA_BIN to an existing executable.' };
  let input: Awaited<ReturnType<typeof snapshot>>;
  try { input = await snapshot(resolve(dir, path)); }
  catch { return { status: 'refused', summary: 'Choose a stable, regular PNG: at most 8 MiB, 4096 pixels per side and 8 million pixels.' }; }
  const out = resolve(receiptsDir(dir), 'visual-tools', randomUUID());
  try {
    await mkdir(out, { recursive: true, mode: 0o700 });
    const source = join(out, 'source.png');
    await writeFile(source, input.data, { flag: 'wx', mode: 0o600 });
    const sourceIdentity = await snapshot(source);
    const args = ['--format=symbols', '--symbols=block+border+space-wide', '--colors=full', '--animate=off', '--probe=off',
      '--size=64x10', '--view-size=64x10', '--optimize=0', '--relative=off', '--polite=on', '--threads=2', '--work=3', '--', source];
    const started = Date.now();
    const result = await new Promise<{code: number | null; stdout: Buffer; stderr: Buffer; failure: string | null}>(done => {
      let child: ReturnType<typeof spawn> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let count = 0, settled = false;
      const finish = (code: number | null, failure: string | null) => {
        if (settled) return;
        settled = true; // Guard before killing: termination may synchronously emit more events.
        clearTimeout(timer);
        if (failure && child) {
          if (child.pid !== undefined && child.pid > 0) {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
          }
          child.stdout?.destroy(); child.stderr?.destroy();
        }
        done({ code, failure, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      };
      const collect = (chunk: Buffer, target: Buffer[]) => {
        if (settled) return;
        // Retain the exact bounded prefix, including the portion of the chunk
        // that crosses the limit. Never normalize decoder failures into UTF-8.
        const available = MAX_OUTPUT - count;
        if (available > 0) target.push(Buffer.from(chunk.subarray(0, available)));
        count += Math.min(chunk.length, available);
        if (chunk.length > available) finish(null, 'output_limit');
      };
      try {
        child = spawn(executable, args, { shell: false, detached: process.platform !== 'win32',
          env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, stdio: ['ignore', 'pipe', 'pipe'] });
        timer = setTimeout(() => finish(null, 'timeout'), 5000);
        child.stdout!.on('data', c => collect(c, stdout)); child.stderr!.on('data', c => collect(c, stderr));
        // Keep an error listener after settlement so a late error cannot become uncaught.
        child.on('error', () => finish(null, 'spawn_error'));
        child.once('close', code => finish(code, null));
      } catch { finish(null, 'spawn_error'); }
    });
    await writeFile(join(out, 'raw.ansi'), result.stdout, { flag: 'wx', mode: 0o600 });
    await writeFile(join(out, 'stderr.txt'), result.stderr, { flag: 'wx', mode: 0o600 });
    let sourceVerified = false;
    try {
      const retained = await snapshot(source);
      sourceVerified = retained.dev === sourceIdentity.dev && retained.ino === sourceIdentity.ino && retained.data.equals(input.data);
    } catch { /* Missing, linked, unstable or non-PNG source cannot support completion. */ }
    // Preserve the preimage separately; never overwrite the renderer's changed file.
    const originalInput = sourceVerified ? null : `original-input-${randomUUID()}.png`;
    if (originalInput) await writeFile(join(out, originalInput), input.data, { flag: 'wx', mode: 0o600 });
    let failure = result.failure ?? (result.code !== 0 ? 'renderer_exit' : null), ansiPreview: string | undefined;
    if (!sourceVerified && !failure) failure = 'source_changed';
    if (!failure) { try { ansiPreview = checkedTerminalPreview(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)); } catch { failure = 'unsafe_or_oversized_preview'; } }
    const body = JSON.stringify({ schema: 'timmy.terminal-image/1', status: failure ? 'failed' : 'completed',
      source: { sha256: sourceVerified ? sha(input.data) : null, input_sha256: sha(input.data),
        integrity: sourceVerified ? 'verified' : 'changed_or_unavailable', original_input: originalInput, width: input.width, height: input.height },
      command: { executable, args }, exit_code: result.code, failure, elapsed_ms: Date.now() - started,
      preview_sha256: sha(result.stdout), stderr_sha256: sha(result.stderr),
      limits: { format: 'PNG', animation: 'single still', columns: 64, rows: 10, model_calls: 0,
        geometry_verified: false, receipt_sealed: false, terminal_controls: 'SGR only' } }, null, 2) + '\n';
    const artifactPath = join(out, 'preview.json'); await writeFile(artifactPath, body, { flag: 'wx', mode: 0o600 });
    return { status: failure ? 'failed' : 'completed', artifactPath, artifactHash: sha(body), ...(ansiPreview ? { ansiPreview } : {}),
      summary: failure ? 'Terminal preview failed; raw output and report retained.' : 'PNG preview rendered locally. Display approximation only; export is unsealed.' };
  } catch { return { status: 'failed', summary: 'Preview could not complete or retain its result.' }; }
}
