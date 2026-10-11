/**
 * Round R4 (helper H74; the plan's F-3 and R1 item 5): NEEDS YOU before a risky workflow block. Which blocks are risky, and
 * why Timmy asks once before the run rather than before each block (upmd cannot run one block alone): src/repl/workflow-risk.ts.
 *
 * Who can answer:
 *   - a /run typed in the REPL: the REPL's NEEDS YOU box (the gate the agent's tool calls use, askPerson), listed in the
 *     Control Room's "Waiting on you" while it waits; y runs it once, n, Esc or Enter (the default) deny it; it never
 *     offers "for this session";
 *   - `timmy md` in a terminal: its own NEEDS YOU box, the same box and keys (src/cli-md.ts);
 *   - the live board's Run: it cannot show a box (the REPL's prompt holds the keys), so the run is refused before anything
 *     runs and kept as waiting on you (HeldRuns) with the command to type in the REPL, until a run of that block starts or
 *     its document changes;
 *   - `timmy act`, and `timmy md` with no terminal or with --json: refused before anything runs (exit 2), with the command
 *     to type in the REPL.
 * A run whose document changed while the person was asked is refused: what they approved is not what would run.
 */
import { readProjectFile } from '../project/index.js';
import { quoteArg } from '../room/decisions.js';
import type { Segment } from '../term/theme.js';
import { docAtEnd } from '../workflows/block-receipts.js';
import { parseWorkflow, runOrder, type WorkflowBlock } from '../workflows/upmd.js';
import { askPerson, type ApprovalRequest, type Decision, type WaitingApproval } from './approvals.js';
import { RISKY_REASON, riskyBlocks, UPMD_GATE, type RiskyBlock } from './workflow-risk.js';

export { RISKY_REASON, riskyBlocks, UPMD_GATE, type RiskyBlock };

type Line = Segment[];

/** A run as /run (and `timmy md`) reads it before anything runs, or why it cannot run. */
export type RunPlan =
  | { ok: true; rel: string; text: string; sha256?: string; blocks: WorkflowBlock[]; target: string; order: string[]; risky: RiskyBlock[] }
  | { ok: false; why: string; failure?: boolean; rel?: string; which?: string[] };

/**
 * The run of `blockArg` in the document `docArg` of the project at `root`, read as /run reads it (one reading for /run and
 * `timmy md`): the document (at most 1 MB), its blocks, the target (the only named block when none is given), its run
 * order and the risky blocks of it. `which`: the names to choose from when no block was given and there are several.
 */
export function planRun(root: string, docArg: string, blockArg?: string): RunPlan {
  const r = readProjectFile(root, docArg, 1024 * 1024);
  if (!r.ok) return { ok: false, why: r.error };
  if (r.binary || r.text === undefined) return { ok: false, why: `${r.rel} is not a Markdown workflow.`, rel: r.rel };
  const blocks = parseWorkflow(r.text);
  const named = blocks.filter((b) => b.name).map((b) => b.name as string);
  if (!named.length) return { ok: false, why: `${r.rel} has no named blocks. upmd runs blocks named like \`\`\`bash [name:build]`, rel: r.rel };
  const target = blockArg ?? (named.length === 1 ? named[0] : undefined);
  if (!target) return { ok: false, why: `Which block? /run ${r.rel} <${named.join(' | ')}>`, rel: r.rel, which: named };
  if (!named.includes(target)) return { ok: false, why: `No block named ${target} in ${r.rel}: ${named.join(', ')}`, rel: r.rel };
  const plan = runOrder(blocks, target);
  if (plan.missing.length) return { ok: false, why: `${target} needs ${plan.missing.join(', ')}, which ${r.rel} does not define. Nothing ran.`, failure: true, rel: r.rel };
  if (plan.cycle) return { ok: false, why: `${target}'s dependencies loop (${plan.cycle.join(' -> ')}). Nothing ran.`, failure: true, rel: r.rel };
  return { ok: true, rel: r.rel, text: r.text, ...(r.sha256 ? { sha256: r.sha256 } : {}), blocks, target, order: plan.order, risky: riskyBlocks(blocks, plan.order) };
}

