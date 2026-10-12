// Timmy's inventory (round R4, helper H106, second part): the capability matrix the operator asked for on 2026-10-11:
// "feature, dependency/provider, control path, screen, renderer, inputs/outputs, backend status, UI status, evidence
// revision and blocker/owner", with researched, designed, implemented, tested and live-qualified used exactly, and visual
// and usability acceptance kept apart (the operator's alone).
//
// One row per user-facing capability. The overlay (docs/ui-cockpit/inventory/overlay.json) says which capabilities there
// are and joins each to its checklist features, its /tools rows and the control paths it names; everything else is read:
// each named path is checked against the code (src/repl/commands.ts, src/cli.ts, the board's and Studio's action handlers,
// the companion's routes and labels, Timmy's MCP server, the agent's tools, the monitor), the paths the code derives from
// a REPL command (`timmy act`, the live board's actions, Studio's card actions) are added, and the statuses come from the
// feature ledger, the tests named, the recorded test runs, the Mac rehearsals and git. A path the code does not have is
// reported, never shown as a path; a capability with no path says so.
//
// What it reads from overlay.json (every field but id, screen and feature optional):
//   capabilities[]  id, screen (one of SCREENS), feature, renderers[], inputs, outputs, providers[], registry[] (/tools
//                   ids), features[] (checklist ids), paths {repl, cli, board (edits), studio (labels, or card:<act>),
//                   companion, mcp, agent, monitor ('/x', or 'v1:/x')}, described[] ({kind, say, file, has}: a path
//                   no registry lists, checked by its file and text), refuses[] ({kind, path, why}: a derived path that
//                   refuses this case), tests[] (file, or {file, has}), uiTests[] (the UI tests, when names mislead),
//                   fakes, testsWith, code[] (its own files), designed {file, says}, researched {file, says},
//                   ledgerRows[] ({row, ran, scope}), viewer, viewOf[], owner, blocker, weight, notes
//   rehearsals[]    id, revision, date, where, how, by, source, facts[] ({step, ran, result, caps {capability: both |
//                   backend | ui | context}, defects: [Dn] for every capability of the fact, or {capability: [Dn]}),
//                   notRun[], defects {Dn: {says, state: open | suspected | changed since, owner}}
//   suites[]        revision, kind ('full suite' or a helper run with its files[]), result, source
//   screens[]       name, group, notBuilt[], workbenchNote
//   acceptance[]    capability, by: 'operator', date, source, visual, usability (anything else is ignored, and said)
import { join } from 'node:path';
import { git, readText, sortStrings, uniq } from './common.mjs';

export const LEVELS = ['researched', 'designed', 'implemented', 'tested here', 'live-qualified on the Mac'];
export const PATH_KINDS = ['repl', 'cli', 'mcp', 'board', 'companion', 'studio', 'monitor', 'agent'];
/** The operator's screen names (the reference package's WORKBENCH-SPEC.md and CLAUDE-WORKBENCH-PROMPT.txt). */
export const SCREENS = ['Chat', 'Studio', 'VoxVision', '3D Create', 'Motion', 'Workflows', 'Control Room', "God's Eye View", 'REA', 'All tools', 'Connections', 'Files'];
export const NOT_REVIEWED = 'not reviewed';
const PATH_WORDS = { repl: 'REPL', cli: 'CLI', mcp: 'MCP', board: 'board', companion: 'companion', studio: 'Studio', monitor: 'monitor', agent: 'agent tool' };
/** Kinds a person operates (an agent tool and an MCP tool are an agent's paths). */
const UI_KINDS = ['repl', 'cli', 'board', 'companion', 'studio', 'monitor'];
/** A test that drives a surface as a person would, by its file name: a headless browser, a terminal, the REPL's commands, a page. */
const UI_TEST = /(?:-browser|-pty)\.test\.ts$|^tests\/(?:repl|board|studio|canvas|companion|monitor|ui|local-servers|room|overview|logs)-/;

/** Gap flags, most serious first; the first four make the "top gaps". */
export const FLAGS = [
  ['no-path', 'no operation path'],
  ['stub', 'a control path exits 69 (not built)'],
  ['viewer', 'viewer only'],
  ['fakes', 'tested with FAKE or stand-in parts, never on the Mac'],
  ['defect', 'an open defect a Mac run found'],
  ['stale', 'live evidence older than its code'],
  ['no-test', 'no automated test found'],
  ['missing-path', 'a named path is not in the code'],
];
const FLAG_ORDER = new Map(FLAGS.map(([k], i) => [k, i]));
/** The top gaps, as the lead asked for them: advertised without an operation path (none, one that exits 69, a viewer only), or tested only with fakes. */
const TOP_FLAGS = new Set(['no-path', 'stub', 'viewer', 'fakes']);

const cut = (s, max) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')} …`; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A rehearsal fact's scope for one capability: both, backend, ui or context (seen; never raises a level). */
const SCOPES = new Set(['both', 'backend', 'ui', 'context']);

/**
 * Newest first, by commit date, then by git ancestry; at one revision the most specific record first (a rehearsal's own
 * fact, a ledger row the overlay names, a checklist row, the /tools demonstrations table), then by run name. A revision git
 * does not know sorts last.
 */
function newestFirst(gi) {
  return (a, b) => {
    const da = gi?.dateOf(a.revision) ?? '';
    const db = gi?.dateOf(b.revision) ?? '';
    if (da !== db) return da < db ? 1 : -1;
    if (a.revision !== b.revision && gi) {
      if (gi.contains(a.revision, b.revision) === true) return -1;
      if (gi.contains(b.revision, a.revision) === true) return 1;
    }
    if ((a.rank ?? 9) !== (b.rank ?? 9)) return (a.rank ?? 9) - (b.rank ?? 9);
    return a.run < b.run ? 1 : a.run > b.run ? -1 : 0;
  };
}

