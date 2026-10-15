/**
 * Round R4 (helper H93): Timmy Cloud's client, its verbs once for both surfaces: `timmy cloud …` (src/cloud/cli.ts) and the
 * REPL's `/cloud …` (src/cloud/repl.ts). Each returns lines to print (Timmy Homebrew roles: labels secondary, commands amber (B10),
 * outcome words in the text colour), one JSON object (--json), and an exit code: 0 done, 1 refused or not read (in full),
 * 2 usage.
 *
 *   use <url> --token-file <file>   records the backend's address and the PATH of the operator's token file (0600 or 0400;
 *                                   a looser file is refused); the token is never copied or printed; nothing is contacted
 *   status [--json]                 reads GET /v1/operator/overview and GET /v1/operator/orders with the token, and keeps the
 *                                   answer in <Timmy home>/cloud/overview.json (0600) with when it was read; a read that
 *                                   fails keeps the previous answer and records the attempt
 *
 * The client only reads. Approving, reconciling, resolving and deciding are the backend's operator routes, sent by a person
 * in this slice; the overview names each one to copy. The client holds no agency credential and never will.
 */
import path from 'node:path';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { tildePath } from '../utils/home-scrub.js';
import { expandHome } from '../connect/store.js';
import { money, parseOrders, parseOverview } from './answer.js';
import { getJson } from './read.js';
import { CLOUD_CACHE_SCHEMA, cloudPaths, readCache, readConfig, writeCache, writeConfig, type CloudCache, type CloudPaths } from './store.js';
import { checkBackendUrl, readTokenFile, redactToken } from './token.js';

export type Line = Segment[];

export interface CloudContext {
  /** Timmy home (TIMMY_HOME or ~/timmy when absent) */
  home?: string;
  glyphs: GlyphSet;
  by: 'cli' | 'repl';
  /** the folder a relative --token-file is resolved from */
  cwd?: string;
  /** how long each read waits for an answer (default 15 s) */
  timeoutMs?: number;
}

export interface CloudSaid { code: number; lines: Line[]; json: Record<string, unknown> }

export const SETUP_COMMAND = 'timmy cloud use <url> --token-file <file>';

export function cloudHelp(surface: 'cli' | 'repl' = 'cli'): string[] {
  const c = surface === 'cli' ? 'timmy cloud' : '/cloud';
  return [
    `${c}: Timmy Cloud's backend, read by its operator (Timmy Cloud client)`,
    '',
    `  ${c} use <url> --token-file <file>   the backend's address, and the file holding your operator token`,
    '      (yours alone: 0600 or 0400; Timmy keeps only its path, reads it at each read, never prints it)',
    `  ${c} status [--json]                 reads the backend's overview and orders now, and keeps the answer`,
    '      in <Timmy home>/cloud/overview.json (0600) for God\'s Eye View (/overview hosting)',
    `  ${c}                                 the same as ${c} status`,
    '',
    '  It only reads. Approving, reconciling and resolving are the backend\'s operator routes, sent by a person in',
    '  this slice; /overview hosting names each to copy. The client holds no agency credential and never will.',
    '  http:// is allowed only to this computer (127.0.0.1, ::1, localhost); use https:// for any other host.',
  ];
}

