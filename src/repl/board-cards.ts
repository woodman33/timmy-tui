/**
 * Round R4 (H22): two kinds of board card.
 *
 * The parameter card: the CadQuery tray recipe's parameter file, recipes/tray.params.json (src/recipes/
 * params-file.ts), or the recipe card's defaults when there is none, with each parameter's unit, meaning and
 * range. The snapshot shows it read-only; the live board's form saves new values with one structured edit
 * ('set-params') that the server checks with the recipe's own rules (writeParams) and answers in plain words;
 * its Rebuild button runs the typed `/recipe tray` (a live action), which takes the saved file as its defaults.
 *
 * The result cards: one card per result the board knows (recipe jobs, observations, native runs, code-agent
 * runs, finished jobs), all with the same parts: what it is, its status in words, its values with how each
 * was obtained, its editable files (links), its receipts and the commands that act on it. A value is shown as
 * measured only when the board's own check verifies it now (a recipe's signed result and the copied exports'
 * sha256; round R4, H29: a recipe card is kept between polls while no file its checks read has changed, and then
 * says when they ran); an observation's values stay in its own card, under its provenance check. `renderResultCards` is
 * the hook for results built elsewhere (the /iterate flows): give it more cards in the same shape.
 *
 * Round R4 (H34): MCP calls (/mcp call and the agent's call_mcp_tool) are result cards too (mcpResults): the tool and
 * the server, the outcome in words, how long it took, the record and the raw output as files, and the answer's first
 * lines, read back from output.json; the record counts as sealed only when an mcp.call receipt of this project sealed
 * exactly its bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listAgentRuns, taskWords, AGENTS_DIR, type AgentRunRecord } from '../code-agents/index.js';
import { answerLines, hintWords, readMcpCalls, readRouteAnswer, serverSaid } from '../connectors/mcp-records.js';
import type { JobRecord } from '../jobs/index.js';
import { listNativeRuns, NATIVE_APPS, readNativeRecord, type NativeApp } from '../native/index.js';
import { resolveInside } from '../project/index.js';
import { checkCopyOf, deliverable, DOCTRINE_15, EXPORTS, failureFiles, isRecipeJobId, outcomeOf, outDir, PARAMETER_HELP, PARAMETER_NAMES, readCard, readRecipe, RECIPE_ID, type RecipeRead } from '../recipes/index.js';
import { checkParams, paramsPath, PARAMS_RECIPES, readParams, writeParams } from '../recipes/params-file.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { Receipt } from '../utils/receipts.js';
import { esc, stamp, type Kit } from './board-kit.js';
import type { EditAnswer, EditContext } from './board-nodes.js';
import type { BoardObservation } from './board.js';

const fmt =(n: number): string => String(Math.round(n * 1e6) / 1e6);

// ── the parameter card ───────────────────────────────────────────────────────

export interface ParamsCard {
  /** the short name /recipe uses */
  recipe: string;
  id: string;
  engine: string;
  /** recipes/<recipe>.params.json, relative to the project */
  path: string;
  file: { state: 'none' } | { state: 'ok'; sha256: string } | { state: 'unusable'; error: string; sha256?: string };
  /** what `/recipe tray` takes now: the file's values, or the card's defaults (also when the file is unusable) */
  values: Record<string, number>;
  defaults: Record<string, number>;
  fixed: Record<string, number>;
  units: string;
}

/** The tray recipe's parameter card for a project: its file, read and checked, or the recipe's defaults. */
export function paramsCard(root: string, recipe = 'tray'): ParamsCard {
  const card = readCard();
  const read = readParams(root, recipe);
  const file: ParamsCard['file'] = read.ok ? (read.exists ? { state: 'ok', sha256: read.sha256 } : { state: 'none' }) : { state: 'unusable', error: read.error, ...(read.sha256 ? { sha256: read.sha256 } : {}) };
  return {
    recipe, id: PARAMS_RECIPES[recipe] ?? RECIPE_ID, engine: card.engine, path: paramsPath(recipe), file,
    values: read.ok ? { ...read.parameters } : { ...card.parameters }, defaults: { ...card.parameters }, fixed: { ...card.fixed }, units: card.units,
  };
}

/** The base a save must still find: the file's sha256, or 'none' when there is no file. */
const baseOf = (p: ParamsCard): string => (p.file.state === 'none' ? 'none' : p.file.sha256 ?? 'unreadable');

