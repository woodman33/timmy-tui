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

/** R11 round 7: a capture's options (the array form of `facts` stays for the round-6 suites). */
export interface CapOptions {
  /** the step's own REAL/FAKE lines */
  facts?: string[];
  /** scrolls one element into the viewport first; said in the sidecar */
  reveal?: { to: Locator; what: string };
  /** a second, whole-document picture when the page scrolls as a document */
  full?: boolean;
  /**
   * the sidecar's FIRST line (H168's rubric r7 §13: "page · state · size · head sha · FAKE/REAL"): the page and its state and the
   * FAKE/REAL words, to which the size, the revision and the time are appended; the suite's name moves to the second line
   */
  line?: string;
}

export interface Capturer {
  /** The folder, or '' when captures are off. */
  readonly folder: string;
  /**
   * One capture at a step; `facts` adds the step's own REAL/FAKE lines (or the options above). `reveal` scrolls one element into
   * the viewport first (a viewport capture shows only what is in view: at 390x844 the newest turn sits below the composer's
   * fold) and the sidecar says so; a reveal that cannot be made is said in the sidecar, never a failure.
   * `full` (R11 round 7: the order's "full-page desktop/mobile captures") adds a second picture `<base>-full.png` of the whole
   * document when it is taller than the viewport (a page that scrolls as a document — a phone); when the document is not taller
   * (the shell's regions scroll inside themselves) the viewport picture IS the full page, and the sidecar says so either way.
   */
  cap(page: Page, size: { width: number; height: number }, step: string, facts?: string[] | CapOptions, reveal?: { to: Locator; what: string }, full?: boolean): Promise<void>;
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
    async cap(page, size, step, factsOrOptions = [], revealArg, fullArg = false) {
      if (!folder) return;
      const o: CapOptions = Array.isArray(factsOrOptions) ? { facts: factsOrOptions, reveal: revealArg, full: fullArg } : { reveal: revealArg, full: fullArg, ...factsOrOptions };
      const facts = o.facts ?? [];
      const reveal = o.reveal;
      const full = Boolean(o.full);
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
        let whole = `A viewport capture of the companion page in headless Chromium at ${key} (not the full page).`;
        if (full) {
          // the document's own height against the window's: taller → a second, whole picture; not taller → the viewport is the whole page
          const taller = await page.evaluate(() => ({ doc: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), win: window.innerHeight })).catch(() => null);
          if (taller && taller.doc > taller.win + 2) {
            await page.screenshot({ path: `${base}-full.png`, fullPage: true });
            whole = `A viewport capture at ${key} (${base.split('/').pop()}.png) AND the whole document (${base.split('/').pop()}-full.png, ${taller.doc} px tall: the page scrolls as a document at this size).`;
          } else {
            whole = `A viewport capture at ${key} that IS the whole page: the document is no taller than the window (${taller ? `${taller.doc} px against ${taller.win}` : 'heights not read'}); the shell's regions scroll inside themselves.`;
          }
        }
        writeFileSync(`${base}.txt`, [
          o.line ? `${o.line} · ${key} · head ${revision} · ${new Date().toISOString()}` : `${suite} · ${step} · ${key} · revision ${revision} · ${new Date().toISOString()}`,
          ...(o.line ? [`${suite} · ${step}`] : []),
          whole,
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
