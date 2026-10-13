/**
 * Pi Durable, slice S1 (R4 H118): the ONE module that imports @earendil-works/pi-durable, pi-ai and chord. Every pi type
 * and call Timmy uses goes through here, so the experimental package's API churn (breaking releases on 10-05, 10-05 and
 * 10-07) stays in one file (plan b.1.2).
 *
 * The packages are not Timmy dependencies. They are installed, on the operator's yes, into the worker folder
 * (workers/pi-durable, its own package.json and lockfile with exact pins) and loaded here by absolute path, as H115's
 * spike did. Nothing here is imported statically and no pi type is imported for the compiler: `tsc` passes on a checkout
 * where the worker folder was never installed. The types below are the structural subset Timmy uses, checked against the
 * 1.1.0 declarations (dist/harness/types.d.ts); a pin bump re-checks them (plan a.6).
 *
 * The only model route in S1 is pi-ai's in-memory faux provider: FAKE, scripted, never a network request.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

/** chord's Context: carries cancellation (BACKGROUND_CONTEXT never cancels). */
export interface PiContext { readonly abortSignal?: AbortSignal }

export type SubmissionStatus = 'queued' | 'placed' | 'done' | 'unanswered';
export interface SubmissionRecord {
  readonly id: number;
  readonly conversationId: number;
  readonly requestId?: string;
  readonly type: 'input' | 'write';
  readonly status: SubmissionStatus;
  readonly reason?: string;
  readonly detail?: unknown;
}
export interface Submission {
  readonly id: number;
  status(c: PiContext): Promise<SubmissionRecord>;
  wait(c: PiContext): Promise<SubmissionRecord>;
}
export interface TaskRecord {
  readonly id: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly owner?: number;
  readonly abortRequested?: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly state: { readonly status: 'pending' | 'running' | 'waiting' | 'completing' | 'terminal'; readonly checkpoint?: { readonly phase?: string }; readonly outcome?: { readonly status: string; readonly error?: { readonly message?: string } } };
}
export interface Inspection {
  readonly scheduling: 'paused' | 'running' | 'closing';
  readonly tasks: readonly { readonly record: TaskRecord; readonly state: { readonly kind: string } }[];
  readonly submissions: readonly SubmissionRecord[];
}
export interface EntryRecord {
  readonly id: number;
  readonly kind: string;
  readonly byTaskId?: number;
  readonly model?: readonly { readonly role: string; readonly stopReason?: string; readonly content?: unknown; readonly errorMessage?: string }[];
}
export interface Conversation {
  readonly id: number;
  submit(draft: { type: 'input'; content: string; requestId?: string; whenBusy?: 'steer' | 'followUp' | 'reject' }, c: PiContext): Promise<Submission>;
  abort(c: PiContext): Promise<void>;
  entries(query: { order?: 'ascending' | 'descending'; minEntryId?: number; maxEntryId?: number }, limit: number, cursor: unknown, c: PiContext): Promise<{ items: EntryRecord[]; next?: unknown }>;
}
export interface Tx {
  doc(token: unknown): Promise<Record<string, unknown>>;
  scanSubmissions(query: { conversationId?: number }, limit: number): Promise<{ items: SubmissionRecord[] }>;
  submissionByRequest(conversationId: number, requestId: string): Promise<SubmissionRecord | undefined>;
}
export interface Harness {
  resume(): void;
  close(c: PiContext): Promise<void>;
  inspect(c: PiContext): Promise<Inspection>;
  conversation(id: number, c: PiContext): Promise<Conversation | undefined>;
  createConversation(options: { ownership: { kind: 'ownerless' }; agent?: unknown; init?: (tx: Tx, id: number) => void | Promise<void> }, c: PiContext): Promise<Conversation>;
  submission(id: number, c: PiContext): Promise<Submission | undefined>;
  abortTask(id: number, c: PiContext): Promise<'marked' | 'terminal'>;
  abortSubmission(id: number, c: PiContext, conversationId?: number): Promise<string>;
  getTask(id: number, c: PiContext): Promise<TaskRecord | undefined>;
  commit<T>(change: (tx: Tx) => T | Promise<T>, c: PiContext): Promise<T>;
  snapshot(token: unknown, c: PiContext): Promise<Record<string, unknown> | undefined>;
  usage(c: PiContext): Promise<unknown>;
}