export function renderParamsCard(p: ParamsCard, k: Kit): string {
  const state = p.file.state === 'ok'
    ? `<div class="status status-verified"><strong>saved</strong> ${esc(`${p.path} · sha256 ${p.file.sha256.slice(0, 12)} · /recipe ${p.recipe} takes it as its defaults; name=value words override it`)}</div>`
    : p.file.state === 'none'
      ? `<div class="status status-none"><strong>defaults</strong> ${esc(`no ${p.path} yet: these are the recipe's own defaults${k.live ? '; Save writes the file' : ''}`)}</div>`
      : `<div class="status status-unverified"><strong>not usable</strong> ${esc(`${p.path}: ${p.file.error}. /recipe ${p.recipe} refuses to start until it is fixed; shown below are the recipe's defaults${k.live ? '; Save writes a new file and keeps this one' : ''}`)}</div>`;
  const rows = PARAMETER_NAMES.map((name) => {
    const v = p.values[name];
    const value = k.live
      ? `<input type="number" step="any" inputmode="decimal" class="param-input" data-param="${esc(name)}" value="${esc(fmt(v))}" aria-label="${esc(`${name} in millimetres`)}"> <span class="unit">mm</span>`
      : `<span class="param-value">${esc(fmt(v))}</span> <span class="unit">mm</span>`;
    const differs = v !== p.defaults[name] ? ` (default ${fmt(p.defaults[name])})` : '';
    return `<tr><th scope="row">${esc(name)}</th><td>${value}</td><td class="help">${esc(`${PARAMETER_HELP[name]}${differs}`)}</td></tr>`;
  }).join('');
  const fixed = Object.entries(p.fixed).map(([n, v]) => `${n} ${fmt(v)}`).join(', ');
  const live = k.live
    ? `<div class="param-actions"><button type="button" class="act" data-params-save>Save parameters</button><button type="button" class="act quiet" data-params-discard>Discard</button>`
      + `${k.act('Rebuild', { act: 'rebuild', recipe: p.recipe })}</div><p class="params-msg" data-params-msg hidden></p>`
      + `<p class="meta">${esc(`Save checks the values with the recipe's own rules and keeps the previous file under .timmy/params-history/. Rebuild runs /recipe ${p.recipe} from the saved file, as a job you can stop.`)}</p>`
    : '';
  const data = k.live ? ` data-params="${esc(p.recipe)}" data-params-base="${esc(baseOf(p))}"` : '';
  return `<article class="card wide params"${data}><div class="jobhead"><span>${p.file.state === 'none' ? `<span class="name">${esc(p.path)}</span>` : k.fileLink(p.path)}</span> <span class="kind">parameters</span></div>`
    + `<div class="meta">${esc(`${p.id} (/recipe ${p.recipe}) · ${p.engine} · ${p.units}`)}</div>${state}`
    + `<table class="param-table"><thead><tr><th scope="col">parameter</th><th scope="col">value</th><th scope="col">meaning and range (mm)</th></tr></thead><tbody>${rows}</tbody></table>`
    + `<p class="meta">${esc(`fixed (mm): ${fixed}`)}</p>${live}`
    + `${k.cmds([`/recipe ${p.recipe}`, ...(p.file.state === 'none' ? [] : [`/open ${p.path}`]), '/recipe status'])}`
    + `<p class="notice">${esc(DOCTRINE_15)}</p></article>`;
}

const keysAre = (o: Record<string, unknown>, keys: string[]): boolean => {
  const have = Object.keys(o).sort();
  return have.length === keys.length && [...keys].sort().every((x, i) => have[i] === x);
};
const reply = (status: number, text: string, line = text): EditAnswer => ({ status, text, line });

/**
 * `set-params`: {"action":"set-params","recipe":"tray","base":"<sha256 of the file as shown>"|null,"parameters":{
 * "width":…, "wall":…, "supportOffset":…, "bore":…}}. Checked with the recipe's own rules; written by writeParams
 * (the previous file kept first, then replaced atomically) and sealed as an edit; or refused, with why.
 */
