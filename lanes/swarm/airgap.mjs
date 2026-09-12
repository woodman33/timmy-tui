#!/usr/bin/env node
// lanes/swarm/airgap.mjs — the "closed" swarm topology's air-gap enforcement.
//
// Three layers, one file:
//   1. policy   — policyFor(spec) / policyHash(policy) / isPrivateEndpoint(url)
//   2. hands    — runHandsClosed(script, {context, timeout}) runs an untrusted JS
//                 function body under sbx lockdown with every egress primitive
//                 shadowed and every host-realm reference removed from the vm.
//   3. wire     — snoopSession(name, runFn) runs Timmy's MCP server behind
//                 mcpsnoop, speaks JSON-RPC to it over stdio, exports the
//                 session, and counts tool calls that look like egress.
//
// CLI:
//   node lanes/swarm/airgap.mjs policy   [--json]
//   node lanes/swarm/airgap.mjs selftest [--json]
//
// Nothing here prints or writes environment secrets; the server child gets an
// env with *_KEY / *_TOKEN / *_SECRET / *PASSWORD names removed (closed policy).

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));            // <root>/lanes/swarm
const WORKTREE_ROOT = resolve(HERE, '..', '..');                  // <root>
const CACHE_DIR = join(HERE, '.cache', 'snoop');                  // gitignored

// ---------------------------------------------------------------------------
// 1. policy
// ---------------------------------------------------------------------------

export const TAILNET_CIDR = '100.64.0.0/10';
export const DENIAL = 'egress denied by policy';
export const EGRESS_TOOL_RE = /fetch|http|browser|web|url|openrouter|curl/i;
const CLOSED_HOSTS = Object.freeze(['127.0.0.1', 'localhost', TAILNET_CIDR]);
const PRIVATE_CIDRS = Object.freeze(['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', TAILNET_CIDR]);

/**
 * Build the closed network policy from a swarm spec (lanes/swarm schema:
 * spec.network = { policy: 'open'|'tailnet'|'closed', egress_allow: string[] }).
 * Accepts the whole spec, just its network object, or the string 'closed'.
 * Throws for anything that is not a closed swarm — this module enforces one thing.
 */
export function policyFor(spec = {}) {
  const src = spec && typeof spec === 'object' ? spec : { network: spec };
  let net = src.network ?? (('policy' in src || 'egress_allow' in src) ? src : {});
  if (typeof net === 'string') net = { policy: net };
  if (!net || typeof net !== 'object') net = {};
  const topology = src.topology ?? null;
  const policy = net.policy ?? ((topology === null || topology === 'closed') ? 'closed' : null);
  if (policy !== 'closed') {
    throw new Error(`airgap: only the closed policy is enforced here (network.policy=${JSON.stringify(policy)}, topology=${JSON.stringify(topology)})`);
  }
  if (topology !== null && topology !== 'closed') {
    throw new Error(`airgap: network.policy closed requires topology closed (got ${JSON.stringify(topology)})`);
  }
  const allow = Array.isArray(net.egress_allow) ? net.egress_allow : [];
  if (allow.length) throw new Error(`airgap: a closed swarm has an empty egress_allow (got ${allow.length})`);
  return {
    policy: 'closed',
    egress_allow: [],
    hands: 'sbx-lockdown',
    allowed_hosts: [...CLOSED_HOSTS],
    denied: '*',
  };
}

/** Canonical JSON: object keys sorted recursively, arrays kept in order, undefined dropped. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function policyHash(policy) {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex');
}

function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n * 256) + o;
  }
  return n >>> 0;
}

function inCidr(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const b = parseIPv4(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
}

/**
 * True only for: localhost, ::1, 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10
 * (tailnet). String-only — no DNS, so a hostname that *would* resolve to a
 * private address is still denied. Accepts a URL or a bare host[:port].
 */
