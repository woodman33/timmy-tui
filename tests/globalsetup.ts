// v0.9.0 (friction log #1): keep src/version.ts in sync even under raw
// `npx vitest`, which bypasses npm's pretest hook.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.timmy/runs/timmy-events.jsonl');

export default function setup(): () => void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(__dirname, '../src/version.ts'),
    `// This file is generated automatically. Do not edit.\nexport const VERSION = '${pkg.version}';\n`,
    'utf8'
  );
  // ONE BUS (onebus-m5f2): the legacy event file must receive ZERO writes across
  // the full suite. Record its size now; fail the run if any test writes it.
  const before = fs.existsSync(LEGACY) ? fs.statSync(LEGACY).size : -1;
  return () => {
    const after = fs.existsSync(LEGACY) ? fs.statSync(LEGACY).size : -1;
    if (after !== before) {
      throw new Error(`ONE BUS violation: legacy timmy-events.jsonl grew ${before} -> ${after} during the suite`);
    }
  };
}