const label = (text: string): Segment => ({ text, role: 'secondary' });
const cmd = (text: string): Segment => ({ text, role: 'accent' });
const fail = (g: GlyphSet, words: string): Line => [{ text: `  ${g.fail} `, role: 'failure' }, { text: words }];
const okLine = (g: GlyphSet, words: string): Line => [{ text: `  ${g.ok} `, role: 'verified' }, { text: words }];
const stamp = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`; };

function usage(error: string, surface: 'cli' | 'repl'): CloudSaid {
  const c = surface === 'cli' ? 'timmy cloud' : '/cloud';
  return { code: 2, lines: [[{ text: `  ${error}` }], [label('  '), cmd(`${c} help`), label(' says what it does')]], json: { ok: false, error, usage: cloudHelp(surface) } };
}

interface Parsed { verb: string; pos: string[]; tokenFile?: string; json: boolean }
function parse(args: readonly string[]): Parsed | { error: string } {
  const pos: string[] = [];
  let tokenFile: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--token-file') { const v = args[++i]; if (v === undefined) return { error: '--token-file needs a file' }; tokenFile = v; }
    else if (a === '--help' || a === '-h') pos.unshift('help');
    else if (a.startsWith('-') && a.length > 1) return { error: `unknown option ${a}` };
    else pos.push(a);
  }
  return { verb: pos.shift() ?? 'status', pos, ...(tokenFile !== undefined ? { tokenFile } : {}), json };
}

/** The answer's summary in a few lines (the overview shows it in full: /overview hosting). */
export function answerLines(cache: CloudCache, g: GlyphSet): Line[] {
  const lines: Line[] = [];
  const ov = parseOverview(cache.overview);
  const orders = cache.orders === null ? null : parseOrders(cache.orders);
  if (!ov.ok) return [fail(g, `the overview could not be read: ${ov.why}`)];
  const o = ov.value;
  const p = o.provider;
  lines.push([label('  provider    '), { text: p ? `${p.name}${p.simulated ? ' (simulated: nothing real is bought or set up)' : p.simulated === null ? ' (whether it is simulated is not said)' : ''}` : 'not named' }]);
  if (orders?.ok) {
    const waits = orders.value.orders.filter((x) => x.needs_person).length;
    lines.push([label('  orders      '), { text: `${orders.value.orders.length}${waits ? `, ${waits} waiting for a person` : ''}; ${orders.value.resources.length} resource${orders.value.resources.length === 1 ? '' : 's'}` }]);
  } else lines.push([label('  orders      '), { text: `not known: ${orders ? orders.why : cache.orders_why ?? 'not read'}`, role: 'estimate' }]);
  for (const c of o.customers.slice(0, 6)) {
    const spend = c.approved_this_month_cents === null ? 'spend not said' : `${money(c.approved_this_month_cents)} approved${c.limits ? ` of ${money(c.limits.monthly_cents)}` : ''} in ${c.month || 'this month'}, ${c.paid_this_month_cents === null ? 'paid not said' : `${money(c.paid_this_month_cents)} paid`}`;
    lines.push([label('  customer    '), { text: `${c.customer_id} ${c.subscription}: ${spend}${c.orders_with_unknown_cost ? `, ${c.orders_with_unknown_cost} of unknown cost (never summed as 0)` : ''}` }]);
  }
  if (o.customers.length > 6) lines.push([label(`  and ${o.customers.length - 6} more customers`)]);
  const kinds = new Map<string, number>();
  for (const n of o.needs_person) kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
  lines.push([label('  needs you   '), { text: o.needs_person.length ? `${o.needs_person.length}: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}` : 'nothing' }]);
  return lines;
}

/** One `timmy cloud …` or `/cloud …`, run. */
export async function cloudDo(args: readonly string[], c: CloudContext): Promise<CloudSaid> {
  const parsed = parse(args);
  if ('error' in parsed) return usage(parsed.error, c.by);
  const g = c.glyphs;
  const p = cloudPaths(c.home);
  const surface = c.by === 'cli' ? 'timmy cloud' : '/cloud';
  switch (parsed.verb) {
    case 'help': return { code: 0, lines: cloudHelp(c.by).map((t) => [{ text: t }]), json: { ok: true, verb: 'help', usage: cloudHelp(c.by) } };
    case 'use': {
      if (parsed.pos.length !== 1 || parsed.tokenFile === undefined) return usage(`usage: ${surface} use <url> --token-file <file>`, c.by);
      const u = checkBackendUrl(parsed.pos[0]);
      if ('why' in u) return { code: 1, lines: [fail(g, `not set up: ${u.why}`)], json: { ok: false, verb: 'use', error: `not set up: ${u.why}` } };
      const file = path.resolve(c.cwd ?? process.cwd(), expandHome(parsed.tokenFile));
      // the file is checked as every read checks it (owner alone, a regular file, a token's shape); the token is not kept
      const t = readTokenFile(file);
      if (!t.ok) return { code: 1, lines: [fail(g, `not set up: ${t.why}`)], json: { ok: false, verb: 'use', error: `not set up: ${t.why}` } };
      writeConfig(p, { url: u.url, token_file: file, set_at: new Date().toISOString() });
      const words = `Timmy Cloud's backend is ${u.url}; the operator's token is read from ${tildePath(file)} at each read, never copied or printed (Timmy keeps only the file's path, in ${tildePath(p.config)}). Nothing was contacted.`;
      return {
        code: 0, lines: [okLine(g, words), [label('  then: '), cmd(`${surface} status`), label(' reads it')]],
        json: { ok: true, verb: 'use', backend: u.url, token_file: tildePath(file), config: tildePath(p.config), words },
      };
    }
    case 'status': {
      if (parsed.pos.length) return usage(`usage: ${surface} status [--json]`, c.by);
      return status(p, c, surface);
    }
    default: return usage(`unknown verb ${JSON.stringify(parsed.verb)}`, c.by);
  }
}

