// Timmy's inventory (round R4, helper H106, second part): the control paths a person or an agent has to Timmy's
// capabilities, read from the code without running it. Each reader names the file it read; a file that is absent, or a
// shape that is not found, is reported as a problem (unknown), never left out silently.
//
//   REPL      src/repl/commands.ts COMMANDS (what /help lists)
//   act       src/ops/act.ts needsPerson and its help text (what `timmy act` refuses: it needs a person), and the REPL
//             context act gives a command (a command whose run needs more of the REPL answers "not available here")
//   CLI       src/cli.ts: the verbs it dispatches, the lines `timmy --help` prints, and a verb whose module exits 69
//             (a stub that says it is not built)
//   board     src/repl/board-live.ts checkAction (each action and the typed command it stands for, including the vox,
//             lesson and restore actions in their own files) and src/repl/board-edits.ts (the board's own edits)
//   Studio    src/studio/card-relay.ts CARD_ACTS (what a drawn card sends to the REPL) and the page's button labels
//   companion src/companion/server.ts routes and the page's labels
//   MCP       src/mcp/server.ts (`timmy mcp serve`: Timmy's own MCP server) and its tools
//   agent     the tools the REPL's agent can call (src/**/tools.ts, tool.ts and *-tools.ts definitions)
//   /tools    the ids of the /tools rows (src/capabilities and the modules it asks), the proposed rows (plans.ts), the
//             Mac demonstrations table (demonstrations.ts) and the qualification records (evidence.ts, with each sealed
//             source's sha256 compared now)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, readText, sortStrings, uniq } from './common.mjs';
import { constLiteral } from './literal.mjs';

