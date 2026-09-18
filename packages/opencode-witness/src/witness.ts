// ORDER witness-o7c2 C1 — the witness core. Pure and injectable: no OpenCode import, so it is testable
// outside the harness.
//
// Versions are recorded separately because they do not have to match:
//   * OpenCode CLI 1.18.31 — `opencode --version`; /opt/homebrew/bin/opencode → Cellar/opencode/1.18.31.
//   * @opencode-ai/plugin 1.4.7 — the SDK actually installed locally, in BOTH ~/.opencode/node_modules
//     and ~/.config/opencode/node_modules, with @opencode-ai/sdk 1.4.7 alongside.
// The shapes below were read from the installed 1.4.7 dist/index.d.ts: Hooks at line 170,
// "tool.execute.before"(input{tool,sessionID,callID}, output{args}) at 231-237,
// "shell.env"(input{cwd,sessionID?,callID?}, output{env}) at 238-244,
// "tool.execute.after"(input{tool,sessionID,callID,args}, output{title,output,metadata}) at 245-254,
// Plugin at 51 and PluginModule {id?, server, tui?: never} at 52-54. The registry's 1.18.31 tarball
// happens to carry identical shapes for these three hooks, but the installed 1.4.7 d.ts is the
// authority here: a registry version is not evidence about a local install.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve as resolvePath } from 'node:path';

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
  realpath?: (p: string) => string;
};

