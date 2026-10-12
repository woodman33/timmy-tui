/**
 * R4 (H110): Stop current, which always names its target, reaches the durable job through the paths that already stop jobs:
 *
 *   a job this Workbench started     the REPL's own /stop (Workspace.stop): its process group, its record cancelled
 *   a job an ended session left      recovery's stop (src/repl/recover.ts stopLeft): only when the process table proves the
 *                                    session ended and the group is the job's; its record cancelled through the job store
 *   a job a live session runs        nothing is stopped: the words name that session and the command to type there
 *
 * Leaving a view never stops anything; a stop is only ever this explicit press.
 */
import type { JobRecord } from '../jobs/index.js';
import { stopLeft, type LeftJob, type LeftStop, type RecoverDeps } from '../repl/recover.js';
import type { JobRow } from './state.js';
import type { Role } from './text.js';

export interface StopDeps {
  /** the REPL's /stop on this Workbench's Workspace */
  stop(id: string): Promise<Array<Array<{ text: string }>>>;
  jobs: RecoverDeps['jobs'];
  /** a test's (FAKE): recovery's stop of a left job */
  stopLeft?: (job: JobRecord) => Promise<LeftStop | LeftJob>;
}

export interface Stopped { words: string; role: Role; stopped: boolean }

export async function stopCurrent(job: JobRow, d: StopDeps): Promise<Stopped> {
  if (job.owner === 'workbench') {
    const lines = await d.stop(job.id);
    const words = lines.map((l) => l.map((x) => x.text).join('').trim()).filter(Boolean).join('; ');
    const now = d.jobs.get(job.id);
    const stopped = now?.state === 'cancelled' || now?.state === 'failed' || now?.state === 'completed';
    return { words: words || `${job.id}: the stop said nothing`, role: stopped ? 'text' : 'failure', stopped };
  }
  // the outcome comes first in every answer: a narrow terminal's one row shows its start (Activity, expanded, the whole)
  const rec = d.jobs.get(job.id);
  if (!rec) return { words: `Nothing stopped: ${job.id}'s record is not in the jobs folder any more.`, role: 'secondary', stopped: false };
  const r = await (d.stopLeft ?? ((j: JobRecord) => stopLeft({ jobs: d.jobs }, j)))(rec);
  if ('job' in r) {
    const n = `${r.processes} process${r.processes === 1 ? '' : 'es'}`;
    const outcome = r.cleanup === 'unresolved'
      ? `Stopped ${job.id} only in part: some of process group ${r.process_group} did not stop (kill -KILL -- -${r.process_group})`
      : `Stopped ${job.id}`;
    const record = r.recorded ? `its record says ${r.recorded.state}` : 'its record could not be written (/recover in the REPL records it)';
    return {
      words: `${outcome}; ${record}. ${job.label}: the session that started it had ended, so recovery's stop ended its process group ${r.process_group} (${n}) with ${r.signals.join(', then ')}.`,
      role: r.cleanup === 'complete' ? 'text' : 'failure', stopped: true,
    };
  }
  if (r.kind === 'theirs') {
    return { words: `Nothing stopped: ${job.id} belongs to another Timmy session that is still running${r.why ? ` (${r.why})` : ''}. Stop it there: /stop ${job.id} in that REPL (or end that session).`, role: 'attention', stopped: false };
  }
  if (r.kind === 'gone') return { words: `Nothing to stop: ${job.id}'s process is gone. /recover in the REPL records how it ended.`, role: 'secondary', stopped: false };
  // stopLeft stops a proven group itself; an 'orphan' answer here would mean it did not, so nothing is claimed
  if (r.kind === 'orphan') return { words: `Not confirmed: ${job.id}'s process group ${r.pgid} was left by an ended session, and the stop did not report what it did; /jobs ${job.id} in the REPL shows its record.`, role: 'attention', stopped: false };
  return { words: `Nothing stopped: ${job.id}'s session has ended, but its process group could not be proven the job's (${r.why}). kill -TERM -- -${r.pgid} stops the group.`, role: 'attention', stopped: false };
}