const unq = (s) => s.replace(/\\(['"`\\])/g, '$1');

/**
 * The REPL's slash commands, in /help's order: name, group, description, aliases, and what of the REPL's context its run
 * uses (`ctx.<member>`; `workspace` for a run through inWorkspace), which says whether `timmy act` can run it.
 */
function readRepl(src) {
  const at = src.indexOf('export const COMMANDS');
  if (at < 0) return { commands: [], why: 'export const COMMANDS was not found' };
  const end = src.indexOf('\n];', at);
  const body = src.slice(at, end < 0 ? src.length : end);
  const starts = [...body.matchAll(/\bname:\s*'([\w-]+)'/g)];
  const commands = starts.map((m, i) => {
    const seg = body.slice(m.index, starts[i + 1]?.index ?? body.length);
    const d = /\bdescription:\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(seg);
    const g = /\bgroup:\s*'(\w+)'/.exec(seg);
    const al = /\baliases:\s*\[([^\]]*)\]/.exec(seg);
    const uses = sortStrings(uniq([...seg.matchAll(/\bctx\.(\w+)/g)].map((x) => x[1]).concat(/\binWorkspace\(/.test(seg) ? ['workspace'] : [])));
    return { name: m[1], group: g?.[1] ?? null, description: d ? unq(d[2]) : null, aliases: al ? [...al[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]) : [], uses };
  });
  return commands.length ? { commands } : { commands: [], why: 'COMMANDS names no command' };
}

/** The members of the REPL context `timmy act` gives a command (src/ops/act.ts: `const ctx: ReplContext = { … }`). */
function readActContext(src) {
  const at = src.indexOf('const ctx: ReplContext = {');
  if (at < 0) return null;
  const end = src.indexOf('\n  };', at);
  const body = src.slice(at, end < 0 ? at + 2000 : end);
  const keys = sortStrings(uniq([...body.matchAll(/^ {4}(\w+)\s*[:,]/gm)].map((m) => m[1])));
  return keys.length ? keys : null;
}

/** What `timmy act` refuses (it needs a person): each command, why, and whether only some of its forms are refused. */
function readAct(src) {
  const out = new Map();
  const fn = src.indexOf('export function needsPerson');
  if (fn < 0) return { refused: out, why: 'needsPerson was not found' };
  const end = src.indexOf('\n}\n', fn);
  for (const line of src.slice(fn, end < 0 ? src.length : end).split('\n')) {
    const names = [...line.matchAll(/case '([\w-]+)':/g)].map((m) => m[1]);
    if (!names.length) continue;
    const conditional = /\?\s*['"`]/.test(line);
    const words = /return\s+(?:[^?]*\?\s*)?(['"`])((?:\\.|(?!\1).)*)\1/.exec(line);
    for (const n of names) out.set(n, { why: words ? unq(words[2]).replace(/\$\{word\}/g, n) : 'it needs a person', conditional });
  }
  // A command refused only in some of its runs, as the help says it ("a /run whose blocks include a destructive …").
  for (const m of src.matchAll(/\ba \/([\w-]+) whose ([^',]+)/g)) if (!out.has(m[1])) out.set(m[1], { why: `a /${m[1]} whose ${m[2].trim()}`, conditional: true });
  return { refused: out };
}

/** `timmy --help`'s command lines: the first word and the description (continuation lines joined). */
function helpLines(src) {
  const fn = src.indexOf('function printHelp');
  if (fn < 0) return [];
  const start = src.indexOf('Commands:', fn);
  const stop = src.indexOf('Options:', start);
  if (start < 0 || stop < 0) return [];
  const out = [];
  for (const line of src.slice(start, stop).split('\n').slice(1)) {
    const m = /^ {2}(\S.*?)\s{2,}(\S.*)$/.exec(line);
    if (m) { out.push({ usage: m[1].trim(), verb: m[1].trim().split(/[\s|]/)[0], help: m[2].trim() }); continue; }
    const cont = /^ {6,}(\S.*)$/.exec(line);
    if (cont && out.length) out.at(-1).help += ` ${cont[1].trim()}`;
  }
  return out;
}

/** The verbs src/cli.ts dispatches, each with its help line, the module it imports, and whether that module is a stub. */
function readCli(root, src, has) {
  const verbs = new Map();
  const add = (v, how) => { if (!verbs.has(v)) verbs.set(v, { verb: v, how, help: [], module: null, stub: false }); };
  for (const m of src.matchAll(/\bcommand === '([\w-]+)'/g)) add(m[1], 'dispatched in src/cli.ts');
  for (const m of src.matchAll(/\bcommand !== '([\w-]+)'/g)) add(m[1], 'dispatched in src/cli.ts (to a script)');
  for (const v of verbs.values()) {
    // The block that handles it: the first `if (command === '<verb>')` and the module it imports within a few lines.
    const at = src.indexOf(`if (command === '${v.verb}')`);
    if (at < 0) continue;
    const block = src.slice(at, at + 700);
    const imp = /await import\('\.\/([\w./-]+)\.js'\)/.exec(block);
    if (!imp) continue;
    const mod = `src/${imp[1]}.ts`;
    v.module = has.has(mod) ? mod : null;
    if (v.module) {
      const text = readText(join(root, mod)) ?? '';
      v.stub = /\breturn 69\b/.test(text) && /not built/i.test(text);
    }
  }
  const help = helpLines(src);
  for (const h of help) {
    if (verbs.has(h.verb)) verbs.get(h.verb).help.push(`${h.usage}: ${h.help}`);
  }
  return { verbs: [...verbs.values()].sort((a, b) => (a.verb < b.verb ? -1 : a.verb > b.verb ? 1 : 0)), help };
}

/**
 * The REPL commands a file's checked actions stand for: `line: \`/<command> …\``, a line built as `/${verb}` where the
 * same line names the verbs it takes (`verb === 'inspect' || verb === 'measure'`), and `command: { name: '<command>' }`.
 */
function typedLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/\bline:\s*`\/([\w-]+)(?:\s+(view|check))?/g)) out.push(m[2] ? `${m[1]} ${m[2]}` : m[1]);
    if (/\bline:\s*`\/\$\{verb\}/.test(line)) for (const m of line.matchAll(/\bverb === '([\w-]+)'/g)) out.push(m[1]);
    for (const m of line.matchAll(/\bcommand:\s*\{\s*name:\s*'([\w-]+)'/g)) if (m[1] !== 'vox') out.push(m[1]);
  }
  return uniq(out);
}

/** The live board's actions (each with the typed commands it runs) and its edits. */
function readBoard(root, files) {
  const has = new Set(files);
  const out = { actions: [], edits: [], problems: [] };
  const live = 'src/repl/board-live.ts';
  const s = has.has(live) ? readText(join(root, live)) : null;
  if (s === null) out.problems.push({ file: live, what: 'board actions', why: 'not in this tree' });
  else {
    const fn = s.indexOf('export function checkAction');
    const end = s.indexOf('\n}\n', fn);
    const body = fn < 0 ? '' : s.slice(fn, end < 0 ? s.length : end);
    const segs = [...body.matchAll(/if \(o\.action === '([\w-]+)'/g)];
    segs.forEach((m, i) => {
      const seg = body.slice(m.index, segs[i + 1]?.index ?? body.length);
      let commands = typedLines(seg);
      let file = live;
      const del = /return (check\w+Action)\(/.exec(seg);
      if (!commands.length && del) {
        const f = files.find((x) => x.startsWith('src/') && x.endsWith('.ts') && (readText(join(root, x)) ?? '').includes(`export function ${del[1]}(`));
        if (f) { commands = typedLines(readText(join(root, f)) ?? ''); file = f; }
      }
      const prev = out.actions.find((a) => a.action === m[1]);
      if (prev) prev.commands = uniq([...prev.commands, ...commands]);
      else out.actions.push({ action: m[1], commands, file });
    });
    if (!segs.length) out.problems.push({ file: live, what: 'board actions', why: 'checkAction names no action' });
  }
  const ed = 'src/repl/board-edits.ts';
  const e = has.has(ed) ? readText(join(root, ed)) : null;
  if (e === null) out.problems.push({ file: ed, what: 'board edits', why: 'not in this tree' });
  else for (const m of e.matchAll(/if \(o\.action === '([\w-]+)'\) return/g)) out.edits.push({ edit: m[1], file: ed });
  return out;
}

/** Timmy Studio: what a drawn card sends (through the REPL) and the labels of the page's own buttons and links. */
function readStudio(root, files) {
  const has = new Set(files);
  const out = { cardActs: [], labels: [], problems: [] };
  const relay = 'src/studio/card-relay.ts';
  const r = has.has(relay) ? readText(join(root, relay)) : null;
  const acts = r && /export const CARD_ACTS\s*=\s*\[([^\]]*)\]/.exec(r);
  if (!acts) out.problems.push({ file: relay, what: 'CARD_ACTS', why: r === null ? 'not in this tree' : 'not found' });
  else out.cardActs = [...acts[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  const labels = [];
  for (const f of files.filter((x) => x.startsWith('companion/studio-canvas/') && /\.(?:js|html)$/.test(x) && !x.includes('/licenses/'))) {
    const t = readText(join(root, f)) ?? '';
    for (const m of t.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)) labels.push(m[1].trim());
    for (const m of t.matchAll(/\bel\('(?:button|a)',\s*'([^']+)'/g)) labels.push(m[1]);
    for (const m of t.matchAll(/\bh\('button',\s*\{[^}]*\},\s*'([^']+)'\)/g)) labels.push(m[1]);
  }
  out.labels = sortStrings(uniq(labels));
  return out;
}

/** The browser companion: its routes and the labels its page shows. */
function readCompanion(root, files) {
  const out = { routes: [], labels: [], problems: [] };
  const srv = 'src/companion/server.ts';
  const s = files.includes(srv) ? readText(join(root, srv)) : null;
  if (s === null) out.problems.push({ file: srv, what: 'companion routes', why: 'not in this tree' });
  else out.routes = uniq([...s.matchAll(/\bapp\.(get|post|put|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
  const labels = [];
  for (const f of files.filter((x) => /^src\/companion\/(client|island)\/[^/]+\.(?:js|html)$/.test(x))) {
    const t = readText(join(root, f)) ?? '';
    for (const m of t.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)) labels.push(m[1].trim());
    for (const m of t.matchAll(/'((?:Send|Try it|Copy)[^'<>]{0,40})'/g)) labels.push(m[1].trim());
    if (/✨/.test(t) && /Try it/.test(t)) labels.push('✨ Try it');
  }
  out.labels = sortStrings(uniq(labels));
  return out;
}

/** Timmy's own MCP server (`timmy mcp serve`) and the tools it serves. */
function readMcpServer(root, files) {
  const f = 'src/mcp/server.ts';
  const s = files.includes(f) ? readText(join(root, f)) : null;
  if (s === null) return { tools: [], problems: [{ file: f, what: 'MCP server tools', why: 'not in this tree' }] };
  const tools = [...s.matchAll(/\{\s*name:\s*'(timmy_[\w]+)',\s*description:\s*'((?:\\.|[^'])*)'/g)].map((m) => ({ name: m[1], description: unq(m[2]) }));
  return { tools, problems: tools.length ? [] : [{ file: f, what: 'MCP server tools', why: 'no tool definition was found' }] };
}

/** The agent's tools: every `name: '<tool>'` in the REPL agent's tool files (src/agent/*tools.ts, src/memory/tool.ts). */
function readAgentTools(root, files) {
  const out = new Map();
  for (const f of files.filter((x) => /^src\/agent\/(?:[\w-]+-)?tools\.ts$|^src\/memory\/tool\.ts$/.test(x))) {
    const t = readText(join(root, f)) ?? '';
    for (const m of t.matchAll(/\bname:\s*'([a-z][a-z0-9_]*)'/g)) if (!out.has(m[1])) out.set(m[1], f);
  }
  return [...out].map(([name, file]) => ({ name, file })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * The monitor's commands: what the default monitor's chat line (src/tui/components/ShellV2.tsx) handles itself, and the
 * older command registry (src/utils/slash-commands.ts), which only the v1 shell dispatches (cli.tsx starts it when
 * TIMMY_SHELL is v1).
 */
function readMonitor(root, files) {
  const out = { own: [], v1: [], v1Only: null, problems: [] };
  const shell = 'src/tui/components/ShellV2.tsx';
  const s = files.includes(shell) ? readText(join(root, shell)) : null;
  if (s === null) out.problems.push({ file: shell, what: 'the monitor\'s chat line', why: 'not in this tree' });
  else {
    for (const m of s.matchAll(/if \(\/\^\\\/([\w-]+)\(\\s\|\$\)\/\.test\(text0\)\)/g)) out.own.push(`/${m[1]}`);
    const mt = /const MODEL_TEST = '([^']+)'/.exec(s);
    if (mt && s.includes('text0 === MODEL_TEST')) out.own.push(mt[1]);
  }
  const reg = 'src/utils/slash-commands.ts';
  const r = files.includes(reg) ? readText(join(root, reg)) : null;
  if (r === null) out.problems.push({ file: reg, what: 'the monitor\'s older commands', why: 'not in this tree' });
  else out.v1 = sortStrings(uniq([...r.matchAll(/\bcommand:\s*'(\/[\w-]+)'/g)].map((m) => m[1])));
  const cli = files.includes('cli.tsx') ? readText(join(root, 'cli.tsx')) : null;
  out.v1Only = cli ? /process\.env\.TIMMY_SHELL !== 'v1'/.test(cli) : null;
  return out;
}

/** The /tools rows' ids, from index.ts's rows and the modules it asks. */
function readToolsIds(root, files, registries) {
  const ids = new Set();
  const has = new Set(files);
  for (const it of registries.items) {
    if (it.registry === '/tools rows') ids.add(it.id);
    if (it.registry === 'native apps') ids.add(it.id);
    if (it.registry === 'VoxVision tools' || it.registry === 'VoxVision viewer layers') ids.add(`vox:${it.id}`);
    if (it.registry === 'MCP routes') ids.add(`mcp-cli:${it.id}`);
  }
  if (registries.items.some((it) => it.registry === 'MCP routes')) ids.add('mcp-cli');
  for (const f of ['src/capabilities/ollama-row.ts', 'src/recipes/index.ts']) {
    const t = has.has(f) ? readText(join(root, f)) : null;
    if (t) for (const m of t.matchAll(/\bconst base = \{ id: '([\w-]+)'|\bid: '([\w-]+)' as const/g)) ids.add(m[1] ?? m[2]);
  }
  for (const f of ['src/code-agents/codex-local.ts', 'src/code-agents/openhands.ts']) {
    const t = has.has(f) ? readText(join(root, f)) : null;
    // The route a /tools row is keyed by (CODEX_LOCAL_ROUTE, OPENHANDS_ROUTE); not a model route such as OPENHANDS_LLM_ROUTE.
    if (t) for (const m of t.matchAll(/export const (?:CODEX_LOCAL|OPENHANDS)_ROUTE = '([\w-]+)'/g)) ids.add(m[1]);
  }
  return ids;
}

/** The Mac demonstrations table (src/capabilities/demonstrations.ts): each entry with its run's constants resolved. */
function readDemonstrations(root, files) {
  const f = 'src/capabilities/demonstrations.ts';
  const s = files.includes(f) ? readText(join(root, f)) : null;
  if (s === null) return { entries: [], problems: [{ file: f, what: 'DEMONSTRATIONS', why: 'not in this tree' }] };
  const runs = new Map();
  for (const m of s.matchAll(/^const (\w+) = \{/gm)) {
    const r = constLiteral(s, m[1]);
    if (r.ok && r.value && typeof r.value === 'object' && r.value.run) runs.set(m[1], r.value);
  }
  const entries = [];
  for (const m of s.matchAll(/\{\s*\.\.\.(\w+),\s*tool:\s*'([\w:-]+)'(?:,\s*part:\s*'([^']*)')?,\s*result:\s*'(PASS|FAIL)',\s*outcome:\s*'((?:\\.|[^'])*)'/g)) {
    const run = runs.get(m[1]);
    if (!run) continue;
    entries.push({ tool: m[2], run: run.run, row: run.row, date: run.date, revision: run.revision, how: run.how, part: m[3] ?? null, result: m[4], outcome: unq(m[5]) });
  }
  return { entries, problems: entries.length ? [] : [{ file: f, what: 'DEMONSTRATIONS', why: 'no entry was read' }] };
}

/** The proposed /tools rows (src/capabilities/plans.ts): the plan that names each and why no code runs it. */
function readProposed(root, files) {
  const f = 'src/capabilities/plans.ts';
  const s = files.includes(f) ? readText(join(root, f)) : null;
  if (s === null) return { rows: [], problems: [{ file: f, what: 'PROPOSED', why: 'not in this tree' }] };
  const consts = new Map();
  for (const m of s.matchAll(/^const (\w+) = \{/gm)) { const r = constLiteral(s, m[1]); if (r.ok) consts.set(m[1], r.value); }
  const rows = [];
  for (const m of s.matchAll(/'([\w:-]+)':\s*\{\s*\.\.\.(\w+),\s*says:\s*'((?:\\.|[^'])*)',\s*noCode:\s*'((?:\\.|[^'])*)'/g)) {
    const c = consts.get(m[2]) ?? {};
    rows.push({ id: m[1], plan: c.plan ?? null, section: c.section ?? null, says: unq(m[3]), noCode: unq(m[4]) });
  }
  return { rows, problems: [] };
}

/** The qualification records (src/capabilities/evidence.ts), each checked as /tools checks it: every sealed source's sha256 now. */
function readQualifications(root, files) {
  const f = 'src/capabilities/evidence.ts';
  const s = files.includes(f) ? readText(join(root, f)) : null;
  if (s === null) return { records: [], problems: [{ file: f, what: 'QUALIFICATION_RECORDS', why: 'not in this tree' }] };
  const r = constLiteral(s, 'QUALIFICATION_RECORDS');
  if (!r.ok || !Array.isArray(r.value)) return { records: [], problems: [{ file: f, what: 'QUALIFICATION_RECORDS', why: r.ok ? 'not an array' : r.why }] };
  const records = r.value.map((q) => {
    const ev = readJson(join(root, String(q.evidence ?? '')));
    const seal = readJson(join(root, String(q.seal ?? '')));
    const sources = seal.ok && Array.isArray(seal.value?.sources) ? seal.value.sources.filter((x) => x && typeof x.path === 'string' && typeof x.sha256 === 'string') : [];
    const changed = [];
    for (const src of sources) {
      let now = null;
      try { now = createHash('sha256').update(readFileSync(join(root, src.path))).digest('hex'); } catch { now = null; }
      if (now !== src.sha256) changed.push(src.path);
    }
    const passed = ev.ok && ev.value?.schema === q.schema && ev.value?.state === 'passed';
    const state = !ev.ok ? `no record: ${q.evidence} is not here`
      : !passed ? `${q.evidence} is not a passed ${q.schema} record`
        : !sources.length ? `${q.seal} names no sources`
          : changed.length ? `covers earlier sources: ${changed.length} of ${sources.length} sealed sources have changed since (${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ', …' : ''}), so it does not qualify this tree`
            : `qualifies this tree: all ${sources.length} sealed sources unchanged`;
    return { row: q.row, evidence: q.evidence, seal: q.seal, seal_id: seal.ok ? seal.value?.id ?? null : null, what: q.what, scope: q.scope, state, qualifiesNow: passed && sources.length > 0 && !changed.length };
  });
  return { records, problems: [] };
}

/** Every control path the code offers, read statically. */
export function readControls(root, files, registries) {
  const has = new Set(files);
  const problems = [];
  const text = (f, what) => {
    const t = has.has(f) ? readText(join(root, f)) : null;
    if (t === null) problems.push({ file: f, what, why: 'not in this tree' });
    return t;
  };
  const replSrc = text('src/repl/commands.ts', 'REPL commands');
  const repl = replSrc === null ? { commands: [] } : readRepl(replSrc);
  if (repl.why) problems.push({ file: 'src/repl/commands.ts', what: 'REPL commands', why: repl.why });
  const actSrc = text('src/ops/act.ts', 'timmy act refusals');
  const act = actSrc === null ? { refused: new Map() } : readAct(actSrc);
  if (act.why) problems.push({ file: 'src/ops/act.ts', what: 'timmy act refusals', why: act.why });
  const actContext = actSrc === null ? null : readActContext(actSrc);
  if (actSrc !== null && !actContext) problems.push({ file: 'src/ops/act.ts', what: 'the context timmy act gives a command', why: 'const ctx: ReplContext = { … } was not found' });
  const cliSrc = text('src/cli.ts', 'CLI verbs');
  const cli = cliSrc === null ? { verbs: [], help: [] } : readCli(root, cliSrc, has);
  const board = readBoard(root, files);
  const studio = readStudio(root, files);
  const companion = readCompanion(root, files);
  const mcpServer = readMcpServer(root, files);
  const agentTools = readAgentTools(root, files);
  const monitor = readMonitor(root, files);
  const demonstrations = readDemonstrations(root, files);
  const proposed = readProposed(root, files);
  const qualifications = readQualifications(root, files);
  problems.push(...board.problems, ...studio.problems, ...companion.problems, ...mcpServer.problems, ...monitor.problems, ...demonstrations.problems, ...proposed.problems, ...qualifications.problems);
  return {
    repl: repl.commands,
    actRefuses: Object.fromEntries([...act.refused].sort(([a], [b]) => (a < b ? -1 : 1))),
    actContext,
    cli: cli.verbs,
    cliHelp: cli.help,
    board: { actions: board.actions, edits: board.edits },
    studio: { cardActs: studio.cardActs, labels: studio.labels },
    companion: { routes: companion.routes, labels: companion.labels },
    mcpServer: mcpServer.tools,
    agentTools,
    monitor: { own: monitor.own, v1: monitor.v1, v1Only: monitor.v1Only },
    toolsIds: sortStrings([...readToolsIds(root, files, registries)]),
    demonstrations: demonstrations.entries,
    proposed: proposed.rows,
    qualifications: qualifications.records,
    problems,
  };
}
