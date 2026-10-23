/**
 * R5 (H131; the operator's finish line, item 3): the Workbench's own paths for the fixes the workspace frame names when chat
 * cannot answer (src/ops/workspace-frame.ts chatFix), so that Enter does the thing where the Workbench can do it honestly, and
 * says the specific command where only a shell can:
 *
 *   /model free            the free models in this computer's OpenRouter catalog (src/agent/model-price.ts freeModels), with
 *                          their context and tool calling; the one chosen is saved as the chat's model (src/utils/config.ts
 *                          saveConfig). With no catalog, that is said, with the command that fetches one. Never a made-up list.
 *   /model, local route    what the Ollama the setup names lists now (src/setup/ollama-models.ts listOllamaModels: the list
 *                          the setup's chat question shows and `timmy init --chat local --model` checks a name against; a
 *                          request to that Ollama, no charge); the one chosen becomes the local chat's model through the
 *                          setup's writer (src/utils/init.ts applySetup, the writer of timmy init --chat local --model)
 *   timmy workspace check  the connection check, in this process (src/ops/workspace-frame.ts checkConnections): free requests
 *                          only, no model called
 *   timmy init …,          the guided setup is a shell's (`timmy init`; `timmy setup` makes a governed workspace's folders and
 *   timmy setup,           asks nothing): what it asks now, for the command's own flags (src/setup/questions.ts
 *   /setup chat            pendingQuestions); a key is typed there, hidden, never into a tab
 *
 * Why the Ollama list is the setup's and not the connection check's probe (src/agent/providers.ts probeOllama): the probe asks
 * OLLAMA_HOST (else 127.0.0.1:11434), and the local chat asks the address the setup recorded (src/agent/chat-route.ts
 * resolveChatRoute). The model chosen here is for that chat, so the list is that Ollama's, the same GET /api/tags.
 *
 * The deps are the real modules, each loaded when first used; a test gives FAKE ones (no network, no real settings).
 */
import { readFileSync } from 'node:fs';
import type { ConnectionCheck, ConnectionsRecord } from '../ops/workspace-frame.js';
import type { LocalModelCheck } from '../setup/local-model-check.js';

export type { LocalModelCheck };

type Env = Record<string, string | undefined>;

/** The free models this computer knows, and which catalog says so. */
export interface FreeCatalog {
  /** fetched: the catalog this computer fetched (timmy models --refresh); shipped: the snapshot that came with Timmy; none */
  from: 'fetched' | 'shipped' | 'none';
  /** the catalog's date (YYYY-MM-DD), or null with none */
  at: string | null;
  models: Array<{ id: string; ctx?: number; tools: boolean | null }>;
}

/** What the Ollama the setup names answered (GET /api/tags), as the box shows it. */
export interface OllamaList {
  /** the address asked, in words: "Ollama at 127.0.0.1:11434" (another computer's says so) */
  where: string;
  /** it answered with its list */
  answered: boolean;
  /** the models it lists that run on that Ollama, with their facts: the ones offered here (cloud-backed ones are not). R10
   *  CHAT (H167): `chat`, the probe's /api/show check of it (src/models/ollama-list.ts assertLocalOllamaModel: local
   *  completion weights): false, its answer does not establish a chat model (an embedding or a classifier); null, not checked
   *  (no answer in time, or an Ollama the probe does not ask: another computer's); absent, not asked */
  models: Array<{ name: string; facts: string; chat?: boolean | null }>;
  /** how many it lists, and how many of those are cloud-backed */
  listed: number;
  cloud: number;
  /** with no answer: why, in words ("Ollama at 127.0.0.1:11434 did not answer (…)") */
  why?: string;
}

/** What a `timmy init …` command asks now, and where the OpenRouter key in use comes from. */
export interface SetupPlan {
  /** the titles of the questions it asks now, in order (none: every one has an answer); null: its flags could not be read */
  asks: string[] | null;
  /** where the OpenRouter key in use comes from (src/utils/model-key.ts modelKeySource), or null: no key is set */
  keyFrom: 'environment' | 'timmy-tui.config.json' | 'providers.json' | 'settings' | null;
}

