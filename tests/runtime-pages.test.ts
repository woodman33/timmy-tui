// R4 (H87): the files the browser companion and `timmy logs` serve beside their code ship in the package. r23 (the package
// built from b234164): the installed companion answered GET / with 404 and "ENOENT … dist/src/companion/client/index.html"
// (its path included), and GET /chat crashed `timmy logs` (no dist/src/utils/chatpage.html). tsc emits only TypeScript, and
// tsconfig excludes the companion's client folder; the build copies the rest from an allowlist (scripts/copy-runtime-assets.mjs).
// Each server names the files it reads (COMPANION_RUNTIME_FILES, LOGS_RUNTIME_FILES); this test keeps those lists, the
// servers' own code and the allowlist together, so a new page cannot be left out of the package.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUNTIME_ASSETS } from '../scripts/copy-runtime-assets.mjs';
import { COMPANION_RUNTIME_FILES } from '../src/companion/server.js';
import { LOGS_RUNTIME_FILES } from '../src/utils/logserver.js';

/** The page files a server's source names (an .html, .css, .js, .svg, image, font or wasm file), as written there; its module imports are code, not pages. */
function pageFilesNamedIn(source: string): string[] {
  const text = readFileSync(source, 'utf8').split('\n').filter((l) => !/^\s*import\b|\bfrom\s+['"]|\bimport\(/.test(l)).join('\n');
  const named = [...text.matchAll(/['"`](?:\.\/)?([\w.-]+\.(?:html|css|m?js|svg|png|ico|woff2?|wasm))['"`]/g)].map((m) => m[1]);
  return [...new Set(named)].sort();
}

describe('the pages the local servers serve ship in the package (R4 H87)', () => {
  it('every file the two servers list is a regular file here and in the build\'s allowlist', () => {
    for (const f of [...COMPANION_RUNTIME_FILES, ...LOGS_RUNTIME_FILES]) {
      expect(lstatSync(f).isFile(), f).toBe(true);
      expect(RUNTIME_ASSETS, f).toContain(f);
    }
  });

  it('the companion lists every file of its client folder (served as it is; tsc builds nothing there)', () => {
    const client = readdirSync('src/companion/client').map((f) => `src/companion/client/${f}`).sort();
    expect([...COMPANION_RUNTIME_FILES].sort()).toEqual(client);
  });

  it('each page file a server\'s code names is on that server\'s list', () => {
    const base = (f: string): string => f.slice(f.lastIndexOf('/') + 1);
    expect(pageFilesNamedIn('src/companion/server.ts')).toEqual(COMPANION_RUNTIME_FILES.map(base).sort());
    expect(pageFilesNamedIn('src/utils/logserver.ts')).toEqual(LOGS_RUNTIME_FILES.map(base).sort());
  });
});