export function saveParams(body: Record<string, unknown>, ctx: EditContext): EditAnswer {
  if (!keysAre(body, ['action', 'recipe', 'base', 'parameters']) || typeof body.recipe !== 'string' || (body.base !== null && typeof body.base !== 'string')
    || !body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters)) {
    return reply(400, 'A parameter save is {"action":"set-params","recipe":"tray","base":"<sha256>"|null,"parameters":{…}}.');
  }
  const recipe = body.recipe;
  if (!ctx.recipes.includes(recipe) || !(recipe in PARAMS_RECIPES)) return reply(404, `No parameter card for ${recipe.slice(0, 40)} on this board.`);
  const given = body.parameters as Record<string, unknown>;
  if (!keysAre(given, [...PARAMETER_NAMES])) return reply(400, `The parameters are ${PARAMETER_NAMES.join(', ')}, each once.`);
  for (const [n, v] of Object.entries(given)) {
    if (!(typeof v === 'number' || (typeof v === 'string' && v.length <= 32))) return reply(400, `${n} is a number of millimetres.`);
  }
  const rel = paramsPath(recipe);
  const now = readParams(ctx.root, recipe);
  const nowSha = now.ok ? (now.exists ? now.sha256 : null) : now.sha256 ?? 'unreadable';
  if ((body.base ?? null) !== nowSha) {
    return reply(409, `${rel} changed since the board showed it (it is now ${nowSha === null ? 'not there' : nowSha === 'unreadable' ? 'unreadable' : `sha256 ${nowSha.slice(0, 12)}`}); nothing was written. Discard shows it as it is now.`, `refused a parameter save: ${rel} changed since the board showed it`);
  }
  // The previous file is kept under .timmy/params-history/: that place must stay inside the project.
  const keep = resolveInside(ctx.root, `.timmy/params-history/${recipe}/kept.json`);
  if ('error' in keep) return reply(403, `Refused: ${keep.error}; the previous file could not be kept safely. Nothing was written.`);
  const checked = checkParams(given);
  if (!checked.ok) return reply(422, `Refused: ${checked.error}. Nothing was written; ${rel} is as it was.`, `refused a parameter save: ${checked.error}`);
  const before = now.ok ? now.parameters : readCard().parameters;
  const words = PARAMETER_NAMES.map((n) => (before[n] !== checked.parameters[n] ? `${n} ${fmt(before[n])} → ${fmt(checked.parameters[n])}` : `${n} ${fmt(checked.parameters[n])}`)).join(', ');
  if (now.ok && now.exists) {
    const same = PARAMETER_NAMES.every((n) => now.parameters[n] === checked.parameters[n]);
    if (same) return reply(200, `No change: ${rel} already holds ${words} (sha256 ${now.sha256.slice(0, 12)}); nothing was written.`, `no change to ${rel}`);
  }
  const w = writeParams(ctx.root, given, recipe);
  if (!w.ok) return reply(500, `${rel} could not be written: ${w.error}. Nothing was changed.`);
  let receipt: string | undefined;
  try {
    receipt = ctx.seal?.({
      kind: 'edit', subject: `edit · ${rel} · parameters from the live board`, policy: 'human-gated', status: 'ok', project: ctx.project, project_id: ctx.projectId,
      files: [{ path: rel, sha256: w.sha256, ...(w.previous ? { previous_sha256: w.previous.sha256 } : {}), created: !w.previous, bytes: w.bytes }],
      ...(w.previous ? { sources: [{ path: w.previous.kept, sha256: w.previous.sha256, role: 'previous version' }] } : {}),
    });
  } catch { receipt = undefined; }
  const kept = w.previous ? `the previous version is kept at ${w.previous.kept}${!now.ok ? ' (it was not usable)' : ''}` : 'a new file (there was none before)';
  return reply(200,
    `Saved ${rel}: ${words} (mm). sha256 ${w.sha256.slice(0, 12)}; ${kept}${receipt ? `; receipt ${receipt}` : '; no receipt was sealed'}. /recipe ${recipe} and Rebuild take these values.`,
    `saved ${rel}: ${words}${receipt ? ` · receipt ${receipt}` : ''}`);
}

// ── result cards ─────────────────────────────────────────────────────────────

export interface ResultCard {
  /** what kind of result: recipe, observation, native, agent, job, or another source's (a flow) */
  kind: string;
  title: string;
  /** when it happened (ISO), for ordering and display */
  at?: string;
  /** the outcome in words; the tone only colours it, never stands for it */
  status: { word: string; tone: 'ok' | 'failed' | 'running' | 'attention' | 'neutral'; detail?: string };
  lines?: string[];
  /** values, each with how it was obtained, in words */
  facts?: Array<{ label: string; value: string; how: string }>;
  /** files in the project, as links */
  files?: Array<{ rel: string; note?: string }>;
  receipts?: Array<{ id: string; what?: string }>;
  commands?: string[];
  /** a sentence shown verbatim (DOCTRINE §15 on a recipe's measured values) */
  notice?: string;
}

/** A path relative to the project with no climbing and nothing absolute, or null. */
const inProject = (p: unknown): string | null => {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
};

/**
 * The hook for result cards: any list in the ResultCard shape, drawn the board's way (the /iterate flows can
 * pass theirs here). Every string is escaped; files are links on the snapshot and text on the live board.
 */