/** What the recorded test runs say about one test file now: the run that covers its current bytes, or why none does. */
function testRunIndex(root, facts, suites) {
  const full = (suites ?? []).filter((s) => s.kind === 'full suite' && s.revision);
  const helper = (suites ?? []).filter((s) => s.kind !== 'full suite' && s.revision && Array.isArray(s.files));
  const memo = new Map();
  const tree = new Map();
  const changed = new Map();
  const inTree = (rev) => {
    if (!tree.has(rev)) { const out = facts ? git(root, ['ls-tree', '-r', '--name-only', rev, '--', 'tests']) : null; tree.set(rev, out === null ? null : new Set(out.split('\n').filter(Boolean))); }
    return tree.get(rev);
  };
  const changedSince = (rev) => {
    if (!changed.has(rev)) { const out = facts ? git(root, ['diff', '--name-only', rev, 'HEAD', '--', 'tests']) : null; changed.set(rev, out === null ? null : new Set(out.split('\n').filter(Boolean))); }
    return changed.get(rev);
  };
  return (file) => {
    if (memo.has(file)) return memo.get(file);
    let v = null;
    for (const s of full) {
      const t = inTree(s.revision);
      const c = changedSince(s.revision);
      if (t?.has(file) && c && !c.has(file)) { v = { revision: s.revision, run: s.kind, words: `the full suite at ${s.revision} (${s.result})` }; break; }
    }
    if (!v) for (const s of helper) {
      if (!s.files.includes(file)) continue;
      const c = changedSince(s.revision);
      if (c && !c.has(file)) { v = { revision: s.revision, run: s.kind, words: `${s.source} at ${s.revision} (${s.result})` }; break; }
    }
    if (!v) {
      const t = full.length ? inTree(full[0].revision) : null;
      v = { revision: null, run: null, words: t?.has(file) ? `changed since the full suite at ${full[0].revision}; no recorded run of its current version` : 'no recorded run names it' };
    }
    memo.set(file, v);
    return v;
  };
}

/** Each named path checked against the code, the derived paths added, and what was named but not found. */
function resolvePaths(o, controls, files, root) {
  const P = Object.fromEntries(PATH_KINDS.map((k) => [k, []]));
  const missing = [];
  const refused = [];
  const decl = o.paths ?? {};
  const replWords = [];
  for (const r of decl.repl ?? []) {
    const word = String(r).split(/\s+/)[0];
    const cmd = controls.repl.find((c) => c.name === word || c.aliases.includes(word));
    if (!cmd) { missing.push(`REPL /${r}`); continue; }
    replWords.push(String(r));
    P.repl.push({ path: `/${r}`, from: 'src/repl/commands.ts', words: cmd.description ?? '' });
  }
  for (const v of decl.cli ?? []) {
    const word = String(v).split(/\s+/)[0];
    const verb = controls.cli.find((x) => x.verb === word);
    if (!verb) { missing.push(`CLI timmy ${v}`); continue; }
    P.cli.push({ path: `timmy ${v}`, from: 'src/cli.ts', words: verb.help[0] ? verb.help[0].replace(/^[^:]*:\s*/, '') : 'not in `timmy --help`', ...(verb.stub ? { stub: true, note: `${verb.module} exits 69: not built in this revision` } : {}) });
  }
  // `timmy act` runs a REPL command headlessly, unless it needs a person (src/ops/act.ts), or its run needs more of the
  // REPL than act gives a command (such a command answers "not available here" under act).
  const act = controls.cli.some((x) => x.verb === 'act' && !x.stub) && controls.actContext;
  for (const r of act ? replWords : []) {
    const [word, ...rest] = r.split(/\s+/);
    const ref = controls.actRefuses[word];
    const sub = rest[0] ?? '';
    if (ref && (!ref.conditional || (sub && ref.why.startsWith(`/${word} ${sub}`)))) { refused.push(`timmy act refuses /${r}: ${ref.why}`); continue; }
    const cmd = controls.repl.find((x) => x.name === word || x.aliases.includes(word));
    const lacks = (cmd?.uses ?? []).filter((u) => !controls.actContext.includes(u));
    if (lacks.length) { refused.push(`timmy act cannot run /${r}: its run needs the REPL's ${lacks.join(', ')}, which timmy act does not give a command (src/ops/act.ts)`); continue; }
    P.cli.push({ path: `timmy act '/${r}'`, from: 'src/ops/act.ts', words: 'the REPL command, headlessly, as one operation', ...(ref?.conditional ? { note: `not for ${ref.why}` } : {}) });
  }
  // The live board's actions stand for typed REPL commands (src/repl/board-live.ts checkAction); its edits are its own.
  const boardActs = [];
  for (const a of controls.board.actions) {
    const hit = a.commands.filter((c) => replWords.some((p) => p === c || c.startsWith(`${p} `) || p.startsWith(`${c} `)));
    if (!hit.length) continue;
    boardActs.push(a.action);
    P.board.push({ path: `action ${a.action}`, from: a.file, words: `runs ${hit.map((c) => `/${c}`).join(', ')}, as typed` });
  }
  const edits = [];
  for (const e of decl.board ?? []) {
    const ed = controls.board.edits.find((x) => x.edit === e);
    if (!ed) { missing.push(`board edit ${e}`); continue; }
    edits.push(e);
    P.board.push({ path: `edit ${e}`, from: ed.file, words: 'the board\'s own edit (an edit receipt)' });
  }
  // Studio: a drawn card's action is the live board's own (src/studio/card-relay.ts CARD_ACTS, run through the REPL).
  for (const act of controls.studio.cardActs) if (boardActs.includes(act) || edits.includes(act)) P.studio.push({ path: `card action ${act}`, from: 'src/studio/card-relay.ts', words: 'a drawn card\'s button, run by the REPL that holds the project as the board\'s own' });
  for (const s of decl.studio ?? []) {
    if (String(s).startsWith('card:')) {
      const act = String(s).slice(5);
      if (!controls.studio.cardActs.includes(act)) { missing.push(`Studio card action ${act}`); continue; }
      if (!P.studio.some((x) => x.path === `card action ${act}`)) P.studio.push({ path: `card action ${act}`, from: 'src/studio/card-relay.ts', words: 'a drawn card\'s button, run by the REPL that holds the project as the board\'s own' });
      continue;
    }
    if (!controls.studio.labels.includes(s)) { missing.push(`Studio "${s}"`); continue; }
    P.studio.push({ path: s, from: 'companion/studio-canvas', words: 'a button of the canvas page' });
  }
  for (const c of decl.companion ?? []) {
    const ok = controls.companion.routes.includes(c) || controls.companion.labels.includes(c);
    if (!ok) { missing.push(`companion "${c}"`); continue; }
    P.companion.push({ path: c, from: controls.companion.routes.includes(c) ? 'src/companion/server.ts' : 'src/companion', words: controls.companion.routes.includes(c) ? 'a route of the companion\'s server' : 'a control of the companion\'s page' });
  }
  for (const t of decl.mcp ?? []) {
    const tool = controls.mcpServer.find((x) => x.name === t);
    if (!tool) { missing.push(`MCP ${t}`); continue; }
    P.mcp.push({ path: `${t} (timmy mcp serve)`, from: 'src/mcp/server.ts', words: cut(tool.description, 140) });
  }
  for (const t of decl.agent ?? []) {
    const tool = controls.agentTools.find((x) => x.name === t);
    if (!tool) { missing.push(`agent tool ${t}`); continue; }
    P.agent.push({ path: t, from: tool.file, words: 'the REPL agent\'s tool (NEEDS YOU asks before a risky one)' });
  }
  for (const m of decl.monitor ?? []) {
    const v1 = String(m).startsWith('v1:');
    const name = v1 ? String(m).slice(3) : String(m);
    const ok = v1 ? controls.monitor.v1.includes(name) : controls.monitor.own.includes(name);
    if (!ok) { missing.push(`monitor ${m}`); continue; }
    P.monitor.push(v1
      ? { path: `${name} (the v1 monitor only: TIMMY_SHELL=v1 timmy watch)`, from: 'src/utils/slash-commands.ts', words: 'listed in the older monitor\'s help; the default monitor does not dispatch it' }
      : { path: `${name} in the monitor's chat line`, from: 'src/tui/components/ShellV2.tsx', words: 'handled by the monitor itself' });
  }
  for (const d of o.described ?? []) {
    const has = files.includes(d.file);
    const text = has && d.has ? readText(join(root, d.file)) ?? '' : '';
    if (!has || (d.has && !text.includes(d.has))) { missing.push(`${PATH_WORDS[d.kind] ?? d.kind}: ${d.say} (${d.file}${d.has ? ` with "${d.has}"` : ''})`); continue; }
    if (!P[d.kind]) { missing.push(`${d.say}: kind ${d.kind} is not a path kind`); continue; }
    P[d.kind].push({ path: d.say, from: d.file, words: d.words ?? (d.has ? `${d.file} has it` : `${d.file} is here`), ...(d.note ? { note: d.note } : {}) });
  }
  // A path the code has in general that refuses this capability's case (the board cannot ask a person; act refuses a
  // destructive block): the overlay names it, and it is listed as refused, not as a path.
  for (const x of o.refuses ?? []) {
    const at = (P[x.kind] ?? []).findIndex((p) => p.path === x.path);
    if (at < 0) { missing.push(`${PATH_WORDS[x.kind] ?? x.kind} ${x.path} (named as refusing, but no such path was found)`); continue; }
    P[x.kind].splice(at, 1);
    refused.push(`${PATH_WORDS[x.kind]} ${x.path} refuses it: ${x.why}`);
  }
  for (const k of PATH_KINDS) P[k].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { paths: P, missing: sortStrings(uniq(missing)), refused: sortStrings(uniq(refused)) };
}

