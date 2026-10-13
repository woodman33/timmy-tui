/**
 * Round R4 (H76): the plan's one status ladder per tool (docs/ui-cockpit/COMMAND-CENTER-PLAN.md, "Rules every feature
 * follows" 1; AGENTS.md §8), as data on every /tools row: the rung that stands here now, and each rung's own evidence.
 *
 *   proposed    a plan in this repository names it and no code here runs it (the plan's file and section)
 *   installed   found here: where, how it was found, and its version only as the program or its package says it
 *   reachable   a probe answered: what was asked, when, the answer's gist (a configured URL or a file on disk is not)
 *   exercised   a run of Timmy's own here that Timmy judged and sealed: its record and its receipt, on a chain that
 *               verifies (a fixture, a test or another program's run does not count)
 *   qualified   a formal qualification record only (an admitted /observe --qualify answer for a model; a qualification
 *               record that still covers the sources it sealed); development runs never qualify anything
 *
 * Each rung stands on its own evidence: none is inferred from a lower one or from a configured value. A rung above
 * installed stands only while the tool is here now: when the check finds what it needs missing, the row reads
 * "needs setup" with its step, and the evidence of an earlier run stays in its ladder (it never raises the rung).
 *
 * A demonstration on the operator's Mac (src/capabilities/demonstrations.ts) is a separate fact: it is never a rung here.
 */

/** The ladder's rungs, lowest first. */
export const RUNGS = ['proposed', 'installed', 'reachable', 'exercised', 'qualified'] as const;
export type LadderRung = (typeof RUNGS)[number];

/** What a /tools row reads: a rung of the ladder, or "needs setup" (Timmy has the code; what it needs is not here). */
export type Rung = LadderRung | 'needs setup';
/** The words of each state, lowest first: the legend of `/tools`, `timmy tools --json` and the Control Room's panel. */
export const RUNG_ORDER: readonly Rung[] = ['proposed', 'needs setup', 'installed', 'reachable', 'exercised', 'qualified'];

/** proposed: the plan that names it (a file in this repository), its section, and its words. */
export interface ProposedEvidence { plan: string; section: string; says: string }
/** installed: what the check found, in its own words; where and how, when the check says; the version only as said. */
export interface InstalledEvidence {
  found: string;
  /** a path (the home folder as ~) or a setting's name */
  where?: string;
  /** how it was found: the PATH, a setting, a folder scan, built into Timmy */
  how?: string;
  version?: string;
  /** who said the version (its package.json, the program in a sealed run) */
  versionFrom?: string;
}
/** reachable: what was asked, when the answer came, and its gist (never a key). */
export interface ReachableEvidence { asked: string; at: string; answer: string }
/** exercised: Timmy's own run here, judged and sealed, on a chain that verifies. */
export interface ExercisedEvidence {
  at: string;
  /** what ran and how Timmy judged it */
  what: string;
  /** the receipt's short id (as /results shows it) and its full hash */
  receipt: string;
  hash?: string;
  /** the run's own record, relative to its project, when it keeps one */
  record?: string;
  /** what verified it */
  chain: string;
}
/** qualified: a formal qualification record, what it qualifies, and its record and receipt. */
export interface QualifiedEvidence {
  at?: string;
  what: string;
  /** what it does not cover */
  scope: string;
  record: string;
  receipt: string;
  hash?: string;
}

export interface Ladder {
  proposed: ProposedEvidence | null;
  installed: InstalledEvidence | null;
  reachable: ReachableEvidence | null;
  exercised: ExercisedEvidence | null;
  qualified: QualifiedEvidence | null;
}
/** Why a rung is not reached, in words (only for rungs whose evidence is null). */
export type NotReached = Partial<Record<LadderRung, string>>;

export const emptyLadder = (): Ladder => ({ proposed: null, installed: null, reachable: null, exercised: null, qualified: null });

/** The highest rung whose evidence is there, or null. */
export function highestRung(l: Ladder): LadderRung | null {
  for (let i = RUNGS.length - 1; i >= 0; i -= 1) if (l[RUNGS[i]]) return RUNGS[i];
  return null;
}

/**
 * The rung a row reads: "needs setup" when the check found what it needs missing (whatever was reached before); proposed
 * when only a plan names it; otherwise the highest rung whose own evidence is here, at least installed.
 */
export function standingRung(present: 'reachable' | 'installed' | 'needs setup' | 'proposed', l: Ladder): Rung {
  if (present === 'needs setup') return 'needs setup';
  if (present === 'proposed') return 'proposed';
  const top = highestRung(l);
  return top && top !== 'proposed' ? top : 'installed';
}

/** One phrase per state: the legend's words. */
export const RUNG_MEANS: Readonly<Record<Rung, string>> = {
  'proposed': 'a plan names it; no code runs it',
  'needs setup': 'Timmy has the code; do the step',
  'installed': 'found here; nothing asked',
  'reachable': 'a probe answered just now',
  'exercised': 'its own run here, judged and sealed',
  'qualified': 'a formal qualification record',
};

/** The default words for a rung that is not reached, by what the check is. */
export const NOT_REACHED = {
  proposed: 'past this rung: Timmy has code that runs it',
  installed: 'not found here',
  noProbe: 'no probe asked: this check runs no program and contacts nothing for it',
  exercised: 'no run of its own here judged ok and sealed on a chain that verifies',
  brokenChain: 'the receipts chain does not verify here, so no run of it counts',
  qualified: 'no qualification record',
} as const;