// Fail-closed by design: a witness does not parse intent. `.env.example` is refused too — narrowing this
// list is an operator decision, documented in the package README. Case-insensitive because the host
// filesystem (macOS/APFS by default) is case-insensitive, so `.ENV` opens `.env`.
export const GUARDED_PATHS: { id: string; re: RegExp }[] = [
  { id: 'dotenv', re: /(^|[/\s'"])\.env(\.[A-Za-z0-9_.-]+)?($|[/\s'"])/i },
  { id: 'private_overlay', re: /\.timmy[/\\]private([/\\]|$)/i },
  { id: 'privacy_overlay_module', re: /lanes[/\\]privacy[/\\]overlay\./i },
];

// Lexical normalization for GUARD MATCHING ONLY — never used to open a file. Collapses `.` and `..`
// segments, expands a leading `~`, drops duplicate and trailing separators, and clamps a `..` that would
// escape the root, so `/a/../../.env` still matches as `/.env`. Without it, `/x/.timmy/pub/../private/y`
// hides a guarded path from a raw match. Non-path strings pass through unchanged and harmless.
export const normalizePathish = (s: string): string => {
  const t = s.trim();
  if (!t) return t;
  const home = t === '~' || t.startsWith('~/') || t.startsWith('~\\');
  const win = /^[A-Za-z]:[\\/]/.test(t);
  const prefix = home ? '~/' : win ? t.slice(0, 2) + '/' : t.startsWith('/') ? '/' : '';
  const body = home ? t.slice(1) : win ? t.slice(2) : t;
  const out: string[] = [];
  for (const seg of body.split(/[/\\]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop(); // clamped at the root: escaping `..` cannot smuggle a guarded tail past
      continue;
    }
    out.push(seg);
  }
  return prefix + out.join('/');
};

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

// Both the raw string and its lexical normalization are matched: the raw form catches what a reader would
// see, the normalized form catches a traversal alias such as `/x/.timmy/pub/../private/y`. The hash bound
// in a refusal is of the ORIGINAL string, so the evidence names what was actually presented.
export const guardedHit = (args: unknown): { id: string; path_sha256: string } | null => {
  for (const s of strings(args)) {
    const norm = normalizePathish(s);
    const forms = norm === s ? [s] : [s, norm];
    for (const f of forms) {
      for (const g of GUARDED_PATHS) {
        if (g.re.test(f)) return { id: g.id, path_sha256: sha256(s) };
      }
    }
  }
  return null;
};

const pathPrefixes = (p: string): { path: string; rest: string[] }[] => {
  const root = parse(p).root;
  const segments = p
    .slice(root.length)
    .split(/[/\\]+/)
    .filter(Boolean);
  const prefixes: { path: string; rest: string[] }[] = [];
  let acc = root;
  for (let i = 0; i < segments.length; i++) {
    acc = acc ? join(acc, segments[i]) : segments[i];
    prefixes.push({ path: acc, rest: segments.slice(i + 1) });
  }
  return prefixes;
};

const guardedSymlinkAlias = (p: string): { hit: { id: string }; alias: string } | null => {
  let current = p;
  const seen = new Set<string>([resolvePath(p)]);
  for (let hops = 0; hops < 40; hops++) {
    let followed = false;
    for (const prefix of pathPrefixes(current)) {
      try {
        if (!lstatSync(prefix.path).isSymbolicLink()) continue;
        const target = readlinkSync(prefix.path);
        const alias = isAbsolute(target) ? target : join(dirname(prefix.path), target);
        const hit = guardedHit([target, alias]);
        if (hit) return { hit, alias };
        const next = prefix.rest.length ? join(alias, ...prefix.rest) : alias;
        const key = resolvePath(next);
        if (seen.has(key)) return null;
        seen.add(key);
        current = next;
        followed = true;
        break;
      } catch {
        continue;
      }
    }
    if (!followed) return null;
  }
  return null;
};

// A Managed Tool Output File is the harness-persisted file a large tool result is spilled to (the
// `<persisted-output>` / truncated-output case). OpenCode's after-hook exposes only {title,output,metadata},
// so the file is found by a metadata key or by the marker in the output text — and bound by hash, never
// by content, so a spilled secret is not copied into the chain.
const MOF_KEY = /managed|persisted|output_?file|outfile|truncated_?to/i;
const MOF_TEXT = /([/~][^\s'"<>|]+\.output)\b/;

export type ManagedOutput =
  | 'none'
  | { path: string; realpath?: string; sha256?: string; size?: number; missing?: boolean }
  | { refused: 'guarded_path'; guarded_id: string; path_sha256: string; alias_of_sha256?: string };

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
  // The candidate is tool-controlled input — metadata keys or the output text can name any path — so it
  // is guarded BEFORE exists/stat/read. A tool must not be able to redirect the witness into hashing
  // .env or the private overlay, and a refused candidate is bound by hash only: the literal path never
  // enters the chain, and nothing is read or measured.
  const hit = guardedHit(path);
  if (hit) return { refused: 'guarded_path', guarded_id: hit.id, path_sha256: hit.path_sha256 };
  // A lexical miss is not enough: the candidate can be a symlink, or sit under a symlinked directory,
  // whose target chain is guarded. Resolve aliases BEFORE any exists/stat/read, so protected content
  // cannot be reached — or hashed — behind an innocent-looking name.
  // Resolution reads no content; an unresolvable path falls through to the missing branch.
  const symlinkAlias = deps.realpath ? null : guardedSymlinkAlias(path);
  if (symlinkAlias) {
    return {
      refused: 'guarded_path',
      guarded_id: symlinkAlias.hit.id,
      path_sha256: sha256(path),
      alias_of_sha256: sha256(symlinkAlias.alias),
    };
  }
  const resolve = deps.realpath ?? realpathSync;
  let real = path;
  try {
    real = resolve(path);
  } catch {
    real = path;
  }
  if (real !== path) {
    const alias = guardedHit(real);
    if (alias) {
      return {
        refused: 'guarded_path',
        guarded_id: alias.id,
        path_sha256: sha256(path),
        alias_of_sha256: sha256(real),
      };
    }
  }
  if (!exists(path)) return { path, missing: true };
  // A PERMITTED path is bound literally: `path` (and `realpath` when it differs) stay visible in the
  // receipt. Only refused candidates are hash-only.
  return {
    path,
    ...(real !== path ? { realpath: real } : {}),
    sha256: sha256(read(path)),
    size: sizeOf(path),
  };
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

// Session/call identity: an intent is identified by the pair OpenCode hands both hooks — (sessionID,
// callID). callID alone is NOT unique across sessions, so it is never the key by itself; the key is the
// JSON pair, which is injective (no value can forge the separator).
export const intentKey = (sessionID: string, callID: string): string => JSON.stringify([sessionID, callID]);

// An intent is single-use and stays bound to the context it was sealed in: the after-hook must present the
// same identity, tool, order and head, or the result is refused. A duplicate before-hook is refused rather
// than overwriting the pending intent or sealing a replacement. A witness that re-bound a result to
// whatever the environment happens to say now would be forgeable, and a nonempty TIMMY_ORDER /
// TIMMY_HEAD is context — not authorization, and not identity.
type PendingIntent = {
  tool: string;
  sessionID: string;
  args_sha256: string;
  order: string;
  head: string;
  receipt: SealResult;
};

export function createWitness(deps: WitnessDeps = {}): WitnessHooks {
  const seal: SealSink = deps.seal ?? chainSeal;
  const pending = new Map<string, PendingIntent>();

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
      const key = intentKey(input.sessionID, input.callID);
      const existing = pending.get(key);
      if (existing) {
        // Refuse BEFORE sealing a replacement or overwriting: the original intent stays authoritative and
        // the denial cites it, so a second before-hook cannot launder a different call under one identity.
        await seal('witness.denial', {
          reason: 'duplicate_intent',
          status: 'denied',
          tool: input.tool,
          callID: input.callID,
          sessionID: input.sessionID,
          order: o.id,
          head: o.head,
          existing_intent_receipt: existing.receipt.id,
          existing_intent_hash: existing.receipt.hash,
        });
        throw new WitnessRefusal(
          'duplicate_intent',
          'an intent is already pending for this (sessionID, callID) — the original is preserved and no replacement is sealed'
        );
      }
      const args_sha256 = argsHash(output.args);
      const receipt = await seal('witness.intent', {
        tool: input.tool,
        args_sha256,
        order: o.id,
        head: o.head,
        sessionID: input.sessionID,
        callID: input.callID,
      });
      pending.set(key, {
        tool: input.tool,
        sessionID: input.sessionID,
        args_sha256,
        order: o.id,
        head: o.head,
        receipt,
      });
    },

    'tool.execute.after': async (input, output) => {
      const o = orderOf(deps);
      const hit = guardedHit(input.args);
      if (hit) await refuseGuarded(hit, o, input.tool, input.callID, input.sessionID);

      const refuseResult = async (reason: string, detail: string): Promise<void> => {
        // Sealed before the throw; the reason text is bound by hash so no argument value ever enters
        // the chain.
        await seal('witness.denial', {
          reason,
          detail_sha256: sha256(detail),
          status: 'denied',
          tool: input.tool,
          callID: input.callID,
          sessionID: input.sessionID,
          order: o.id,
          head: o.head,
        });
        throw new WitnessRefusal(reason, detail);
      };

      const key = intentKey(input.sessionID, input.callID);
      const intent = pending.get(key);
      if (!intent) {
        await refuseResult(
          'orphan_result',
          'no witness.intent is pending for this (sessionID, callID) — a result without its matching intent is refused, not sealed'
        );
        return;
      }
      // sessionID is already part of the identity key, so only the tool can mismatch here
      if (intent.tool !== input.tool) {
        await refuseResult(
          'intent_mismatch',
          'this after-hook names a different tool than the intent sealed for this (sessionID, callID)'
        );
        return;
      }
      if (intent.order !== o.id || intent.head !== o.head) {
        await refuseResult(
          'context_changed',
          'the order context changed between the intent and the result — the original linkage is preserved, never rebound'
        );
        return;
      }
      pending.delete(key); // single-use: a replayed after-hook arrives as an orphan

      const text = String(output.output ?? '');
      const afterArgs = argsHash(input.args);
      const managed = resolveManagedOutput(output.metadata, text, deps);
      if (managed !== 'none' && 'refused' in managed) {
        await seal('witness.denial', {
          reason: 'managed_output_redirect',
          guarded_id: managed.guarded_id,
          path_sha256: managed.path_sha256,
          status: 'denied',
          tool: intent.tool,
          callID: input.callID,
          sessionID: intent.sessionID,
          order: intent.order,
          head: intent.head,
        });
      }
      await seal('witness.result', {
        tool: intent.tool,
        // the intent's hash is the linkage; a differing after-hash is flagged, never substituted
        args_sha256: intent.args_sha256,
        args_drift: afterArgs === intent.args_sha256 ? false : afterArgs,
        intent_receipt: intent.receipt.id,
        intent_hash: intent.receipt.hash,
        output_sha256: sha256(text),
        output_bytes: text.length,
        managed_output: managed,
        order: intent.order,
        head: intent.head,
        sessionID: intent.sessionID,
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
