// Timmy's inventory: the feature ledger. Read from docs/ui-cockpit/FEATURE-CHECKLIST.md (one row per feature) and the
// ledger docs/ui-cockpit/CHECKPOINTS.md (what ran, where, at which revision), checked against the tree (do the cited
// files exist?) and against git (when did the feature's code last change, and is that change inside a demonstrated
// revision?), then joined with a hand-kept overlay (docs/ui-cockpit/inventory/overlay.json) for what no document says:
// the user benefit, the connected surfaces, the exact gap, an owner and the next bounded task.
import { join } from 'node:path';
import { git, readText, slug, sortStrings, uniq } from './common.mjs';

/** A table row's cells: split on "|" not escaped as "\|", the outer empty cells dropped, "\|" restored. */
export function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (line[i] === '|') { cells.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  cells.push(cur);
  return cells.slice(1, -1).map((c) => c.trim());
}

const MARK = (cell) => {
  const t = cell.trim();
  if (/^✓/.test(t)) return 'yes';
  if (/^partial/i.test(t)) return 'partial';
  if (/^unknown/i.test(t)) return 'unknown';
  if (/^(–|-|—)/.test(t)) return 'no';
  if (/excluded/i.test(t)) return 'excluded';
  return t ? 'see text' : 'unknown';
};

const FAKE_WORDS = /\b(fakes?|FAKE|stand-in|test-double|mock(?:ed)?|simulated|fixture)\b/i;
const REV = /`([0-9a-f]{7,12})`/g;

