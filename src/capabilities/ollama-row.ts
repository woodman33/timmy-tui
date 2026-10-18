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
 * of which was checked within the probe's time; needs setup otherwise, with the step. Nothing here asks anything: it words
 * what the probe found.
 *
 * R6 (H140; the R5 interaction review, defect 2): "needs setup" follows the HTTP answer at the address the chat asks
 * (src/capabilities/ollama-route.ts), never the `ollama` program on the PATH: nothing answering there needs setup whether or
 * not the program is here (it was "installed" with the program, "needs setup · brew install" without it), and the step fits
 * this computer: `ollama serve` with the program, else this platform's install (Homebrew only on macOS), or the setting that
 * names the address when the address is what is wrong.
 */
import type { OllamaAnswer } from '../agent/providers.js';
import { ollamaAddressStep, ollamaStartStep, type OllamaFrom } from './ollama-route.js';

/** What the probe found (a test's stand-in may give only ok and models: it is worded as before). */
export interface OllamaProbe { ok: boolean; models: string[]; base?: string; answer?: OllamaAnswer }

export const NO_OLLAMA_COMMAND = 'the ollama command is not on PATH';
const PULL = 'ollama pull <model> (a local model, not a cloud one)';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const hostOf = (base: string | undefined): string | undefined => { try { return base ? new URL(base).host : undefined; } catch { return undefined; } };

/** R4 (H88; r23): the local models that did not pass their check, or were not checked within the probe's time, in words. */
function rest(a: Extract<OllamaAnswer, { state: 'listed' }>, check: string): string {
  const parts = [
    a.failed ? `${a.failed} more did not pass ${check}` : '',
    a.late ? `${a.late} more ${a.late === 1 ? 'was' : 'were'} not checked within ${a.deadlineMs / 1000} s` : '',
  ].filter(Boolean);
  return parts.length ? `; ${parts.join(', and ')}` : '';
}

/** What Ollama's answer says, in words: the probe's states told apart (what was asked, and when, the ladder adds). */
export function ollamaAnswerWords(p: OllamaProbe): string {
  const a = p.answer;
  if (!a) return p.ok ? plural(p.models.length, 'local model') : 'no answer, or no local model';
  switch (a.state) {
    case 'not asked': return `not asked: ${a.why}`;
    case 'not sent': return `the request was not sent: ${a.why}`; // R4 (H88; r23)
    case 'no answer': return `nothing answered (${a.why})`;
    case 'unreadable': return `something answered, but not as Ollama (${a.why})`;
    case 'listed': {
      const local = a.checked + a.failed + a.late;
      const cloud = a.cloud ? `${plural(a.cloud, 'cloud model')}, which Timmy does not use as local ones` : '';
      // R4 (H88; r23): and how many did not pass, or were not checked in time (r23: 9 listed, 8 passed, the 9th unmentioned)
      if (a.checked) return `${plural(a.checked, 'local model')} passed ${a.checked === 1 ? 'its' : 'their'} /api/show check${rest(a, 'it')} (it lists ${plural(a.listed, 'model')}${cloud ? `, ${cloud}` : ''})`;
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

/**
 * The row, as /tools shows it. `cli`: the `ollama` program is on the PATH (said in the words; never the rung); `platform`: this
 * computer's (the install step fits it; process.platform when absent); `from`: where the address asked came from (the step for
 * a wrong address names that setting).
 */
export function ollamaRow(p: OllamaProbe, o: { cli: boolean; base?: string; platform?: NodeJS.Platform; from?: OllamaFrom }): { id: 'ollama'; kind: 'model'; name: string; rung: 'reachable' | 'installed' | 'needs setup'; detail: string; setup?: string } {
  const row = { id: 'ollama' as const, kind: 'model' as const, name: 'Ollama (local models)' };
  const host = hostOf(p.base ?? o.base);
  const at = host ? ` at ${host}` : '';
  const noCli = o.cli ? '' : `; ${NO_OLLAMA_COMMAND}`;
  const start = ollamaStartStep({ cli: o.cli, platform: o.platform ?? process.platform });
  const address = ollamaAddressStep(o.from);
  // R4 (H88; r23): with how many did not pass the check (r23: 9 local models listed, 8 passed, the 9th unmentioned)
  if (p.ok) return { ...row, rung: 'reachable', detail: `${plural(p.models.length, 'local model')}${p.answer?.state === 'listed' ? rest(p.answer, 'the /api/show check that establishes local completion weights') : ''}${noCli}` };
  const a = p.answer;
  // A probe that says no more than ok: false: nothing that answered is known, so it needs setup (R6, H140: never "installed"
  // for the program alone)
  if (!a) return { ...row, rung: 'needs setup', detail: `no answer, or no local model${noCli}`, setup: start };
  switch (a.state) {
    case 'listed': {
      const words = `Ollama answered${at}: ${ollamaAnswerWords(p)}${noCli}`;
      // Local models are there and their check did not finish in time: found, not shown working.
      if (a.late && a.checked + a.failed + a.late > 0) return { ...row, rung: 'installed', detail: words };
      return { ...row, rung: 'needs setup', detail: words, setup: PULL };
    }
    case 'unreadable':
      return { ...row, rung: 'needs setup', detail: `something answered${at}, but not as Ollama (${a.why})${noCli}`, setup: o.from === 'the chat setup' ? 'start Ollama there (ollama serve), or set it: /setup chat in the REPL' : 'start Ollama there (ollama serve), or set OLLAMA_HOST to where it listens' };
    case 'not asked':
      return { ...row, rung: 'needs setup', detail: `not asked: ${a.why}${noCli}`, setup: o.from === 'the chat setup' ? address : 'set OLLAMA_HOST to a loopback address, such as 127.0.0.1:11434' };
    case 'not sent':
      // R4 (H88; the Mac run r23): OLLAMA_HOST=127.0.0.1:9: fetch refuses that port itself, so nothing was asked there
      return { ...row, rung: 'needs setup', detail: `the request to ${host ?? 'the local Ollama'} was not sent: ${a.why}${noCli}`, setup: address };
    case 'no answer':
      // R6 (H140): nothing answered at the address the chat asks: it needs setup, with the program or without it
      return o.cli
        ? { ...row, rung: 'needs setup', detail: `nothing answered${at} (${a.why})`, setup: start }
        : { ...row, rung: 'needs setup', detail: `${NO_OLLAMA_COMMAND}, and nothing answered${at} (${a.why})`, setup: start };
  }
}
