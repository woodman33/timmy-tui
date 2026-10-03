// hub-content-sync report: verify sync + record stats.
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { writeFileSync } from 'fs';

const [,, outDir, stem] = process.argv;
if (!outDir || !stem) { console.log(JSON.stringify({ok:false,error:'Usage: report.mjs <outDir> <stem>'})); process.exit(1); }

const manifestPath = join(outDir, `${stem}.hub.manifest.json`);
let sync_ok = false;
let pack_count = 0;
let note = '';

if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    sync_ok = manifest.ok === true;
    pack_count = Array.isArray(manifest.installed_content) ? manifest.installed_content.length : 0;
    note = manifest.note ?? '';
  } catch { note = 'Failed to parse manifest'; }
} else {
  note = 'Manifest not found';
}

const report = { ok: sync_ok, sync_ok, pack_count, note: note || undefined };
writeFileSync(join(outDir, `${stem}.hub.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
