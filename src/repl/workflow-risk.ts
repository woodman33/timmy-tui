/**
 * Round R4 (helper H74): which blocks of a workflow run are risky, and how far Timmy can ask before them (the rest of the
 * gate is src/repl/workflow-gate.ts; this part has no other dependency, so the board's card reads it too).
 *
 * A block is risky when Timmy's own rule for a destructive shell command matches its code: the rule the chat agent's shell
 * tool is asked about by (src/repl/approvals.ts destructiveCommand: rm, sudo, chmod, chown, dd, mkfs). No second rule is
 * written here. Only the blocks a run would run count: the target and the blocks it needs, in runOrder's order.
 *
 * How far Timmy can ask: upmd 0.2.7 runs a block only after the blocks it needs, one after the other with no stop between
 * them, and has no option that runs one block alone. Its `--help`, read on the operator's Mac on 2026-10-10, lists
 * `--all`, `--cli`, `--ci`, `-d`, `-y`, `--theme`, `--capture-state`, `-b` ("Run a specific code block by name or numeric
 * ID"), `--dump-default-config`, `--transparent`, `--tick-rate`, `-h` and `-V`. So Timmy cannot stop a run between two
 * blocks to ask: it asks once, before anything of the run starts, naming every risky block of it with its whole command,
 * approved together. The prediction says so in its words (UPMD_GATE) and seals the risky blocks.
 */
import { codeSha256 } from '../workflows/block-receipts.js';
import type { WorkflowBlock } from '../workflows/upmd.js';
import { destructiveCommand } from './approvals.js';

/** A block of a run that needs a person before it runs. */
export interface RiskyBlock {
  name: string;
  /** upmd's number for it */
  index: number;
  /** its whole code, as the document holds it */
  command: string;
  /** why, in words */
  reason: string;
  code_sha256: string;
}

/** What upmd lets Timmy ask, in the prediction's words (sealed with it as prediction.gate). */
export const UPMD_GATE = 'upmd runs a block only after the blocks it needs, one after the other with no stop between them (upmd 0.2.7 has no option that runs one block alone), so Timmy asks once, before the run, for every risky block in it, approved together';
/** Why a block is risky, in words. */
export const RISKY_REASON = 'a destructive shell command on this machine';

/** Whether a block's code is risky (the destructive-command rule of the agent's shell tool). */
export const riskyCode = (code: string): boolean => destructiveCommand(code);

/** The blocks of `order` (the target and what it needs, as runOrder gives them) whose code the destructive-command rule matches. */
export function riskyBlocks(blocks: readonly WorkflowBlock[], order: readonly string[]): RiskyBlock[] {
  const out: RiskyBlock[] = [];
  for (const name of order) {
    const b = blocks.find((x) => x.name === name);
    if (!b || !riskyCode(b.code)) continue;
    out.push({ name, index: b.index, command: b.code, reason: RISKY_REASON, code_sha256: codeSha256(b) });
  }
  return out;
}
