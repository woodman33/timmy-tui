/**
 * Round R4 (helper H88; the Mac run r23): `/jobs <id>` says how the job ran: its program and its arguments as the job record
 * keeps them (for a /run on a pty: python3, Timmy's pty wrapper and its options, then upmd's `--ci -b <block> -d <project>
 * <run folder>/checked.md`). Before, it did not say. Each path of the project, Timmy's home and Timmy's own folder is shown by
 * its name ("[project tray]", "[Timmy home]", "[Timmy]"), and any other path under the home folder (the account's own home
 * and $HOME) from "~": no absolute path under a home folder is shown. Nothing is run or read.
 */
import { realpathSync } from 'node:fs';
import type { JobRecord } from '../jobs/index.js';
import { packageRoot } from '../utils/asset-dirs.js';
import { homeFolders } from '../utils/home-scrub.js';
import { secondsText } from '../workflows/run-blocks.js';

/** An argument as typed in a shell line: as it is when plain, else in single quotes. */
const shown = (a: string): string => (a !== '' && /^[A-Za-z0-9_@%+=:,./[\]~-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

/** The folder and its real path (a folder reached through a link is named either way), longest first. */
function forms(dir: string | undefined): string[] {
  if (!dir || dir.length < 2) return [];
  const out = [dir.replace(/\/+$/, '')];
  try { out.push(realpathSync(dir)); } catch { /* gone: as given */ }
  return [...new Set(out)].filter((d) => d.length > 1);
}

/** A path with its known folders named (the longest folder first, at a path boundary only). */
function named(text: string, names: ReadonlyArray<[string, string]>): string {
  let out = text;
  for (const [dir, name] of names) {
    let at = out.indexOf(dir);
    while (at >= 0) {
      const after = out[at + dir.length];
      const before = at === 0 ? '' : out[at - 1];
      if ((after === undefined || after === '/' || after === '\'' || after === ' ') && (before === '' || before === ' ' || before === '=' || before === '\'')) {
        out = `${out.slice(0, at)}${name}${out.slice(at + dir.length)}`;
        at = out.indexOf(dir, at + name.length);
      } else at = out.indexOf(dir, at + 1);
    }
  }
  return out;
}

/** How the job ran, in one line: its program and arguments as its record keeps them, the folders named (see above). */
export function jobCommandWords(j: Pick<JobRecord, 'command' | 'args' | 'root' | 'project'>, o: { timmyHome: string; env?: NodeJS.ProcessEnv; packageRoot?: string | null }): string {
  const own = o.packageRoot === undefined ? packageRoot(import.meta.url) : o.packageRoot ?? undefined;
  const names: Array<[string, string]> = [
    ...forms(j.root).map((d): [string, string] => [d, `[project ${j.project}]`]),
    ...forms(o.timmyHome).map((d): [string, string] => [d, '[Timmy home]']),
    ...forms(own).map((d): [string, string] => [d, '[Timmy]']),
    ...homeFolders(o.env).map((d): [string, string] => [d, '~']),
  ].sort((a, b) => b[0].length - a[0].length);
  return [j.command, ...j.args].map((a) => named(shown(a), names)).join(' ');
}

/** The words every end a later recovery writes in a job's record begin with (src/repl/recover.ts, workflow-recover.ts,
 *  openhands-recover.ts), the Timmy that started it named (R4, H88: its REPL, timmy md or timmy act). */
export const ENDED_BY_RECOVERY = /^(?:interrupted: )?its (?:REPL|timmy md|timmy act|Workbench) (?:ended|did not see it end)\b/;

/** Whether a job's end was written by a later session's recovery (JobManager endLeft), not seen when it happened. */
export const endedByRecovery = (j: Pick<JobRecord, 'endedAt' | 'interrupted' | 'error' | 'note'>): boolean =>
  !!j.endedAt && (j.interrupted !== undefined || ENDED_BY_RECOVERY.test(j.error ?? '') || ENDED_BY_RECOVERY.test(j.note ?? ''));

const utc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/**
 * R4 (H88; the Mac run r23): how long a job ran, in words for its /jobs line. A job whose end a later recovery recorded did
 * not end then: r23's /jobs said "88 min" for a run whose one block ran 5.3 s (its end was written when /recover settled it,
 * 88 minutes after it started). Such a job says when its end was recorded and why, and its blocks' own times when its record
 * has them (a run on a pty stamps each block's start and end); every other job, its time as before (`elapsed`).
 */
export function ranWords(j: Pick<JobRecord, 'endedAt' | 'interrupted' | 'error' | 'note' | 'steps'>, elapsed: string): string {
  if (!j.endedAt || !endedByRecovery(j)) return elapsed;
  const own = j.steps.flatMap((s) => { const ms = s.startedAt && s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : Number.NaN; return Number.isFinite(ms) && ms >= 0 ? [`${s.name} ${secondsText(ms)}`] : []; });
  const blocks = own.length ? `; its blocks' own times: ${own.join(', ')}` : '';
  return `ended unseen: a later recovery recorded its end at ${utc(j.endedAt)}, after the Timmy that ran it had ended${blocks}`;
}
