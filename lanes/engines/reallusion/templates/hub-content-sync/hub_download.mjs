// hub_download.mjs — Download selected content pack (placeholder).
import { writeFileSync } from 'fs';
import { join } from 'path';

const [,, outDir, stem] = process.argv;
if (!outDir || !stem) { console.log(JSON.stringify({ok:false,error:'Usage: hub_download.mjs <outDir> <stem>'})); process.exit(1); }

const result = {
  ok: true,
  note: "Download step is a placeholder. Implement when Hub API endpoint is discovered.",
  downloaded_packs: [],
};

writeFileSync(join(outDir, `${stem}.download.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
