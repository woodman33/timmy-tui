/**
 * Pi Durable, slice S1 (R4 H118): the exact versions the worker runs with (plan a.6). The worker reads each installed
 * package's own package.json before it loads any of them, and refuses to start when one differs, naming the package and
 * both versions. A bump is a change of its own: the pins here, workers/pi-durable/package.json and its lockfile move
 * together, and the fixture suite runs again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PINS: Readonly<Record<string, string>> = Object.freeze({
  '@earendil-works/pi-durable': '1.1.0',
  '@earendil-works/pi-ai': '1.1.0',
  '@earendil-works/chord': '1.1.0',
});

export interface PinMismatch { readonly package: string; readonly pinned: string; readonly installed: string | null }
export type PinCheck = { ok: true; versions: Record<string, string> } | { ok: false; mismatches: PinMismatch[]; words: string };

/** The installed version of each pinned package in the worker folder, compared with its pin. */
export function checkPins(workerDir: string, pins: Readonly<Record<string, string>> = PINS): PinCheck {
  const versions: Record<string, string> = {};
  const mismatches: PinMismatch[] = [];
  for (const [name, pinned] of Object.entries(pins)) {
    let installed: string | null = null;
    try {
      const v = (JSON.parse(readFileSync(join(workerDir, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }).version;
      installed = typeof v === 'string' ? v : null;
    } catch { installed = null; }
    if (installed === pinned) versions[name] = installed;
    else mismatches.push({ package: name, pinned, installed });
  }
  if (!mismatches.length) return { ok: true, versions };
  const words = `the Pi worker refuses to start: ${mismatches.map((m) => (m.installed === null
    ? `${m.package} is not installed in the worker folder (pinned ${m.pinned})`
    : `${m.package} is ${m.installed} in the worker folder, pinned ${m.pinned}`)).join('; ')}. Install the pins (workers/pi-durable, npm ci) or change them together.`;
  return { ok: false, mismatches, words };
}