export function renderResultCards(cards: ResultCard[], k: Kit): string {
  return `<div class="grid wide">${cards.map((c) => {
    const status = `<div class="rstatus rstatus-${c.status.tone}"><strong>${esc(c.status.word)}</strong>${c.status.detail ? ` ${esc(c.status.detail)}` : ''}</div>`;
    const lines = (c.lines ?? []).map((l) => `<div class="meta">${esc(l)}</div>`).join('');
    const facts = c.facts?.length ? `<dl class="facts">${c.facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)} <span class="tier">${esc(f.how)}</span></dd>`).join('')}</dl>` : '';
    const files = c.files?.length ? `<ul class="rfiles">${c.files.map((f) => `<li>${k.fileLink(f.rel, 'file')}${f.note ? ` <span class="tier">${esc(f.note)}</span>` : ''}</li>`).join('')}</ul>` : '';
    const receipts = c.receipts?.length ? `<div class="meta">${esc(c.receipts.map((r) => `receipt ${r.id}${r.what ? ` (${r.what})` : ''}`).join(' · '))}</div>` : '';
    return `<article class="card result result-${esc(c.kind.replace(/[^a-z-]/gi, ''))}"><div class="jobhead"><strong class="label">${esc(c.title)}</strong> <span class="kind">${esc(c.kind)}</span></div>`
      + `<div class="meta">${esc(stamp(c.at))}</div>${status}${lines}${facts}${files}${receipts}`
      + `${c.notice ? `<p class="notice">${esc(c.notice)}</p>` : ''}${k.cmds(c.commands ?? [])}</article>`;
  }).join('')}</div>`;
}

const mm = (b: number[]): string => b.map(fmt).join(' x ');
const mm3 = (n: number): string => (Math.round(n * 1000) / 1000).toLocaleString('en-US');
const shortId = (r: { hash?: unknown; id?: unknown }): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));

/**
 * The project's newest recipe jobs (by job file time), each read through the recipe's own status().
 *
 * Round R4 (H29): the live board asks for this every 2 seconds per open page, and a card's checks hash every export
 * several times (measured: 35 ms a poll with 4 MB of exports, 118 ms with 20 MB, all of it on the REPL's thread).
 * So a card is kept with the fingerprint of everything its checks read (inputsPrint) and reused while that
 * fingerprint is unchanged; any change, and the card is checked afresh, as before.
 */
export function recipeResults(root: string, max = 4): ResultCard[] {
  const dir = path.join(root, '.timmy', 'recipe-jobs');
  let ids: string[] = [];
  try { ids = fs.readdirSync(dir).filter(isRecipeJobId); } catch { return []; }
  const timed = ids.map((id) => { let t = 0; try { t = fs.statSync(path.join(dir, id, 'job.json')).mtimeMs; } catch { /* unreadable: last */ } return { id, t }; });
  return timed.sort((a, b) => b.t - a.t).slice(0, max).map(({ id, t }) => {
    const key = `${root}\0${id}`;
    // taken before the checks: a change during them leaves a fingerprint the next poll does not match
    const print = inputsPrint(root, id);
    const kept = keptCards.get(key);
    if (kept && kept.print === print.text) return shownAgain(kept);
    const at = Date.now();
    const card = recipeCard(root, id, t);
    keptCards.delete(key);
    if (print.settled) {
      keptCards.set(key, { print: print.text, card: structuredClone(card), at });
      if (keptCards.size > CARDS_KEPT) keptCards.delete(keptCards.keys().next().value!);
    }
    return card;
  });
}

/** How long every time in a fingerprint must be in the past before a card is kept: longer than the coarsest file
 *  time resolution (1 to 2 s), so a change within the same tick as the check cannot look like no change. */
const SETTLE_MS = 2000;
const CARDS_KEPT = 64;
const keptCards = new Map<string, { print: string; card: ResultCard; at: number }>();
const VERIFIED_NOW = 'its signed result verified now, and every copied file matches its sha256';

/** A kept card shown again: its checks did not run now, so a success says when they ran. */
function shownAgain(kept: { card: ResultCard; at: number }): ResultCard {
  const card = structuredClone(kept.card);
  if (card.status.detail === VERIFIED_NOW) card.status.detail = `its signed result and every copied file's sha256 were verified at ${stamp(kept.at)}; no file those checks read has changed since`;
  return card;
}

/**
 * The fingerprint of everything a recipe card's checks read: the project folder's real path; the type, device,
 * inode, size, mtime and ctime (nanoseconds where the file system has them) of .timmy, .timmy/recipe-jobs, every file
 * and folder under the job's folder (a link: its own and its target's; the checks refuse links, but some ask whether
 * one exists), and the copied files the copy check reads in out/recipes/<uuid8>/ (through links, as it reads them).
 * `settled`: every time in it was at least SETTLE_MS before now. A ctime cannot be set back, so a file rewritten with
 * the same size and its old mtime restored still changes the fingerprint.
 */
function inputsPrint(root: string, id: string): { text: string; settled: boolean } {
  const lines: string[] = [];
  const now = Date.now();
  let settled = true;
  const stat = (p: string, follow: boolean): fs.BigIntStats | string => {
    try { return follow ? fs.statSync(p, { bigint: true }) : fs.lstatSync(p, { bigint: true }); } catch (e) { return `!${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`; }
  };
  const note = (p: string, follow: boolean): fs.BigIntStats | string => {
    const s = stat(p, follow);
    if (typeof s === 'string') { lines.push(`${p} ${follow ? '=>' : '->'} ${s}`); return s; }
    if (Number(s.mtimeMs > s.ctimeMs ? s.mtimeMs : s.ctimeMs) > now - SETTLE_MS) settled = false;
    lines.push(`${p} ${follow ? '=>' : '->'} ${s.mode}:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`);
    return s;
  };
  const walk = (p: string): void => {
    const s = note(p, false);
    if (typeof s === 'string') return;
    if (s.isSymbolicLink()) { note(p, true); return; }
    if (!s.isDirectory()) return;
    let names: string[];
    try { names = fs.readdirSync(p).sort(); } catch (e) { lines.push(`${p} ls ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`); return; }
    for (const name of names) walk(path.join(p, name));
  };
  try { lines.push(`root ${fs.realpathSync(root)}`); } catch (e) { lines.push(`root !${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`); }
  for (const p of [path.join(root, '.timmy'), path.join(root, '.timmy', 'recipe-jobs')]) {
    const s = note(p, false);
    if (typeof s !== 'string' && s.isSymbolicLink()) note(p, true);
  }
  walk(path.join(root, '.timmy', 'recipe-jobs', id));
  for (const name of [...EXPORTS, 'report.json', 'request.json', 'prediction.json']) note(path.join(root, outDir(id), name), true);
  return { text: lines.join('\n'), settled };
}

