// ORDER witness-o7c2 C1 — the witness core. Pure and injectable: no OpenCode import, so it is testable
// outside the harness. The hook shapes it satisfies are structurally typed from @opencode-ai/plugin
// 1.18.31 (npm pack; the exact version of the installed binary), whose Hooks keys are
// "tool.execute.before"(input{tool,sessionID,callID}, output{args}),
// "tool.execute.after"(input{tool,sessionID,callID,args}, output{title,output,metadata}) and
// "shell.env"(input{cwd,sessionID?,callID?}, output{env}).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

export class WitnessRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super('witness refused (' + reason + '): ' + detail);
    this.name = 'WitnessRefusal';
    this.reason = reason;
  }
}

export type OrderContext = { id: string; head: string };
export type SealResult = { id: string; hash: string };
export type SealSink = (subject: string, input: Record<string, unknown>) => SealResult | Promise<SealResult>;
export type WitnessDeps = {
  env?: Record<string, string | undefined>;
  seal?: SealSink;
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
  sizeOf?: (p: string) => number;
};

// Fail-closed by design: a witness does not parse intent. `.env.example` is refused too — narrowing this
// list is an operator decision, documented in the package README.
export const GUARDED_PATHS: { id: string; re: RegExp }[] = [
  { id: 'dotenv', re: /(^|[/\\\s'"])\.env(\.[A-Za-z0-9_.-]+)?($|[/\\\s'"])/i },
  { id: 'private_overlay', re: /\.timmy[/\\]private([/\\]|$)/i },
  { id: 'privacy_overlay_module', re: /lanes[/\\]privacy[/\\]overlay\./i },
];

const sha256 = (s: string): string => 'sha256_' + createHash('sha256').update(s).digest('hex');

const sortDeep = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep(src[k]);
        return acc;
      }, {});
  }
  return v;
};

// Canonical so a seal cannot be evaded by re-ordering keys, and so the same call always hashes the same.
export const argsHash = (args: unknown): string => sha256(JSON.stringify(sortDeep(args) ?? null));

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) strings(x, out);
  return out;
};

export const guardedHit = (args: unknown): { id: string; path_sha256: string } | null => {
  for (const s of strings(args)) {
    for (const g of GUARDED_PATHS) {
      if (g.re.test(s)) return { id: g.id, path_sha256: sha256(s) };
    }
  }
  return null;
};

// A Managed Tool Output File is the harness-persisted file a large tool result is spilled to (the
// `<persisted-output>` / truncated-output case). OpenCode's after-hook exposes only {title,output,metadata},
// so the file is found by a metadata key or by the marker in the output text — and bound by hash, never
// by content, so a spilled secret is not copied into the chain.
const MOF_KEY = /managed|persisted|output_?file|outfile|truncated_?to/i;
const MOF_TEXT = /([/~][^\s'"<>|]+\.output)\b/;

export type ManagedOutput = 'none' | { path: string; sha256?: string; size?: number; missing?: boolean };

export function resolveManagedOutput(
  metadata: unknown,
  output: string,
  deps: WitnessDeps = {}
): ManagedOutput {
  const exists = deps.exists ?? existsSync;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const sizeOf = deps.sizeOf ?? ((p: string) => statSync(p).size);
  const cands: string[] = [];
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      if (key && MOF_KEY.test(key)) cands.push(v);
      return;
    }
    if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
    }
  };
  walk(metadata);
  if (!cands.length) {
    const m = output.match(MOF_TEXT);
    if (m) cands.push(m[1]);
  }
  if (!cands.length) return 'none';
  const path = cands[0];
  if (!exists(path)) return { path, missing: true };
  return { path, sha256: sha256(read(path)), size: sizeOf(path) };
}