/**
 * A capability's live evidence: rehearsal facts, the ledger rows the overlay names, the checklist's Mac demonstrations of
 * its features (each revision named by the run it belongs to: a rehearsal the row names, else a ledger row of that
 * revision), and the /tools demonstrations table's. A fact's defects are its own, or, given per capability, this one's.
 */
function liveItems(o, feats, controls, rehearsals, ledgerRows) {
  const items = [];
  for (const r of rehearsals) {
    for (const f of r.facts ?? []) {
      const scope = f.caps?.[o.id];
      if (!scope) continue;
      const defects = Array.isArray(f.defects) ? f.defects : (f.defects?.[o.id] ?? []);
      items.push({ rank: 0, run: r.id, revision: r.revision, date: r.date ?? null, what: `${r.id} ${f.step}: ${f.ran}`, result: f.result ?? 'PASS', scope: SCOPES.has(scope) ? scope : 'context', defects, source: r.source });
    }
  }
  for (const x of o.ledgerRows ?? []) {
    const row = ledgerRows?.get(x.row);
    if (!row?.rev || !/Mac/.test(row.where)) continue;
    items.push({ rank: 1, run: `row ${x.row}`, revision: row.rev, date: null, what: `row ${x.row} (CHECKPOINTS.md): ${x.ran}`, result: x.result ?? 'PASS', scope: SCOPES.has(x.scope) ? x.scope : 'both', defects: [], source: 'docs/ui-cockpit/CHECKPOINTS.md' });
  }
  for (const e of feats) {
    if (!(e.demonstrated === 'yes' || e.demonstrated === 'partial')) continue;
    const ui = Boolean(e.entry) || e.surfaces.some((s) => /REPL|board|Canvas|timmy/.test(s));
    for (const { rev } of e.demonstrationRevisions) {
      // Where it ran, by the run of that revision: a rehearsal the row names (the Mac), or a ledger row of that revision
      // and the place the row states. A revision the cell names with neither is not taken as a Mac run (its place is not known).
      // A rehearsal whose own facts name this capability says what of it ran (its backend, its UI): the row's mention of
      // the same rehearsal adds nothing to them.
      const named = rehearsals.filter((h) => h.revision === rev && (e.rehearsalsNamed ?? []).includes(h.id));
      const byReh = named.filter((h) => !(h.facts ?? []).some((f) => f.caps?.[o.id])).map((h) => h.id);
      const byRow = e.demonstrationRows.filter((n) => ledgerRows?.get(n)?.rev === rev && /Mac/.test(ledgerRows.get(n).where ?? '')).map((n) => `row ${n}`);
      if (!byReh.length && !byRow.length) continue;
      const run = [...byReh, ...byRow].join(', ');
      items.push({ rank: 2, run, revision: rev, date: null, what: `the checklist's ${e.id} (${run}): ${cut(e.text.demonstrated, 260)}`, result: e.demonstrated === 'partial' ? 'partial' : 'PASS', scope: ui ? 'both' : 'backend', defects: [], source: 'docs/ui-cockpit/FEATURE-CHECKLIST.md' });
    }
  }
  for (const d of controls.demonstrations) {
    if (!(o.registry ?? []).includes(d.tool)) continue;
    items.push({ rank: 3, run: `${d.run}, row ${d.row}`, revision: d.revision, date: d.date, what: `${d.run}${d.part ? ` ${d.part}` : ''} (row ${d.row}, /tools row ${d.tool}): ${d.outcome}`, result: d.result, scope: d.result === 'PASS' ? 'backend' : 'context', defects: [], source: 'src/capabilities/demonstrations.ts' });
  }
  return items;
}

