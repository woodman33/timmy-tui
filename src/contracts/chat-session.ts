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

export interface ChatSession {
  /** read at every message: a /setup elsewhere takes effect at the next one */
  route(): ChatRouteState;
  send(text: string, hooks: ChatTurnHooks): Promise<ChatTurnResult>;
}

export type ChatSurface = 'repl' | 'monitor' | 'workbench' | 'companion';

export type OpenChatSession = (o: { project: { name: string; root: string }; surface: ChatSurface }) => Promise<ChatSession>;