/** A tool call as a beforeTool hook sees it. */
export interface ToolCall { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }
/** What a tool's execute() is given (the subset Timmy's tools use). */
export interface ToolApi { readonly taskId: number; readonly conversationId: number; readonly callId: string }
export interface ToolResult { readonly content: readonly { type: 'text'; text: string }[]; readonly isError?: boolean }
/** A tool Timmy offers Pi: name, words, a TypeBox schema built with `schema`, the replay rule and its execute. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly replay: 'safe' | 'unsafe';
  execute(args: Record<string, unknown>, api: ToolApi, context: PiContext): Promise<ToolResult>;
}
/** The hooks Timmy installs: a tool's beforeTool (refuse or let through) and a generation's beforeRequest. */
export interface HookSpec {
  beforeTool?(call: ToolCall, api: { readonly conversationId: number; readonly taskId: number }, context: PiContext): Promise<{ block: string } | undefined> | { block: string } | undefined;
  beforeRequest?(api: { readonly conversationId: number; readonly taskId: number }, context: PiContext): Promise<void> | void;
}

/** One message the FAKE model sees last, as its script reads it. */
export interface FauxSeen { readonly role: string; readonly text: string }
/** What one FAKE model step answers: a text, or one tool call. */
export type FauxAnswer = { readonly text: string } | { readonly tool: string; readonly args: Record<string, unknown> };

/** A storage over one already-open, already-locked connection: each `storage()` is a fresh SqliteStorage over it, whose
 * close leaves the connection (and so the lock) held; `closeConnection()` ends both, at the worker's exit. */
export interface LockedStorage {
  storage(): Promise<unknown>;
  closeConnection(): Promise<void>;
}

/** The pinned packages' files, relative to the worker folder. */
export const PI_FILES = {
  durable: 'node_modules/@earendil-works/pi-durable/dist/index.js',
  sqliteNode: 'node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js',
  sqliteCore: 'node_modules/@earendil-works/pi-durable/dist/storage/sqlite/index.js',
  ai: 'node_modules/@earendil-works/pi-ai/dist/index.js',
  context: 'node_modules/@earendil-works/chord/dist/context/index.js',
  /** loaded only for a catalog estimate: pi-ai's built-in OpenRouter catalog (no request is made) */
  openrouter: 'node_modules/@earendil-works/pi-ai/dist/providers/openrouter.js',
} as const;

/** pi-durable's agent events of one conversation (experimental upstream): a snapshot, then batches per commit. */
export interface PiEventStream {
  readonly snapshot: { readonly entries?: readonly unknown[] } & Record<string, unknown>;
  start(listener: (events: readonly Record<string, unknown>[]) => Promise<void>): void;
  stop(): Promise<unknown>;
}

/** pi-ai's catalog arithmetic for one OpenRouter model: its rates and the USD figure for the given tokens. */
export interface CatalogEstimate { readonly usd: number; readonly rates: { readonly input: number; readonly output: number } }

type Loose = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- the pinned modules carry no types here, by design

/** The loaded API: everything the worker calls, and nothing else. */
export interface PiApi {
  readonly C: PiContext;
  /** pi-ai's TypeBox, for tool parameter schemas. */
  readonly schema: {
    object(fields: Record<string, unknown>): unknown;
    string(opts?: { description?: string }): unknown;
    integer(opts?: { minimum?: number; maximum?: number; description?: string }): unknown;
    boolean(opts?: { description?: string }): unknown;
    array(items: unknown, opts?: { minItems?: number; maxItems?: number }): unknown;
    optional(s: unknown): unknown;
  };
  /** Attaches to one conversation's agent events (a read-only viewer: it never starts the scheduler). */
  events(harness: Harness, conversationId: number): Promise<PiEventStream>;
  /** pi-ai's catalog price for `input` + `output` tokens of an OpenRouter model, computed here (no request), or undefined when the catalog lacks it. */
  catalogEstimate(modelId: string, tokens: { input: number; output: number }): Promise<CatalogEstimate | undefined>;
  lockedStorage(raw: DatabaseSync): LockedStorage;
  /**
   * A pi-ai model collection holding the FAKE providers. `addFaux` registers one faux provider (FAKE: an in-memory script,
   * no request leaves the process) whose every answer comes from `answer(seen)`; `onCall` hears each request as it starts.
   */
  models(): {
    readonly models: unknown;
    addFaux(provider: string, opts: { tokensPerSecond?: number; answer: (seen: FauxSeen | undefined) => FauxAnswer; onCall: (n: number, seen: FauxSeen | undefined) => void }): void;
  };
  /** A registry with one extension holding Timmy's tools and hooks. */
  registry(name: string, tools: readonly ToolSpec[], hooks: HookSpec): unknown;
  open(storage: unknown, options: { models: unknown; registry: unknown; onReport: (e: unknown) => void }): Promise<Harness>;
  /** The session document mapping each Timmy run to its conversation, written in the creating commit. */
  readonly runIndex: unknown;
}

