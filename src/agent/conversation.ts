import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import type { Message } from '../types/index.js';

export class ConversationManager {
  private dir: string;
  private currentSession: string | null = null;
  private messages: Message[] = [];
  private chosenNew = false;

  /**
   * The folder is fixed when the conversation is made (an absolute path), so a later change of working
   * folder (/project) never sends its writes elsewhere; it is created by the first message, not on open.
   */
  constructor(dir: string = '.sessions') {
    this.dir = resolve(dir);
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * R4 lead: the conversation this manager holds (its file's name without .jsonl), or null when none is started: read by the
   * project's one conversation across surfaces (src/agent/chat-turn.ts continueConversation), never written from outside.
   */
  get current(): string | null {
    return this.currentSession;
  }

  /**
   * R4 lead (the package rehearsal at 2ba6b73): the conversation this manager holds was started by a person (the REPL's /new),
   * not by the agent itself when it opened with nothing kept yet. Only a chosen one, not written yet, is kept as the project's
   * newest (src/agent/chat-turn.ts continueConversation); one an agent started by itself gives way to the project's kept one.
   */
  get chosen(): boolean {
    return this.chosenNew;
  }

  startNew(o: { chosen?: boolean } = {}): string {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.currentSession = id;
    this.messages = [];
    this.chosenNew = o.chosen === true;
    return id;
  }

  load(id: string): Message[] {
    const path = join(this.dir, `${id}.jsonl`);
    if (!existsSync(path)) {
      throw new Error(`Session ${id} not found`);
    }
    const content = readFileSync(path, 'utf-8');
    this.messages = content.split('\n').filter(Boolean).map(line => JSON.parse(line));
    this.currentSession = id;
    this.chosenNew = false;
    return this.messages;
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
    if (this.currentSession) {
      const path = join(this.dir, `${this.currentSession}.jsonl`);
      const line = JSON.stringify({
        role: message.role,
        content: message.content,
        name: message.name,
        timestamp: message.timestamp || Date.now(),
      });
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, line + '\n', { flag: 'a' });
    }
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.currentSession = null;
    this.chosenNew = false;
  }

  listSessions(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''))
      .sort()
      .reverse();
  }
}