/** One recipe job's card, checked afresh from one verified read (R4, H29: no second verification for the copy check):
 *  its status and, when it succeeded, its copy in the project. */
function recipeCard(root: string, id: string, t: number): ResultCard {
  const title = `recipe ${RECIPE_ID} · ${id.slice(0, 8)}`;
  let read: RecipeRead;
  try { read = readRecipe(root, id); } catch (e) {
    return { kind: 'recipe', title, at: new Date(t).toISOString(), status: { word: 'unreadable', tone: 'failed', detail: e instanceof Error ? e.message : String(e) }, commands: ['/recipe status'] } satisfies ResultCard;
  }
  const s = read.s;
  const base: ResultCard = {
    kind: 'recipe', title, at: new Date(s.job.created).toISOString(), status: { word: s.state, tone: 'neutral' },
    lines: [`job ${id} · request ${s.job.requestHash.slice(0, 12)} · source ${s.job.sourceHash.slice(0, 12)}`], commands: ['/recipe status'],
  };
  if (s.state === 'succeeded') {
    const got = deliverable(id, read);
    const copy = got.ok ? checkCopyOf(root, got.v) : got;
    if (!copy.ok) return { ...base, status: { word: 'succeeded', tone: 'attention', detail: `but its exports are not verified in the project: ${copy.error}` }, commands: [`/recipe copy ${id}`, '/recipe status'] };
    const o = outcomeOf(copy.v);
    const facts: NonNullable<ResultCard['facts']> = [];
    if (o.checks) facts.push({ label: 'geometry checks', value: `${o.checks.passed} of ${o.checks.total} passed`, how: "the recipe's gate, from its signed result" });
    if (o.measured) facts.push({ label: 'bounds', value: `${mm(o.measured.bounds)} mm`, how: `measured on the generated CAD${o.predicted ? `; ${mm(o.predicted.bounds)} mm in the sealed prediction` : ''}` });
    if (o.measured) facts.push({ label: 'volume', value: `${mm3(o.measured.volume)} mm3`, how: `measured on the generated CAD${o.predicted ? `; ${mm3(o.predicted.volume)} mm3 predicted` : ''}` });
    if (o.step) facts.push({ label: 'STEP reimport', value: `${o.step.passed} of ${o.step.total} checks passed`, how: 'from its signed result' });
    if (o.mesh) facts.push({ label: 'mesh checks', value: `${o.mesh.passed} of ${o.mesh.total} passed`, how: `independent (${o.engines.join(', ') || 'engine not recorded'})` });
    return {
      ...base, status: { word: 'succeeded', tone: 'ok', detail: VERIFIED_NOW }, facts,
      files: copy.v.files.map((f) => ({ rel: `${copy.dir}/${f.name}`, note: f.name.endsWith('.json') ? 'record' : 'export' })),
      receipts: [{ id: copy.v.resultReceipt, what: 'result' }], notice: DOCTRINE_15,
    };
  }
  const failed = s.state === 'failed' || s.state === 'interrupted';
  const kept = failed || s.state === 'cancelled' ? failureFiles(root, id) : [];
  return {
    ...base, status: { word: s.state, tone: failed ? 'failed' : s.state === 'cancelled' ? 'neutral' : 'running', detail: `${s.progress}${s.reason ? `: ${s.reason}` : ''}` },
    ...(kept.length ? { files: kept.map((rel) => ({ rel, note: 'kept' })) } : {}),
    commands: s.state === 'interrupted' ? [`/recipe recover ${id}`, '/recipe status'] : ['/recipe status'],
  };
}