export interface SetupDeps {
  /** the free models and their catalog (files only: no request) */
  freeModels: () => Promise<FreeCatalog>;
  /** R10 CHAT (H167): OpenRouter's catalog as this computer keeps it (files only: the one it fetched, else the snapshot shipped
   *  with Timmy; no request), for the Models rail */
  catalog?: () => Promise<{ from: 'fetched' | 'shipped' | 'none'; at: string | null; models: unknown[] }>;
  /** saves the chat's OpenRouter model in Timmy's settings; the settings file written */
  saveModel: (id: string) => Promise<{ path: string }>;
  /** the models the Ollama the setup names lists now (a request to it, no charge) */
  ollama: () => Promise<OllamaList>;
  /** R11 (H167; step 1a, the operator's first-use failure): the readiness of one local model on the Ollama the setup names,
   *  now (H170's checkLocalModel: one POST /api/show of that exact name, no model run; it never throws: every outcome is a
   *  state with words). `signal` cancels the request. */
  checkLocal: (model: string, signal?: AbortSignal) => Promise<LocalModelCheck>;
  /** the local chat's model, written as the setup's answer; the files written. R11 (H167; step 1a): on a home with no
   *  identity yet, the identity is made first, through the same writer as timmy init's, and `identity` says so; before,
   *  the choice was refused there and the person sent to a shell. */
  setLocal: (model: string) => Promise<{ written: string[]; identity?: boolean }>;
  /** the connection check (free requests only); the record it wrote, and where */
  check: () => Promise<{ record: ConnectionsRecord; path: string }>;
  /** what `command` (timmy init with its flags; timmy setup and /setup as plain timmy init) asks now */
  setupPlan: (command: string) => Promise<SetupPlan>;
  /** whether this computer has no Timmy identity yet (the setup has not run) */
  blank: () => Promise<boolean>;
}

function readCatalogFile(path: string): { fetchedAt: string; models: Array<{ id: string }> } | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { fetchedAt?: unknown; models?: unknown } | unknown[];
    if (Array.isArray(j)) return { fetchedAt: '1970-01-01T00:00:00.000Z', models: j as Array<{ id: string }> };
    if (j && Array.isArray(j.models)) return { fetchedAt: typeof j.fetchedAt === 'string' ? j.fetchedAt : '', models: j.models as Array<{ id: string }> };
    return null;
  } catch { return null; }
}

/** The flags of a `timmy init …` command as the setup reads them; a <placeholder> is the person's to give, so it is left out. */
export function initFlags(command: string): string[] {
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'timmy' || words[1] !== 'init') return [];
  return words.slice(2).filter((w) => !/^<[^>]*>$/.test(w));
}

