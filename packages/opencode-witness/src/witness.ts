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
import { constants, openSync, closeSync, fstatSync, lstatSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  readFile?: (p: string) => string | Uint8Array;
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

const sha256 = (s: string | Uint8Array): string => 'sha256_' + createHash('sha256').update(s).digest('hex');

const sortDeep = (v: unknown, seen = new Set<object>(), depth = 0): unknown => {
  if (depth > 100) throw new WitnessRefusal('invalid_args', 'argument nesting exceeds the supported bound');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object') {
    if (seen.has(v)) throw new WitnessRefusal('invalid_args', 'arguments must be acyclic JSON');
    if ((!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) || Object.getOwnPropertySymbols(v).length) {
      throw new WitnessRefusal('invalid_args', 'arguments must be plain JSON');
    }
    seen.add(v);
    if (Array.isArray(v)) {
      const result = Array.from(v, item => sortDeep(item, seen, depth + 1));
      seen.delete(v);
      return result;
    }
    const src = v as Record<string, unknown>;
    const result = Object.fromEntries(Object.keys(src).sort().map(k => [k, sortDeep(src[k], seen, depth + 1)]));
    seen.delete(v);
    return result;
  }
  throw new WitnessRefusal('invalid_args', 'arguments must contain only finite JSON values');
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

// A Managed Tool Output File is the harness-persisted file a large tool result is spilled to (the
// `<persisted-output>` / truncated-output case). OpenCode's after-hook exposes only {title,output,metadata},
// so the file is found by a metadata key or by the marker in the output text — and bound by hash, never
// by content, so a spilled secret is not copied into the chain.
const MOF_KEY = /managed|persisted|output_?file|outfile|truncated_?to/i;
const MOF_TEXT = /([/~][^\s'"<>|]+\.output)\b/;

export type ManagedOutput =
  | 'none'
  | { path: string; realpath?: string; sha256?: string; size?: number; missing?: boolean }
  | { refused: 'guarded_path' | 'unsafe_file'; guarded_id: string; path_sha256: string; alias_of_sha256?: string };

export function resolveManagedOutput(
  metadata: unknown,
  output: string,
  deps: WitnessDeps = {}
): ManagedOutput {
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
  const unsafe = (reason: string): ManagedOutput => ({ refused: 'unsafe_file', guarded_id: reason, path_sha256: sha256(path) });
  const blocked = (candidate: string): ManagedOutput | null => {
    const h = guardedHit(candidate);
    return h ? { refused: 'guarded_path', guarded_id: h.id, path_sha256: sha256(path), alias_of_sha256: sha256(candidate) } : null;
  };
  // realpath alone discards intermediate symlink names. Resolve one component
  // at a time and guard every hop before inspecting the next one. Do not
  // normalize '..' before following links: that changes native path semantics.
  let real = '/';
  let todo = (path.startsWith('/') ? path : `${process.cwd()}/${path}`).split('/');
  let hops = 0;
  let expected: ReturnType<typeof lstatSync>;
  try {
    while (todo.length) {
      const part = todo.shift()!;
      if (!part || part === '.') continue;
      if (part === '..') { real = dirname(real); continue; }
      const candidate = join(real, part);
      const guard = blocked(candidate);
      if (guard) return guard;
      const st = lstatSync(candidate);
      if (st.isSymbolicLink()) {
        if (++hops > 40) return unsafe('symlink_limit');
        const target = readlinkSync(candidate);
        const expanded = target.startsWith('/') ? target : `${real}/${target}`;
        const targetGuard = blocked(expanded);
        if (targetGuard) return targetGuard;
        if (target.startsWith('/')) real = '/';
        todo = [...target.split('/'), ...todo];
      } else real = candidate;
    }
    expected = lstatSync(real);
    const resolved = (deps.realpath ?? realpathSync)(path);
    if (resolved !== real) return unsafe('resolution_changed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, missing: true };
    return unsafe('resolution_failed');
  }
  if (!expected.isFile()) return unsafe('not_regular');
  if (expected.size > 16 * 1024 * 1024) return unsafe('size_limit');
  if (deps.exists && !deps.exists(path)) return { path, missing: true };
  // The production path hashes raw bytes from one no-follow, nonblocking
  // descriptor. Match the inspected inode before reading, then check it stayed
  // stable. Injected readers are trusted test adapters, not a security boundary.
  const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.size > 16 * 1024 * 1024) return unsafe('file_changed');
    let bytes: Buffer;
    if (deps.readFile) bytes = Buffer.from(deps.readFile(path));
    else {
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      bytes = buffer.subarray(0, offset);
    }
    const after = fstatSync(fd);
    if (before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return unsafe('file_changed');
    if (deps.sizeOf && deps.sizeOf(path) !== bytes.length) return unsafe('size_mismatch');
    return { path, ...(real !== path ? { realpath: real } : {}), sha256: sha256(bytes), size: bytes.length };
  } finally { closeSync(fd); }
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
  receipt?: SealResult;
  state: 'intent_pending' | 'ready' | 'result_pending' | 'seal_uncertain';
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
      const args_sha256 = argsHash(output.args); // Validate before recursive guard traversal.
      const hit = guardedHit(output.args);
      if (hit) await refuseGuarded(hit, o, input.tool, input.callID, input.sessionID);
      const key = intentKey(input.sessionID, input.callID);
      const existing = pending.get(key);
      if (existing) {
        const reason = existing.state === 'seal_uncertain' ? 'seal_uncertain' : 'duplicate_intent';
        // Refuse BEFORE sealing a replacement or overwriting: the original intent stays authoritative and
        // the denial cites it, so a second before-hook cannot launder a different call under one identity.
        await seal('witness.denial', {
          reason,
          status: 'denied',
          tool: input.tool,
          callID: input.callID,
          sessionID: input.sessionID,
          order: o.id,
          head: o.head,
          existing_intent_receipt: existing.receipt?.id,
          existing_intent_hash: existing.receipt?.hash,
        });
        throw new WitnessRefusal(
          reason,
          'an intent is already pending for this (sessionID, callID) — the original is preserved and no replacement is sealed'
        );
      }
      const reservation: PendingIntent = {
        tool: input.tool, sessionID: input.sessionID, args_sha256,
        order: o.id, head: o.head, state: 'intent_pending',
      };
      pending.set(key, reservation); // Reserve before the first asynchronous write.
      try {
        const receipt = await seal('witness.intent', {
          tool: input.tool,
          args_sha256,
          order: o.id,
          head: o.head,
          sessionID: input.sessionID,
          callID: input.callID,
        });
        reservation.receipt = receipt;
        reservation.state = 'ready';
      } catch {
        // A rejected append may already have committed. Preserve identity and
        // require reconciliation rather than blindly writing another intent.
        reservation.state = 'seal_uncertain';
        throw new WitnessRefusal('seal_uncertain', 'intent append outcome is unknown; reconciliation required');
      }
    },

    'tool.execute.after': async (input, output) => {
      const o = orderOf(deps);
      const afterArgs = argsHash(input.args);
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
      if (intent.state !== 'ready' || !intent.receipt) {
        await refuseResult(intent.state === 'seal_uncertain' ? 'seal_uncertain' : 'operation_in_flight',
          'this identity is not ready for a result; wait or reconcile the uncertain append');
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
      intent.state = 'result_pending';
      let sealAttempted = false;
      try {
        const text = String(output.output ?? '');
        const managed = resolveManagedOutput(output.metadata, text, deps);
        if (managed !== 'none' && 'refused' in managed) {
          sealAttempted = true;
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
        sealAttempted = true;
        await seal('witness.result', {
          tool: intent.tool,
          // the intent's hash is the linkage; a differing after-hash is flagged, never substituted
          args_sha256: intent.args_sha256,
          args_drift: afterArgs === intent.args_sha256 ? false : afterArgs,
          intent_receipt: intent.receipt.id,
          intent_hash: intent.receipt.hash,
          output_sha256: sha256(text),
          output_bytes: Buffer.byteLength(text, 'utf8'),
          managed_output: managed,
          order: intent.order,
          head: intent.head,
          sessionID: intent.sessionID,
          callID: input.callID,
        });
        pending.delete(key); // Consume only after an observed successful append.
      } catch (error) {
        intent.state = sealAttempted ? 'seal_uncertain' : 'ready';
        if (sealAttempted) throw new WitnessRefusal('seal_uncertain', 'result append outcome is unknown; reconciliation required');
        throw error;
      }
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
