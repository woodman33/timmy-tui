/**
 * R4 (H103): what `timmy doctor` says of the chat's route (scripts/timmy-doctor.ts). The REPL answers by the route the setup
 * chose (src/agent/chat-route.ts): the local model needs no key, so a home whose chat is local and has a model chosen is not
 * "no model key" (exit 78): the doctor says that route, and whether its Ollama answers and lists the model now (one GET
 * /api/tags, the list only: no model is run). Without a local route the doctor's own key lines stand.
 */
import { atWords, cloudModelTag, listOllamaModels, listProblem, type ModelList } from '../setup/ollama-models.js';
import { resolveChatRoute } from './chat-route.js';

type Env = Record<string, string | undefined>;

export interface ChatReadiness {
  route: 'local' | 'openrouter';
  /** a model can answer by this route as configured now: a key, or the local model chosen and listed by its Ollama */
  answers: boolean;
  /** on the local route: the doctor's REPL line, its exit line and its next step, in place of the key's */
  replLine?: string;
  exitLine?: string;
  next?: string;
  /** what `timmy doctor --json` adds (never a key) */
  json: Record<string, unknown>;
}

const CODES = 'The codes: 0 ready, 78 the chat cannot answer (no model key, or the local model not ready), 1 cannot start. The lanes never change them; `timmy doctor preflight` exits 1 while they are blocked.';

export async function chatReadiness(o: { env: Env; node: string; keySource: string | null; list?: (host: string) => Promise<ModelList> }): Promise<ChatReadiness> {
  const route = (() => { try { return resolveChatRoute({ env: o.env }); } catch { return { kind: 'openrouter' as const }; } })();
  if (route.kind !== 'local') return { route: 'openrouter', answers: o.keySource !== null, json: { route: 'openrouter', key: o.keySource ?? 'none' } };
  const node = o.node.replace(/^v/, '');
  const notYet = (why: string, fix: string, json: Record<string, unknown>): ChatReadiness => ({
    route: 'local', answers: false,
    replLine: `  ! REPL: opens, but its chat cannot answer yet (Node ${node}): ${why}; ${fix}`,
    exitLine: `Exit 78: the REPL opens, but its chat cannot answer until the local model is ready (above). ${CODES}`,
    next: `Next step: ${fix.split('; ')[0]}, then \`timmy\` opens the REPL.`,
    json: { route: 'local', ...json },
  });
  if ('error' in route.at) return notYet(`the chat is set to the local model, and its Ollama address (${route.host}) is not one Timmy uses: ${route.at.error}`, 'timmy init --chat local --ollama <host>', { host: route.host, ready: false });
  const where = atWords(route.at);
  if (!route.model) return notYet(`the chat is set to the local model (${where}), and no model is chosen`, 'timmy init --chat local --model <name> (a model Ollama lists); or /model in the REPL', { host: route.at.host, model: null, ready: false });
  const list = await (o.list ?? ((host: string) => listOllamaModels(host, { timeoutMs: 1500 })))(route.host);
  const json = { host: route.at.host, model: route.model, from: route.from, cloud: route.cloud };
  if (!list.ok) return notYet(`the chat is the local model ${route.model}, and ${listProblem(list, route.host)}`, 'start Ollama (the Ollama app, or ollama serve)', { ...json, ollama: list.state, ready: false });
  if (!list.models.some((m) => m.name === route.model)) return notYet(`the chat is the local model ${route.model}, and ${where} answers but lists no model by that name`, `ollama pull ${route.model} (Timmy downloads nothing), or timmy init --chat local --model <name>`, { ...json, ollama: 'listed', listed: false, ready: false });
  const leaves = cloudModelTag(route.model) || !route.at.loopback;
  return {
    route: 'local', answers: true,
    replLine: `  ✓ REPL: ready (Node ${node}): the chat is the local model ${route.model} on ${where}, which lists it now; no model key is needed${leaves ? ` (${cloudModelTag(route.model) ? 'ollama cloud: it runs on Ollama\'s servers; your account\'s terms' : 'another computer'}: the chat leaves this computer, and no cost comes back)` : ', and nothing is charged'}. No model was run.`,
    exitLine: `Exit 0: the REPL is ready. ${CODES}`,
    next: 'Next step: `timmy` opens the REPL.',
    json: { route: 'local', ...json, ollama: 'listed', listed: true, ready: true },
  };
}
