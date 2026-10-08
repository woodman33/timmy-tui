import type { Message } from '../types/index.js';

export interface AgentEvents {
  'message:user': (message: Message) => void;
  'message:assistant': (message: Message) => void;
  'item:update': (item: unknown) => void;
  'stream:start': () => void;
  'stream:delta': (delta: string, accumulated: string) => void;
  'stream:end': (fullText: string) => void;
  'tool:call': (name: string, args: unknown) => void;
  'tool:result': (name: string, result: unknown) => void;
  'reasoning:update': (text: string) => void;
  'error': (error: Error) => void;
  'thinking:start': () => void;
  'thinking:end': () => void;
  /** `info.complete` false: the cost is a lower bound (a cancel, or a response with no charge reported). */
  'cost:update': (cost: number, totalCost: number, info?: { complete: boolean }) => void;
  'model:switch': (model: string) => void;
  'tmux.command.sent': (data: { runId: string; sessionId: string; sessionName: string; command: string; cwd?: string; timestamp: string }) => void;
  'command.finished': (data: { runId: string; sessionId: string; sessionName: string; commandId: string; command: string; cwd: string; exitCode: number; success: boolean; timestamp: string }) => void;
  'tmux.output.line': (data: { runId: string; sessionId: string; sessionName: string; line: string; timestamp: string }) => void;
  'approval.required': (data: { runId: string; sessionId: string; sessionName: string; command: string; riskLevel: string; reason: string }) => void;
  'tmux:log': (data: { sessionId: string; logs: string[] }) => void;
  'tmux:update': () => void;
  'model:health': (status: 'UNTESTED' | 'READY' | 'ERROR' | 'FALLBACK READY') => void;
  'simulation.started': (data: any) => void;
  'simulation.plan.created': (data: any) => void;
  'simulation.score.created': (data: any) => void;
  'simulation.finished': (data: any) => void;
}
