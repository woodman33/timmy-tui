/**
 * Round R4 (H120): `timmy decide <kind> --option id[:label] ... [--deterministic id]`: one decision, recorded in the
 * project's .timmy/decisions (src/decision/service.ts), shown in plain words or as one JSON line. decideDo is shared with
 * the MCP tool (src/decision/mcp.ts); decideMain is what the CLI runs. The lead wires them into src/cli.ts.
 *
 *   exit 0   recorded, whatever the outcome (a recommendation, an abstention for a person, or a fallback with its reason)
 *   exit 1   refused: nothing was recorded (the decisions folder cannot be written, a recorded decision cannot be read,
 *            another process is still deciding the same request)
 *   exit 2   usage
 *
 * The project is the current folder or --project <dir|name>; its revision is git's HEAD now (or --revision, which must
 * still be HEAD, or the request is stale). The operation is --operation, else TIMMY_OPERATION, else a new one for this
 * decision (said so). The fixture transport (--fixture) is for tests and the offline slice.
 *
 * The operator's rule it keeps: printing a decision never dispatches it; a recommendation is printed as one, with what a
 * person must do. Nothing here prints a token or an account id (the records never hold them).
 */
import fs from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { chooseProject } from '../project/index.js';
import { currentOperation, newOperationId, OPERATION_ENV, OPERATION_ID } from '../ops/context.js';
import { optionIdProblems } from './policy.js';
import { decideDetailed, DecisionRefused, projectRevision } from './service.js';
import { readSettings } from './settings.js';
import { DECISION_KINDS, DECISION_SCHEMA, type AdmissionChecks, type DecisionKind, type DecisionOption, type DecisionProvider } from './types.js';
import { decisionLines } from './view.js';

export const DECIDE_USAGE = 'timmy decide route --option codex[:label] --option pi --option openhands --deterministic codex [--instructions "..."] [--operation oXXXXXXXX] [--project <dir>] [--fixture <file>] [--json]';

/** What each kind asks when no --instructions are given. */
export const DEFAULT_INSTRUCTIONS: Record<DecisionKind, string> = {
  route: 'Which of the available runtimes should take this task?',
  queue: 'Should this queued task run next?',
  mode: 'How should this task run: in a sandbox, under review, or after a clarifying question?',
  'vox-review': 'Should a person review this VoxVision observation?',
};

/** The deterministic rule's words when none are given. */
export const DEFAULT_RULE = 'the existing route the caller named';

export interface DecideArgs {
  kind?: string;
  options: DecisionOption[];
  deterministic?: string;
  rule?: string;
  instructions?: string;
  operation?: string;
  project?: string;
  revision?: string;
  state?: unknown;
  fixture?: string;
  requestKey?: string;
  localOnly: boolean;
  freeOnly: boolean;
  budgetUsd?: number;
  json: boolean;
  help?: boolean;
}

const VALUE_FLAGS = ['option', 'unavailable', 'deterministic', 'rule', 'instructions', 'operation', 'project', 'revision', 'state', 'fixture', 'request-key', 'budget-usd'] as const;

/** `id[:words]` split at the first colon. */
const split = (v: string): [string, string | undefined] => {
  const at = v.indexOf(':');
  return at < 0 ? [v.trim(), undefined] : [v.slice(0, at).trim(), v.slice(at + 1).trim() || undefined];
};

/** Problems with arguments, from the CLI or the MCP tool: the same checks for both. Empty means they may be decided. */
export function checkDecideArgs(a: DecideArgs): string | undefined {
  if (!a.kind) return `Name the kind of decision: ${DECISION_KINDS.join(', ').replace(/, ([^,]*)$/, ' or $1')}. Usage: ${DECIDE_USAGE}`;
  if (!(DECISION_KINDS as readonly string[]).includes(a.kind)) return `${a.kind} is not a kind of decision: ${DECISION_KINDS.join(', ').replace(/, ([^,]*)$/, ' or $1')}. Usage: ${DECIDE_USAGE}`;
  if (!a.options.length) return `Give the options with --option id[:label] (at least one). Usage: ${DECIDE_USAGE}`;
  const ids = optionIdProblems(a.options);
  if (ids.length) return `${ids.join('; ')}. Usage: ${DECIDE_USAGE}`;
  if (a.deterministic !== undefined && !a.options.some((o) => o.id === a.deterministic)) {
    return `--deterministic ${a.deterministic} is not one of the options (${a.options.map((o) => o.id).join(', ')}). Usage: ${DECIDE_USAGE}`;
  }
  if (a.operation !== undefined && !OPERATION_ID.test(a.operation)) return `${a.operation} is not an operation id (o and 8 hex digits). Usage: ${DECIDE_USAGE}`;
  if (a.budgetUsd !== undefined && !(Number.isFinite(a.budgetUsd) && a.budgetUsd >= 0)) return `--budget-usd needs an amount of dollars, 0 or more. Usage: ${DECIDE_USAGE}`;
  if (a.instructions !== undefined && !a.instructions.trim()) return `--instructions are empty. Usage: ${DECIDE_USAGE}`;
  return undefined;
}

