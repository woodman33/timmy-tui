/**
 * Round R4 (H75): an action from one of Timmy Canvas's drawn cards, taken by the REPL that holds the project
 * (src/repl/canvas-project.ts asks the canvas server for them) and run only through the live board's own path:
 * - Run and Rebuild are the board's run and rebuild actions: checked by checkAction against the live board's state as it is
 *   now (the document and block on the board, one word each; the recipe the board shows), then run as the typed command
 *   (/run <doc> <block>, /recipe <name>) through the Workspace's own method, as this REPL's own jobs;
 * - a parameter save is the board's set-params or set-scad-params edit (src/repl/board-edits.ts applyBoardEdit): the
 *   recipe's or the scad-params rules, the file as the card showed it (its sha256), no link on its way, refused while a flow
 *   runs in the project, the previous version kept, a human-gated edit receipt, whose subject names Timmy Canvas;
 * - nothing else: a card sends run, rebuild, set-params or set-scad-params, the one its card offers, for this REPL's
 *   active project. Anything else is refused here too, even though the canvas server refused it first.
 */
import { actFits, CARD_ACTS } from '../studio/card-relay.js';
import { checkAction, plainText, type BoardCommand, type LiveState } from './board-live.js';

export interface CanvasActionDeps {
  /** the id of this REPL's active project (projectId of its folder) */
  projectId: () => string;
  /** the live board's state as it is now: what its actions are checked against */
  state: () => LiveState;
  /** runs a checked run or rebuild as its typed command (the live board's own method) */
  command: (c: BoardCommand) => Promise<string[]>;
  /** checks and applies a parameter save through the live board's edit path */
  edit: (body: Record<string, unknown>, state: LiveState) => Promise<{ status: number; text: string }>;
}

export interface CanvasAnswer { status: number; text: string }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One card's action, checked and run as the live board's own; its answer in plain words. */
export async function canvasAction(envelope: unknown, d: CanvasActionDeps): Promise<CanvasAnswer> {
  if (!isObject(envelope) || typeof envelope.project !== 'string' || typeof envelope.card !== 'string' || !isObject(envelope.act)) {
    return { status: 400, text: 'Refused: not an action of a canvas card; nothing was run.' };
  }
  const act = envelope.act;
  if (!(CARD_ACTS as readonly unknown[]).includes(act.action)) return { status: 400, text: `Refused: a canvas card sends ${CARD_ACTS.join(', ')}; nothing was run.` };
  const fit = actFits(envelope.card, act);
  if (fit) return { status: 400, text: `Refused: ${fit} Nothing was run.` };
  // The canvas server checked that the card is the project named to it; this REPL may have switched since.
  if (envelope.project !== d.projectId()) return { status: 409, text: 'Refused: this REPL\'s active project is not the card\'s project now (it switched with /project); nothing was run.' };
  const state = d.state();
  if (act.action === 'run' || act.action === 'rebuild') {
    const checked = checkAction(act, state);
    if (!checked.ok) return { status: checked.status, text: `${checked.error} Nothing was run.` };
    const lines = await d.command(checked.command);
    return { status: 200, text: [`canvas ${checked.command.line}`, ...lines.map(plainText)].join('\n') };
  }
  return d.edit(act, state);
}

const BOARD_WORDS = ' from the live board';

/** An edit receipt's subject for a save from the canvas: the board's own words, saying the save came from Timmy Canvas. */
export function canvasSubject(subject: string): string {
  return subject.endsWith(BOARD_WORDS)
    ? `${subject.slice(0, -BOARD_WORDS.length)} from Timmy Canvas (the live board's save path)`
    : `${subject} (from Timmy Canvas)`;
}
