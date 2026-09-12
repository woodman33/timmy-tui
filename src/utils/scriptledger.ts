import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { appendReceipt, readChain } from './receipts.js';

// toolchain-e2a4 close: script ledger v0. A script draft carries a sidecar
// (<file>.ledger.json) recording its sha256 and every seal/cut/ledger action
// against it, so the ledger is in-repo and re-verifiable (DOCTRINE §14).
export const shaOfFile = (p: string): string =>
  'sha256_' + crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
export const sidecarPath = (file: string): string => `${file}.ledger.json`;

export interface Sidecar { file: string; sha256: string; seals: { ts: string; receipt: string; action: string }[] }

export function sealScript(file: string, dir?: string): { ok: boolean; note?: string; sidecar?: Sidecar; receipt?: string } {
  if (!existsSync(file)) return { ok: false, note: `missing script: ${file}` };
  const sha = shaOfFile(file);
  const rec = appendReceipt('runs', {
    kind: 'seal', subject: `script.seal · ${basename(file)} ${sha.slice(7, 15)}`, policy: 'human-gated', status: 'ok',
  }, dir);
  const sp = sidecarPath(file);
  const sc: Sidecar = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) as Sidecar : { file, sha256: sha, seals: [] };
  sc.sha256 = sha;
  sc.seals.push({ ts: rec.ts, receipt: rec.hash, action: 'seal' });
  writeFileSync(sp, JSON.stringify(sc, null, 2));
  return { ok: true, sidecar: sc, receipt: rec.hash };
}

const SLUG = /^(INT|EXT|EST|I\/E)\b/i;
const CHAR_CUE = /^[A-Z][A-Z .'-]+:$/;
export function cutScript(input: string, output: string, dir?: string): { ok: boolean; note?: string; scenes?: number } {
  if (!existsSync(input)) return { ok: false, note: `missing input: ${input}` };
  const lines = readFileSync(input, 'utf8').split('\n');
  const out: string[] = [];
  let scenes = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) { out.push(''); continue; }
    if (SLUG.test(t)) { out.push('', t.toUpperCase()); scenes++; continue; }
    if (t.startsWith('@')) { out.push('', t.slice(1).trim()); continue; } // forced action
    if (CHAR_CUE.test(t)) { out.push('', t); continue; }               // character cue → dialogue
    out.push(t);
  }
  // VO-only scripts (no slugs): one narrator cue carries the prose as dialogue
  if (scenes === 0 && out.some(l => l.trim())) {
    const body = out.join('\n').trim();
    out.length = 0;
    out.push('', 'TIMMY (V.O.):', ...body.split('\n').map(l => (l.trim() ? l.trim() : '')));
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
  appendReceipt('runs', {
    kind: 'run', subject: `script.cut · ${basename(input)} → ${basename(output)} · ${scenes} scenes`, policy: 'auto', status: 'ok',
  }, dir);
  return { ok: true, scenes };
}

export function ledgerTroff(file: string, dir?: string): { ok: boolean; note?: string; troff?: string; entries: number } {
  const sp = sidecarPath(file);
  const sc: Sidecar | null = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) as Sidecar : null;
  const chain = readChain('runs', dir);
  const bn = basename(file);
  const rows = chain.filter(r => String(r.subject).includes(bn) || (sc !== null && sc.seals.some(s => s.receipt === r.hash)));
  const troff = [
    '.TH TIMMY-LEDGER 1',
    '.SH NAME',
    `script ledger \\- ${bn}`,
    '.SH ENTRIES',
    ...rows.map(r => `.IP \\(bu 2\n${r.ts.slice(0, 19)} ${r.kind} ${r.subject} [${r.hash.slice(7, 15)}]`),
    '.SH SIDECAR',
    sc ? `sidecar ${sp} sha ${sc.sha256}` : 'no sidecar',
    '',
  ].join('\n');
  return { ok: true, troff, entries: rows.length };
}

// minimal single-font PDF writer (fallback when groff is absent, e.g. macOS)
function minimalPdf(lines: string[]): Buffer {
  const esc = (x: string): string => x.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = lines.slice(0, 60).map((l, i) => `BT /F1 9 Tf 40 ${780 - i * 12} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'binary');
}

export function ledgerPdf(troff: string, outPdf: string): { ok: boolean; note?: string; via?: string } {
  const r = spawnSync('groff', ['-man', '-Tpdf'], { input: troff, timeout: 30000 });
  let buf: Buffer | null = null;
  let via = 'groff';
  if (r.status === 0 && r.stdout?.length) buf = r.stdout;
  else { via = 'minimal-pdf-writer (groff absent)'; buf = minimalPdf(troff.split('\n').filter(l => !l.startsWith('.'))); }
  mkdirSync(dirname(outPdf), { recursive: true });
  writeFileSync(outPdf, buf);
  return { ok: true, via };
}

export function ledgerHtml(file: string, troff: string, outHtml: string): { ok: boolean } {
  const rows = troff.split('\n').filter(l => !l.startsWith('.')).map(l => `<p>${l.replace(/</g, '&lt;')}</p>`).join('\n');
  mkdirSync(dirname(outHtml), { recursive: true });
  writeFileSync(outHtml, `<!doctype html><meta charset="utf-8"><title>ledger ${basename(file)}</title><body>${rows}</body>\n`);
  return { ok: true };
}

export { join };
