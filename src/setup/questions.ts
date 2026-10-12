/**
 * Timmy's one guided setup (round R4, H98): the questions `timmy init`, the monitor (`timmy watch`) and the REPL's /setup
 * ask, from this one list. Before, `timmy init` asked four things in the terminal and the monitor then asked its own FIRST
 * RUN (a brain, a key, Cloudflare log sync, the log archive), whose defaults leaned to the cloud (OpenRouter first, sync to
 * a worker); the operator met two setups (r24).
 *
 * Now:
 * - the answers are saved once, in the Timmy home (setup.json, 0600, never a key; a key goes to providers.json, 0600, as
 *   `timmy init` always kept it), and each question is asked only while it has no answer: what an older `timmy init` wrote
 *   (identity.json, providers.json, the project folder) counts as an answer;
 * - the local model (Ollama at the home's host) and local-only logs are preselected; anything cloud or paid is opt-in and
 *   says so where it is offered;
 * - an identity is never replaced (an existing identity.json and identity.seed stay as they are).
 *
 * This module only reads and words; src/utils/init.ts writes the answers (applySetup), src/setup/terminal.ts asks in a
 * terminal, src/tui/Onboarding.tsx asks inside the monitor. It needs nothing but node (see ./home.ts).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { identityPath, privateDir, setupPath, settingsFile, timmyHome, workspaceRoot, type Env } from './home.js';

export const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
export const OPERATOR_DEFAULT = 'operator';
export const PROJECT_DEFAULT = 'first-light';

export type QuestionId = 'operator' | 'identity' | 'ollama' | 'chat' | 'key' | 'logs' | 'edge' | 'project';
export type Chat = 'local' | 'openrouter';
export type Logs = 'local' | 'cloud';

/** Answers as given now (a key and a seed are never recorded in setup.json). */
export interface Answers {
  operator?: string;
  /** 'generate', a 64-hex ed25519 seed, or a path to a PEM private key */
  identity?: string;
  ollama?: string;
  chat?: Chat;
  /** the OpenRouter key; '' is "no key" */
  key?: string;
  logs?: Logs;
  /** the Cloudflare worker's host for log sync; '' is "none yet" */
  edge?: string;
  project?: string;
  /** `--anthropic <key>` only: kept in providers.json as before (nothing in Timmy reads it yet); never asked */
  anthropic?: string;
}

/** What setup.json records: who answered, when, and each answer in words a person can read (never a key). */
export interface Recorded {
  version: 1;
  by?: string;
  at?: string;
  /** `edge`: the worker's host as answered ('' is "none yet": answered, so not asked again) */
  answers: { operator?: string; identity?: string; ollama?: string; chat?: Chat; logs?: Logs; edge?: string; project?: string };
}

/** What the home holds now, read without writing anything. */
export interface SetupState {
  home: string;
  privateDir: string;
  identity: { exists: boolean; operator?: string; operatorId?: string; source?: string };
  providers: { exists: boolean; ollama?: string; key: boolean };
  /** the monitor's settings hold a key (its old FIRST RUN saved one there) */
  settingsKey: boolean;
  /** the monitor's settings say its old FIRST RUN finished */
  onboarded: boolean;
  /** OPENROUTER_API_KEY is set in this environment (it is used while it is set; it is not an answer) */
  envKey: boolean;
  /** the worker's host: the private overlay's edge_host, else TIMMY_EDGE_HOST */
  edgeHost?: string;
  /** folders under <home>/projects */
  projects: string[];
  /** the private overlay's first_project */
  firstProject?: string;
  recorded: Recorded | null;
}

const readJson = (file: string): unknown => {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as unknown : undefined; } catch { return undefined; }
};
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
/** The overlay's placeholder form (lanes/privacy/overlay.mjs isPlaceholder): `<hostname>` and the like are not values. */
const placeholder = (v: string): boolean => /^<[a-z-]+>$/.test(v);

