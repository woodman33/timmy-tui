import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { packageRoot, packagedPath } from '../utils/asset-dirs.js';

/** Executable assets come from Timmy's own module/package, never the project. */
export function visionAsset(relativePath: string, dir = process.cwd()): string {
  const root = packageRoot(import.meta.url);
  const packaged = packagedPath(relativePath, import.meta.url);
  if (packaged) return packaged;
  const trusted = root ? resolve(root, relativePath)
    : fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
  // Project files may be untrusted input. A same-named project script must not
  // receive the server's Python environment or Roboflow credentials.
  if (relativePath.startsWith('scripts/')) return trusted;
  // Keep the existing static-view fallback, after package/module assets only.
  const candidates = [trusted,
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), resolve(dir, relativePath)];
  return candidates.find(existsSync) ?? candidates[0];
}

/** Private configuration is server-only. Explicit process environment wins. */
export function loadVisionEnvironment(dir = process.cwd()): void {
  const path = resolve(dir, '.timmy/vision.env');
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if ((key.startsWith('TIMMY_VISION_') || ['ROBOFLOW_API_KEY', 'ROBOFLOW_WORKSPACE'].includes(key)) && value && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