/** The REPL command that runs it (each argument as Timmy's command lines read it). */
export const runCommand = (rel: string, target: string): string => `/run ${quoteArg(rel)} ${quoteArg(target)}`;
const firstLine = (code: string): string => code.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const listed = (names: readonly string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** The NEEDS YOU box for a run: the run, why, each risky block's whole command; never "for this session". */
export function gateRequest(rel: string, target: string, order: readonly string[], risky: readonly RiskyBlock[]): ApprovalRequest {
  const summary = risky.map((b) => `${b.name}: ${firstLine(b.command)}`).join('; ');
  const detail = [
    ...risky.flatMap((b) => [`${b.name} (block ${b.index} of ${rel}):`, ...b.command.split('\n').map((l) => `  ${l}`)]),
    `upmd runs ${order.join(' → ')}; approved together, before the run`,
  ].join('\n');
  return {
    tool: runCommand(rel, target),
    reason: `runs ${risky.length === 1 ? 'a destructive shell command' : `${risky.length} destructive shell commands`} on this machine: ${listed(risky.map((b) => b.name))}`,
    summary, detail, session: false,
  };
}

/** What the Control Room's "Waiting on you" says while the box waits. */
export function gateWords(rel: string, target: string, order: readonly string[], risky: readonly RiskyBlock[]): NonNullable<WaitingApproval['words']> {
  return {
    title: `NEEDS YOU: ${runCommand(rel, target)} (${risky.map((b) => `${b.name}: ${firstLine(b.command)}`).join('; ')})`,
    needed: 'answer its NEEDS YOU box in the REPL: y runs it once, n, Esc or Enter deny it; nothing of the run starts until then',
    why: `upmd would run ${order.join(' → ')}, and ${risky.map((b) => `${b.name} runs ${RISKY_REASON}: ${b.command.replace(/\s+/g, ' ').trim()}`).join('; ')}; ${UPMD_GATE}`,
    commands: [], keys: true,
  };
}

/** Each risky block (its name, the first line of its command, why) and how Timmy asks; nothing when none is risky. */
export function riskyLines(risky: readonly RiskyBlock[], o: { sep: string }): Line[] {
  if (!risky.length) return [];
  const lines: Line[] = risky.map((b, i) => [{ text: i ? '             ' : '  Needs you  ', role: 'secondary' }, { text: b.name, role: 'strong' }, { text: `: ${firstLine(b.command)}${b.command.includes('\n') ? ' …' : ''}${o.sep}${b.reason}`, role: 'estimate' }]);
  lines.push([{ text: `             ${UPMD_GATE}.`, role: 'secondary' }]);
  return lines;
}

/** The prediction's words before the box: what would run, each risky block and why, and how Timmy asks. */
export function gateLines(p: { order: readonly string[]; risky: readonly RiskyBlock[] }, o: { arrow: string; sep: string; answer: 'box' | 'none' }): Line[] {
  return [
    [{ text: '  Predicted  ', role: 'secondary' }, { text: p.order.join(` ${o.arrow} `), role: 'strong' }, { text: `, each exits 0${o.answer === 'box' ? `${o.sep}nothing runs or is sealed until you answer` : ''}`, role: 'secondary' }],
    ...riskyLines(p.risky, o),
  ];
}

/**
 * Why a `/run <file> [<block>]` line needs a person: its blocks include a risky one, in the words `timmy act` refuses with
 * ("Not run: <this>, which needs a person. Type this in the REPL instead: <line>"); undefined for any other line, and for a
 * run that cannot start (the Workspace's own /run says why).
 */
export function workflowNeedsPerson(root: string, line: string): string | undefined {
  const m = /^\/run\s+(\S+)(?:\s+(\S+))?\s*$/.exec(line.trim());
  if (!m) return undefined;
  const p = planRun(root, m[1], m[2]);
  if (!p.ok || !p.risky.length) return undefined;
  const names = listed(p.risky.map((b) => `${b.name} (${firstLine(b.command)})`));
  return `${names} in ${p.rel} ${p.risky.length === 1 ? 'is a destructive shell command' : 'are destructive shell commands'} on this machine`;
}

/** Why a run with risky blocks did not run where no one can be asked, and the command to type in the REPL. */
export function needsPersonText(rel: string, target: string, risky: readonly RiskyBlock[], where: string): string {
  const names = risky.map((b) => `${b.name} (${firstLine(b.command)})`);
  return `Not run: ${listed(names)} ${risky.length === 1 ? 'is' : 'are'} ${risky.length === 1 ? RISKY_REASON : 'destructive shell commands on this machine'}, which needs a person, and ${where} cannot ask you. Type this in the REPL instead: ${runCommand(rel, target)}`;
}

// ── asking ────────────────────────────────────────────────────────────────────

export type GateAnswer = { ok: true; decision: Decision } | { ok: false; why: string; denied?: boolean };

/**
 * Asks the person in the NEEDS YOU box (`ask`, the REPL's own) about a run's risky blocks, listed as waiting meanwhile;
 * then checks that the document is still the bytes that were read (`sha256`): what was approved is what upmd will read.
 */
export async function askRun(p: { root: string; rel: string; target: string; order: readonly string[]; risky: readonly RiskyBlock[]; sha256?: string }, ask: (req: ApprovalRequest) => Promise<Decision>): Promise<GateAnswer> {
  let decision: Decision;
  try { decision = await askPerson(gateRequest(p.rel, p.target, p.order, p.risky), ask, gateWords(p.rel, p.target, p.order, p.risky)); } catch (e) {
    return { ok: false, why: `Not run: its NEEDS YOU box could not ask (${e instanceof Error ? e.message : String(e)}). Nothing ran, and nothing was sealed.` };
  }
  if (decision === 'deny') return { ok: false, denied: true, why: 'Not run: you denied it in its NEEDS YOU box. Nothing ran, and nothing was sealed.' };
  if (docAtEnd(p.root, p.rel, p.sha256) !== 'unchanged') return { ok: false, why: `Not run: ${p.rel} changed while you were asked, so what you approved is not what upmd would read. Nothing ran, and nothing was sealed: ${runCommand(p.rel, p.target)} asks again.` };
  return { ok: true, decision };
}

// ── the live board's runs that wait on a person ──────────────────────────────

interface Held { root: string; rel: string; target: string; sha256?: string; at: number; order: string[]; risky: RiskyBlock[]; operation?: string }

/**
 * The live board's runs refused because a block needs a person (the board cannot show the REPL's box), as this REPL's
 * board knows them: kept in memory, per project, nothing written. Each is waiting on you, with the command to type, while
 * its document is still the bytes it was when the run was refused and no run of that block has started since.
 */
export class HeldRuns {
  private readonly held = new Map<string, Held>();

  hold(h: Held): void { this.held.set(`${h.root}\0${h.rel}\0${h.target}`, h); }

  /** A run of that block started: it no longer waits. */
  settle(root: string, rel: string, target: string): void { this.held.delete(`${root}\0${rel}\0${target}`); }

  /** This project's held runs that still hold, newest first, as "Waiting on you" reads a NEEDS YOU wait. */
  list(root: string): WaitingApproval[] {
    const out: WaitingApproval[] = [];
    for (const [key, h] of this.held) {
      if (h.root !== root) continue;
      if (docAtEnd(root, h.rel, h.sha256) !== 'unchanged') { this.held.delete(key); continue; }
      const cmd = runCommand(h.rel, h.target);
      out.push({
        tool: cmd, reason: RISKY_REASON, summary: h.risky.map((b) => `${b.name}: ${firstLine(b.command)}`).join('; '), session: false, since: h.at, shown: false,
        ...(h.operation ? { operation: h.operation } : {}),
        words: {
          title: `NEEDS YOU: ${cmd} from the board (${h.risky.map((b) => `${b.name}: ${firstLine(b.command)}`).join('; ')})`,
          needed: 'type the command below in the REPL and answer its NEEDS YOU box: the board cannot show the box, so its Run was refused and nothing ran',
          why: `upmd would run ${h.order.join(' → ')}, and ${h.risky.map((b) => `${b.name} runs ${RISKY_REASON}: ${b.command.replace(/\s+/g, ' ').trim()}`).join('; ')}; ${UPMD_GATE}`,
          commands: [cmd], keys: false, kind: 'blocks a requested run',
        },
      });
    }
    return out.sort((a, b) => b.since - a.since);
  }
}
