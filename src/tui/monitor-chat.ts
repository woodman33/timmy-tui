/**
 * R4 (H103): the monitor's chat (`timmy watch`, ShellV2's drawer), its words and its commands. Pure: ShellV2 draws what
 * these return, and the turn itself is the shared chat session's (src/agent/chat-session.ts).
 *
 * D1e: a line that starts with / is a command and never reaches a model. The monitor runs four: /setup and /studio (words:
 * where each happens), /model test (one explicit check) and /storyboard <idea> (the storyboard, its preview served on
 * 127.0.0.1 only: src/utils/slash-commands.ts); any other gets the words that say so.
 * D7: the flash line wraps instead of losing its end. D10: the drawer is a full-width band, so no cell beside it keeps
 * what was drawn under it.
 */
import type { ChatTurnResult } from '../contracts/chat-session.js';
import type { RouteNow } from '../agent/chat-route.js';
import { wrapText } from './utils/rows.js';
import { NO_MODEL_KEY } from './provider-status.js';

export const MODEL_TEST = '/model test';

export type MonitorSlash = 'setup' | 'studio' | 'model-test' | 'storyboard' | 'unknown';

/** Which of the monitor's commands a line is, or null when it is a message (it does not start with /). */
export function monitorSlash(text: string): MonitorSlash | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  if (/^\/setup(\s|$)/.test(t)) return 'setup';
  if (/^\/studio(\s|$)/.test(t)) return 'studio';
  if (t === MODEL_TEST) return 'model-test';
  if (/^\/storyboard(\s|$)/.test(t)) return 'storyboard';
  return 'unknown';
}

/** Any other command: the monitor does not run it, and it is not sent to a model. */
export const MONITOR_UNKNOWN_WORDS = 'Unknown here: the monitor\'s chat runs /setup, /studio, /storyboard and /model test; the REPL runs the rest.';

/**
 * The flash as rows no wider than `width`, each a whole word where it can be (D7: /studio's and /setup's words lost their
 * ends at the terminal's edge). At most `max` rows: a text longer than that ends its last row with … (no flash is near it).
 */
export function flashRows(text: string, width: number, max: number): string[] {
  if (!text) return [];
  const rows = wrapText(text, Math.max(10, width));
  if (rows.length <= max) return rows;
  const kept = rows.slice(0, Math.max(1, max));
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
  return kept;
}

/** What the flash line says when a turn ends: the outcome, who answered, the cost in words and the receipt. */
export function turnFlash(r: ChatTurnResult): string {
  const receipt = r.receipt ? ` · receipt ${r.receipt.slice(7, 15)}` : '';
  if (r.status === 'answered') return `Answered${r.model ? ` by ${r.model}` : ''} · ${r.costWords}${receipt}`;
  if (r.status === 'refused') return `Not sent: ${(r.lines?.[0] ?? 'the chat has no route to a model.').replace(/^(Error|Not sent):\s*/, '')}`;
  // R7 lead (H148's N5): a chat turn a person stopped is stopped (src/contracts/stop-words.ts), never cancelled
  if (r.status === 'cancelled') return `Stopped${r.sent ? '' : ': nothing was sent to any model'}${receipt}`;
  return `The turn failed: ${(r.lines?.find((l) => !/^OpenRouter failed:/.test(l)) ?? 'no reason came back').replace(/^Error:\s*/, '')}${r.sent ? '' : ' Nothing was sent to any model.'}${receipt}`;
}

/** No key, and the chat is not on the local model: the drawer's words (the session refuses a message the same way). */
export const NO_ROUTE_STATUS = NO_MODEL_KEY;

/** The drawer's status line for the route in effect (`provider`: what the OpenRouter route's own check knows). */
export function drawerStatus(now: RouteNow | null, provider: string): string {
  if (!now) return provider;
  const { route, state } = now;
  if (state.kind === 'none') return NO_ROUTE_STATUS;
  if (route.kind === 'local') {
    if (!state.ready || 'error' in route.at) return (state.refusal ?? []).filter((l) => !/^Nothing was sent/.test(l)).join(' ');
    return route.at.loopback && !route.cloud
      ? `Local: ${route.model} on this computer's Ollama (${route.at.host}). No key, no charge; the chat stays on this computer. /model test asks Ollama about it.`
      : `${state.words.replace(/^chat: /, '')}: the chat leaves this computer, and no cost comes back (unknown).`;
  }
  return provider;
}