/** Reads what the home and the workspace's private folder hold now. Writes nothing. */
export function readSetupState(env: Env = process.env, workspace: string = workspaceRoot(env)): SetupState {
  const home = timmyHome(env);
  const priv = privateDir(workspace, env);
  const id = readJson(identityPath(env));
  const providers = readJson(join(home, 'providers.json'));
  const settings = readJson(settingsFile(env));
  const overlay = readJson(join(priv, 'config.json'));
  const rec = readJson(setupPath(env));
  let projects: string[] = [];
  try {
    projects = readdirSync(join(home, 'projects')).filter((n) => !n.startsWith('.') && (() => { try { return statSync(join(home, 'projects', n)).isDirectory(); } catch { return false; } })()).sort();
  } catch { /* no projects folder */ }
  const edgeOverlay = isObject(overlay) ? text(overlay.edge_host) : undefined;
  const edgeEnv = text(env.TIMMY_EDGE_HOST);
  const edgeHost = [edgeOverlay, edgeEnv].find((h): h is string => Boolean(h) && !placeholder(h!));
  const answers = isObject(rec) && isObject(rec.answers) ? rec.answers : undefined;
  const recorded: Recorded | null = answers ? {
    version: 1,
    ...(text((rec as Record<string, unknown>).by) ? { by: text((rec as Record<string, unknown>).by) } : {}),
    ...(text((rec as Record<string, unknown>).at) ? { at: text((rec as Record<string, unknown>).at) } : {}),
    answers: {
      ...(text(answers.operator) ? { operator: text(answers.operator) } : {}),
      ...(text(answers.identity) ? { identity: text(answers.identity) } : {}),
      ...(text(answers.ollama) ? { ollama: text(answers.ollama) } : {}),
      ...(answers.chat === 'local' || answers.chat === 'openrouter' ? { chat: answers.chat } : {}),
      ...(answers.logs === 'local' || answers.logs === 'cloud' ? { logs: answers.logs } : {}),
      ...(typeof answers.edge === 'string' && !CONTROL.test(answers.edge) ? { edge: answers.edge.trim() } : {}),
      ...(text(answers.project) ? { project: text(answers.project) } : {}),
    },
  } : null;
  return {
    home,
    privateDir: priv,
    identity: isObject(id)
      ? { exists: true, ...(text(id.operator) ? { operator: text(id.operator) } : {}), ...(text(id.operator_id) ? { operatorId: text(id.operator_id) } : {}), ...(text(id.seed_source) ? { source: text(id.seed_source) } : {}) }
      : { exists: existsSync(identityPath(env)) },
    providers: isObject(providers)
      ? { exists: true, ...(text(providers.ollama_host) ? { ollama: text(providers.ollama_host) } : {}), key: Boolean(text(providers.openrouter_api_key)) }
      : { exists: false, key: false },
    settingsKey: isObject(settings) && Boolean(text(settings.apiKey)),
    onboarded: isObject(settings) && settings.onboarded === true,
    envKey: Boolean(text(env.OPENROUTER_API_KEY)),
    ...(edgeHost ? { edgeHost } : {}),
    projects,
    ...(isObject(overlay) && text(overlay.first_project) ? { firstProject: text(overlay.first_project) } : {}),
    recorded,
  };
}

/** The answers the home already holds, in words (a key only as "set"; never its value). */
export function knownAnswers(s: SetupState): Partial<Record<QuestionId, string>> {
  const r = s.recorded?.answers ?? {};
  const stored = s.providers.key || s.settingsKey;
  const out: Partial<Record<QuestionId, string>> = {};
  const operator = r.operator ?? s.identity.operator;
  if (operator) out.operator = operator;
  if (s.identity.exists) out.identity = r.identity ?? s.identity.source ?? 'existing';
  const ollama = r.ollama ?? s.providers.ollama;
  if (ollama) out.ollama = ollama;
  // a stored key is an answer given before (an older `timmy init`, or the monitor's old FIRST RUN): OpenRouter
  const chat = r.chat ?? (stored ? 'openrouter' : undefined);
  if (chat) out.chat = chat;
  if (stored) out.key = 'set';
  if (r.logs) out.logs = r.logs;
  // a blank host answered before is an answer ("none yet"); a host set anywhere is the one used
  if (s.edgeHost) out.edge = s.edgeHost;
  else if (r.edge !== undefined) out.edge = r.edge;
  const project = r.project ?? s.firstProject ?? s.projects[0];
  if (project) out.project = project;
  return out;
}

export interface Choice { key: string; value: string; label: string; /** what choosing it means, one sentence or two (wrapped where it is drawn) */ note: string }

export interface Question {
  id: QuestionId;
  /** the question, one line (within 60 columns) */
  title: string;
  kind: 'text' | 'choice' | 'secret';
  choices?: Choice[];
  /** the preselected answer: a choice's value, or a text ('' for none) */
  preselect(a: Answers, s: SetupState): string;
  /** asked at all, given the answers so far (absent: always, while it has no answer) */
  when?(a: Answers, s: SetupState): boolean;
  /** an answer as typed: the value it stands for, or why it cannot be one */
  read(typed: string, a: Answers, s: SetupState): { ok: true; value: string } | { ok: false; why: string };
}

/** The host part of an Ollama address, for the words ("Ollama at 127.0.0.1:11434"). */
export const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

