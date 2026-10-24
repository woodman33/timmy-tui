/**
 * R11 round 5 (H172): capture points for the journey tests — inert unless the env TIMMY_JOURNEY_CAPS names a folder. Each
 * capture is one viewport screenshot (`<size>-<NN>-<step>.png`, numbered per size) with a sibling `.txt` naming the revision,
 * the size, the step, what is REAL and what is FAKE in the picture, and what animates or not (each suite's own line: the
 * operator's timmy-ui.riv is gitignored, so a checkout draws the Rive components only when the file is beside its source).
 * No assertion lives here: a capture that fails leaves the test's verdict alone.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';

export interface Capturer {
  /** The folder, or '' when captures are off. */
  readonly folder: string;
  /**
   * One capture at a step; `facts` adds the step's own REAL/FAKE lines. `reveal` scrolls one element into the viewport first
   * (a viewport capture shows only what is in view: at 390x844 the newest turn sits below the composer's fold) and the
   * sidecar says so; a reveal that cannot be made is said in the sidecar, never a failure.
   */
  cap(page: Page, size: { width: number; height: number }, step: string, facts?: string[], reveal?: { to: Locator; what: string }): Promise<void>;
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
export function capturer(suite: string, common: string[], sub = ''): Capturer {
  const folder = process.env.TIMMY_JOURNEY_CAPS ? (sub ? join(process.env.TIMMY_JOURNEY_CAPS, sub) : process.env.TIMMY_JOURNEY_CAPS) : '';
  const counts = new Map<string, number>();
  const revision = revisionOf();
  if (folder) { try { mkdirSync(folder, { recursive: true }); } catch { /* said on the first capture */ } }
  return {
    folder,
    async cap(page, size, step, facts = [], reveal) {
      if (!folder) return;
      const key = sizeKey(size);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      const base = join(folder, `${key}-${String(n).padStart(2, '0')}-${step}`);
      let revealed = '';
      if (reveal) {
        revealed = await reveal.to.scrollIntoViewIfNeeded({ timeout: 2_000 }).then(
          async () => { await page.waitForTimeout(150); return `Scrolled so that ${reveal.what} is in view before the capture.`; },
          (e: unknown) => `Not scrolled: ${reveal.what} could not be brought into view (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); the capture is the page as it stood.`,
        );
      }
      try {
        await page.screenshot({ path: `${base}.png`, fullPage: false });
        writeFileSync(`${base}.txt`, [
          `${suite} · ${step} · ${key} · revision ${revision} · ${new Date().toISOString()}`,
          `A viewport capture of the companion page in headless Chromium at ${key} (not the full page).`,
          ...common,
          ...facts,
          ...(revealed ? [revealed] : []),
          'Scripted test run, not a person: the clicks and the typed words are the test\'s.',
          '',
        ].join('\n'));
      } catch (e) {
        try { writeFileSync(`${base}.failed.txt`, `the capture at ${step} (${key}) did not complete: ${e instanceof Error ? e.message : String(e)}\n`); } catch { /* nothing to say it with */ }
      }
    },
  };
}
