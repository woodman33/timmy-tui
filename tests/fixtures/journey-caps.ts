/**
 * R11 round 5 (H172): capture points for the journey tests — inert unless the env TIMMY_JOURNEY_CAPS names a folder. Each
 * capture is one viewport screenshot (`<size>-<NN>-<step>.png`, numbered per size) with a sibling `.txt` naming the revision,
 * the size, the step, what is REAL and what is FAKE in the picture, and that nothing animates (no .riv in this installation).
 * No assertion lives here: a capture that fails leaves the test's verdict alone.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

export interface Capturer {
  /** The folder, or '' when captures are off. */
  readonly folder: string;
  /** One capture at a step; `facts` adds the step's own REAL/FAKE lines. */
  cap(page: Page, size: { width: number; height: number }, step: string, facts?: string[]): Promise<void>;
}

/** The checkout's revision, for the sidecar (the folder is usually named after it too). */
export function revisionOf(cwd: string = process.cwd()): string {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown'; } catch { return 'unknown'; }
}

const sizeKey = (s: { width: number; height: number }): string => `${s.width}x${s.height}`;

/**
 * @param suite  the test file's name, written in every sidecar
 * @param common the REAL/FAKE lines true of every capture of that file
 */
export function capturer(suite: string, common: string[]): Capturer {
  const folder = process.env.TIMMY_JOURNEY_CAPS || '';
  const counts = new Map<string, number>();
  const revision = revisionOf();
  if (folder) { try { mkdirSync(folder, { recursive: true }); } catch { /* said on the first capture */ } }
  return {
    folder,
    async cap(page, size, step, facts = []) {
      if (!folder) return;
      const key = sizeKey(size);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      const base = join(folder, `${key}-${String(n).padStart(2, '0')}-${step}`);
      try {
        await page.screenshot({ path: `${base}.png`, fullPage: false });
        writeFileSync(`${base}.txt`, [
          `${suite} · ${step} · ${key} · revision ${revision} · ${new Date().toISOString()}`,
          `A viewport capture of the companion page in headless Chromium at ${key} (not the full page).`,
          ...common,
          ...facts,
          'Nothing animates in this picture: no .riv is in this installation (the Rive source files only); every state is the word beside its component.',
          'Scripted test run, not a person: the clicks and the typed words are the test\'s.',
          '',
        ].join('\n'));
      } catch (e) {
        try { writeFileSync(`${base}.failed.txt`, `the capture at ${step} (${key}) did not complete: ${e instanceof Error ? e.message : String(e)}\n`); } catch { /* nothing to say it with */ }
      }
    },
  };
}