/** The project's newest native runs (Cinema 4D, Blender, After Effects), judged by their own result files. */
export function nativeResults(root: string, chain: readonly Receipt[], scrub: (t: string) => string, max = 4): { cards: ResultCard[]; jobs: Set<string> } {
  // The jobs a native card stands for: every sealed native run's job, and the shown runs' own start notes.
  const jobs = new Set<string>(chain.flatMap((x) => (x.kind === 'native' && x.job?.id ? [x.job.id] : [])));
  const runs = listNativeRuns(root);
  const cards = runs.slice(0, max).map((r): ResultCard => {
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(root, r.run); } catch { rec = undefined; }
    if (rec?.started) jobs.add(rec.started.job);
    const app = NATIVE_APPS[r.app as NativeApp]?.name ?? r.app;
    const last = r.verdicts.at(-1);
    const sealed = [...chain].reverse().find((x) => x.kind === 'native' && x.native?.run === r.run);
    const status: ResultCard['status'] = !last
      ? { word: rec?.started ? 'not judged yet' : 'submitted', tone: 'running', detail: rec?.started ? `job ${rec.started.job} started it; it is judged by its result file when it ends` : 'it has not started' }
      : { word: last.outcome, tone: last.outcome === 'ok' ? 'ok' : last.outcome === 'failed' ? 'failed' : 'attention', detail: `judged by its result file: ${scrub(last.why)}` };
    const files = (last?.files ?? []).flatMap((f) => {
      const rel = inProject(f.path);
      if (!rel || f.outside || !f.present) return [];
      return [{ rel, note: f.written ? 'written by this run' : f.matches === false ? 'differs from what its result recorded' : 'not written by this run' }];
    }).slice(0, 8);
    return {
      kind: 'native', title: `${app} · ${scrub(rec?.job.label ?? r.run.slice(0, 8))}`, at: r.started_at, status,
      lines: [`run ${r.run.slice(0, 8)}${rec?.started ? ` · job ${rec.started.job}` : ''}${last ? ` · exit ${last.exit.code ?? last.exit.signal ?? last.exit.state}` : ''} (the exit is recorded, not decisive)`],
      ...(files.length ? { files } : {}),
      ...(sealed ? { receipts: [{ id: shortId(sealed), what: 'native' }] } : {}),
      ...(rec?.started ? { commands: [`/jobs ${rec.started.job}`] } : {}),
    };
  });
  return { cards, jobs };
}

