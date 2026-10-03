// iClone 8 · render-still report: verify PNG + record timing.
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const [,, outDir, stem] = process.argv;
if (!outDir || !stem) { console.log(JSON.stringify({ok:false,error:'Usage: report.mjs <outDir> <stem>'})); process.exit(1); }

const pngPath = join(outDir, `${stem}.iclone.png`);
const configPath = join(outDir, `${stem}.config.json`);
const scenePath = join(outDir, `${stem}.scene.json`);

let render_ok = false;
let resolution = null;
let note = '';

if (!existsSync(pngPath)) {
  note = 'PNG not found';
} else {
  const buf = readFileSync(pngPath);
  const isPng = buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47;
  if (!isPng) { note = 'not a valid PNG header'; }
  else {
    render_ok = true;
    if (buf.length >= 24) {
      resolution = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    }
  }
}

let config = {};
if (existsSync(configPath)) { try { config = JSON.parse(readFileSync(configPath,'utf8')); } catch {} }

let scene = {};
if (existsSync(scenePath)) { try { scene = JSON.parse(readFileSync(scenePath,'utf8')); } catch {} }

const report = {
  ok: render_ok,
  render_ok,
  resolution: resolution ?? config.resolution ?? null,
  camera: config.camera ?? null,
  iclone_version: scene.version ?? null,
  product: scene.product ?? 'iClone',
  note: note || undefined,
};

const reportPath = join(outDir, `${stem}.iclone.json`);
import { writeFileSync } from 'fs';
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