/** Ledger row numbers a cell cites: "row 128", "rows 124, 125 and 130", "rows 129 to 131". */
export function citedRows(text) {
  const out = new Set();
  for (const m of text.matchAll(/\brows?\s+(\d+(?:\s*(?:,|and|to|–)\s*\d+)*)/g)) {
    const parts = m[1].split(/\s*(,|and|to|–)\s*/);
    let prev = null;
    let range = false;
    for (const p of parts) {
      if (p === 'to' || p === '–') { range = true; continue; }
      if (p === ',' || p === 'and') { range = false; continue; }
      const n = Number(p);
      if (!Number.isInteger(n)) continue;
      if (range && prev !== null && n > prev && n - prev < 40) for (let k = prev + 1; k <= n; k++) out.add(k);
      else out.add(n);
      prev = n;
      range = false;
    }
  }
  // "rows 171 (r23b: …) and 173 (r23c: …)": a number that a parenthesis naming a run or a revision follows is a row too.
  for (const m of text.matchAll(/(?:,|\band)\s+(\d{1,3})\s+\((?:r\d|u\d|`[0-9a-f]{7})/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

const PATHISH = /^(?:src|tests|templates|workers|lanes|scripts|companion|docs|assets|services|packages|tools|\.github|cli\.tsx|headless\.ts|timmy\.ts|package\.json|vitest\.config\.ts)(?:\/|$)/;

/** Repository paths a cell cites in backticks (a trailing description after a space is dropped). */
export function citedPaths(text) {
  const out = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const p = m[1].trim().split(/\s/)[0].replace(/[,;:)]+$/, '');
    if (PATHISH.test(p) && !p.includes('..')) out.push(p);
  }
  return uniq(out);
}

/** Whether a cited path is in the tree: a file, a folder (a prefix of files), or a glob/brace form matching one. */
function pathPresent(p, fileSet, files) {
  if (fileSet.has(p)) return true;
  const dir = p.replace(/\/$/, '');
  if (/[*{]/.test(p)) {
    const prefix = p.slice(0, p.search(/[*{]/));
    return files.some((f) => f.startsWith(prefix));
  }
  return files.some((f) => f.startsWith(`${dir}/`));
}

/** The checklist's rows: one per feature, with its section and every cell as written. */
export function parseChecklist(text) {
  const rows = [];
  const meta = { date: /^Date:\s*([0-9-]{10})/m.exec(text)?.[1] ?? null, revisions: uniq([...(/^Date:[\s\S]*?\n\n/m.exec(text)?.[0] ?? '').matchAll(REV)].map((m) => m[1])) };
  let section = null;
  for (const line of text.split('\n')) {
    const h = /^##\s+(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (h) { section = { n: Number(h[1]), title: h[2] }; continue; }
    if (/^##\s/.test(line)) { section = null; continue; }
    if (!section || !line.startsWith('|') || /^\|\s*-{3}/.test(line) || /^\|\s*Feature\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (cells.length < 7) continue;
    const [feature, planned, implemented, tested, demonstrated, blocker, evidence] = cells;
    rows.push({ section, feature, planned, implemented, tested, demonstrated, blocker, evidence });
  }
  return { meta, rows };
}

/** The ledger's rows: number, step, status, and the revision and place each names. */
export function parseLedger(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (cells.length < 4) continue;
    const n = Number(cells[0]);
    const step = cells[1];
    const evidence = cells[3];
    const rev = [...step.matchAll(REV)].map((m) => m[1]).find((r) => r.length === 7) ?? [...evidence.matchAll(REV)].map((m) => m[1]).find((r) => r.length === 7) ?? null;
    const both = `${step} ${evidence}`;
    // The checklist counts as demonstrated only a run on the operator's Mac or in CI with the real dependency.
    const where = /\bMac\b|operator's Mac|sandbox user|installed package/.test(both) ? "macOS (the operator's Mac)"
      : /GitHub(?:-hosted| Actions)|\bin CI\b/.test(step) ? 'GitHub Actions' : 'not stated in the row';
    rows.set(n, { n, step, status: cells[2], rev, where, scripted: /scripted/i.test(both) });
  }
  return rows;
}

const PROVIDERS = [
  [/Qwen Code/, 'Qwen Code'], [/\bOllama\b/, 'Ollama (local)'], [/\bCodex\b/, 'Codex'], [/anthropic\/[\w.-]+/, null],
  [/\bOpenRouter\b/, 'OpenRouter'], [/\bOpenHands\b/, 'OpenHands'], [/OrbStack/, 'OrbStack Docker'], [/\bBlender [0-9.]+/, null],
  [/FreeCAD [0-9.]+/, null], [/OpenSCAD [0-9.]+/, null], [/After Effects (?:20\d\d|[0-9.]+x\d+)/, null], [/Unreal(?: Engine)? 5\.\d/, null],
  [/upmd [0-9.]+/, null], [/Rerun [0-9.]+/, null], [/Illustrator(?: 20\d\d)?/, 'Illustrator'], [/MCPorter/, 'MCPorter'], [/Spline/, 'Spline'],
  [/cloudflare-docs/, 'cloudflare-docs MCP'], [/\bNode 2\d[.0-9]*/, null], [/codex-cli [0-9.]+/, null],
];

function providersIn(text) {
  const out = [];
  for (const [re, name] of PROVIDERS) {
    const m = re.exec(text);
    if (m) out.push(name ?? m[0]);
  }
  return uniq(out);
}

const SURFACES = [
  [/`\/board live`|live board/i, 'live board'], [/`\/board`|the board|board snapshot/i, 'board'], [/Timmy Canvas|`\/canvas/i, 'Timmy Canvas'],
  [/`timmy act`/, 'timmy act'], [/agent tool|`run_native`|`iterate_|`call_mcp_tool`|`recall_project_work`|`canvas_place/i, 'agent tool'],
  [/`timmy watch`|the monitor|browser companion/i, 'monitor or companion'], [/Control Room|`\/room`/i, 'Control Room'],
  [/`timmy [a-z]+/, 'timmy CLI'], [/`\/[a-z]/, 'REPL command'],
];

function surfacesIn(text) {
  const out = [];
  for (const [re, name] of SURFACES) if (re.test(text)) out.push(name);
  return uniq(out);
}

/** The command a feature starts from: the first backticked command in its cell, else its first backticked span. */
function entryOf(feature) {
  const spans = [...feature.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  const command = spans.find((s) => /^\/[a-z]/.test(s) || /^timmy\s+[a-z]/.test(s));
  const tool = spans.find((s) => /^(?:list|read|write|call|run|iterate|observe|describe|recall|canvas)_[a-z_]+$/.test(s));
  return command ?? tool ?? null;
}

/**
 * Git facts for the ledger: the newest commit touching each file (one `git log`), the date of each revision, and whether
 * a change is inside a revision (`git merge-base --is-ancestor`). All unknown without git.
 */
export function gitIndex(root, facts) {
  if (!facts) return null;
  const log = git(root, ['log', '--format=>%h %cs', '--name-only', 'HEAD']);
  if (log === null) return null;
  const newest = new Map(); // file -> { rev, date, order }
  let cur = null;
  let order = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('>')) { const [rev, date] = line.slice(1).split(' '); cur = { rev, date, order: order++ }; continue; }
    if (line && cur && !newest.has(line)) newest.set(line, cur);
  }
  const dates = new Map();
  const ancestor = new Map();
  const kinds = new Map();
  return {
    newestFor(paths, files) {
      let best = null;
      for (const p of paths) {
        const dir = p.replace(/\/$/, '');
        const hits = /[*{]/.test(p) ? files.filter((f) => f.startsWith(p.slice(0, p.search(/[*{]/)))) : newest.has(p) ? [p] : files.filter((f) => f.startsWith(`${dir}/`));
        for (const f of hits) { const c = newest.get(f); if (c && (!best || c.order < best.order)) best = c; }
      }
      return best;
    },
    isCommit(rev) {
      if (!kinds.has(rev)) kinds.set(rev, git(root, ['cat-file', '-t', rev])?.trim() === 'commit');
      return kinds.get(rev);
    },
    dateOf(rev) {
      if (!dates.has(rev)) dates.set(rev, git(root, ['show', '-s', '--format=%cs', `${rev}^{commit}`])?.trim() || null);
      return dates.get(rev);
    },
    contains(rev, change) {
      const key = `${change} ${rev}`;
      if (!ancestor.has(key)) {
        let v = null;
        if (this.dateOf(rev) && this.dateOf(change)) v = git(root, ['merge-base', '--is-ancestor', change, rev]) !== null;
        ancestor.set(key, v);
      }
      return ancestor.get(key);
    },
  };
}

/** A code file cited by more features than this is shared (a hub such as the REPL's workspace or the CLI). */
export const SHARED_CITES = 6;

const IMPL_PREFIX = /^(?:src|workers|templates|lanes|companion|services|scripts|packages)\/|^(?:cli\.tsx|headless\.ts|timmy\.ts)$/;

/** One feature's ledger entry from a checklist row (or an overlay-added row), checked against the tree and git. */
function ledgerEntry(row, ctx) {
  const { fileSet, files, ledger, gi } = ctx;
  const allText = [row.feature, row.implemented, row.tested, row.demonstrated, row.blocker, row.evidence].join(' ');
  const paths = citedPaths(`${row.implemented} ${row.evidence} ${row.feature}`);
  const missing = paths.filter((p) => !pathPresent(p, fileSet, files));
  const tests = paths.filter((p) => p.startsWith('tests/'));
  const impl = paths.filter((p) => IMPL_PREFIX.test(p));
  // Rows a "no" cell names are context (where it stopped, what ran instead), not demonstrations.
  const namedRows = citedRows(row.demonstrated).filter((n) => !ledger.size || ledger.has(n));
  const notDemonstrated = /^(–|-|—)/.test(row.demonstrated.trim());
  const demoRows = notDemonstrated ? [] : namedRows;
  // A backticked hex word is a commit only when git knows it as one (an 8-hex receipt id looks the same); without git,
  // only the 7-character form this repository uses for commits is taken.
  const isRev = (r) => (gi ? gi.isCommit(r) : r.length === 7);
  const demoRevs = notDemonstrated ? [] : uniq([...[...row.demonstrated.matchAll(REV)].map((m) => m[1]), ...demoRows.map((n) => ledger.get(n)?.rev).filter(Boolean)]).filter(isRev);
  const implRevs = uniq([...row.implemented.matchAll(REV)].map((m) => m[1])).filter(isRev);
  const where = uniq(demoRows.map((n) => ledger.get(n)?.where ?? 'unknown (row not in the ledger)'));
  const demonstrated = MARK(row.demonstrated);
  // A file many features cite (src/repl/workspace.ts, src/cli.ts …) changes with almost every commit: the check uses the
  // feature's own files when it cites any, and says when it could only use shared ones.
  const present = impl.filter((p) => pathPresent(p, fileSet, files));
  const own = present.filter((p) => !ctx.shared.has(p));
  const checked = own.length ? own : present;
  const last = gi ? gi.newestFor(checked, files) : null;
  let sinceDemo = 'unknown';
  if (!gi) sinceDemo = 'unknown (no git history read)';
  else if (demonstrated === 'no' || demonstrated === 'unknown') sinceDemo = 'not demonstrated';
  else if (!last) sinceDemo = 'unknown (no implementation file cited)';
  else if (!demoRevs.length) sinceDemo = 'unknown (no revision named for the demonstration)';
  else {
    const covered = demoRevs.map((r) => gi.contains(r, last.rev));
    if (covered.some((c) => c === true)) sinceDemo = 'no: the newest code change is inside a demonstrated revision';
    else if (covered.every((c) => c === null)) sinceDemo = 'unknown (the revisions are not in this clone\'s history)';
    else sinceDemo = `yes: ${own.length ? 'a file of its own' : 'a shared file it cites'} changed at ${last.rev} (${last.date}), after every demonstrated revision named`;
  }
  const tested = MARK(row.tested);
  return {
    section: `${row.section.n}. ${row.section.title}`,
    feature: row.feature,
    entry: entryOf(row.feature),
    planned: MARK(row.planned),
    implemented: MARK(row.implemented),
    implementedRevisions: implRevs.map((r) => ({ rev: r, date: gi ? gi.dateOf(r) : null })),
    tested,
    testedWithFakes: tested === 'yes' || tested === 'partial' ? FAKE_WORDS.test(row.tested) : false,
    testFiles: tests,
    demonstrated,
    scripted: /scripted/i.test(row.demonstrated),
    demonstrationRows: demoRows,
    rowsNamed: namedRows,
    demonstrationRevisions: demoRevs.map((r) => ({ rev: r, date: gi ? gi.dateOf(r) : null })),
    demonstratedWhere: where,
    demonstrationProviders: providersIn(row.demonstrated),
    lastCodeChange: last ? { rev: last.rev, date: last.date, of: own.length ? 'its own files' : 'shared files only' } : null,
    checkedFiles: checked,
    changedSinceDemonstration: sinceDemo,
    surfaces: surfacesIn(allText),
    blocker: row.blocker,
    citedPaths: paths,
    missingPaths: missing,
    text: { implemented: row.implemented, tested: row.tested, demonstrated: row.demonstrated },
  };
}

/**
 * The whole ledger: checklist rows and overlay-added rows, each with its checks; the overlay's judgement joined by id;
 * overlay ids that match no feature reported.
 */
export function buildLedger(root, files, facts, overlay) {
  const fileSet = new Set(files);
  const checklistText = fileSet.has('docs/ui-cockpit/FEATURE-CHECKLIST.md') ? readText(join(root, 'docs/ui-cockpit/FEATURE-CHECKLIST.md')) : null;
  const ledgerText = fileSet.has('docs/ui-cockpit/CHECKPOINTS.md') ? readText(join(root, 'docs/ui-cockpit/CHECKPOINTS.md')) : null;
  const ledger = ledgerText ? parseLedger(ledgerText) : new Map();
  const gi = gitIndex(root, facts);
  const parsed = checklistText ? parseChecklist(checklistText) : { meta: { date: null, revisions: [] }, rows: [] };
  // Shared files: code files cited by more than SHARED_CITES features (counted over the checklist and the added rows).
  const cites = new Map();
  for (const r of [...parsed.rows, ...(overlay?.added ?? []).map((a) => ({ feature: a.feature ?? '', implemented: a.implemented ?? '', evidence: a.evidence ?? '' }))]) {
    for (const p of citedPaths(`${r.implemented} ${r.evidence} ${r.feature}`)) if (IMPL_PREFIX.test(p)) cites.set(p, (cites.get(p) ?? 0) + 1);
  }
  const shared = new Set([...cites].filter(([, n]) => n > SHARED_CITES).map(([p]) => p));
  const ctx = { fileSet, files, ledger, gi, shared };
  const used = new Set();
  const idFor = (row) => {
    const base = `${row.section.n}-${slug(row.feature.replace(/\(.*$/, ''), 40)}`;
    let id = base; let k = 2;
    while (used.has(id)) id = `${base}-${k++}`;
    used.add(id);
    return id;
  };
  const entries = parsed.rows.map((row) => ({ id: idFor(row), source: 'docs/ui-cockpit/FEATURE-CHECKLIST.md', ...ledgerEntry(row, ctx) }));
  for (const a of overlay?.added ?? []) {
    const row = { section: { n: a.sectionNumber ?? 15, title: a.section ?? 'Built since the checklist was last updated' }, feature: a.feature ?? a.id, planned: a.planned ?? 'unknown', implemented: a.implemented ?? 'unknown', tested: a.tested ?? 'unknown', demonstrated: a.demonstrated ?? 'unknown', blocker: a.blocker ?? 'unknown', evidence: a.evidence ?? '' };
    used.add(a.id);
    const entry = ledgerEntry(row, ctx);
    entries.push({ id: a.id, source: 'docs/ui-cockpit/inventory/overlay.json (added: not yet a checklist row)', ...entry, entry: a.entry ?? entry.entry });
  }
  const judged = overlay?.features ?? {};
  const unmatched = sortStrings(Object.keys(judged).filter((id) => !entries.some((e) => e.id === id)));
  for (const e of entries) {
    const j = judged[e.id] ?? (overlay?.added ?? []).find((a) => a.id === e.id) ?? {};
    e.stage = j.stage ?? defaultStage(e);
    e.benefit = j.benefit ?? null;
    e.surfacesJudged = j.surfaces ?? null;
    e.gap = j.gap ?? null;
    e.owner = j.owner ?? null;
    e.next = j.next ?? null;
    e.assessed = Boolean(judged[e.id] || (overlay?.added ?? []).some((a) => a.id === e.id));
  }
  return { checklist: parsed.meta, checklistFound: Boolean(checklistText), ledgerFound: Boolean(ledgerText), ledgerRows: ledger.size, ledgerLast: ledger.size ? Math.max(...ledger.keys()) : null, entries, unmatched, git: Boolean(gi), shared: sortStrings([...shared]) };
}

/** The stage a feature belongs to when the overlay says none: by its section and its state. */
function defaultStage(e) {
  const n = Number(e.section.split('.')[0]);
  if (n === 13 || n === 14) return 'research';
  return 'preview';
}

/** A generated statement of a feature's gap when the overlay gives none: from its marks and the checks above. */
export function generatedGap(e) {
  const parts = [];
  if (e.implemented === 'no') parts.push('not built');
  else if (e.implemented === 'partial') parts.push('partly built');
  if (e.tested === 'no') parts.push('no automated test');
  if (e.demonstrated === 'no') parts.push('never demonstrated for real');
  else if (e.demonstrated === 'partial') parts.push('demonstrated in part');
  else if (e.demonstrated === 'unknown') parts.push('demonstration unknown');
  if (e.changedSinceDemonstration.startsWith('yes')) parts.push('its code changed after the newest demonstrated revision');
  if (/not run yet|queued r\d+|not run on the Mac/i.test(e.text.demonstrated)) parts.push('a fix not yet run for real');
  if (e.missingPaths.length) parts.push(`${e.missingPaths.length} cited path(s) missing`);
  return parts.length ? parts.join('; ') : 'none found by these checks';
}

/** A generated next step when the overlay gives none. */
export function generatedNext(e) {
  if (e.implemented === 'no') return 'decide whether it is in scope, then a bounded first slice';
  if (e.missingPaths.length) return 'correct the checklist row\'s cited paths';
  if (e.demonstrated === 'no' || e.demonstrated === 'unknown') return e.entry && /^(\/|timmy\b)/.test(e.entry) ? `a scripted run of \`${e.entry}\` on the Mac, recorded as a ledger row` : 'a scripted Mac run that exercises it, recorded as a ledger row';
  if (e.changedSinceDemonstration.startsWith('yes') || /not run yet|queued r\d+/i.test(e.text.demonstrated)) return 'run its demonstration again on the current revision';
  if (e.demonstrated === 'partial') return 'demonstrate the part not yet shown';
  return 'none until something changes';
}