/** The project's newest code-agent runs: how each ended, what it changed, and its cost as reported. */
export function agentResults(root: string, scrub: (t: string) => string, max = 4): { cards: ResultCard[]; jobs: Set<string> } {
  let runs: AgentRunRecord[] = [];
  try { runs = listAgentRuns(root); } catch { runs = []; }
  const jobs = new Set(runs.map((r) => r.job).filter(Boolean));
  const cards = runs.slice(0, max).map((r): ResultCard => {
    const f = r.files;
    const tone: ResultCard['status']['tone'] = r.outcome === 'completed' ? 'ok' : r.outcome === 'failed' || r.outcome === 'timed out' ? 'failed' : r.outcome === 'cancelled' ? 'neutral' : 'attention';
    const cost = r.cost_usd === undefined ? undefined : r.cost_usd === null ? 'cost unknown: the agent reported none' : `cost $${r.cost_usd.toFixed(4)} (${r.cost_basis ?? 'as reported'})`;
    const changed = f ? [...f.added.map((c) => ({ rel: inProject(c.path), note: 'added' })), ...f.changed.map((c) => ({ rel: inProject(c.path), note: 'changed' }))]
      .flatMap((x) => (x.rel ? [{ rel: x.rel, note: x.note }] : [])).slice(0, 8) : [];
    return {
      kind: 'agent', title: `agent ${r.agent} · ${r.run}`, at: r.ended_at ?? r.started_at,
      status: r.outcome ? { word: r.outcome, tone, ...(r.why ? { detail: scrub(r.why) } : {}) } : { word: 'not finished here', tone: 'attention', detail: 'no result was written (its REPL ended first, or it is still running)' },
      lines: [taskWords(r.task, root, 120), `${r.model ?? 'its default model'} · ${r.endpoint === 'local' ? `local endpoint ${r.where}` : r.where}${cost ? ` · ${cost}` : ''}`,
        ...(f ? [`${f.added.length} added, ${f.changed.length} changed, ${f.deleted.length} deleted${f.truncated ? ' (not every file was compared)' : ''}`] : [])],
      files: [...changed, { rel: `${AGENTS_DIR}/${r.run}/${r.outcome ? 'result.json' : 'run.json'}`, note: 'its record' }],
      ...(r.receipt ? { receipts: [{ id: r.receipt, what: 'agent' }] } : {}),
      commands: ['/agent last'],
    };
  });
  return { cards, jobs };
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Finished jobs that no other card stands for (workflow runs, previews, tasks), with what their receipt sealed. */
export function jobResults(jobs: readonly JobRecord[], chain: readonly Receipt[], skip: ReadonlySet<string>, scrub: (t: string, root: string) => string, max = 6): ResultCard[] {
  return jobs.filter((j) => TERMINAL.has(j.state) && !skip.has(j.id) && !/^(look|recipe|agent) /.test(j.label)).slice(0, max).map((j): ResultCard => {
    const rec = [...chain].reverse().find((r) => r.job?.id === j.id);
    const steps = j.steps.length ? `${j.steps.filter((s) => s.state === 'completed').length} of ${j.steps.length} steps completed` : '';
    const met = rec?.prediction?.met;
    const tone: ResultCard['status']['tone'] = j.state === 'completed' ? 'ok' : j.state === 'failed' ? 'failed' : 'neutral';
    const files = (rec?.outputs ?? []).flatMap((o) => { const rel = inProject(o.path); return rel ? [{ rel, note: fs.existsSync(path.join(j.root, rel)) ? 'written during the job' : 'not there now' }] : []; }).slice(0, 8);
    return {
      kind: 'job', title: `${j.id} · ${scrub(j.label, j.root)}`, at: j.endedAt ?? j.startedAt,
      status: { word: j.state === 'cancelled' ? 'stopped' : j.state, tone, ...(j.error ? { detail: scrub(j.error, j.root) } : j.state === 'failed' && j.exitCode !== undefined ? { detail: `exit ${j.exitCode ?? j.signal ?? '?'}` } : {}) },
      lines: [[j.kind, steps, met === undefined ? '' : met ? 'its sealed prediction was met' : 'its sealed prediction was missed'].filter(Boolean).join(' · ')],
      ...(files.length ? { files } : {}),
      ...(j.receipt ? { receipts: [{ id: j.receipt, what: rec?.kind ?? 'job' }] } : {}),
      commands: [`/jobs ${j.id}`],
    };
  });
}

/** An observation as a result card: its provenance status in words and its files; its values stay in its own card. */
export function observationResults(observations: readonly BoardObservation[], max = 6): ResultCard[] {
  return observations.slice(0, max).map((o): ResultCard => {
    const c = o.check ?? { status: 'unverified' as const, reasons: ['its provenance was not checked'] };
    const n = o.measurements.length;
    const claim = o.qualified ? (o.qualified.status === 'admitted' ? "a model's cited answer (a claim)" : 'no admitted model answer')
      : o.interpretation?.status === 'answered' ? "a model's claim" : '';
    return {
      kind: 'observation', title: o.source?.path ?? '(an image outside the project)', ...(o.madeAt ? { at: o.madeAt } : {}),
      status: c.status === 'verified'
        ? { word: 'verified', tone: 'ok', detail: `an observe receipt sealed this file and its image is unchanged; ${n} value${n === 1 ? '' : 's'}${claim ? ` and ${claim}` : ''} in its card under Observations` }
        : { word: c.status, tone: 'attention', detail: `${c.reasons[0] ?? 'no reason was given'}; its values are shown as recorded, not as measured, under Observations` },
      files: [...(o.source?.path ? [{ rel: o.source.path, note: 'the image' }] : []), { rel: o.file, note: 'the observation' }],
      ...(c.status === 'verified' && c.receipt ? { receipts: [{ id: c.receipt, what: 'observe' }] } : {}),
      ...(o.job ? { lines: [`job ${o.job}`] } : {}),
    };
  });
}

/** How many of an MCP answer's first lines a card shows, and how long each may be. */
const MCP_CARD_LINES = 6;
const MCP_CARD_WIDTH = 200;

/**
 * R4 (H34): the project's newest MCP calls (.timmy/mcp/<call-id>/), each as a result card. Every string goes through
 * `scrub` (the project's folder as ".", the home folder as "~") and is escaped when drawn; a line's leading spaces
 * become non-breaking ones, so pretty-printed JSON keeps its indent on the page.
 */
export function mcpResults(root: string, chain: readonly Receipt[], scrub: (t: string) => string, max = 6): ResultCard[] {
  let read: ReturnType<typeof readMcpCalls>;
  try { read = readMcpCalls(root, chain, max); } catch { return []; }
  const keepIndent = (l: string): string => l.replace(/^ +/, (m) => '\u00a0'.repeat(m.length));
  const cut = (l: string): string => (l.length > MCP_CARD_WIDTH ? `${l.slice(0, MCP_CARD_WIDTH - 1)}…` : l);
  return read.list.map((c): ResultCard => {
    const r = c.record;
    const tone: ResultCard['status']['tone'] = r.outcome === 'answered' ? 'ok' : r.outcome === 'needs authorization' ? 'attention' : 'failed';
    const why = r.isError === true ? 'the server answered with its own error (isError)' : r.outcome !== 'answered' && typeof r.error === 'string' ? scrub(r.error).slice(0, 300) : '';
    const sealed = c.check.status === 'verified' ? `its record was sealed by receipt ${c.check.receipt}` : `its record is not verified: ${c.check.reason}`;
    const lines = [scrub(`via ${r.route} · ${r.transport}${r.url ? ` ${r.url}` : ''} · ${r.ms} ms · ${r.output_bytes} bytes${r.truncated ? ' (output.json keeps the first 32 KB)' : ''}`)];
    const hints = hintWords(r.annotations);
    if (hints) lines.push(`the server's hints: ${hints} (its claim)`);
    // The answer's first lines, as output.json holds them now; an answer that was not shown when it came is not shown here.
    if (c.outputText !== undefined && (r.outcome === 'answered' || r.isError === true)) {
      const a = readRouteAnswer(c.outputText, r.route);
      const body = (r.isError === true ? serverSaid(a, r.route) : answerLines(a, r.route).lines).filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1));
      lines.push(r.isError === true ? 'the server said:' : 'the answer begins:', ...body.slice(0, MCP_CARD_LINES).map((l) => keepIndent(cut(scrub(l)))));
      if (body.length > MCP_CARD_LINES) lines.push(`… ${body.length - MCP_CARD_LINES} more line${body.length - MCP_CARD_LINES === 1 ? '' : 's'} in output.json`);
    }
    // The record's own notes on what the route could not pass on (MCPorter's JSON output, an isError told by its exit).
    for (const n of (Array.isArray(r.notes) ? r.notes : []).slice(0, 3)) lines.push(`note: ${scrub(String(n)).slice(0, 300)}`);
    if (c.outputCheck === 'differs') lines.push('output.json is not what the record sealed (its sha256 differs)');
    if (c.outputCheck === 'missing') lines.push('output.json is missing or unreadable');
    return {
      kind: 'mcp', title: scrub(`${r.tool} on ${r.server}`), at: r.started_at,
      status: { word: r.outcome, tone, detail: [why, sealed].filter(Boolean).join('; ') },
      lines,
      files: [{ rel: c.call, note: 'the record' }, ...(c.output ? [{ rel: c.output, note: 'the raw output' }] : [])],
      ...(c.check.status === 'verified' ? { receipts: [{ id: c.check.receipt, what: 'mcp.call' }] } : {}),
      commands: [`/open ${c.output ?? c.call}`],
    };
  });
}

