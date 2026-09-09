import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Assets stay in the package root in both source and dist/src builds. */
export function visionAsset(relativePath: string, dir = process.cwd()): string {
  const candidates = [resolve(dir, relativePath),
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url))];
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
