/**
 * R4 (H103): the setup's chat question as a terminal asks it (./terminal.ts askSetup), with the models the Ollama the setup
 * names lists (GET /api/tags; nothing is loaded or downloaded). Each model is numbered and labelled: local weights, or
 * cloud-backed (Ollama sends the chat off this computer; never preselected). OpenRouter stays the paid choice it was. With no
 * model it says how to get one (Timmy downloads nothing) and the local chat stays off until one is chosen ("none chosen").
 *
 * The monitor's own first run asks the same question without the list (l or o, ./questions.ts); the REPL's /setup chat asks
 * it here, again, with the list. Node only, and nothing outside src/setup (./home.ts).
 */
import { atWords, listProblem, modelFacts, PULL_WORDS, validOllamaModelName, type ListedModel, type ModelList } from './ollama-models.js';
import { question, type Chat } from './questions.js';

/** What the question shows, what Enter takes, and how a typed answer reads. */
export interface ChatChoices {
  lines: string[];
  /** shown in [brackets]: a model's number, or l (the local chat, none chosen) */
  shown: string;
  read(typed: string): { ok: true; chat: Chat; model?: string } | { ok: false; why: string };
}

/** The chat question's lines and reader for this list (`wrap`: ./terminal.ts's, lines within 60 columns). */
export function chatChoices(list: ModelList, host: string, wrap: (words: string, width?: number, indent?: string) => string[]): ChatChoices {
  const q = question('chat');
  const openrouter = q.choices?.find((c) => c.value === 'openrouter');
  const models: ListedModel[] = list.ok ? list.models : [];
  const firstLocal = models.findIndex((m) => !m.cloud);
  const lines = [`  ${q.title}`];
  if (!list.ok) lines.push(...wrap(`${capital(listProblem(list, host))}.`, 60, '    '));
  else if (!models.length) lines.push(...wrap(`${atWords(list.at)} lists no model.`, 60, '    '));
  else {
    lines.push(...wrap(`${atWords(list.at)} lists ${models.length === 1 ? 'one model' : `${models.length} models`}:`, 60, '    '));
    models.forEach((m, i) => {
      const n = String(i + 1).padStart(2);
      const rows = wrap(`${m.name} · ${modelFacts(m, list.at)}`, 60, '        ');
      lines.push(`    ${n}  ${rows[0].trimStart()}`, ...rows.slice(1));
    });
    if (models.some((m) => !m.cloud)) {
      lines.push(...wrap(list.at.loopback ? 'Local weights: on this computer, free, private, no key.' : `Local weights: on ${list.at.host}; the chat leaves this computer for that one.`, 60, '    '));
    }
  }
  if (firstLocal < 0) {
    lines.push('    l  local model only: off until a model is chosen');
    lines.push(...wrap(`${PULL_WORDS} Then /setup chat in the REPL.`, 60, '       '));
  }
  if (openrouter) {
    lines.push(`    ${openrouter.key}  ${openrouter.label}`);
    lines.push(...wrap(openrouter.note, 60, '       '));
  }
  // the numbers as a person says them: 1; 1, 2; 1 to 3
  const numbers = models.length === 0 ? '' : models.length === 1 ? '1' : models.length === 2 ? '1, 2' : `1 to ${models.length}`;
  const keys = [numbers, firstLocal < 0 ? 'l' : '', openrouter ? openrouter.key : ''].filter(Boolean);
  const typeWords = `Type ${keys.length > 1 ? `${keys.slice(0, -1).join(', ')} or ${keys.at(-1)}` : keys[0]}; Enter takes the one in brackets.`;
  lines.push(...wrap(typeWords, 60, '    '));
  const shown = firstLocal >= 0 ? String(firstLocal + 1) : 'l';
  const read = (typed: string): ReturnType<ChatChoices['read']> => {
    const t = typed.trim();
    const lower = t.toLowerCase();
    if (t === '') return firstLocal >= 0 ? { ok: true, chat: 'local', model: models[firstLocal].name } : { ok: true, chat: 'local', model: '' };
    if (/^\d{1,3}$/.test(t)) {
      const m = models[Number(t) - 1];
      return m ? { ok: true, chat: 'local', model: m.name } : { ok: false, why: models.length ? `No model number ${t}: type ${models.length === 1 ? '1' : models.length === 2 ? '1 or 2' : `1 to ${models.length}`}.` : 'There is no model to number here.' };
    }
    if (openrouter && (lower === openrouter.key || lower === 'openrouter')) return { ok: true, chat: 'openrouter' };
    if (lower === 'l' || lower === 'local') return firstLocal >= 0 ? { ok: true, chat: 'local', model: models[firstLocal].name } : { ok: true, chat: 'local', model: '' };
    const named = models.find((m) => m.name === t);
    if (named) return { ok: true, chat: 'local', model: named.name };
    // Ollama gave no list: a model's own name is taken as typed, and checked at the chat's first message
    if (!list.ok && validOllamaModelName(t)) return { ok: true, chat: 'local', model: t };
    return { ok: false, why: typeWords };
  };
  return { lines, shown, read };
}

const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