/** The newest commit that touched any of these files (a folder: any file under it), from the ledger's git index. */
function newestChange(gi, paths, files) {
  if (!gi || !paths.length) return null;
  return gi.newestFor(paths, files);
}

/** Builds the matrix. `c` is the inventory's collected state (collect() in inventory.mjs). */
export function buildCapabilities(c) {
  const ov = c.overlay ?? {};
  const problems = [];
  const controls = c.controls;
  const gi = c.ledger.gi ?? null;
  const byId = new Map(c.ledger.entries.map((e) => [e.id, e]));
  const toolsIds = new Set(controls.toolsIds);
  const rehearsals = (ov.rehearsals ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const testRun = testRunIndex(c.root, c.facts, ov.suites);
  const acceptance = new Map();
  for (const a of ov.acceptance ?? []) {
    if (a?.by !== 'operator' || !a.date || !a.source || !a.capability) { problems.push(`an acceptance entry without by: operator, a date, a source and a capability is ignored (${cut(JSON.stringify(a), 80)})`); continue; }
    acceptance.set(a.capability, a);
  }
  const screens = new Set(SCREENS);
  const rows = [];
  const seen = new Set();
  for (const o of ov.capabilities ?? []) {
    if (!o?.id || seen.has(o.id)) { problems.push(`a capability without an id, or a repeated id (${o?.id ?? '?'})`); continue; }
    seen.add(o.id);
    if (!screens.has(o.screen)) problems.push(`${o.id}: screen "${o.screen}" is not one of the operator's screens`);
    const feats = [];
    for (const id of o.features ?? []) { const e = byId.get(id); if (e) feats.push(e); else problems.push(`${o.id}: feature ${id} is not in the ledger`); }
    for (const id of o.registry ?? []) if (!toolsIds.has(id)) problems.push(`${o.id}: /tools row ${id} is not in the code`);
    const { paths, missing, refused } = resolvePaths(o, controls, c.files, c.root);
    const kinds = PATH_KINDS.filter((k) => paths[k].some((p) => !p.stub));
    const operationPath = kinds.length > 0;

    // Tests: those the features cite, and those the overlay names (each must be in the tree).
    const named = [];
    for (const t of o.tests ?? []) {
      const file = typeof t === 'string' ? t : t.file;
      const has = c.files.includes(file);
      const text = has && t.has ? readText(join(c.root, file)) ?? '' : '';
      if (!has || (t.has && !text.includes(t.has))) problems.push(`${o.id}: test ${file}${t.has ? ` naming "${t.has}"` : ''} is not in the tree`);
      else named.push(file);
    }
    const tests = sortStrings(uniq([...feats.flatMap((e) => e.testFiles.filter((f) => c.files.includes(f))), ...named]));
    const fakes = o.fakes ?? (feats.some((e) => e.testedWithFakes) || (o.testsWith ?? '') !== '');
    const fakesWords = o.testsWith ?? uniq(feats.filter((e) => e.testedWithFakes).map((e) => cut(e.text.tested, 120))).slice(0, 2).join('; ');
    const runs = tests.map((t) => ({ file: t, ...testRun(t) }));
    const ranAt = runs.filter((r) => r.revision);
    const testRev = ranAt.find((r) => r.run === 'full suite') ?? ranAt[0] ?? null;

    // Live evidence.
    for (const x of o.ledgerRows ?? []) if (!c.ledger.rows?.get(x.row)) problems.push(`${o.id}: ledger row ${x.row} is not in CHECKPOINTS.md`);
    const items = liveItems(o, feats, controls, rehearsals, c.ledger.rows).sort(newestFirst(gi));
    const counts = (r) => r.result !== 'FAIL' && r.scope !== 'context';
    const backLive = items.find((r) => counts(r) && (r.scope === 'both' || r.scope === 'backend')) ?? null;
    const uiLive = items.find((r) => counts(r) && (r.scope === 'both' || r.scope === 'ui')) ?? null;

    // Implemented: the features' marks, or the overlay's code paths for a capability no checklist row covers.
    const implRevs = feats.flatMap((e) => (e.implemented === 'yes' || e.implemented === 'partial' ? e.implementedRevisions.map((x) => ({ run: e.id, revision: x.rev })) : []));
    const codePaths = (o.code ?? []).filter((p) => c.files.some((f) => f === p || f.startsWith(`${p.replace(/\/$/, '')}/`)));
    for (const p of o.code ?? []) if (!codePaths.includes(p)) problems.push(`${o.id}: code path ${p} is not in the tree`);
    const implemented = feats.some((e) => e.implemented === 'yes' || e.implemented === 'partial') || (codePaths.length > 0 && codePaths.length === (o.code ?? []).length);
    const implNewest = implRevs.sort(newestFirst(gi))[0] ?? null;
    // Its own code: the features' files and the overlay's code paths. The revision of its code: the features'
    // implementation commits, else the newest change to its own code, else the tree read.
    const own = uniq([...feats.flatMap((e) => e.checkedFiles), ...codePaths]);
    const codeChange = implNewest ? null : newestChange(gi, own, c.files);
    const implRev = implNewest?.revision ?? codeChange?.rev ?? c.facts?.head ?? null;
    const designDoc = o.designed ? { ...o.designed, inTree: o.designed.file ? c.files.includes(o.designed.file) : false } : null;

    const head = c.facts?.head ?? null;
    let backend;
    if (backLive) backend = { level: 'live-qualified on the Mac', revision: backLive.revision, evidence: backLive.what, run: backLive.run, result: backLive.result };
    else if (tests.length) backend = { level: 'tested here', revision: testRev?.revision ?? null, evidence: `${tests.join(', ')}${fakes ? ` (with FAKE or stand-in parts${fakesWords ? `: ${fakesWords}` : ''})` : ''}; ${testRev ? testRev.words : runs[0].words}` };
    else if (implemented) backend = { level: 'implemented', revision: implRev, evidence: implNewest ? `${implNewest.revision} (${implNewest.run}); no automated test found` : `${own.join(', ')}${codeChange ? ` (newest change ${codeChange.rev})` : ''}; no automated test found` };
    else if (designDoc) backend = { level: 'designed', revision: designDoc.inTree ? newestChange(gi, [designDoc.file], c.files)?.rev ?? head : null, evidence: designDoc.says };
    else if (o.researched) backend = { level: 'researched', revision: o.researched.file && c.files.includes(o.researched.file) ? newestChange(gi, [o.researched.file], c.files)?.rev ?? head : null, evidence: o.researched.says };
    else { backend = { level: 'researched', revision: null, evidence: 'unknown: the overlay names no evidence' }; problems.push(`${o.id}: no evidence for any level`); }
    if (tests.length) backend.tests = runs.map((r) => ({ file: r.file, run: r.words }));
    if (fakes && tests.length) backend.fakes = fakesWords || 'yes';

    // A UI test by its file name, unless the overlay names the UI tests (a test named like one that does not drive the surface).
    const uiTests = Array.isArray(o.uiTests) ? o.uiTests.filter((t) => tests.includes(t)) : tests.filter((t) => UI_TEST.test(t));
    for (const t of Array.isArray(o.uiTests) ? o.uiTests : []) if (!tests.includes(t)) problems.push(`${o.id}: UI test ${t} is not one of its tests`);
    const uiKinds = UI_KINDS.filter((k) => paths[k].some((p) => !p.stub));
    let ui;
    if (uiLive) ui = { level: 'live-qualified on the Mac', revision: uiLive.revision, evidence: uiLive.what, run: uiLive.run, result: uiLive.result };
    else if (uiTests.length && uiKinds.length) ui = { level: 'tested here', revision: (uiTests.map((t) => testRun(t)).find((r) => r.run === 'full suite') ?? uiTests.map((t) => testRun(t)).find((r) => r.revision))?.revision ?? null, evidence: `${uiTests.join(', ')} (${Array.isArray(o.uiTests) ? 'the UI tests the overlay names' : 'a UI test by its name'})` };
    else if (uiKinds.length) ui = { level: 'implemented', revision: implRev, evidence: `${uiKinds.map((k) => PATH_WORDS[k]).join(', ')} in the code; no UI test ${Array.isArray(o.uiTests) ? '(the overlay names none)' : 'found by name'}` };
    else ui = { level: 'designed', revision: null, evidence: `no surface a person operates in this tree; the Workbench's ${o.screen} screen is designed (WORKBENCH-SPEC.md, the operator's reference package of 2026-10-11, not in this repository)` };

    // Code since the live evidence: the newest change to its own code.
    let codeSince = null;
    if (backLive || uiLive) {
      const liveRev = [backLive, uiLive].filter(Boolean).sort(newestFirst(gi))[0].revision;
      const last = newestChange(gi, own, c.files);
      if (!gi) codeSince = { state: 'unknown', words: 'no git history read' };
      else if (!last) codeSince = { state: 'unknown', words: 'no code file cited' };
      else {
        const inside = gi.contains(liveRev, last.rev);
        codeSince = inside === true ? { state: 'no', words: `its newest code change (${last.rev}, ${last.date}) is inside ${liveRev}` }
          : inside === false ? { state: 'yes', words: `its code changed at ${last.rev} (${last.date}), after ${liveRev}`, rev: last.rev }
            : { state: 'unknown', words: `${liveRev} or ${last.rev} is not in this clone's history` };
      }
    }

    // Defects: those the newest rehearsal that ran this capability found (an older one's are superseded by it).
    const rehItems = items.filter((r) => rehearsals.some((h) => h.id === r.run));
    const newestReh = rehearsals.find((h) => h.id === rehItems[0]?.run) ?? null;
    const defects = !newestReh ? [] : uniq(rehItems.filter((r) => r.run === newestReh.id).flatMap((r) => r.defects)).map((id) => {
      const d = newestReh.defects?.[id];
      return d ? { id: `${newestReh.id} ${id}`, says: d.says, state: d.state ?? 'open', owner: d.owner ?? null } : { id: `${newestReh.id} ${id}`, says: 'not described in the overlay', state: 'unknown', owner: null };
    });
    const openDefects = defects.filter((d) => d.state === 'open' || d.state === 'suspected');

    const blocker = o.blocker ?? (uniq(feats.map((e) => e.blocker).filter((b) => b && !/^(–|-|—)$/.test(b.trim()))).map((b) => cut(b, 200)).join('; ') || '–');
    const owner = o.owner ?? (uniq(feats.map((e) => e.owner).filter(Boolean)).join('; ') || 'unassigned (the lead assigns)');
    const acc = acceptance.get(o.id);
    const flags = [];
    if (!operationPath) flags.push('no-path');
    if (PATH_KINDS.some((k) => paths[k].some((p) => p.stub))) flags.push('stub');
    if (o.viewer) flags.push('viewer');
    if (backend.level === 'tested here' && fakes) flags.push('fakes');
    if (openDefects.length) flags.push('defect');
    if (codeSince?.state === 'yes') flags.push('stale');
    if (!tests.length && (backend.level === 'implemented' || backend.level === 'live-qualified on the Mac')) flags.push('no-test');
    if (missing.length) flags.push('missing-path');
    rows.push({
      id: o.id,
      screen: o.screen,
      feature: o.feature,
      provider: uniq([...(o.providers ?? []), ...(o.registry ?? []).map((id) => `/tools row ${id}`)]),
      controlPaths: paths,
      operationPath,
      ...(o.viewer ? { viewerOf: [].concat(o.viewOf ?? []) } : {}),
      notPaths: refused,
      namedNotFound: missing,
      renderers: o.renderers ?? [],
      inputs: o.inputs ?? 'unknown (not assessed)',
      outputs: o.outputs ?? 'unknown (not assessed)',
      backend,
      ui,
      evidenceRevision: {
        backend: backend.revision ?? null,
        ui: ui.revision ?? null,
        codeSinceLive: codeSince,
      },
      visualAcceptance: acc?.visual ?? NOT_REVIEWED,
      usabilityAcceptance: acc?.usability ?? NOT_REVIEWED,
      ...(acc ? { acceptanceSource: `${acc.source} (${acc.date})` } : {}),
      defects,
      blocker,
      owner,
      flags: flags.map((k) => FLAGS.find(([x]) => x === k)[1]),
      flagKeys: flags,
      features: o.features ?? [],
      registry: o.registry ?? [],
      liveEvidence: items.map((r) => ({ run: r.run, revision: r.revision, scope: r.scope, result: r.result, what: cut(r.what, 300) })).slice(0, 6),
      weight: o.weight ?? 0,
      ...(o.notes ? { notes: o.notes } : {}),
    });
  }
  const order = new Map(SCREENS.map((s, i) => [s, i]));
  rows.sort((a, b) => (order.get(a.screen) ?? 99) - (order.get(b.screen) ?? 99) || b.weight - a.weight || (a.id < b.id ? -1 : 1));
  for (const r of rows) for (const v of r.viewerOf ?? []) if (!seen.has(v)) problems.push(`${r.id}: a view of ${v}, which is not a capability here`);

  // Gaps: the flagged rows, the most serious flag first, then the overlay's weight, then the screen order.
  const worst = (r) => Math.min(...r.flagKeys.map((k) => FLAG_ORDER.get(k)));
  const flagged = rows.filter((r) => r.flagKeys.length).sort((a, b) => worst(a) - worst(b) || b.weight - a.weight || (order.get(a.screen) ?? 99) - (order.get(b.screen) ?? 99) || (a.id < b.id ? -1 : 1));
  const top = flagged.filter((r) => r.flagKeys.some((k) => TOP_FLAGS.has(k))).slice(0, 10).map((r) => r.id);

  // What the code advertises that no row claims.
  const claimedRepl = new Set(rows.flatMap((r) => r.controlPaths.repl.map((p) => p.path.slice(1).split(/\s+/)[0])));
  const claimedCli = new Set(rows.flatMap((r) => r.controlPaths.cli.map((p) => p.path.replace(/^timmy /, '').split(/\s+/)[0])));
  const claimedAgent = new Set(rows.flatMap((r) => r.controlPaths.agent.map((p) => p.path)));
  const claimedMcp = new Set(rows.flatMap((r) => r.controlPaths.mcp.map((p) => p.path.split(' ')[0])));
  const claimedTools = new Set(rows.flatMap((r) => r.registry));
  const unclaimed = {
    repl: controls.repl.filter((x) => !claimedRepl.has(x.name)).map((x) => ({ name: `/${x.name}`, words: x.description })),
    cli: controls.cli.filter((x) => x.help.length && !claimedCli.has(x.verb)).map((x) => ({ name: `timmy ${x.verb}`, words: x.help[0].replace(/^[^:]*:\s*/, ''), ...(x.stub ? { stub: true } : {}) })),
    cliWithoutHelp: controls.cli.filter((x) => !x.help.length && !claimedCli.has(x.verb)).map((x) => `timmy ${x.verb}`),
    agent: controls.agentTools.filter((x) => !claimedAgent.has(x.name)).map((x) => x.name),
    mcp: controls.mcpServer.filter((x) => !claimedMcp.has(x.name)).map((x) => x.name),
    tools: controls.toolsIds.filter((x) => !claimedTools.has(x)),
    monitorV1: controls.monitor.v1.length,
  };
  const stubs = controls.cli.filter((x) => x.stub).map((x) => ({ verb: `timmy ${x.verb}`, module: x.module, words: x.help[0]?.replace(/^[^:]*:\s*/, '') ?? '' }));

  const screenRows = SCREENS.map((s) => {
    const rs = rows.filter((r) => r.screen === s);
    const info = (ov.screens ?? []).find((x) => x.name === s) ?? {};
    return {
      name: s,
      group: info.group ?? null,
      workbench: info.workbench ?? null,
      notBuilt: info.notBuilt ?? [],
      capabilities: rs.length,
      backend: Object.fromEntries(LEVELS.map((l) => [l, rs.filter((r) => r.backend.level === l).length])),
      ui: Object.fromEntries(LEVELS.map((l) => [l, rs.filter((r) => r.ui.level === l).length])),
      renderers: sortStrings(uniq(rs.flatMap((r) => r.renderers))),
    };
  });
  for (const s of ov.screens ?? []) if (!screens.has(s.name)) problems.push(`overlay screen "${s.name}" is not one of the operator's screens`);

  return {
    schema: 'timmy.capability-matrix/1',
    date: c.o.date,
    sourceRevision: c.facts?.head ?? null,
    levels: LEVELS,
    pathKinds: PATH_KINDS,
    screens: screenRows,
    rehearsals: rehearsals.map((r) => ({ id: r.id, revision: r.revision, date: r.date, where: r.where, how: r.how, source: r.source, notRun: r.notRun ?? [], defects: r.defects ?? {} })),
    suites: ov.suites ?? [],
    stubs,
    counts: {
      capabilities: rows.length,
      withoutPath: rows.filter((r) => !r.operationPath).length,
      backend: Object.fromEntries(LEVELS.map((l) => [l, rows.filter((r) => r.backend.level === l).length])),
      ui: Object.fromEntries(LEVELS.map((l) => [l, rows.filter((r) => r.ui.level === l).length])),
      accepted: rows.filter((r) => r.visualAcceptance !== NOT_REVIEWED || r.usabilityAcceptance !== NOT_REVIEWED).length,
    },
    gaps: { top, flagged: flagged.map((r) => ({ id: r.id, flags: r.flags })) },
    rows: rows.map(({ weight: _w, flagKeys: _f, ...r }) => r),
    unclaimed,
    problems: sortStrings(uniq([...problems, ...controls.problems.map((p) => `${p.file} ${p.what}: ${p.why}`)])),
  };
}

// ------------------------------------------------------------------------------------------------------------ Markdown

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();
const code = (s) => (s ? `\`${String(s).replace(/`/g, "'")}\`` : '–');
const SHORT = { 'researched': 'researched', 'designed': 'designed', 'implemented': 'implemented', 'tested here': 'tested here', 'live-qualified on the Mac': 'live on the Mac' };
const FLAG_SHORT = { 'no operation path': 'no path', 'a control path exits 69 (not built)': 'exits 69', 'viewer only': 'viewer only', 'tested with FAKE or stand-in parts, never on the Mac': 'fakes, not live', 'an open defect a Mac run found': 'open defect', 'live evidence older than its code': 'code since', 'no automated test found': 'no test', 'a named path is not in the code': 'path not found' };

