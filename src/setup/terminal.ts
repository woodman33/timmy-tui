/**
 * The guided setup in a terminal (round R4, H98): `timmy init`, `timmy watch` on a home that is not set up, and the REPL's
 * /setup (in the REPL's own terminal, between two prompts) all ask through this one function, in the words of ./questions.ts.
 * It asks only the questions that have no answer yet, shows each preselected answer in [brackets] (Enter takes it), hides
 * a key as it is typed, and writes nothing itself: it returns the answers, and the caller writes them only after the
 * person said yes. Ctrl+C or the end of input stops it, with nothing written. Lines stay within 60 columns (C-14).
 */
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { chatWords, effectiveAnswers, hostOf, logsWords, needsAsking, pendingQuestions, QUESTIONS, type Answers, type Chat, type Logs, type Question, type SetupState } from './questions.js';

export interface SetupIO {
  log(s: string): void;
  /** One line typed after `prompt`; null when the person stopped (Ctrl+C, or the input ended). */
  question?(prompt: string): Promise<string | null>;
  /** The same, not shown as it is typed (a key). */
  hidden?(prompt: string): Promise<string | null>;
}

export type Asked = { answers: Answers } | { stopped: 'interrupted' | 'declined' };

/** Words wrapped at `width` columns, each line indented by `indent`. */
export function wrap(words: string, width = 60, indent = '  '): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of words.split(/\s+/).filter(Boolean)) {
    if (line && (indent + line + ' ' + w).length > width) { out.push(indent + line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(indent + line);
  return out;
}

/** A question as its lines (the prompt line apart). */
export function questionLines(q: Question): string[] {
  const lines = [`  ${q.title}`];
  for (const c of q.choices ?? []) {
    lines.push(`    ${c.key}  ${c.label}`);
    lines.push(...wrap(c.note, 60, '       '));
  }
  return lines;
}

/** The prompt: the preselected answer in brackets (a choice by its key), or none (a key, a blank default). */
export function promptFor(q: Question, a: Answers, s: SetupState): string {
  const pre = q.preselect(a, s);
  const shown = q.kind === 'choice' ? q.choices?.find((c) => c.value === pre)?.key ?? pre : pre;
  return shown ? `  > [${shown}] ` : '  > ';
}

/** What the answers will be, in words (one line wrapped): the confirm step and the summary say the same. */
export function answersWords(a: Answers, s: SetupState, given: Answers = {}): string {
  const parts: string[] = [];
  if (a.operator) parts.push(`operator ${a.operator}`);
  if (!s.identity.exists) parts.push(`identity: ${!a.identity || a.identity === 'generate' ? 'a new key' : 'imported'}`);
  const keyNow = a.key !== undefined ? Boolean(a.key) : s.providers.key || s.settingsKey;
  if (a.chat) parts.push(`chat: ${a.chat === 'openrouter' ? `OpenRouter (paid, cloud; key ${keyNow ? 'set' : 'not set'})` : chatWords('local', s, a.ollama)}`);
  else if (a.ollama) parts.push(`Ollama at ${hostOf(a.ollama)}`);
  if (a.logs) parts.push(`logs: ${a.logs === 'cloud' ? (a.edge || s.edgeHost ? `also your worker ${a.edge || s.edgeHost} (cloud)` : logsWords('cloud', s)) : 'this computer only'}`);
  if (a.project) parts.push(`project ${a.project}`);
  void given;
  return parts.join(' · ');
}

/** A line read with readline; null on Ctrl+C or the end of input. */
async function readLine(prompt: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const stop = new AbortController();
  rl.on('SIGINT', () => stop.abort());
  rl.on('close', () => stop.abort());
  try {
    return await rl.question(prompt, { signal: stop.signal });
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/** A line read with nothing shown but a * per character; null on Ctrl+C, Ctrl+D on an empty line, or the end of input. */
async function readHidden(prompt: string): Promise<string | null> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !input.setRawMode) return readLine(prompt);
  output.write(prompt);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    let typed = '';
    const done = (v: string | null): void => {
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      resolve(v);
    };
    const onEnd = (): void => done(null);
    const onKey = (s: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string } = {}): void => {
      if (key.ctrl && key.name === 'c') return done(null);
      if (key.ctrl && key.name === 'd' && !typed) return done(null);
      if (key.name === 'return' || key.name === 'enter') return done(typed);
      if (key.name === 'backspace') {
        if (typed) { typed = typed.slice(0, -1); output.write('\b \b'); }
        return;
      }
      if (key.ctrl || key.meta || !s) return;
      // a paste arrives as one string; anything with a control character in it is not part of a key
      for (const ch of s) {
        if (ch < ' ' || ch === '\x7f') continue;
        typed += ch;
        output.write('*');
      }
    };
    input.on('keypress', onKey);
    input.on('end', onEnd);
  });
}

export const terminalIO = (log: (s: string) => void = (s) => process.stdout.write(`${s}\n`)): SetupIO => ({ log, question: readLine, hidden: readHidden });

/**
 * Asks, in order, every question that has no answer and none given (`given`: flags), then shows what will be written and
 * asks to proceed. Returns the answers given now (with `given`), or why it stopped; writes nothing.
 */
export async function askSetup(o: { state: SetupState; given?: Answers; io: SetupIO; title: string; writes: string[] }): Promise<Asked> {
  const { state: s, io } = o;
  const given = o.given ?? {};
  const ask = io.question ?? readLine;
  const hidden = io.hidden ?? io.question ?? readHidden;
  const pending = pendingQuestions(s, given);
  io.log('');
  io.log(`  ${o.title}`);
  io.log('');
  if (pending.length) {
    for (const l of wrap(`${pending.length === 1 ? 'One question has' : `${pending.length} questions have`} no answer yet. Enter takes the answer in [brackets]; Ctrl+C stops, and nothing is written.`)) io.log(l);
  }
  const now: Answers = { ...given };
  const a = effectiveAnswers(s, given);
  for (const q of QUESTIONS) {
    if (!needsAsking(q, s, a, given)) continue;
    io.log('');
    for (const l of questionLines(q)) io.log(l);
    for (;;) {
      const typed = await (q.kind === 'secret' ? hidden : ask)(promptFor(q, a, s));
      if (typed === null) { io.log(''); io.log('  Stopped: nothing was written.'); return { stopped: 'interrupted' }; }
      const r = q.read(typed, a, s);
      if (!r.ok) { io.log(`  ${r.why}`); continue; }
      if (q.id === 'chat') a.chat = now.chat = r.value as Chat;
      else if (q.id === 'logs') a.logs = now.logs = r.value as Logs;
      else (a as Record<string, string>)[q.id] = (now as Record<string, string>)[q.id] = r.value;
      break;
    }
  }
  // a chosen OpenRouter with no key typed is no key: the chat stays without one, and the words say so
  if (now.chat === 'openrouter' && now.key === '') io.log('  No key given: the chat has no model key (the local model stays).');
  io.log('');
  io.log('  Will write only to:');
  for (const w of o.writes) io.log(`    ${w}`);
  for (const l of wrap(answersWords(a, s, given), 60, '    ')) io.log(l);
  const yes = await ask('  Proceed? [Y/n] ');
  if (yes === null) { io.log(''); io.log('  Stopped: nothing was written.'); return { stopped: 'interrupted' }; }
  const t = yes.trim().toLowerCase();
  if (t && t !== 'y' && t !== 'yes') { io.log('  Nothing was written.'); return { stopped: 'declined' }; }
  return { answers: now };
}