/** Loads the pinned packages from the worker folder (absolute paths), or throws naming the file that is missing. */
export async function loadPi(workerDir: string): Promise<PiApi> {
  const load = async (rel: string): Promise<Loose> => import(pathToFileURL(join(workerDir, rel)).href);
  const [durable, sqliteNode, sqliteCore, ai, ctx] = await Promise.all([
    load(PI_FILES.durable), load(PI_FILES.sqliteNode), load(PI_FILES.sqliteCore), load(PI_FILES.ai), load(PI_FILES.context),
  ]);
  const C: PiContext = ctx.BACKGROUND_CONTEXT;
  const T = ai.Type;
  const runIndex = durable.defineDoc({ kind: 'timmy.runs', version: 1, scope: 'session', initial: () => ({ runs: {} }) });

  const textOf = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

  return {
    C,
    runIndex,
    schema: {
      object: (fields) => T.Object(fields),
      string: (opts) => T.String(opts ?? {}),
      integer: (opts) => T.Integer(opts ?? {}),
      boolean: (opts) => T.Boolean(opts ?? {}),
      array: (items, opts) => T.Array(items, opts ?? {}),
      optional: (s) => T.Optional(s),
    },
    events: (harness, conversationId) => durable.watchEvents(harness, conversationId, C),
    async catalogEstimate(modelId, tokens) {
      const or: Loose = await load(PI_FILES.openrouter);
      const models: Loose = ai.createModels();
      models.setProvider(or.openrouterProvider());
      const model: Loose = models.getModel('openrouter', modelId);
      if (!model) return undefined;
      const usage = { input: tokens.input, output: tokens.output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: tokens.input + tokens.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      ai.calculateCost(model, usage);
      return { usd: usage.cost.total, rates: { input: model.cost?.input, output: model.cost?.output } };
    },
    lockedStorage(raw) {
      const db: Loose = new sqliteNode.NodeSqliteDatabase(raw);
      // A SqliteStorage closes its database on close(); this facade keeps the connection (and its exclusive lock) open
      // across a pause, where the Harness is closed and opened again in the same worker.
      const keep = {
        exec: (sql: string) => db.exec(sql),
        run: (sql: string, ...p: unknown[]) => db.run(sql, ...p),
        get: (sql: string, ...p: unknown[]) => db.get(sql, ...p),
        all: (sql: string, ...p: unknown[]) => db.all(sql, ...p),
        transaction: (cb: unknown) => db.transaction(cb),
        close: async () => undefined,
      };
      return {
        storage: () => sqliteCore.SqliteStorage.open(keep),
        closeConnection: () => db.close(),
      };
    },
    models() {
      const models: Loose = ai.createModels();
      return {
        models,
        addFaux(provider, opts) {
          const faux: Loose = ai.fauxProvider({ provider, models: [{ id: 'faux-1', name: 'FAKE scripted model' }], ...(opts.tokensPerSecond ? { tokensPerSecond: opts.tokensPerSecond } : {}) });
          const step = (context: Loose): unknown => {
            const last = context?.messages?.at?.(-1);
            const seen: FauxSeen | undefined = last ? { role: String(last.role), text: textOf(last.content) } : undefined;
            opts.onCall(faux.state.callCount, seen);
            const answer = opts.answer(seen);
            if ('tool' in answer) return ai.fauxAssistantMessage([ai.fauxToolCall(answer.tool, answer.args)], { stopReason: 'toolUse' });
            return ai.fauxAssistantMessage(answer.text);
          };
          // Each request takes one step; a step that runs low appends more, so a script never runs out by count.
          const refill = (): void => { faux.appendResponses(Array.from({ length: 64 }, () => (context: Loose) => { if (faux.getPendingResponseCount() < 8) refill(); return step(context); })); };
          refill();
          models.setProvider(faux.provider);
        },
      };
    },
    registry(name, tools, hooks) {
      const registry: Loose = durable.createRegistry();
      const defined = tools.map((t) => durable.defineTool({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        replay: t.replay,
        execute: (args: Record<string, unknown>, api: Loose, context: PiContext) => t.execute(args, { taskId: api.taskId, conversationId: api.conversationId, callId: api.callId }, context),
      }));
      const hookList: unknown[] = [];
      if (hooks.beforeTool) {
        const before = hooks.beforeTool;
        hookList.push(durable.hook(durable.ToolTask, { beforeTool: (call: Loose, api: Loose, context: PiContext) => before({ id: call.id, name: call.name, arguments: call.arguments ?? {} }, api, context) }));
      }
      if (hooks.beforeRequest) {
        const before = hooks.beforeRequest;
        hookList.push(durable.hook(durable.GenerationTask, { beforeRequest: async (_request: unknown, api: Loose, context: PiContext) => { await before(api, context); return undefined; } }));
      }
      registry.install(durable.defineExtension({ name, tools: defined, hooks: hookList }));
      return registry;
    },
    open: (storage, options) => durable.Harness.open(storage, { models: options.models, registry: options.registry, onReport: options.onReport }, C),
  };
}