const partial = (s) => (s.level === 'live-qualified on the Mac' && s.result === 'partial' ? ', partial' : '');

function levelCell(s, run) {
  const rev = s.revision ? ` \`${s.revision}\`` : '';
  if (s.level === 'live-qualified on the Mac') return `live on the Mac${partial(s)} (${run ?? s.run})${rev}`;
  return `${SHORT[s.level]}${rev}`;
}

const pathsShort = (r) => {
  const kinds = PATH_KINDS.filter((k) => r.controlPaths[k].some((p) => !p.stub));
  return kinds.length ? kinds.map((k) => PATH_WORDS[k]).join(' · ') : '**none**';
};

function pathsLong(r) {
  const parts = [];
  for (const k of PATH_KINDS) {
    const ps = r.controlPaths[k];
    if (!ps.length) continue;
    parts.push(`**${PATH_WORDS[k]}**: ${ps.map((p) => `${code(p.path)}${p.stub ? ' (exits 69: not built)' : ''}${p.note && !p.stub ? ` (${esc(p.note)})` : ''}`).join(', ')}`);
  }
  const none = PATH_KINDS.filter((k) => !r.controlPaths[k].length).map((k) => PATH_WORDS[k]);
  if (!parts.length) parts.push('**none**: no REPL command, CLI verb, MCP tool, board, companion, Studio or monitor control, and no agent tool');
  else if (none.length) parts.push(`none: ${none.join(', ')}`);
  if (r.notPaths.length) parts.push(r.notPaths.map(esc).join('; '));
  if (r.namedNotFound.length) parts.push(`named but not in the code: ${r.namedNotFound.map(esc).join('; ')}`);
  return parts.join('<br>');
}

