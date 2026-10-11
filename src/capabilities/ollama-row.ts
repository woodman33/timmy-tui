/**
 * Round R4 (helper H82; the review of 6fb765a..4338fdb, finding 2): the Ollama row of /tools, from the server's own answer
 * (src/agent/providers.ts probeOllama). The probe's `ok: false` lumped together no answer, an answer that is not Ollama's,
 * a list of only cloud models, and local models whose /api/show check did not finish within the probe's 1.5 s; and the
 * row then said "needs setup · not installed" whenever the ollama command was not on PATH. On the Mac (r22) a sandbox whose
 * PATH had no ollama command was told so while Ollama answered at 127.0.0.1:11434. The row now says what the server
 * answered, and the command's absence on its own ("the ollama command is not on PATH"): Timmy asks the server over HTTP;
 * the command is needed only to set up (ollama serve, ollama pull).
 *
 * The rung: reachable when a local model passed its check; installed when Ollama answered and listed local models none
 * of which was checked within the probe's time, or when nothing answered and the command is here (as before); needs setup
 * otherwise, with the step. Nothing here asks anything: it words what the probe found.
 */
import type { OllamaAnswer } from '../agent/providers.js';

/** What the probe found (a test's stand-in may give only ok and models: it is worded as before). */
export interface OllamaProbe { ok: boolean; models: string[]; base?: string; answer?: OllamaAnswer }

export const NO_OLLAMA_COMMAND = 'the ollama command is not on PATH';
const INSTALL = 'brew install ollama; brew services start ollama; ollama pull <model>';
const PULL = 'ollama pull <model> (a local model, not a cloud one)';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const hostOf = (base: string | undefined): string | undefined => { try { return base ? new URL(base).host : undefined; } catch { return undefined; } };

/** What Ollama's answer says, in words: the probe's states told apart (what was asked, and when, the ladder adds). */
export function ollamaAnswerWords(p: OllamaProbe): string {
  const a = p.answer;
  if (!a) return p.ok ? plural(p.models.length, 'local model') : 'no answer, or no local model';
  switch (a.state) {
    case 'not asked': return `not asked: ${a.why}`;
    case 'no answer': return `nothing answered (${a.why})`;
    case 'unreadable': return `something answered, but not as Ollama (${a.why})`;
    case 'listed': {
      const local = a.checked + a.failed + a.late;
      const cloud = a.cloud ? `${plural(a.cloud, 'cloud model')}, which Timmy does not use as local ones` : '';
      if (a.checked) return `${plural(a.checked, 'local model')} passed ${a.checked === 1 ? 'its' : 'their'} /api/show check (it lists ${plural(a.listed, 'model')}${cloud ? `, ${cloud}` : ''})`;
      if (!a.listed) return 'it lists no model';
      if (!local) return `it lists only ${cloud || 'models whose names Timmy does not read'}`;
      const parts: string[] = [];
      const check = 'the /api/show check that establishes local completion weights';
      if (a.failed) parts.push(a.failed === local ? `none passed ${check}` : `${a.failed} did not pass ${check}`);
      if (a.late) parts.push(a.late === local ? `no model was checked within ${a.deadlineMs / 1000} s` : `${a.late} ${a.late === 1 ? 'was' : 'were'} not checked within ${a.deadlineMs / 1000} s`);
      return `it lists ${plural(local, 'local model')}${cloud ? ` and ${cloud}` : ''}; ${parts.join(', and ')}`;
    }
  }
}

/** The row, as /tools shows it. */
export function ollamaRow(p: OllamaProbe, o: { cli: boolean; base?: string }): { id: 'ollama'; kind: 'model'; name: string; rung: 'reachable' | 'installed' | 'needs setup'; detail: string; setup?: string } {
  const row = { id: 'ollama' as const, kind: 'model' as const, name: 'Ollama (local models)' };
  const host = hostOf(p.base ?? o.base);
  const at = host ? ` at ${host}` : '';
  const noCli = o.cli ? '' : `; ${NO_OLLAMA_COMMAND}`;
  if (p.ok) return { ...row, rung: 'reachable', detail: `${plural(p.models.length, 'local model')}${noCli}` };
  const a = p.answer;
  // A probe that says no more than ok: false: the words it had before.
  if (!a) return o.cli ? { ...row, rung: 'installed', detail: 'no answer, or no local model: ollama serve' } : { ...row, rung: 'needs setup', detail: 'not installed', setup: INSTALL };
  switch (a.state) {
    case 'listed': {
      const words = `Ollama answered${at}: ${ollamaAnswerWords(p)}${noCli}`;
      // Local models are there and their check did not finish in time: found, not shown working.
      if (a.late && a.checked + a.failed + a.late > 0) return { ...row, rung: 'installed', detail: words };
      return { ...row, rung: 'needs setup', detail: words, setup: PULL };
    }
    case 'unreadable':
      return { ...row, rung: 'needs setup', detail: `something answered${at}, but not as Ollama (${a.why})${noCli}`, setup: 'start Ollama there (ollama serve), or set OLLAMA_HOST to where it listens' };
    case 'not asked':
      return { ...row, rung: 'needs setup', detail: `not asked: ${a.why}${noCli}`, setup: 'set OLLAMA_HOST to a loopback address, such as 127.0.0.1:11434' };
    case 'no answer':
      return o.cli
        ? { ...row, rung: 'installed', detail: `nothing answered${at} (${a.why}): ollama serve` }
        : { ...row, rung: 'needs setup', detail: `${NO_OLLAMA_COMMAND}, and nothing answered${at} (${a.why})`, setup: INSTALL };
  }
}