export function isPrivateEndpoint(input) {
  if (typeof input !== 'string' || !input.trim()) return false;
  let host;
  try {
    const s = input.trim();
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s);
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host === '::1') return true;
  let v4 = host;
  if (host.startsWith('::ffff:')) {
    // IPv4-mapped IPv6; WHATWG URL serialises it in hex form (::ffff:a00:1).
    const rest = host.slice(7);
    if (rest.includes('.')) v4 = rest;
    else {
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      if (!m) return false;
      const hi = parseInt(m[1], 16); const lo = parseInt(m[2], 16);
      v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  const ip = parseIPv4(v4);
  if (ip === null) return false;
  return PRIVATE_CIDRS.some((cidr) => inCidr(ip, cidr));
}

// ---------------------------------------------------------------------------
// 2. hands under deny-all (sbx lockdown + sandbox-realm prelude)
// ---------------------------------------------------------------------------
//
// sbx forks a child, builds `Object.assign({}, standards, context, {_result,
// _exception, _stdout})` and runs the code with vm.runInNewContext. `standards`
// leaks HOST objects into the sandbox (process, setTimeout, exports,
// captureConsole) and `_stdout` is a host array — each one is a realm-escape
// handle (`x.constructor.constructor('return process')()`). `context` crosses
// process.send as JSON, so it cannot carry functions or undefined.
//
// The fix is sbx's `transform(code)` hook, which runs in the parent and lets us
// replace the whole wrapper with our own source that executes INSIDE the vm:
//   - a prelude that (a) overwrites every host reference on the sandbox global
//     with sandbox-realm values — timers become id-returning wrappers, console
//     capture / exports / sbx / _stdout are re-created in the sandbox, user
//     context values are deep-cloned into the sandbox — and (b) pins every
//     egress name to `undefined` (non-enumerable so sbx's JSON/for-in reply
//     serialisation ignores them; configurable so sbx's strict-mode `delete`
//     in clean() still works). `require` is a deny *value* because sbx
//     evaluates `if (context.require)`.
//   - the untrusted body runs inside `with (denyScope)`, a Proxy whose `has`
//     claims the egress names and whose `get`/`set` throw DENIAL. Identifier
//     resolution consults the with-object before the global, so `typeof fetch`
//     and `fetch(...)` both throw exactly DENIAL — independent of how the vm
//     global-proxy interceptor treats accessors (it swallows getter throws).
// After the prelude the sandbox global holds no host-realm reference at all.

const DENY_NAMES = Object.freeze([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'require', 'process',
  'child_process', 'globalThis', 'navigator', 'importScripts', 'Deno', 'Bun',
  'module', '__filename', '__dirname',
]);
const RESERVED_CONTEXT_KEYS = new Set([
  '_result', '_exception', '_stdout', 'exports', 'sbx', 'console',
  'captureConsole', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  '__airgapDenyScope', ...DENY_NAMES,
]);

function buildSource(script, contextKeys) {
  return `(function () {
  var g = this;
  var DENIAL = ${JSON.stringify(DENIAL)};
  var DENY_NAMES = ${JSON.stringify(DENY_NAMES)};
  var denyFn = function () { throw new Error(DENIAL); };
  var define = function (name, value) {
    Object.defineProperty(g, name, { configurable: true, enumerable: false, writable: false, value: value });
  };
  var hostSetTimeout = setTimeout, hostClearTimeout = clearTimeout;
  var hostSetInterval = setInterval, hostClearInterval = clearInterval;

  DENY_NAMES.forEach(function (name) { define(name, undefined); });
  define('require', denyFn);
  define('exports', {});
  define('sbx', {});
  define('__airgapDenyScope', function () {
    var names = {};
    DENY_NAMES.forEach(function (n) { names[n] = true; });
    var denied = function (k) { return typeof k === 'string' && names[k] === true; };
    return new Proxy(Object.create(null), {
      has: function (t, k) { return denied(k); },
      get: function (t, k) { if (denied(k)) throw new Error(DENIAL); return undefined; },
      set: function (t, k) { if (denied(k)) throw new Error(DENIAL); return false; },
      deleteProperty: function (t, k) { if (denied(k)) throw new Error(DENIAL); return false; },
    });
  });

  g._stdout = [];
  var fmt = function (a) {
    if (typeof a === 'string') return a;
    try { var s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch (e) { return String(a); }
  };
  define('captureConsole', function (out) {
    var mk = function (type) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        out.push({ type: type, time: new Date().toISOString(), stdout: args.map(fmt).join(' ') });
      };
    };
    return { log: mk('log'), error: mk('error'), info: mk('info'), warn: mk('warn'), trace: mk('trace'),
             debug: mk('log'), dir: mk('log'), assert: function () {}, time: function () {}, timeEnd: function () {} };
  });

  var timers = {}; var seq = 0;
  var wrapCb = function (fn, args) {
    return function () {
      try { if (typeof fn === 'function') fn.apply(undefined, args); }
      catch (e) { g._stdout.push({ type: 'error', time: new Date().toISOString(), stdout: 'uncaught in timer: ' + (e && e.message) }); }
    };
  };
  define('setTimeout', function (fn, ms) {
    var id = ++seq; var args = Array.prototype.slice.call(arguments, 2);
    timers[id] = hostSetTimeout(function () { delete timers[id]; wrapCb(fn, args)(); }, ms);
    return id;
  });
  define('clearTimeout', function (id) { var t = timers[id]; if (t) { hostClearTimeout(t); delete timers[id]; } });
  define('setInterval', function (fn, ms) {
    var id = ++seq; var args = Array.prototype.slice.call(arguments, 2);
    timers[id] = hostSetInterval(wrapCb(fn, args), ms);
    return id;
  });
  define('clearInterval', function (id) { var t = timers[id]; if (t) { hostClearInterval(t); delete timers[id]; } });

  ${JSON.stringify(contextKeys)}.forEach(function (k) {
    try { g[k] = JSON.parse(JSON.stringify(g[k])); } catch (e) { g[k] = undefined; }
  });
}).call(this);
try {
  var console = captureConsole(_stdout);
  sbx.log = console.log;
  _result = (function (__scope) {
    with (__scope) {
      return (function () {
${script}
      }).call(this);
    }
  }).call(this, __airgapDenyScope());
  if (_result && typeof _result.then === 'function') {
    _result = _result.then(function (_promiseResult) {
      _result = _promiseResult;
    }).catch(function (err) {
      err = err instanceof Error ? err : new Error(err);
      _exception = { scope: 'vm', lineNumber: err.lineNumber, message: err.message, stack: err.stack };
    });
  }
} catch (err) {
  err = err instanceof Error ? err : new Error(err);
  _exception = { scope: 'vm', lineNumber: err.lineNumber, message: err.message, stack: err.stack };
}
`;
}

let sbxModule = null;
function loadSbx() {
  if (sbxModule) return sbxModule;
  const req = createRequire(import.meta.url);
  let mod;
  try {
    mod = req('sbx');
  } catch (e) {
    throw new Error(`airgap: the sbx package is not installed — run \`npm i\` inside ${HERE} (${e.message})`);
  }
  const vm = mod?.vm ?? mod?.default?.vm;
  if (typeof vm !== 'function') throw new Error('airgap: sbx export shape unexpected (no vm function)');
  sbxModule = { vm };
  return sbxModule;
}

/**
 * Run an untrusted JavaScript function body under sbx lockdown with deny-all
 * egress. `script` is the *body* of an anonymous function (use `return`).
 * `context` is a plain JSON-able object whose keys become globals in the vm.
 * Returns { ok, result, exception, stdout, ms, denied, timed_out }.
 *
 * Note: sbx leaks a setInterval on a hard hang (async code that never settles);
 * the CLI exits explicitly, library callers should not rely on natural exit.
 */
export async function runHandsClosed(script, opts = {}) {
  if (typeof script !== 'string') throw new TypeError('airgap: script must be a string (a function body)');
  const context = opts.context ?? {};
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('airgap: context must be a plain object');
  for (const k of Object.keys(context)) {
    if (RESERVED_CONTEXT_KEYS.has(k) || k.startsWith('_')) throw new Error(`airgap: context key ${JSON.stringify(k)} is reserved`);
    if (typeof context[k] === 'function') throw new Error(`airgap: context key ${JSON.stringify(k)} is a function; only JSON values cross into hands`);
  }
  const timeout = Number.isFinite(opts.timeout) && opts.timeout > 0 ? Math.floor(opts.timeout) : 5000;
  const { vm } = loadSbx();
  const keys = Object.keys(context).filter((k) => context[k] !== undefined);
  const source = buildSource(script, keys);

  // sbx passes its message object as fork() options, so `timeout` also becomes a
  // child-kill timeout; a sync hang therefore ends with a dead child and no IPC
  // reply. The guard below turns that into a timed_out result.
  const t0 = performance.now();
  let guardTimer;
  const guard = new Promise((res) => { guardTimer = setTimeout(() => res({ timedOut: true }), timeout + 500); });
  const run = vm(script, { context, lockdown: true, timeout, transform: () => source })
    .then((ctx) => ({ ctx }), (err) => ({ err }));
  const outcome = await Promise.race([run, guard]);
  clearTimeout(guardTimer);
  const ms = Math.round((performance.now() - t0) * 10) / 10;

  const stdoutOf = (ctx) => (Array.isArray(ctx?._stdout) ? ctx._stdout : []);
  if (outcome.timedOut) {
    return { ok: false, result: null, exception: { scope: 'host', message: `hands timed out after ${timeout} ms` }, stdout: [], ms, denied: false, timed_out: true };
  }
  if (outcome.err) {
    const e = outcome.err;
    const ex = e?.context?._exception ?? { scope: 'host', message: e?.message ?? String(e) };
    const exception = { scope: ex.scope ?? 'vm', message: ex.message ?? String(e) };
    const timedOut = /timed out/i.test(exception.message);
    return { ok: false, result: null, exception, stdout: stdoutOf(e?.context), ms, denied: exception.message === DENIAL, timed_out: timedOut };
  }
  const ctx = outcome.ctx;
  return { ok: true, result: ctx?._result ?? null, exception: null, stdout: stdoutOf(ctx), ms, denied: false, timed_out: false };
}

// Self-test probes: every "deny" probe must come back with DENIAL (either as the
// returned string from a try/catch, or as the vm exception). The two positive
// probes prove hands still compute and still await safely-wrapped timers.
const HANDS_PROBES = [
  { name: 'typeof_fetch', code: 'return typeof fetch',
    pass: (r) => r.result === 'undefined' || r.exception?.message === DENIAL },
  { name: 'fetch_call', code: 'try { fetch("https://example.com") } catch (e) { return e.message }', deny: true },
  { name: 'xhr', code: 'try { return new XMLHttpRequest() } catch (e) { return e.message }', deny: true },
  { name: 'websocket', code: 'try { return new WebSocket("wss://example.com") } catch (e) { return e.message }', deny: true },
  { name: 'eventsource', code: 'try { return new EventSource("https://example.com") } catch (e) { return e.message }', deny: true },
  { name: 'require_child_process', code: 'try { return require("child_process").execSync("id").toString() } catch (e) { return e.message }', deny: true },
  { name: 'process_object', code: 'try { return process.mainModule.require("net") } catch (e) { return e.message }', deny: true },
  { name: 'globalThis_walk', code: 'try { return globalThis.process.pid } catch (e) { return e.message }', deny: true },
  { name: 'shadow_redefine', code: 'try { fetch = function () { return "leak" }; return fetch() } catch (e) { return e.message }', deny: true },
  // Escape probes bypass the with-scope (property access on the global, or a
  // Function() built outside it); they must find no host object — either the
  // denial or a plain "undefined" TypeError/ReferenceError proves that.
  { name: 'this_walk', escape: true, code: 'try { return this.process.pid } catch (e) { return e.message }' },
  { name: 'function_ctor_walk', escape: true, code: 'try { return Function("return process")().pid } catch (e) { return e.message }' },
  { name: 'realm_escape_timer', escape: true, code: 'try { return setTimeout.constructor("return process")().pid } catch (e) { return e.message }' },
  { name: 'realm_escape_stdout', escape: true, code: 'try { return _stdout.constructor.constructor("return process")().pid } catch (e) { return e.message }' },
  { name: 'realm_escape_console', escape: true, code: 'try { return console.log.constructor("return process")().pid } catch (e) { return e.message }' },
  { name: 'realm_escape_exports', escape: true, code: 'try { return exports.constructor.constructor("return process")().pid } catch (e) { return e.message }' },
  { name: 'realm_escape_context', escape: true, context: { cfg: { x: 1 } },
    code: 'try { return cfg.constructor.constructor("return process")().pid } catch (e) { return e.message }' },
  { name: 'dynamic_import',
    code: 'return import("node:child_process").then(function (m) { return "LEAK:" + typeof m.execSync }, function (e) { return e.message })',
    pass: (r) => typeof r.result === 'string' && !r.result.startsWith('LEAK:') && (r.result === DENIAL || /dynamic import|not supported|callback/i.test(r.result)) },
  { name: 'compute', positive: true, context: { a: 2, b: 3 },
    code: 'console.log("hands alive", a + b); return a + b',
    pass: (r) => r.ok && r.result === 5 && r.stdout.length === 1 && /hands alive 5/.test(r.stdout[0].stdout) },
  { name: 'async_timer', positive: true,
    code: 'return new Promise(function (res) { setTimeout(function () { res("later") }, 5) })',
    pass: (r) => r.ok && r.result === 'later' },
  { name: 'sync_timeout', positive: true, timeout: 300, code: 'while (true) {}',
    pass: (r) => !r.ok && r.timed_out },
];

export async function handsSelfTest() {
  const t0 = performance.now();
  const probes = [];
  const isDenial = (r) => r.result === DENIAL || r.exception?.message === DENIAL;
  const noHostObject = (r) => isDenial(r) || (typeof r.result === 'string' && /is not defined|of undefined/.test(r.result));
  for (const p of HANDS_PROBES) {
    const r = await runHandsClosed(p.code, { context: p.context ?? {}, timeout: p.timeout ?? 3000 });
    const pass = p.deny ? isDenial(r) : p.escape ? noHostObject(r) : p.pass(r);
    probes.push({ name: p.name, kind: p.positive ? 'positive' : 'deny', pass, result: r.result, exception: r.exception?.message ?? null, ms: r.ms });
  }
  const denied_egress = probes.filter((p) => p.kind === 'deny').every((p) => p.pass);
  const positives_ok = probes.filter((p) => p.kind === 'positive').every((p) => p.pass);
  return {
    ok: denied_egress && positives_ok,
    denied_egress,
    positives_ok,
    denial: DENIAL,
    probes,
    ms: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------------------
// 3. wire: Timmy's MCP server behind mcpsnoop
// ---------------------------------------------------------------------------

const SECRET_ENV_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD)$/i;

function resolveRoot(opts) {
  return opts.root ?? process.env.TIMMY_ROOT ?? WORKTREE_ROOT;
}

function resolveTsx(root) {
  if (process.env.TIMMY_TSX) return process.env.TIMMY_TSX;
  let dir = root;
  for (;;) {
    const p = join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'tsx'; // PATH fallback
}

function serverEnv(opts) {
  const env = {};
  const scrub = opts.scrubSecrets !== false;
  for (const [k, v] of Object.entries(process.env)) {
    if (scrub && SECRET_ENV_RE.test(k)) continue;
    env[k] = v;
  }
  env.TIMMY_SWARM_NETWORK_POLICY = 'closed';
  return Object.assign(env, opts.env ?? {});
}

/** Reduce an `mcpsnoop export --format json` document to the wire summary. */
export function summarizeExport(doc, egressRe = EGRESS_TOOL_RE, fallbackToolsListed = null) {
  const calls = Array.isArray(doc?.calls) ? doc.calls : [];
  const events = Array.isArray(doc?.events) ? doc.events : [];
  const rpcKinds = new Set(['request', 'response', 'notification', 'error']);
  const tool_calls = calls
    .filter((c) => c.is_tool || c.method === 'tools/call')
    .map((c) => ({
      name: c.tool_name ?? c.params?.name ?? '?',
      ms: typeof c.duration_ms === 'number' ? Math.round(c.duration_ms * 10) / 10 : undefined,
      error: !!(c.is_error || c.tool_error),
    }));
  const egressNames = tool_calls.filter((c) => egressRe.test(c.name)).map((c) => c.name);
  const s = doc?.session ?? {};
  return {
    session_id: s.id ?? null,
    label: s.label ?? null,
    frames: events.filter((e) => rpcKinds.has(e.kind)).length,
    events: events.length,
    stderr_lines: events.filter((e) => e.kind === 'stderr').length,
    requests: s.requests ?? calls.length,
    responses: s.responses ?? null,
    notifications: s.notifications ?? null,
    errors: s.errors ?? null,
    pending: s.pending ?? null,
    tools_listed: doc?.summary?.definitions?.tools ?? fallbackToolsListed ?? null,
    tool_calls,
    egress_calls: egressNames.length,
    egress: egressNames.length,
    egress_tools: egressNames,
  };
}

/**
 * Start Timmy's MCP server wrapped by mcpsnoop, drive it over stdio
 * (initialize → notifications/initialized → tools/list → tools/call
 * timmy_env_lock), optionally hand `call(toolName, args)` to `runFn` while the
 * server is up, close it, export the session with `mcpsnoop export`, and
 * summarise the wire. Returns the summary plus session_file / trace_file.
 */
export async function snoopSession(name, runFn, opts = {}) {
  if (typeof runFn === 'object' && runFn !== null && opts === undefined) { opts = runFn; runFn = undefined; }
  if (runFn != null && typeof runFn !== 'function') throw new TypeError('airgap: runFn must be a function');
  const root = resolveRoot(opts);
  const tsx = opts.tsx ?? resolveTsx(root);
  const cli = opts.cli ?? join(root, 'src', 'cli.ts');
  const bin = opts.mcpsnoop ?? 'mcpsnoop';
  const egressRe = opts.egressRe instanceof RegExp ? opts.egressRe : EGRESS_TOOL_RE;
  const outDir = opts.outDir ?? CACHE_DIR;
  mkdirSync(outDir, { recursive: true });
  const label = String(name || 'swarm').replace(/[^\w.-]+/g, '-').slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trace_file = join(outDir, `${label}-${stamp}.jsonl`);
  const session_file = join(outDir, `${label}-${stamp}.export.json`);
  if (!existsSync(cli)) throw new Error(`airgap: MCP server entry not found: ${cli}`);

  const t0 = Date.now();
  const child = spawn(bin, ['--label', label, '--trace-file', trace_file, '--', tsx, cli, 'mcp', 'serve'], {
    cwd: root,
    env: serverEnv(opts),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderr = [];
  child.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) { stderr.push(line); if (stderr.length > 60) stderr.shift(); }
  });

  const pending = new Map();
  let nextId = 1;
  let stdoutNoise = 0;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { stdoutNoise++; return; }
    if (msg && msg.id != null && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); p.resolve(msg); }
  });

  let exit = null;
  const exited = new Promise((res) => {
    child.on('exit', (code, signal) => { exit = { code, signal }; res(); });
    child.on('error', (e) => { exit = { code: null, signal: null, error: e.message }; res(); });
  });
  const failPending = (why) => { for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(why)); } };
  child.on('error', (e) => failPending(`airgap: could not start ${bin}: ${e.message}`));
  child.on('exit', (code, signal) => failPending(`airgap: server exited early (code=${code} signal=${signal}) ${stderr.slice(-3).join(' | ')}`));

  const send = (obj) => { child.stdin.write(JSON.stringify(obj) + '\n'); };
  const request = (method, params, ms) => new Promise((resolve, reject) => {
    if (exit) return reject(new Error(`airgap: server not running (${JSON.stringify(exit)})`));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`airgap: ${method} timed out after ${ms} ms`)); }, ms);
    pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const callTimeout = opts.callTimeout ?? 60000;
  const call = async (toolName, args = {}, ms = callTimeout) => {
    const t = Date.now();
    const m = await request('tools/call', { name: toolName, arguments: args ?? {} }, ms);
    const isError = !!(m.error || m.result?.isError);
    const text = m.result?.content?.find?.((c) => c.type === 'text')?.text ?? (m.error ? JSON.stringify(m.error) : null);
    let json = null;
    if (typeof text === 'string') { try { json = JSON.parse(text); } catch { json = null; } }
    return { ok: !isError, tool: toolName, ms: Date.now() - t, text, json, raw: m };
  };

  const waitExit = (ms) => Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
  const close = async () => {
    if (exit) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    if (await waitExit(3000)) return;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    if (await waitExit(2000)) return;
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    await waitExit(2000);
  };

  let toolsListed = null;
  let envLock = null;
  let run = undefined;
  let serverInfo = null;
  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: `airgap/${label}`, version: '0.1.0' },
    }, 20000);
    serverInfo = init.result?.serverInfo ?? null;
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await request('tools/list', {}, 20000);
    const tools = Array.isArray(list.result?.tools) ? list.result.tools : [];
    toolsListed = tools.length;
    const lock = await call('timmy_env_lock', {});
    envLock = lock.json && typeof lock.json === 'object'
      ? { ok: lock.ok && !!lock.json.os, os: lock.json.os ?? null, arch: lock.json.arch ?? null,
          tools: lock.json.tools && typeof lock.json.tools === 'object' ? Object.keys(lock.json.tools) : [],
          sha256: createHash('sha256').update(canonicalJson(lock.json)).digest('hex'), ms: lock.ms }
      : { ok: false, text: typeof lock.text === 'string' ? lock.text.slice(0, 200) : null, ms: lock.ms };
    if (runFn) run = await runFn(call, { tools: tools.map((t) => t.name), policy: 'closed' });
  } finally {
    await close();
    rl.close();
  }

  const { spawnSync } = await import('node:child_process');
  const ex = spawnSync(bin, ['export', trace_file, '--format', 'json', '--output', session_file], { encoding: 'utf8' });
  if (ex.status !== 0) throw new Error(`airgap: mcpsnoop export failed (status ${ex.status}): ${(ex.stderr || ex.stdout || '').slice(0, 300)}`);
  let doc;
  try { doc = JSON.parse(readFileSync(session_file, 'utf8')); } catch (e) { throw new Error(`airgap: could not parse ${session_file}: ${e.message}`); }

  const summary = summarizeExport(doc, egressRe, toolsListed);
  return {
    ...summary,
    session_file,
    trace_file,
    server: serverInfo,
    env_lock: envLock,
    run,
    stdout_noise: stdoutNoise,
    server_exit: exit,
    ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SELFTEST_SPEC = Object.freeze({ topology: 'closed', network: { policy: 'closed', egress_allow: [] } });

async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const cmd = args.find((a) => !a.startsWith('--')) ?? 'help';
  const print = (obj) => process.stdout.write((json ? JSON.stringify(obj) : JSON.stringify(obj, null, 2)) + '\n');

  if (cmd === 'policy') {
    const policy = policyFor(SELFTEST_SPEC);
    print({ policy, policy_sha256: policyHash(policy), canonical: canonicalJson(policy) });
    return 0;
  }
  if (cmd === 'selftest') {
    const policy = policyFor(SELFTEST_SPEC);
    const hands = await handsSelfTest();
    const snoop = await snoopSession('airgap-selftest');
    const ok = hands.denied_egress && snoop.egress === 0;
    print({ policy, policy_sha256: policyHash(policy), hands, snoop, ok });
    return ok ? 0 : 1;
  }
  process.stdout.write([
    'usage: node lanes/swarm/airgap.mjs <policy|selftest> [--json]',
    '  policy    print the closed network policy and its sha256',
    '  selftest  run the hands deny-all probes and one snooped MCP session (env_lock only)',
  ].join('\n') + '\n');
  return cmd === 'help' ? 0 : 2;
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv).then(
    (code) => process.exit(code),
    (e) => { process.stderr.write(`airgap: ${e?.stack ?? e}\n`); process.exit(2); },
  );
}