export function orderOf(deps: WitnessDeps = {}): OrderContext {
  const env = deps.env ?? process.env;
  const id = String(env.TIMMY_ORDER ?? '').trim();
  const head = String(env.TIMMY_HEAD ?? '').trim();
  if (!id || !head) {
    throw new WitnessRefusal(
      'no_order',
      'TIMMY_ORDER and TIMMY_HEAD are not both bound — a tool call outside an order is refused'
    );
  }
  return { id, head };
}

export type WitnessHooks = {
  'tool.execute.before': (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown }
  ) => Promise<void>;
  'tool.execute.after': (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ) => Promise<void>;
  'shell.env': (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> }
  ) => Promise<void>;
};

type Receipts = {
  appendReceipt: (stream: string, input: Record<string, unknown>, dir?: string) => { id: string; hash: string };
};

// Default sink: the repo's own hash-chained runs stream, through appendReceipt (single-writer locked,
// chain-correct). Spawning the CLI per tool call would not scale, and a private JSONL writer would fork
// the chain. Fails closed — if the repo's receipt writer cannot be loaded, nothing is witnessed silently.
export async function chainSeal(subject: string, input: Record<string, unknown>): Promise<SealResult> {
  const mod = (await import('../../../src/utils/receipts.js')) as unknown as Receipts;
  const rec = mod.appendReceipt('runs', {
    kind: 'seal',
    subject,
    policy: 'auto',
    status: input.status === 'denied' ? 'denied' : 'ok',
    sources: [input],
  });
  return { id: rec.id, hash: rec.hash };
}

export function createWitness(deps: WitnessDeps = {}): WitnessHooks {
  const seal: SealSink = deps.seal ?? chainSeal;

  const refuseGuarded = async (
    hit: { id: string; path_sha256: string },
    o: OrderContext,
    tool: string,
    callID: string,
    sessionID: string
  ): Promise<never> => {
    // The denial is sealed before the throw, so a blocked call still leaves evidence. The offending path
    // is bound by hash only — a witness must not copy the thing it is blocking into the chain.
    await seal('witness.denial', {
      reason: 'guarded_path',
      guarded_id: hit.id,
      path_sha256: hit.path_sha256,
      status: 'denied',
      tool,
      callID,
      sessionID,
      order: o.id,
      head: o.head,
    });
    throw new WitnessRefusal(
      'guarded_path',
      'this call touches a guarded path (' + hit.id + '); .env and the private overlay are not readable under witness'
    );
  };

  return {
    'tool.execute.before': async (input, output) => {
      const o = orderOf(deps); // outside an order: refused, and nothing is sealed (there is no order to bind)
      const hit = guardedHit(output.args);
      if (hit) await refuseGuarded(hit, o, input.tool, input.callID, input.sessionID);
      await seal('witness.intent', {
        tool: input.tool,
        args_sha256: argsHash(output.args),
        order: o.id,
        head: o.head,
        sessionID: input.sessionID,
        callID: input.callID,
      });
    },

    'tool.execute.after': async (input, output) => {
      const o = orderOf(deps);
      const outputText = String(output.output ?? '');
      const hit = guardedHit(input.args);
      if (hit) await refuseGuarded(hit, o, input.tool, input.callID, input.sessionID);
      await seal('witness.result', {
        tool: input.tool,
        args_sha256: argsHash(input.args),
        output_sha256: sha256(outputText),
        output_bytes: Buffer.byteLength(outputText, 'utf8'),
        managed_output: resolveManagedOutput(output.metadata, outputText, deps),
        order: o.id,
        head: o.head,
        sessionID: input.sessionID,
        callID: input.callID,
      });
    },

    'shell.env': async (input, output) => {
      const o = orderOf(deps);
      output.env.TIMMY_ORDER = o.id;
      output.env.TIMMY_HEAD = o.head;
      await seal('witness.shell.env', {
        order: o.id,
        head: o.head,
        cwd_sha256: sha256(String(input.cwd ?? '')),
        sessionID: input.sessionID ?? '',
        callID: input.callID ?? '',
      });
    },
  };
}

export { sha256 as sha256Of };