/** The real paths, over `env`. */
export function realSetupDeps(env: Env = process.env): SetupDeps {
  return {
    freeModels: async () => {
      const { cachePath, catalogPath } = await import('../models/registry.js');
      const { freeModels } = await import('../agent/model-price.js');
      const fetched = readCatalogFile(catalogPath(env));
      const cache = fetched ?? readCatalogFile(cachePath());
      if (!cache) return { from: 'none', at: null, models: [] };
      return { from: fetched ? 'fetched' : 'shipped', at: cache.fetchedAt.slice(0, 10) || null, models: freeModels(cache as Parameters<typeof freeModels>[0]) };
    },
    catalog: async () => {
      const { cachePath, catalogPath } = await import('../models/registry.js');
      const fetched = readCatalogFile(catalogPath(env));
      const cache = fetched ?? readCatalogFile(cachePath());
      if (!cache) return { from: 'none', at: null, models: [] };
      return { from: fetched ? 'fetched' : 'shipped', at: cache.fetchedAt.slice(0, 10) || null, models: cache.models };
    },
    saveModel: async (id) => {
      const { getConfig, saveConfig } = await import('../utils/config.js');
      saveConfig({ model: id });
      return { path: getConfig().path };
    },
    ollama: async () => {
      const { OLLAMA_DEFAULT, readSetupState } = await import('../setup/questions.js');
      const { atWords, listOllamaModels, listProblem, modelFacts: listedFacts } = await import('../setup/ollama-models.js');
      const s = readSetupState(env);
      // the address the local chat asks (src/agent/chat-route.ts resolveChatRoute), as `timmy init --model` checks a name there
      const host = s.providers.ollama ?? s.recorded?.answers.ollama ?? OLLAMA_DEFAULT;
      const list = await listOllamaModels(host, { timeoutMs: 5000 });
      if (!list.ok) return { where: list.at ? atWords(list.at) : `Ollama at ${host}`, answered: false, models: [], listed: 0, cloud: 0, why: listProblem(list, host) };
      const runs = list.models.filter((m) => !m.cloud);
      // R10 CHAT (H167; the lead's Mac check of 50237ef): each one's /api/show check, the probe's own (local completion
      // weights): an embedding or a decision model it does not establish is not offered as a chat model. One request each, no
      // model run; a loopback Ollama only (the probe asks no other)
      const { assertLocalOllamaModel, getLocalOllamaBaseUrl } = await import('../models/ollama-list.js');
      let base: string | null = null;
      try { base = getLocalOllamaBaseUrl(host); } catch { base = null; }
      // (its answer naming a remote host is a cloud-backed model: counted with the cloud ones, not offered here)
      const chat = await Promise.all(runs.map(async (m): Promise<boolean | null | 'cloud'> => {
        if (!base) return null;
        try { await assertLocalOllamaModel(m.name, 4000, { baseUrl: base }); return true; } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          return /refuses cloud-backed/.test(why) ? 'cloud' : /does not establish/.test(why) ? false : null;
        }
      }));
      const local = runs.flatMap((m, i) => { const ok = chat[i]; return ok === 'cloud' ? [] : [{ name: m.name, facts: listedFacts(m, list.at), chat: ok }]; });
      return { where: atWords(list.at), answered: true, models: local, listed: list.models.length, cloud: list.models.length - local.length };
    },
    checkLocal: async (model, signal) => {
      const { OLLAMA_DEFAULT, readSetupState } = await import('../setup/questions.js');
      const { checkLocalModel } = await import('../setup/local-model-check.js');
      const s = readSetupState(env);
      // the address the local chat asks (the same one ollama() lists from), so the check is of the Ollama the turn would ask
      const host = s.providers.ollama ?? s.recorded?.answers.ollama ?? OLLAMA_DEFAULT;
      return checkLocalModel(model, { env, origin: host, ...(signal ? { signal } : {}) });
    },
    setLocal: async (model) => {
      const { readSetupState } = await import('../setup/questions.js');
      const { applySetup } = await import('../utils/init.js');
      // R11 (H167; step 1a, the lead's brief and his 08:58 word): a home with no identity yet is set up here, as `timmy init
      // --yes --chat local --model <model>` would set it up, by the same writer (a new ed25519 identity, providers.json with
      // the Ollama address, setup.json recorded as made by 'timmy workbench', the first project), so the first run never sends
      // the person to a shell. R10 refused this ("never a side effect here"): the operator's first use ran into that refusal.
      const fresh = !readSetupState(process.env).identity.exists;
      const r = applySetup({ chat: 'local', model, ...(fresh ? { identity: 'generate' } : {}) }, { by: 'timmy workbench' });
      return { written: r.written, ...(fresh ? { identity: true } : {}) };
    },
    check: async () => (await import('../ops/workspace-frame.js')).checkConnections({ env }),
    setupPlan: async (command) => {
      const { modelKeySource } = await import('../utils/model-key.js');
      const keyFrom = (() => { try { return modelKeySource(env); } catch { return null; } })();
      const { answersFromFlags, parseInitArgs } = await import('../utils/init.js');
      const o = parseInitArgs(initFlags(command));
      if (o.error) return { asks: null, keyFrom };
      const { pendingQuestions, readSetupState } = await import('../setup/questions.js');
      return { asks: pendingQuestions(readSetupState(env), answersFromFlags(o)).map((q) => q.title), keyFrom };
    },
    blank: async () => (await import('../setup/home.js')).isBlankSlate(env),
  };
}

