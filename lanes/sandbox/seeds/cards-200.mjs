#!/usr/bin/env node
// Seed cards-200: render N synthetic trading-card images with full per-row
// provenance (generator version, seed, every parameter, the SVG sha, the PNG sha)
// so the observer can auto-label them and the dataset row can say exactly where
// each pixel came from. No model, no network: SVG → PNG through sharp.
//   node lanes/sandbox/seeds/cards-200.mjs [--n 200] [--seed 11] [--out out/cards]
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
// sharp lives in vault-custody's dependency tree; the repo root may not have it
let sharp = null; let sharpVersion = 'unknown';
for (const base of [join(ROOT, 'vault-custody', 'package.json'), join(ROOT, 'package.json')]) {
  try { const req = createRequire(base); sharp = req('sharp'); sharpVersion = req('sharp/package.json').version; break; } catch { /* next */ }
}
if (!sharp) { console.error('sharp not installed under vault-custody/ or the repo root (npm ci --prefix vault-custody)'); process.exit(2); }
const require = createRequire(join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(flag('--n', 200));
const SEED = Number(flag('--seed', 11));
const OUT = resolve(flag('--out', join(ROOT, 'out', 'cards')));
const GENERATOR = 'cards-200/0.1';

let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sha = (b) => createHash('sha256').update(b).digest('hex');

const SETS = ['Harbor', 'Kestrel', 'Custody', 'Phosphor', 'Ledger', 'Paradise', 'Bridge', 'Seam'];
const FIRST = ['Mara', 'Teo', 'Ilse', 'Wren', 'Ada', 'Kofi', 'Nia', 'Ravi', 'Sol', 'Yuki', 'Ines', 'Bo'];
const LAST = ['Vance', 'Okonkwo', 'Brandt', 'Hale', 'Serra', 'Quist', 'Marsh', 'Delacroix', 'Ng', 'Fenn'];
const ROLES = ['Captain', 'Quartermaster', 'Pilot', 'Stowaway', 'Harbour Master', 'Buyer', 'Sealer', 'Courier'];
const RARITY = [['common', '#8FA3BF'], ['uncommon', '#33FF66'], ['rare', '#FF8C1A'], ['legendary', '#FFD166']];
const BG = ['#0A1628', '#101F38', '#0F2A2A', '#1A1230', '#1F2A0F'];
const escape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function cardSvg(p) {
  const w = 480, h = 672;
  const rect = (x, y, rw, rh, fill, rx = 8) => `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" rx="${rx}" fill="${fill}"/>`;
  const shapes = [];
  for (let i = 0; i < p.art.shapes; i++) { const cx = 60 + rnd() * 360, cy = 120 + rnd() * 260, r = 12 + rnd() * 60; shapes.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${pick(['#33FF66', '#FF8C1A', '#8FA3BF', '#FFD166', '#F4F1EA'])}" opacity="${(0.25 + rnd() * 0.6).toFixed(2)}"/>`); }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${rect(0, 0, w, h, p.bg, 24)}
${rect(18, 18, w - 36, h - 36, 'none')}
<rect x="18" y="18" width="${w - 36}" height="${h - 36}" rx="18" fill="none" stroke="${p.rarity[1]}" stroke-width="${p.border}"/>
${rect(36, 100, w - 72, 300, '#000000', 12)}
${shapes.join('\n')}
<text x="40" y="70" font-family="Space Grotesk, Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#F4F1EA">${escape(p.name)}</text>
<text x="${w - 40}" y="70" text-anchor="end" font-family="JetBrains Mono, Menlo, monospace" font-size="20" fill="${p.rarity[1]}">${p.number}/${p.setSize}</text>
<text x="40" y="440" font-family="Space Grotesk, Helvetica, Arial, sans-serif" font-size="22" fill="#F4F1EA">${escape(p.role)}</text>
<text x="40" y="475" font-family="JetBrains Mono, Menlo, monospace" font-size="16" fill="#8FA3BF">${escape(p.set)} · ${p.year} · ${p.rarity[0]}</text>
<text x="40" y="520" font-family="Space Grotesk, Helvetica, Arial, sans-serif" font-size="15" fill="#C9D3E0">${escape(p.line)}</text>
<text x="40" y="${h - 36}" font-family="JetBrains Mono, Menlo, monospace" font-size="13" fill="#8FA3BF">${p.serial}</text>
</svg>`;
}

mkdirSync(OUT, { recursive: true });
const rows = [];
const started = Date.now();
for (let i = 0; i < N; i++) {
  const p = {
    index: i, name: `${pick(FIRST)} ${pick(LAST)}`, role: pick(ROLES), set: pick(SETS), year: 2024 + Math.floor(rnd() * 3), number: 1 + Math.floor(rnd() * 120), setSize: 120,
    rarity: pick(RARITY), bg: pick(BG), border: 2 + Math.floor(rnd() * 5), art: { shapes: 3 + Math.floor(rnd() * 9) }, line: pick(['Tap to verify.', 'Every handover is a tap.', 'Sealed across the seam.', 'The loop tells the truth.', 'Receipts, not promises.']),
    serial: `VC${String(1000 + Math.floor(rnd() * 9000))}-${String(i).padStart(3, '0')}`
  };
  const svg = cardSvg(p);
  const svgSha = sha(svg);
  const file = `card-${String(i).padStart(3, '0')}.png`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(join(OUT, file), png);
  rows.push({ v: 'synthetic-v0', generator: GENERATOR, seed: SEED, index: i, file, png_sha256: sha(png), svg_sha256: svgSha, width: 480, height: 672, labels: { name: p.name, role: p.role, set: p.set, year: p.year, number: `${p.number}/${p.setSize}`, rarity: p.rarity[0], serial: p.serial, line: p.line }, params: { bg: p.bg, border: p.border, shapes: p.art.shapes, rarity_color: p.rarity[1] }, provenance: { made_by: 'lanes/sandbox/seeds/cards-200.mjs', renderer: `sharp ${sharpVersion}`, prng: 'mulberry32', ts: new Date().toISOString() } });
}
writeFileSync(join(OUT, 'provenance.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const manifest = rows.map((r) => `${r.png_sha256} ${r.file}`).join('\n');
writeFileSync(join(OUT, 'MANIFEST'), manifest + '\n');
console.log(JSON.stringify({ out: OUT, n: rows.length, generator: GENERATOR, seed: SEED, manifest_sha256: sha(manifest), ms: Date.now() - started }, null, 1));