/** The matrix for people: a short summary first, the full rows after, then what no row claims. */
export function capabilityMatrixMd(m, c) {
  const L = [];
  const p = (...xs) => L.push(...xs);
  const rev = c.facts ? `the tree at \`${c.facts.head}\` (${c.facts.headDate})` : 'a folder that is not a git work tree';
  p('# Timmy capability matrix', '');
  p(`Date: ${m.date}. Source: ${rev}${c.facts?.changed ? `, with ${plural(c.facts.changed, 'tracked file')} changed and not committed` : ''}. Generated by \`node scripts/inventory/inventory.mjs --date ${m.date}\`, with`, '[`INVENTORY.md`](INVENTORY.md) (every dependency, for those who need it) and [`inventory/capabilities.json`](inventory/capabilities.json) (these rows,', 'machine-readable). One row per user-facing capability: which capabilities there are, their screen, renderer, inputs and outputs', 'and owner come from the hand-kept `inventory/overlay.json`; every control path is checked against the code, and every status', 'comes from the feature checklist, the ledger, the tests named, the recorded test runs, the Mac rehearsals and git.', '');
  p('**How to read it.** Each status is the highest that has its own evidence, with the revision of that evidence:', '');
  p('- **researched**: read from documentation or source; nothing of it is built here.');
  p('- **designed**: a written design says how Timmy does it; no code yet.');
  p('- **implemented**: its code is in this tree; no automated test was found for it.');
  p('- **tested here**: automated tests exercise it, named, with the recorded run that covers each file\'s current version (the full suite at `5e5cbb3`, or a helper\'s own run of a file added later); "fakes" names the stand-ins.');
  p('- **live-qualified on the Mac** ("live on the Mac" in the summary): it ran for real on the operator\'s Mac in a recorded, scripted rehearsal (r19 to r25), named with its revision and what ran. This is not a formal qualification (AGENTS.md section 5), and it says nothing of visual or usability acceptance.', '');
  p('**Backend** is the work itself; **UI** is the surface a person operates (a typed REPL command or CLI verb, a button on the live board, in Studio or the companion, the monitor). An agent tool and an MCP tool are paths for an agent, not a person\'s UI. **Visual acceptance** and **usability acceptance** belong to the operator alone: every row says "not reviewed" unless the operator recorded otherwise (none has been recorded). A **control path** is listed only when the code has it; a named path the code does not have is reported, and a capability without any path says so ("a documentation link or viewer alone is incomplete integration", the operator, 2026-10-11).', '');

  // Counts.
  const cn = m.counts;
  p('## At a glance', '');
  p(`${plural(cn.capabilities, 'capability', 'capabilities')} on ${m.screens.filter((s) => s.capabilities).length} of the ${m.screens.length} screens; ${cn.withoutPath} without any operation path; acceptance recorded for ${cn.accepted}.`, '');
  p('| Status | Backend | UI |', '|---|---|---|');
  for (const l of [...LEVELS].reverse()) p(`| ${l} | ${cn.backend[l]} | ${cn.ui[l]} |`);
  p('');

  // Top gaps.
  p('## The ten gaps that matter most', '');
  p('Capabilities advertised without an operation path (none at all, one that exits 69, or a view of what is done elsewhere), or tested only with fakes or stand-ins and never run on the Mac; the most serious kind first, then the overlay\'s weight. Open defects the Mac runs found are in each row\'s Blocker and in the rehearsals at the end.', '');
  m.gaps.top.forEach((id, i) => {
    const r = m.rows.find((x) => x.id === id);
    p(`${i + 1}. **${esc(r.feature)}** (${r.screen}; ${code(r.id)}): ${r.flags.join(', ')}. Backend ${levelCell(r.backend)}, UI ${levelCell(r.ui)}. ${r.defects.length ? `Defects: ${r.defects.map((d) => `${d.id} (${d.state})`).join(', ')}. ` : ''}Owner: ${esc(r.owner)}.`);
  });
  p('');
  if (m.stubs.length) p(`Advertised in \`timmy --help\` and not built (the verb exits 69): ${m.stubs.map((s) => `${code(s.verb)} (${esc(s.words)})`).join('; ')}.`, '');

  // Summary table.
  p('## Summary', '');
  p('| Screen | Capability | Control paths | Backend | UI | Gaps |', '|---|---|---|---|---|---|');
  for (const r of m.rows) p(`| ${r.screen} | [${esc(r.feature.split(/[:;(]/)[0].trim())}](#${r.id}) | ${pathsShort(r)} | ${levelCell(r.backend)} | ${levelCell(r.ui)} | ${r.flags.map((f) => FLAG_SHORT[f] ?? f).join(', ') || '–'} |`);
  p('');

  // Screens.
  p('## Screens', '');
  p('The operator\'s screens (WORKBENCH-SPEC.md and CLAUDE-WORKBENCH-PROMPT.txt in the reference package of 2026-10-11, not in this repository). The terminal Workbench that is to hold them is designed there and not built here: `timmy workbench` exits 69 at this revision. Today each capability is drawn by the renderers listed.', '');
  p('| Screen | Group | Capabilities | Backend: live · tested · implemented · designed · researched | Renderers today | Named for it, not in Timmy |', '|---|---|---|---|---|---|');
  for (const s of m.screens) p(`| ${s.name} | ${esc(s.group ?? '–')} | ${s.capabilities} | ${LEVELS.slice().reverse().map((l) => s.backend[l]).join(' · ')} | ${esc(s.renderers.join(', ') || '–')} | ${esc(s.notBuilt.join(', ') || '–')} |`);
  p('');
  const wb = (c.overlay?.screens ?? []).find((s) => s.workbenchNote)?.workbenchNote;
  if (wb) p(esc(wb), '');

  // Full rows.
  p('## Every capability', '');
  for (const s of SCREENS) {
    const rs = m.rows.filter((r) => r.screen === s);
    if (!rs.length) continue;
    p(`### ${s}`, '');
    for (const r of rs) {
      p(`<a id="${r.id}"></a>`, `#### ${esc(r.feature)}`, '');
      p('| | |', '|---|---|');
      p(`| Capability | ${code(r.id)}${r.viewerOf ? ` (a view of ${r.viewerOf.map(code).join(', ') || 'what is done elsewhere'})` : ''} |`);
      p(`| Dependency / provider | ${esc(r.provider.join('; ') || '–')} |`);
      p(`| Control path | ${pathsLong(r)} |`);
      p(`| Screen | ${r.screen} |`);
      p(`| Renderer | ${esc(r.renderers.join('; ') || '–')} |`);
      p(`| Inputs / outputs | In: ${esc(r.inputs)}<br>Out: ${esc(r.outputs)} |`);
      p(`| Backend status | **${r.backend.level}**${partial(r.backend)}${r.backend.revision ? ` at \`${r.backend.revision}\`` : ''}: ${esc(cut(r.backend.evidence, 520))}${r.backend.tests && r.backend.level !== 'tested here' ? `<br>Tests: ${esc(cut(r.backend.tests.map((t) => t.file).join(', '), 400))}` : ''} |`);
      p(`| UI status | **${r.ui.level}**${partial(r.ui)}${r.ui.revision ? ` at \`${r.ui.revision}\`` : ''}: ${esc(cut(r.ui.evidence, 420))} |`);
      p(`| Evidence revision | backend ${r.evidenceRevision.backend ? `\`${r.evidenceRevision.backend}\`` : 'none'}, UI ${r.evidenceRevision.ui ? `\`${r.evidenceRevision.ui}\`` : 'none'}${r.evidenceRevision.codeSinceLive ? `; code since the live run: ${esc(r.evidenceRevision.codeSinceLive.words)}` : ''} |`);
      p(`| Visual acceptance | ${esc(r.visualAcceptance)} |`);
      p(`| Usability acceptance | ${esc(r.usabilityAcceptance)} |`);
      p(`| Blocker | ${esc(cut(r.blocker, 400))}${r.defects.length ? `<br>Mac runs found: ${r.defects.map((d) => `${d.id} (${d.state}${d.owner ? `, ${d.owner}` : ''}): ${esc(cut(d.says, 160))}`).join('<br>')}` : ''} |`);
      p(`| Owner | ${esc(r.owner)} |`);
      p(`| Gaps | ${r.flags.join(', ') || 'none flagged'} |`);
      p(`| From | ${r.features.length ? `checklist ${r.features.map(code).join(', ')}` : 'no checklist row'}${r.registry.length ? `; /tools ${r.registry.map(code).join(', ')}` : ''}${r.notes ? `. ${esc(r.notes)}` : ''} |`, '');
    }
  }

  // Rehearsals read.
  p('## The Mac rehearsals this matrix reads', '');
  p('Older Mac runs reach it through the checklist\'s rows and the ledger (CHECKPOINTS.md, rows to 173). These two have no ledger row yet; their facts are the helpers\' reports, as the overlay records them:', '');
  for (const r of m.rehearsals) {
    p(`- **${r.id}** at \`${r.revision}\` (${r.date}; ${esc(r.how)}; ${esc(r.where)}). Source: ${esc(r.source)}.${r.notRun.length ? ` Not run: ${r.notRun.map(esc).join('; ')}.` : ''}`);
    const ds = Object.entries(r.defects);
    if (ds.length) p(`  Defects: ${ds.map(([k, d]) => `${k} (${d.state ?? 'open'}${d.owner ? `, ${d.owner}` : ''}): ${esc(d.says)}`).join('; ')}.`);
  }
  p('');
  p('Recorded test runs: ' + (m.suites.map((s) => `${s.kind} at \`${s.revision}\` (${esc(s.result)}; ${esc(s.source)})`).join('; ') || 'none') + '.', '');

  // Coverage.
  const u = m.unclaimed;
  p('## Advertised, and not in a row yet', '');
  p('Read from the code; each is reachable as named, and none is assessed here. A later pass adds rows for those that are user-facing.', '');
  p(`- REPL commands (${u.repl.length}): ${u.repl.map((x) => `${code(x.name)} (${esc(x.words)})`).join(', ') || 'none'}.`);
  p(`- \`timmy --help\` verbs (${u.cli.length}): ${u.cli.map((x) => `${code(x.name)}${x.stub ? ' (exits 69)' : ''}`).join(', ') || 'none'}.`);
  p(`- Verbs src/cli.ts dispatches that \`timmy --help\` does not list (${u.cliWithoutHelp.length}): ${u.cliWithoutHelp.map(code).join(', ') || 'none'}.`);
  p(`- Agent tools (${u.agent.length}): ${u.agent.map(code).join(', ') || 'none'}.`);
  p(`- Tools of Timmy's own MCP server, \`timmy mcp serve\` (${u.mcp.length}): ${u.mcp.map(code).join(', ') || 'none'}.`);
  p(`- /tools rows (${u.tools.length}): ${u.tools.map(code).join(', ') || 'none'}.`);
  p(`- The older monitor's commands (src/utils/slash-commands.ts): ${u.monitorV1}, dispatched only by the v1 monitor (\`TIMMY_SHELL=v1 timmy watch\`); the default monitor handles /setup, /studio and /model test itself and sends any other text to the agent (r25 D1, read in the code).`, '');
  if (m.problems.length) {
    p('## Problems reading the overlay or the code', '');
    for (const x of m.problems) p(`- ${esc(x)}`);
    p('');
  }
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