// ── words ──────────────────────────────────────────────────────────────────────

const CHECK_NAMES: ReadonlyArray<[keyof ConnectionsRecord['checks'], string]> = [
  ['openrouter', 'OpenRouter (its key endpoint, no model called)'],
  ['ollama', 'Ollama (its list of models)'],
  // (R10 H169's connection, asked only with its key: its model list, no model run)
  ['ollama-cloud', 'Ollama Cloud (its model list, with the key; no model run)'],
  ['studio', 'Timmy Studio'],
  ['companion', 'Browser companion'],
  ['cloudflare', 'Cloudflare edge'],
];

const answerWords = (c: ConnectionCheck): string => {
  // R7 lead (H148's N4): 'no model': it answered, with nothing Timmy can use
  const said = c.answer === 'accepted' ? 'answered' : c.answer === 'refused' ? 'refused' : c.answer === 'no answer' ? 'did not answer' : c.answer === 'not running' ? 'not running' : c.answer === 'no model' ? 'answered, with no model Timmy can use' : 'not asked';
  return c.detail ? `${said}: ${c.detail}` : said;
};

/**
 * What one run of the check asked and what came back, a row a service, from the record it wrote: a service asked now (its
 * check made at `since` or later) in its answer's words; one not asked now says why (no key, none set up), never an older
 * answer as if it were new.
 */
export function checkRows(record: ConnectionsRecord, since: number): Array<{ name: string; words: string; answered: boolean }> {
  return CHECK_NAMES.map(([id, name]) => {
    const c = record.checks[id];
    if (c && Date.parse(c.at) >= since) return { name, words: answerWords(c), answered: c.answer === 'accepted' };
    const why = id === 'openrouter' ? 'not asked: no OpenRouter key is set up' : id === 'ollama-cloud' ? 'not asked: no Ollama Cloud key is set up' : id === 'cloudflare' ? 'not asked: none is set up' : 'not asked this time';
    return { name, words: why, answered: false };
  });
}

/** How the free models' catalog is said: which one, of when, and how to fetch the current one. */
export function catalogWords(c: Pick<FreeCatalog, 'from' | 'at'>): string {
  if (c.from === 'fetched') return `From the OpenRouter catalog this computer fetched on ${c.at ?? 'an unknown day'} (timmy models --refresh fetches it again: a free request, in a shell).`;
  if (c.from === 'shipped') return `From the catalog that came with Timmy (of ${c.at ?? 'an unknown day'}): this computer has fetched none. timmy models --refresh fetches the current one (a free request, in a shell).`;
  return 'This computer has no OpenRouter catalog, so no model is listed here. timmy models --refresh fetches it (a free request, in a shell); then this lists its free models.';
}

/** A model's context and tool calling, as the catalog says them. */
export function modelFacts(m: { ctx?: number; tools: boolean | null }): string {
  const ctx = m.ctx ? `${m.ctx >= 1e6 ? `${Number((m.ctx / 1e6).toFixed(2))}M` : `${Math.round(m.ctx / 1000)}k`} context` : 'context not listed';
  const tools = m.tools === true ? 'tools' : m.tools === false ? 'no tools' : 'tool calling not listed';
  return `${ctx} · ${tools}`;
}

/** Where the OpenRouter key in use comes from, in words. */
export function keyFromWords(from: NonNullable<SetupPlan['keyFrom']>): string {
  switch (from) {
    case 'environment': return 'the environment (OPENROUTER_API_KEY, or a .env in the working folder)';
    case 'timmy-tui.config.json': return 'timmy-tui.config.json in the working folder';
    case 'providers.json': return 'Timmy\'s providers.json, where the setup keeps it';
    case 'settings': return 'the monitor\'s settings';
  }
}