export type Tone = 'title' | 'status' | 'you' | 'ai' | 'note' | 'error' | 'needs' | 'input' | 'keys' | 'blank';
export interface DrawerRow { text: string; tone: Tone }

const SYSTEM_PREFIX = /^\s*⚙️?\s*\*\*\[SYSTEM\]\*\*\s*/u;

/**
 * The drawer's rows, wrapped to `width` and bounded to `max` rows (D10: drawn as a full-width band): its title, the route's
 * status, the conversation's latest messages (a notice the agent gave, such as the last-resort fallback, in full), the
 * answer streaming now, what the last message got instead of a turn (a refusal, a failure), the line being typed and its
 * keys. When they do not all fit, the oldest messages give way first, and a row says how many.
 */
export function drawerRows(o: {
  width: number; max: number; title: string; status: string;
  messages: ReadonlyArray<{ role: string; content: unknown }>; streaming?: string; notes: readonly string[]; error?: string | null;
  input: string;
}): DrawerRow[] {
  const w = Math.max(20, o.width);
  const wrapped = (text: string, tone: Tone, lead = ''): DrawerRow[] => wrapText(`${lead}${text}`, w).map((t) => ({ text: t, tone }));
  const head: DrawerRow[] = [...wrapped(o.title, 'title'), ...wrapped(o.status, 'status')];
  const tail: DrawerRow[] = [
    ...o.notes.flatMap((l) => wrapped(l, /^(Error|Cause|Try|Not sent)\b/.test(l) ? 'error' : 'note')),
    ...(o.error && !o.notes.length ? wrapped(o.error, 'error') : []),
    { text: '', tone: 'blank' },
    ...wrapped(`> ${o.input}`, 'input'),
    { text: '[Enter] send · [Esc] leave · digits are text', tone: 'keys' },
  ];
  const body: DrawerRow[][] = o.messages.map((m) => {
    const text = String(m.content ?? '');
    if (m.role === 'user') return wrapped(text, 'you', 'you: ');
    if (SYSTEM_PREFIX.test(text)) return wrapped(text.replace(SYSTEM_PREFIX, ''), 'note', '· ');
    return wrapped(text, 'ai', 'ai:  ');
  });
  if (o.streaming) {
    const rows = wrapped(`${o.streaming}…`, 'ai', 'ai:  ');
    body.push(rows.slice(-6));
  }
  // the newest messages first, as many as fit; a row says how many earlier ones are not shown
  const room = Math.max(0, o.max - head.length - tail.length);
  const shown: DrawerRow[][] = [];
  let used = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const need = body[i].length;
    const left = room - used - (i > 0 ? 1 : 0);
    if (need <= left) { shown.unshift(body[i]); used += need; continue; }
    // the newest message alone never vanishes: its last rows show
    if (shown.length === 0 && left > 0) { shown.unshift(body[i].slice(-left)); used += left; }
    break;
  }
  const hidden = body.length - shown.length;
  const more: DrawerRow[] = hidden > 0 && room > used ? [{ text: `${hidden} earlier ${hidden === 1 ? 'message' : 'messages'} not shown`, tone: 'keys' }] : [];
  return [...head, ...more, ...shown.flat(), ...tail].slice(0, Math.max(o.max, head.length + tail.length));
}

/** The NEEDS YOU box's rows: what wants to run, why, the whole command or code when one line cannot show it, and the keys. */
export function needsYouRows(req: { tool: string; reason: string; summary: string; detail?: string; session?: false }, width: number, maxDetail = 8): DrawerRow[] {
  const w = Math.max(20, width);
  const what = req.detail ? req.tool : `${req.tool}${req.summary ? `: ${req.summary}` : ''}`;
  const detail = req.detail ? req.detail.split('\n').flatMap((l) => wrapText(`    ${l}`, w)) : [];
  const shown = detail.length > maxDetail ? [...detail.slice(0, maxDetail), `    … ${detail.length - maxDetail} more lines not shown`] : detail;
  return [
    ...wrapText(`NEEDS YOU · ${what}`, w).map((text): DrawerRow => ({ text, tone: 'needs' })),
    ...wrapText(`  ${req.reason}`, w).map((text): DrawerRow => ({ text, tone: 'status' })),
    ...shown.map((text): DrawerRow => ({ text, tone: 'note' })),
    { text: `  y allow once${req.session === false ? '' : ' · a allow for this session'} · n, Esc or Enter deny (nothing runs)`, tone: 'keys' },
  ];
}