async function status(p: CloudPaths, c: CloudContext, surface: string): Promise<CloudSaid> {
  const g = c.glyphs;
  const conf = readConfig(p);
  if (conf.state === 'absent') {
    const words = `not set up: no backend is named in ${tildePath(p.config)}`;
    return { code: 1, lines: [fail(g, words), [label('  '), cmd(SETUP_COMMAND.replace('timmy cloud', surface)), label(' sets it up')]], json: { ok: false, verb: 'status', error: words, setup: SETUP_COMMAND } };
  }
  if (conf.state === 'unreadable') {
    const words = `${tildePath(p.config)} cannot be read: ${conf.why}`;
    return { code: 1, lines: [fail(g, words), [label('  '), cmd(SETUP_COMMAND.replace('timmy cloud', surface)), label(' writes it again')]], json: { ok: false, verb: 'status', error: words } };
  }
  const { url, token_file } = conf.config;
  const before = readCache(p);
  const kept = before.state === 'read' && before.cache.backend === url ? before.cache : null;
  const at = new Date().toISOString();
  // A read that does not happen keeps the previous answer (of this backend) and records the attempt.
  const failed = (why: string): CloudSaid => {
    const cache: CloudCache = kept ? { ...kept, failed: { at, why } } : { schema: CLOUD_CACHE_SCHEMA, backend: url, read_at: null, overview: null, orders: null, failed: { at, why } };
    let note = `the previous answer is kept${kept?.read_at ? ` (read ${stamp(kept.read_at)})` : ' (there is none)'}`;
    try { writeCache(p, `${JSON.stringify(cache, null, 2)}\n`); } catch (e) { note = `the attempt could not be recorded (${(e as NodeJS.ErrnoException).code ?? 'error'})`; }
    const words = `not read: ${why}; ${note}`;
    return { code: 1, lines: [fail(g, words)], json: { ok: false, verb: 'status', backend: url, error: words, cache: tildePath(p.cache) } };
  };
  const t = readTokenFile(token_file);
  if (!t.ok) return failed(t.why);
  const token = t.token;
  const scrub = (s: string): string => redactToken(s, token);
  const ov = await getJson(url, '/v1/operator/overview', token, { ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}) });
  if (!ov.ok) return failed(ov.why);
  const orders = await getJson(url, '/v1/operator/orders', token, { ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}) });
  const cache: CloudCache = {
    schema: CLOUD_CACHE_SCHEMA, backend: url, read_at: at, overview: ov.json, orders: orders.ok ? orders.json : null,
    ...(orders.ok ? {} : { orders_why: orders.status === 404 ? `${orders.why} (this backend has no orders route: it is older than this client)` : orders.why }),
  };
  // The token is never in what is kept or printed, whatever the backend answered.
  const text = scrub(`${JSON.stringify(cache, null, 2)}\n`);
  const shown = JSON.parse(text) as CloudCache;
  try { writeCache(p, text); } catch (e) {
    const words = `read, and not kept: ${tildePath(p.cache)} could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
    return { code: 1, lines: [fail(g, words)], json: { ok: false, verb: 'status', backend: url, error: words } };
  }
  const head: Line = [{ text: '  Timmy Cloud ', role: 'strong' }, { text: url }, label(`  read ${stamp(at)}`)];
  const lines: Line[] = [head, ...answerLines(shown, g)];
  if (!orders.ok) lines.push(fail(g, `partly read: ${shown.orders_why}`));
  lines.push([label(`  kept in ${tildePath(p.cache)} (0600); God's Eye View shows it: `), cmd('/overview hosting')]);
  return {
    code: orders.ok ? 0 : 1, lines,
    json: { ok: orders.ok, verb: 'status', backend: url, read_at: at, cache: tildePath(p.cache), overview: shown.overview, orders: shown.orders, ...(shown.orders_why ? { orders_why: shown.orders_why } : {}) },
  };
}
