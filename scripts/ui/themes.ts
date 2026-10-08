// Writes Timmy Night and Day terminal themes to assets/themes:  npx tsx scripts/ui/themes.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { themeFiles } from '../../src/term/theme-files.js';

for (const [path, content] of Object.entries(themeFiles())) {
  const out = join('assets/themes', path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
  console.log(out);
}
