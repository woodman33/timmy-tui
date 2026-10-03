// CC5 · avatar-export report: verify FBX export + record stats.
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { writeFileSync } from 'fs';

const [,, outDir, stem] = process.argv;
if (!outDir || !stem) { console.log(JSON.stringify({ok:false,error:'Usage: report.mjs <outDir> <stem>'})); process.exit(1); }

const fbxPath = join(outDir, `${stem}.cc5.fbx`);
const loadedPath = join(outDir, `${stem}.loaded.json`);

let export_ok = false;
let file_size_bytes = 0;
let note = '';

if (!existsSync(fbxPath)) {
  note = 'FBX not found';
} else {
  const stat = statSync(fbxPath);
  file_size_bytes = stat.size;
  export_ok = file_size_bytes > 0;
  if (!export_ok) note = 'FBX is empty';
}

let loaded = {};
if (existsSync(loadedPath)) { try { loaded = JSON.parse(readFileSync(loadedPath,'utf8')); } catch {} }

const report = {
  ok: export_ok,
  export_ok,
  format: 'fbx',
  file_size_bytes,
  cc5_version: loaded.version ?? null,
  product: loaded.product ?? 'Character Creator',
  note: note || undefined,
};

const reportPath = join(outDir, `${stem}.cc5.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