const plainText = (max: number, what: string) => (typed: string): { ok: true; value: string } | { ok: false; why: string } => {
  const v = typed.trim();
  if (!v) return { ok: false, why: `${what} cannot be empty.` };
  if (v.length > max || CONTROL.test(v)) return { ok: false, why: `${what}: at most ${max} characters, no control characters.` };
  return { ok: true, value: v };
};
/** One of a choice question's keys, or its value written out; '' takes the preselected one. */
const pick = (q: () => Question) => (typed: string, a: Answers, s: SetupState): { ok: true; value: string } | { ok: false; why: string } => {
  const t = typed.trim().toLowerCase();
  const choices = q().choices ?? [];
  const c = t === '' ? choices.find((x) => x.value === q().preselect(a, s)) : choices.find((x) => x.key === t || x.value === t);
  return c ? { ok: true, value: c.value } : { ok: false, why: `Type ${choices.map((x) => x.key).join(' or ')}, or Enter for the one in brackets.` };
};

export const QUESTIONS: readonly Question[] = [
  {
    id: 'operator', kind: 'text', title: 'Operator name (your receipts show it)',
    preselect: () => OPERATOR_DEFAULT,
    read: (t) => (t.trim() === '' ? { ok: true, value: OPERATOR_DEFAULT } : plainText(80, 'The name')(t)),
  },
  {
    id: 'identity', kind: 'text', title: 'Identity: g makes a new key; or a PEM or 64-hex seed path',
    preselect: () => 'generate',
    read: (t) => {
      const v = t.trim();
      if (v === '' || v === 'g' || v === 'generate') return { ok: true, value: 'generate' };
      if (/^[0-9a-fA-F]{64}$/.test(v) || existsSync(v)) return { ok: true, value: v };
      return { ok: false, why: 'Not a 64-hex seed and no such file: g makes a new key.' };
    },
  },
  {
    id: 'ollama', kind: 'text', title: 'Ollama host (the local model)',
    preselect: (_a, s) => s.providers.ollama ?? OLLAMA_DEFAULT,
    read: (t, a, s) => {
      const v = t.trim() || (s.providers.ollama ?? OLLAMA_DEFAULT);
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
      try {
        const u = new URL(url);
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || CONTROL.test(url)) throw new Error('scheme');
        return { ok: true, value: url.replace(/\/+$/, '') };
      } catch { return { ok: false, why: 'An address like http://127.0.0.1:11434.' }; }
    },
  },
  {
    id: 'chat', kind: 'choice', title: 'Chat model',
    choices: [
      { key: 'l', value: 'local', label: 'local model only', note: 'Ollama: free, private, no key. Code agents use it now; the REPL\'s chat needs a model key (a local chat route comes later).' },
      { key: 'o', value: 'openrouter', label: 'OpenRouter: a paid cloud service', note: 'Your messages go to OpenRouter and each answer costs money. Asks for your key next.' },
    ],
    preselect: () => 'local',
    read: pick(() => QUESTIONS.find((q) => q.id === 'chat')!),
  },
  {
    id: 'key', kind: 'secret', title: 'OpenRouter key (hidden as you type; blank: no key)',
    preselect: () => '',
    when: (a) => a.chat === 'openrouter',
    read: (t) => {
      const v = t.trim();
      if (v.length > 512 || CONTROL.test(v) || /\s/.test(v)) return { ok: false, why: 'A key is one word, with no spaces or control characters.' };
      return { ok: true, value: v };
    },
  },
  {
    id: 'logs', kind: 'choice', title: 'Logs and run events',
    choices: [
      { key: 'l', value: 'local', label: 'this computer only', note: 'Kept in .timmy/ here; nothing is sent anywhere.' },
      { key: 'c', value: 'cloud', label: 'also your Cloudflare worker (cloud)', note: 'Run events are sent to your worker: they leave this computer.' },
    ],
    preselect: () => 'local',
    read: pick(() => QUESTIONS.find((q) => q.id === 'logs')!),
  },
  {
    id: 'edge', kind: 'text', title: 'Your worker\'s host (blank: none yet, nothing is sent)',
    preselect: () => '',
    when: (a, s) => a.logs === 'cloud' && !s.edgeHost,
    read: (t) => {
      const v = t.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!v) return { ok: true, value: '' };
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i.test(v)) return { ok: false, why: 'A host name, like worker.example.com.' };
      return { ok: true, value: v };
    },
  },
  {
    id: 'project', kind: 'text', title: 'First project name (under ~/timmy/projects/)',
    preselect: () => PROJECT_DEFAULT,
    read: (t) => {
      const v = t.trim() || PROJECT_DEFAULT;
      if (v === '.' || v === '..' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(v)) return { ok: false, why: 'Letters, digits, dot, dash, underscore and spaces; 64 at most; no slash.' };
      return { ok: true, value: v };
    },
  },
];

export const question = (id: QuestionId): Question => QUESTIONS.find((q) => q.id === id)!;

