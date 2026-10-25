/**
 * R6 (H142): how Timmy runs one of its own small programs in src/mcp/ as a command line (the FAKE fixture server, the wire
 * tap): built, it is the .js file beside this one (node runs it); from a source checkout, the .ts file beside this one, run
 * through tsx's loader (Timmy's own dev dependency), as src/connectors/mcp-cli.ts runs the SDK route's mcp-sdk-cli. The
 * file is always the one of this same build or checkout, never another copy found elsewhere.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE_FILE = fileURLToPath(import.meta.url);
const HERE = dirname(HERE_FILE);

/** tsx's loader, found from this folder up (a source checkout's node_modules). */
function tsxLoader(): string | null {
  for (let d = HERE; ; d = dirname(d)) {
    const loader = join(d, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    if (existsSync(loader)) return loader;
    if (dirname(d) === d) return null;
  }
}

export type OwnScript = { ok: true; file: string; argv: string[]; built: boolean } | { ok: false; why: string };

/**
 * One of src/mcp's programs as the argv that runs it: [node, file] when built, [node, --import, tsx's loader, file] from
 * source. `program` is the first word: `node` (found on PATH, as a person types it; the route's child gets PATH), or this
 * process's own executable when asked for.
 */
export function ownScript(name: string, o: { program?: 'node' | 'exec' } = {}): OwnScript {
  const ext = extname(HERE_FILE) === '.ts' ? '.ts' : '.js';
  const file = join(HERE, `${name}${ext}`);
  if (!existsSync(file)) return { ok: false, why: `${name}${ext} is not part of this installation` };
  const node = o.program === 'exec' ? process.execPath : 'node';
  if (ext === '.js') return { ok: true, file, argv: [node, file], built: true };
  const loader = tsxLoader();
  if (!loader) return { ok: false, why: `${name}.ts is here, but it is not built and tsx is not installed to run it from source (npm run build)` };
  return { ok: true, file, argv: [node, '--import', pathToFileURL(loader).href, file], built: false };
}
