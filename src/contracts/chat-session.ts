/**
 * R4 lead (2026-10-11, the operator's Workbench direction): one chat path for every surface: the REPL, the monitor, the
 * terminal Workbench and, later, the companion. It holds the route the setup chose (src/agent/chat-route.ts), its honest
 * refusal ("Nothing was sent to any model" only when true), the NEEDS YOU gate for tools that need a person, and the turn
 * itself with its receipt. Made by src/agent/chat-session.ts; surfaces only draw what it returns. Opening a second view
 * never starts a second agent: a surface opens a session for the project, it does not make an agent of its own.
 * A change of a field's meaning goes through the lead, with the producer and every surface changing together.
 */
import type { ApprovalRequest, Decision } from '../repl/approvals.js';

export interface ChatRouteState {
  kind: 'openrouter' | 'local' | 'none';
  /** the header's words, for example "chat: local <model> · Ollama" */
  words: string;
  /** false: a message is refused and nothing is sent */
  ready: boolean;
  /** the lines a message gets instead of a turn, when not ready */
  refusal?: string[];
}

export interface ChatTurnHooks {
  /** the answer so far */
  onText(full: string): void;
  onTool?(event: { id: string; name: string; phase: 'start' | 'end'; outcome?: string }): void;
  /** a surface that cannot show the NEEDS YOU box answers 'deny' and says where the person can decide */
  askPerson(req: ApprovalRequest): Promise<Decision>;
  signal?: AbortSignal;
}

export interface ChatTurnResult {
  status: 'answered' | 'refused' | 'failed' | 'cancelled';
  text: string;
  /** refusal or failure words: cause and fix */
  lines?: string[];
  /** whether any request left this process for a model (OpenRouter or an Ollama) */
  sent: boolean;
  /** the turn's receipt id, when sealed */
  receipt?: string;
  /** "no charge (local endpoint)", a reported amount, or "cost unknown" */
  costWords: string;
  model?: string;
}

/**
 * R4 lead (H113's keyed send, made the contract's): what a message's key is: 8 to 80 letters, digits, - or _. A surface gives
 * the same key to every attempt at sending one message (a click, its repeat, a page's request sent again after it reconnected,
 * a resend after a timeout) and a new key to a new message.
 */
export const CHAT_KEY = /^[A-Za-z0-9_-]{8,80}$/;

export interface ChatSession {
  /** read at every message: a /setup elsewhere takes effect at the next one */
  route(): ChatRouteState;
  send(text: string, hooks: ChatTurnHooks): Promise<ChatTurnResult>;
  /**
   * R4 lead (2026-10-12; the operator's direction of 2026-10-11: "Reconcile retries so refresh, duplicate clicks or
   * reconnection cannot repeat completed side effects"): `send` with the message's key (CHAT_KEY), so that no attempt at
   * sending it again repeats a turn that went out. Kept per project, across surfaces and processes (the project's
   * .timmy/chat-turns/keys.jsonl), the newest record of a key deciding:
   *   no turn had the key                      sent, as `send` sends
   *   its turn runs now (any surface, process) refused: nothing is sent (the turn under way stands)
   *   its turn sent a request                  refused, naming that turn's receipt: its answer and its cost stand
   *   its turn ended having sent nothing       sent: a retry, not a repeat (a refusal, or a failure before any request left)
   *   its turn's end was never recorded        refused: the process that ran it ended during the turn, so whether a request
   *     (its process ended during it)           went out is not known, and it is not sent again; a new message is sent anew
   *   not a key (CHAT_KEY)                     refused: sending once could not be kept
   * A refusal's `lines` say which, and that nothing was sent; it is `sent: false` with no receipt.
   */
  sendOnce(key: string, text: string, hooks: ChatTurnHooks): Promise<ChatTurnResult>;
}

export type ChatSurface = 'repl' | 'monitor' | 'workbench' | 'companion';

export type OpenChatSession = (o: { project: { name: string; root: string }; surface: ChatSurface }) => Promise<ChatSession>;