export function parseDecideArgs(argv: string[]): DecideArgs | { error: string } {
  const a: DecideArgs = { options: [], localOnly: false, freeOnly: false, json: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === '-h' || w === '--help') { a.help = true; continue; }
    if (w === '--json') { a.json = true; continue; }
    if (w === '--local-only') { a.localOnly = true; continue; }
    if (w === '--free-only') { a.freeOnly = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(w);
    if (m && (VALUE_FLAGS as readonly string[]).includes(m[1])) {
      const flag = m[1];
      let v = m[2];
      if (v === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) return { error: `--${flag} needs ${flag === 'option' ? 'id[:label]' : flag === 'unavailable' ? 'id[:reason]' : 'a value'}. Usage: ${DECIDE_USAGE}` };
        v = next;
        i++;
      }
      switch (flag) {
        case 'option': {
          const [id, label] = split(v);
          a.options.push({ id, label: label ?? id, description: label ?? id, available: true });
          break;
        }
        case 'unavailable': {
          const [id, reason] = split(v);
          const known = a.options.find((o) => o.id === id);
          if (known) { known.available = false; if (reason) known.unavailableReason = reason; } else a.options.push({ id, label: id, description: id, available: false, ...(reason ? { unavailableReason: reason } : {}) });
          break;
        }
        case 'deterministic': a.deterministic = v.trim(); break;
        case 'rule': a.rule = v; break;
        case 'instructions': a.instructions = v; break;
        case 'operation': a.operation = v.trim(); break;
        case 'project': a.project = v; break;
        case 'revision': a.revision = v.trim(); break;
        case 'state':
          try { a.state = JSON.parse(v) as unknown; } catch { return { error: `--state needs JSON: ${JSON.stringify(v.slice(0, 40))} is not. Usage: ${DECIDE_USAGE}` }; }
          break;
        case 'fixture': a.fixture = v; break;
        case 'request-key': a.requestKey = v.trim(); break;
        case 'budget-usd': {
          const n = Number(v);
          if (!v.trim() || !Number.isFinite(n) || n < 0) return { error: `--budget-usd needs an amount of dollars, 0 or more (not ${JSON.stringify(v)}). Usage: ${DECIDE_USAGE}` };
          a.budgetUsd = n;
          break;
        }
      }
      continue;
    }
    if (w.startsWith('-')) return { error: `No option ${w}. Usage: ${DECIDE_USAGE}` };
    words.push(w);
  }
  if (a.help) return a;
  if (words.length > 1) return { error: `One kind of decision at a time (it was given ${words.join(' ')}). Usage: ${DECIDE_USAGE}` };
  a.kind = words[0];
  const problem = checkDecideArgs(a);
  return problem ? { error: problem } : a;
}

export function decideHelp(): string {
  return [
    `Usage: ${DECIDE_USAGE}`,
    '',
    'timmy decide: asks Clef-Omni (Cloudflare\'s decision model, when "Use Clef routing" is on) to score the options Timmy',
    'offers, and records the decision in the project\'s .timmy/decisions. It only scores: it never writes code, grants a',
    'permission, starts compute or dispatches anything. Its answer is a recommendation, never evidence; with "Require review',
    'before dispatch" on (the default) a person approves it first. An abstention goes to a person; any failure falls back to',
    'the deterministic option, with its reason recorded. The same request is decided once.',
    '',
    '  <kind>                     route (an available harness or runtime), queue, mode or vox-review',
    '  --option id[:label]        an option to offer (repeat); ids are letters, digits, _, . or -',
    '  --unavailable id[:reason]  an option that is out, with why (it is never shown to the model)',
    '  --deterministic id         the existing route: used on a fallback, proposed on an abstention',
    '  --rule "words"             that route\'s rule in words',
    '  --instructions "..."       what is asked (default: the kind\'s own question)',
    '  --state <json>             a non-private summary of the situation (default {})',
    '  --operation oXXXXXXXX      the operation this belongs to (default: TIMMY_OPERATION, else a new one)',
    '  --project <dir|name>       the project (default: the current folder)',
    '  --revision <rev>           the revision the request is bound to (default: git HEAD now; another is stale)',
    '  --local-only, --free-only  policy: nothing off this computer; nothing that costs money',
    '  --budget-usd <n>           what is left to spend on paid inference (paid inference needs one)',
    '  --request-key <key>        the idempotency key (default: the sha256 of the canonical request)',
    '  --fixture <file>           answer from a response file (tests and the offline slice only)',
    '  --json                     one line: {schema: timmy.decision/1, ...the record}',
    '',
    'Exit codes: 0 recorded (any outcome); 1 refused (nothing recorded); 2 usage.',
    '',
  ].join('\n');
}

type Env = Record<string, string | undefined>;

export interface DecideCliContext {
  /** Where --project and --fixture are read from (default: the current folder). */
  cwd?: string;
  env?: Env;
  fetch?: typeof fetch;
  /** Internal, tests only: a FAKE Workers AI endpoint on 127.0.0.1. */
  baseUrl?: string;
  provider?: DecisionProvider;
  checks?: AdmissionChecks;
}