/** The answers so far: what the home holds, then what was given now (given wins: it is the newer word). */
export function effectiveAnswers(s: SetupState, given: Answers = {}): Answers {
  const k = knownAnswers(s);
  return {
    ...(k.operator ? { operator: k.operator } : {}),
    ...(k.ollama ? { ollama: k.ollama } : {}),
    ...(k.chat ? { chat: k.chat as Chat } : {}),
    ...(k.logs ? { logs: k.logs as Logs } : {}),
    ...(k.project ? { project: k.project } : {}),
    ...given,
  };
}

/** Whether `q` still needs asking: it has no answer (known or given) and its condition holds for the answers so far. */
export function needsAsking(q: Question, s: SetupState, a: Answers, given: Answers = {}): boolean {
  if (q.id in given && given[q.id as keyof Answers] !== undefined) return false;
  const k = knownAnswers(s);
  if (k[q.id] !== undefined) return false;
  return q.when ? q.when(a, s) : true;
}

/**
 * The questions the home has no answer for, in order, as they would be asked if every one took its preselected answer
 * (a conditional one, the key or the worker's host, appears only when what it follows asks for it).
 */
export function pendingQuestions(s: SetupState, given: Answers = {}): Question[] {
  const a = effectiveAnswers(s, given);
  const out: Question[] = [];
  for (const q of QUESTIONS) {
    if (!needsAsking(q, s, a, given)) continue;
    out.push(q);
    const pre = q.preselect(a, s);
    if (q.id === 'chat') a.chat = pre as Chat;
    else if (q.id === 'logs') a.logs = pre as Logs;
    else if (q.id !== 'key' && q.id !== 'identity' && q.id !== 'edge') (a as Record<string, string>)[q.id] = pre;
  }
  return out;
}

/** Every question has an answer (the monitor and the REPL then ask nothing). */
export const setupComplete = (s: SetupState): boolean => pendingQuestions(s).length === 0;

/** A chat answer in words. */
export function chatWords(chat: string | undefined, s: SetupState, ollama?: string): string {
  const host = hostOf(ollama ?? s.recorded?.answers.ollama ?? s.providers.ollama ?? OLLAMA_DEFAULT);
  if (chat === 'openrouter') return `OpenRouter (paid, cloud; key ${s.providers.key || s.settingsKey ? 'set' : 'not set'})`;
  if (chat === 'local') return `local model only (Ollama at ${host}; no key)`;
  return 'not answered yet';
}

/** A logs answer in words. */
export function logsWords(logs: string | undefined, s: SetupState): string {
  if (logs === 'cloud') return s.edgeHost ? `also your worker ${s.edgeHost} (cloud)` : 'also your worker (no host set yet, so nothing is sent)';
  if (logs === 'local') return 'this computer only';
  return 'not answered yet';
}

/** One line: what the setup chose (a key only as set or not set). */
export function setupSummary(s: SetupState): string {
  const k = knownAnswers(s);
  return [
    `operator ${k.operator ?? 'not answered yet'}`,
    `chat: ${chatWords(k.chat, s)}`,
    `logs: ${logsWords(k.logs, s)}`,
    `project ${k.project ?? 'not answered yet'}`,
  ].join(' · ');
}

/**
 * The monitor's one line of what the setup chose: the chat and the logs first (a narrow terminal cuts the end of a line),
 * then the project and the operator.
 */
export function setupLine(s: SetupState): string {
  const k = knownAnswers(s);
  const key = s.providers.key || s.settingsKey;
  const chat = k.chat === 'openrouter' ? `OpenRouter, paid (key ${key ? 'set' : 'not set'})` : k.chat === 'local' ? 'local model (no key)' : 'not answered yet';
  const logs = k.logs === 'cloud' ? (s.edgeHost ? `also your worker ${s.edgeHost} (cloud)` : 'also your worker (no host yet)') : k.logs === 'local' ? 'this computer only' : 'not answered yet';
  return `chat ${chat} · logs ${logs} · project ${k.project ?? 'not answered yet'} · operator ${k.operator ?? 'not answered yet'}`;
}

/** Who answered last, in words ("timmy init"), from setup.json; null when no answer was recorded there. */
export const answeredBy = (s: SetupState): string | null => s.recorded?.by ?? null;

/**
 * The chat route in effect, for the REPL's header and the monitor's top line: the model's name only when a key will be
 * used. `short` keeps only the last part of the model's id (the monitor's narrow top line).
 */
export function chatRoute(o: { key: boolean; model?: string | null; short?: boolean }): string {
  if (!o.key) return 'chat: no model key · /setup';
  const model = String(o.model ?? '').trim();
  const name = o.short ? model.split('/').pop() || model : model;
  return name ? `chat: ${name} · OpenRouter` : 'chat: OpenRouter';
}
