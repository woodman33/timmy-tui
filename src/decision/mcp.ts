/**
 * Round R4 (H120): the decision provider as an MCP tool, in plain JSON Schema like src/geo/mcp.ts GEO_TOOLS: one tool,
 * timmy_decide_route, answering with exactly the JSON `timmy decide route --json` prints (src/decision/cli.ts decideDo), under the
 * same checks and the same policy (settings, egress, budget, staleness, admission). The lead adds it to src/mcp/server.ts.
 *
 * The operator's rule it keeps: the tool only records a recommendation. It never dispatches, approves, raises a worker
 * count, starts compute or seals a receipt, and its answer never holds a token or an account id.
 */
import { decideDo, type DecideArgs, type DecideCliContext } from './cli.js';
import { DECISION_SCHEMA, type DecisionOption } from './types.js';

const str = { type: 'string' };
const bool = { type: 'boolean' };

export const DECISION_TOOLS = [
  {
    name: 'timmy_decide_route',
    description: 'Recommend which available harness or runtime should take a task, from the options given, with Cloudflare Clef-Omni when "Use Clef routing" is on. It only scores the options: it never writes code, grants a permission, starts compute, dispatches or seals anything. The answer is a recommendation, never evidence; with "Require review before dispatch" on (the default) a person approves it first. An abstention goes to a person; any failure (Clef off or unavailable, a timeout, a malformed answer, local-only or free-only policy, no budget for paid inference, a stale revision, fewer than 2 available options) falls back to the deterministic option, its reason recorded. The decision is kept in the project\'s .timmy/decisions; the same request returns the recorded decision with no second call. Returns the record as `timmy decide route --json` prints it (exit_code 0 recorded, 1 refused, 2 usage).',
    inputSchema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          description: 'the options to choose between; ids are letters, digits, _, . or -',
          items: { type: 'object', properties: { id: str, label: str, description: str, available: bool, unavailable_reason: str }, required: ['id'] },
        },
        deterministic: { type: 'string', description: 'the existing route\'s option: used on a fallback, proposed on an abstention' },
        rule: { type: 'string', description: 'that route\'s rule in words' },
        instructions: str,
        state: { description: 'a non-private summary of the situation (JSON)' },
        operation: { type: 'string', description: 'the Timmy operation (o and 8 hex digits); default TIMMY_OPERATION, else a new one' },
        project: { type: 'string', description: 'the project folder or name (default: the server\'s folder)' },
        revision: { type: 'string', description: 'the revision the request is bound to (default: git HEAD now)' },
        local_only: bool,
        free_only: bool,
        budget_usd: { type: 'number', description: 'what is left to spend on paid inference (paid inference needs one)' },
        request_key: str,
        fixture: { type: 'string', description: 'offline slice and tests only: answer from a response file' },
      },
      required: ['options'],
    },
  },
];

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The tool's arguments as the CLI's, or why they cannot be. */
function argsOf(a: Record<string, unknown>): DecideArgs | { error: string } {
  if (!Array.isArray(a.options)) return { error: 'options must be a list of {id, label?, description?, available?, unavailable_reason?}' };
  const options: DecisionOption[] = [];
  for (const o of a.options as Array<Record<string, unknown>>) {
    if (!o || typeof o !== 'object') return { error: 'each option must be an object with an id' };
    const id = text(o.id) ?? '';
    const label = text(o.label)?.trim() || id;
    options.push({
      id, label, description: text(o.description)?.trim() || label, available: o.available !== false,
      ...(o.available === false && text(o.unavailable_reason) ? { unavailableReason: text(o.unavailable_reason) } : {}),
    });
  }
  if (a.budget_usd !== undefined && typeof a.budget_usd !== 'number') return { error: 'budget_usd must be a number' };
  return {
    kind: 'route',
    options,
    deterministic: text(a.deterministic),
    rule: text(a.rule),
    instructions: text(a.instructions),
    operation: text(a.operation),
    project: text(a.project),
    revision: text(a.revision),
    ...(a.state !== undefined ? { state: a.state } : {}),
    fixture: text(a.fixture),
    requestKey: text(a.request_key),
    localOnly: a.local_only === true,
    freeOnly: a.free_only === true,
    ...(typeof a.budget_usd === 'number' ? { budgetUsd: a.budget_usd } : {}),
    json: true,
  };
}

/** Calls a decision tool: the CLI's JSON for timmy_decide_route, or a refusal in words. */
export async function callDecisionTool(name: string, args: Record<string, unknown> = {}, ctx: DecideCliContext = {}): Promise<Record<string, unknown>> {
  if (name !== 'timmy_decide_route') {
    return { schema: DECISION_SCHEMA, ok: false, refusal: 'unknown tool', why: `no decision tool is named ${name}; there is timmy_decide_route`, exit_code: 2 };
  }
  const parsed = argsOf(args ?? {});
  if ('error' in parsed) return { schema: DECISION_SCHEMA, ok: false, refusal: 'usage', why: parsed.error, exit_code: 2 };
  return (await decideDo(parsed, ctx)).json;
}