export interface DecideOutput { code: 0 | 1 | 2; lines: string[]; json: Record<string, unknown> }

const refusal = (code: 1 | 2, kind: string, why: string): DecideOutput => ({
  code, lines: [why], json: { schema: DECISION_SCHEMA, ok: false, refusal: kind, why, exit_code: code },
});

/** One decision from CLI words or parsed arguments: the exit code, the lines to print and the JSON (the MCP tool's answer). */
export async function decideDo(argsOrArgv: string[] | DecideArgs, ctx: DecideCliContext = {}): Promise<DecideOutput> {
  const parsed = Array.isArray(argsOrArgv) ? parseDecideArgs(argsOrArgv) : argsOrArgv;
  if ('error' in parsed) return refusal(2, 'usage', parsed.error);
  if (parsed.help) return { code: 0, lines: decideHelp().trimEnd().split('\n'), json: { schema: DECISION_SCHEMA, ok: true, help: DECIDE_USAGE, exit_code: 0 } };
  if (!Array.isArray(argsOrArgv)) {
    const problem = checkDecideArgs(parsed);
    if (problem) return refusal(2, 'usage', problem);
  }
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();
  let root = cwd;
  if (parsed.project !== undefined) {
    const chosen = chooseProject(parsed.project, cwd);
    if ('error' in chosen) return refusal(2, 'usage', `--project ${parsed.project}: ${chosen.error}. Usage: ${DECIDE_USAGE}`);
    root = chosen.root;
  }
  try { root = fs.realpathSync(root); } catch { return refusal(2, 'usage', `the project folder cannot be read. Usage: ${DECIDE_USAGE}`); }

  const now = projectRevision(root);
  const fromEnv = env[OPERATION_ENV]?.trim();
  const inScope = currentOperation();
  const [operationId, operationFrom] = parsed.operation !== undefined ? [parsed.operation, 'given']
    : fromEnv && OPERATION_ID.test(fromEnv) ? [fromEnv, 'environment']
      : inScope && OPERATION_ID.test(inScope) ? [inScope, 'environment']
        : [newOperationId(), 'new'];
  const kind = parsed.kind as DecisionKind;
  const settings = readSettings(env).settings;
  let result;
  try {
    result = await decideDetailed({
      kind,
      operationId,
      project: { root, revision: parsed.revision ?? now.revision ?? '', ...(now.dirty !== undefined ? { dirty: now.dirty } : {}) },
      instructions: parsed.instructions ?? DEFAULT_INSTRUCTIONS[kind],
      options: parsed.options,
      state: parsed.state ?? {},
      ...(parsed.deterministic !== undefined ? { deterministic: { option: parsed.deterministic, rule: parsed.rule?.trim() || DEFAULT_RULE } } : {}),
      ...(parsed.requestKey ? { requestKey: parsed.requestKey } : {}),
    }, {
      settings,
      env,
      fetch: ctx.fetch,
      baseUrl: ctx.baseUrl,
      provider: ctx.provider,
      fixture: parsed.fixture === undefined ? undefined : isAbsolute(parsed.fixture) ? parsed.fixture : resolve(cwd, parsed.fixture),
      policy: { localOnly: parsed.localOnly, freeOnly: parsed.freeOnly },
      ...(parsed.budgetUsd !== undefined ? { budget: { remainingUsd: parsed.budgetUsd } } : {}),
      currentRevision: now.revision,
      ...(now.revision === undefined ? { revisionUnknown: now.why ?? 'it cannot be read' } : {}),
      checks: ctx.checks,
    });
  } catch (e) {
    if (e instanceof DecisionRefused) return refusal(1, e.refusal, e.why);
    throw e;
  }
  const { record, reused, file } = result;
  const lines = decisionLines(record).map((l) => l.text);
  if (operationFrom === 'new') lines.push(`Operation ${operationId} is new for this decision (no --operation or ${OPERATION_ENV} was given)`);
  lines.push(reused ? `The recorded decision, returned again (asked before; no second call): ${file}` : `Kept: ${file}`);
  return { code: 0, lines, json: { ...record, ok: true, exit_code: 0, reused, file, operation_from: operationFrom } };
}

/** `timmy decide …`: its exit code (the CLI exits with it). */
export async function decideMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  const json = o.json === true || argv.includes('--json');
  const out = await decideDo(argv);
  if (out.code === 0 && out.json.help !== undefined) {
    process.stdout.write(decideHelp());
    return 0;
  }
  if (out.code !== 0) {
    process.stderr.write(`${out.code === 2 ? String(out.json.why) : `  timmy decide: ${String(out.json.refusal)}: ${String(out.json.why)}`}\n`);
    if (json) process.stdout.write(`${JSON.stringify(out.json)}\n`);
    return out.code;
  }
  process.stdout.write(json ? `${JSON.stringify(out.json)}\n` : `${out.lines.join('\n')}\n`);
  return 0;
}