/**
 * Every result the board knows, newest first, at most `max`, with how many more there are. `extra` takes cards
 * built elsewhere (the /iterate flows) in the same shape.
 */
export function gatherResults(o: {
  root: string; jobs: readonly JobRecord[]; chain: readonly Receipt[]; observations: readonly BoardObservation[];
  scrub: (t: string, root: string) => string; extra?: readonly ResultCard[]; max?: number;
}): { cards: ResultCard[]; more: number } {
  const scrub = (t: string): string => o.scrub(t, o.root);
  const natives = nativeResults(o.root, o.chain, scrub);
  const agents = agentResults(o.root, scrub);
  const all = [
    ...recipeResults(o.root), ...natives.cards, ...agents.cards,
    ...jobResults(o.jobs, o.chain, new Set([...natives.jobs, ...agents.jobs]), o.scrub),
    ...observationResults(o.observations), ...mcpResults(o.root, o.chain, scrub), ...(o.extra ?? []),
  ];
  const time = (c: ResultCard): number => { const t = c.at ? Date.parse(c.at) : Number.NaN; return Number.isNaN(t) ? 0 : t; };
  all.sort((a, b) => time(b) - time(a));
  const max = o.max ?? 12;
  return { cards: all.slice(0, max), more: Math.max(0, all.length - max) };
}

// ── the look ─────────────────────────────────────────────────────────────────

export const CARDS_CSS = `
.param-table { border-collapse: collapse; width: 100%; font-size: ${TYPE.size.small}px; }
.param-table th, .param-table td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid ${HOMEBREW.line}; vertical-align: middle; }
.param-table thead th { color: ${HOMEBREW.textSecondary}; font-weight: ${TYPE.weight.body}; text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
.param-table tbody th { font-weight: ${TYPE.weight.strong}; white-space: nowrap; }
.param-table .help { color: ${HOMEBREW.textSecondary}; }
.param-value { font-weight: ${TYPE.weight.strong}; }
.unit { color: ${HOMEBREW.textSecondary}; }
.param-input { font: inherit; width: 7.5em; color: ${HOMEBREW.text}; background: ${HOMEBREW.ground}; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 4px; padding: 2px 6px; }
.param-input:focus-visible { outline: 2px solid ${HOMEBREW.accent}; outline-offset: 1px; }
.param-actions, .wf-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.params-msg, .wf-msg { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: ${TYPE.size.small}px; }
.params-msg.bad, .wf-msg.bad { color: ${HOMEBREW.failure}; }
.notice { margin: 0; font-size: ${TYPE.size.small}px; font-weight: ${TYPE.weight.strong}; overflow-wrap: anywhere; }
.status-none strong { color: ${HOMEBREW.textSecondary}; }
.rstatus { font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.rstatus strong { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; margin-right: 6px; }
.rstatus-ok strong { color: ${HOMEBREW.accent}; }
.rstatus-failed strong { color: ${HOMEBREW.failure}; }
.rstatus-running strong, .rstatus-attention strong { color: ${HOMEBREW.attention}; }
.rstatus-neutral strong { color: ${HOMEBREW.text}; }
.rfiles { margin: 0; padding-left: 18px; font-size: ${TYPE.size.small}px; }
.rfiles li { overflow-wrap: anywhere; }
dl.facts { margin: 0; }
`;
