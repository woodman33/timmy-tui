// The `.env` parser, without side effects. ./config.ts loads the variables into the environment at start;
// ./model-key.ts reads them so the doctor looks where the REPL looks (the review of ledger row 99).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The variables a `.env` text sets, the first of each, with the quoting and `export` rules config.ts always had. */
export function parseDotEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.hasOwn(vars, key)) vars[key] = value;
  }
  return vars;
}

/** The variables of the `.env` in `dir`, or none when it is missing or unreadable. */
export function readDotEnv(dir: string = process.cwd()): Record<string, string> {
  try {
    const file = resolve(dir, '.env');
    return existsSync(file) ? parseDotEnv(readFileSync(file, 'utf-8')) : {};
  } catch {
    return {};
  }
}
