/**
 * Round R4 (H102): `timmy op <operation id> [--json | --summary] [--save] [--project <dir>]`: one operation's run detail
 * (src/contracts/run-detail.ts), made by src/ops/run-detail.ts from the project's own records; the same object the terminal
 * Workbench, the companion and Timmy Studio render.
 *
 *   plain words (default)  each part of the run detail on its own line, with the record it came from
 *   --json                 the run detail itself ({ schema: timmy.run-detail/1, ...RunDetail })
 *   --summary              the executive summary in Markdown, made from the run detail alone (no model is asked); upmd reads it
 *   --save                 keeps that summary beside the operation's record (.timmy/operations/<id>/summary.md), never over a
 *                          file already there
 *
 * The project is the current folder (as `timmy act` and `timmy evidence` take it), or --project <dir|name>. The id is given,
 * else TIMMY_OPERATION (a /run's block has it). It refuses, with why: an id that is not one (exit 2), an operation this project
 * has no record of, another project's operation (it says whose, and how to ask there), or a record that cannot be read (named);
 * those exit 1. Nothing here runs, seals or changes a record; --save writes only the one new summary file.
 */
import fs from 'node:fs';
import { chooseProject } from '../project/index.js';
import { OPERATION_ENV, OPERATION_ID } from './context.js';
import { JOB_CANCELLED, TURN_STOPPED } from '../contracts/stop-words.js';
import {
  readRunDetail, RUN_DETAIL_SCHEMA, runDetailJson, runRecipe, runSummaryMarkdown, stopKind, summaryRel, writeRunSummary,
  type RunDetail, type RunDetailResult,
} from './run-detail.js';

export const OP_USAGE = 'timmy op <operation id> [--json | --summary] [--save] [--project <dir>]';

export interface OpArgs { id?: string; json: boolean; summary: boolean; save: boolean; project?: string; help?: boolean }

export function parseOpArgs(argv: string[], o: { json?: boolean } = {}): OpArgs | { error: string } {
  const a: OpArgs = { json: o.json === true, summary: false, save: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === '-h' || w === '--help') { a.help = true; continue; }
    if (w === '--json') { a.json = true; continue; }
    if (w === '--summary') { a.summary = true; continue; }
    if (w === '--save') { a.save = true; continue; }
    const eq = /^--project=(.*)$/.exec(w);
    if (w === '--project' || eq) {
      const v = eq ? eq[1] : argv[++i];
      if (v === undefined || v === '') return { error: `--project needs a folder. Usage: ${OP_USAGE}` };
      a.project = v;
      continue;
    }
    if (/^-/.test(w)) return { error: `No option ${w}. Usage: ${OP_USAGE}` };
    words.push(w);
  }
  if (a.help) return a;
  if (words.length > 1) return { error: `One operation at a time (it was given ${words.join(' ')}). Usage: ${OP_USAGE}` };
  if (a.json && a.summary) return { error: `--json prints the run detail and --summary its Markdown summary: one of them. Usage: ${OP_USAGE}` };
  if (words[0] !== undefined) a.id = words[0];
  return a;
}

export function opHelp(): string {
  return [
    `Usage: ${OP_USAGE}`,
    '',
    'timmy op: one operation\'s run detail, from the project\'s own records: its request, Timmy\'s verdict, the stage (steps',
    'done of total), each process\'s own exit, the freshness of what it made, a person\'s acceptance, the prediction frozen',
    'before it ran beside each check, its files, worker, time, cost, receipts and one next action; each with the record it',
    'came from, and what no record says listed as not recorded.',
    '',
    '  <operation id>    o and 8 hex digits (/ops lists them); default: TIMMY_OPERATION, as a /run\'s block has it',
    '  --json            the run detail as JSON (schema timmy.run-detail/1; the shape: src/contracts/run-detail.ts)',
    '  --summary         its executive summary in Markdown, made from the run detail alone (no model is asked)',
    `  --save            keep that summary beside its record (${summaryRel('<id>')}); never over a file already there`,
    '  --project <dir>   the project folder or a project\'s name (default: the current folder)',
    '',
    'Exit codes: 0 shown (and saved, with --save); 1 refused: no such operation here, another project\'s, a record that',
    'cannot be read, or a summary already kept; 2 usage.',
    '',
  ].join('\n');
}

const stageWords = (s: RunDetail['stage']): string =>
  `${s.total === null ? `${s.done} step${s.done === 1 ? '' : 's'} ended (the planned count is not recorded)` : `${s.done} of ${s.total} steps ended`}${s.current ? `; now ${s.current}` : ''}`;

const durWords = (ms: number | null): string => (ms === null ? 'unknown' : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/**
 * R6 (H140; the R5 interaction review, claim e: `timmy op` said "cancelled" for an operation whose chat turn was stopped): the
 * verdict's word in the one table's words (src/contracts/stop-words.ts). The run detail's verdict "cancelled" covers any stop;
 * an operation whose receipts are a chat turn's (and no job's) was stopped, one whose job a cancel ended, cancelled.
 */
export function verdictWord(d: Pick<RunDetail, 'verdict' | 'receipts' | 'exits'>): string {
  const kind = stopKind(d);
  return kind === null ? d.verdict.state : kind === 'turn' ? TURN_STOPPED : JOB_CANCELLED;
}

/** The run detail in plain words, one part a line, each with the record it came from (in brackets). */
export function runDetailWords(d: RunDetail): string {
  const L: string[] = [];
  const W = 11;
  const at = (from?: string): string => (from ? `  [${from}]` : '');
  const row = (label: string, value: string, from?: string): void => { L.push(`  ${label.padEnd(W)} ${value}${at(from)}`); };
  const rows = (label: string, items: Array<{ value: string; from?: string }>, none: string): void => {
    if (!items.length) { row(label, none); return; }
    items.forEach((x, i) => row(i === 0 ? label : '', x.value, x.from));
  };
  L.push(`operation ${d.operation} · ${d.project.name} · ${verdictWord(d)}`);
  row('request', d.objective ? d.objective.value : 'not recorded', d.objective?.from);
  row('project', `${d.project.name} (project id ${d.project.id})`);
  if (d.parent || d.children.length) {
    row('chain', [d.parent ? `continues ${d.parent}` : '', d.children.length ? `continued by ${d.children.join(', ')}` : ''].filter(Boolean).join('; '));
  }
  if (d.sourceRevision) row('source', d.sourceRevision.value, d.sourceRevision.from);
  row('verdict', d.verdict.words, d.verdict.from);
  row('stage', stageWords(d.stage), d.stage.from);
  rows('exits', d.exits.map((e) => ({ value: `${e.who}: ${e.code === null ? 'no exit code' : `exit ${e.code}`}${e.state ? ` (${e.state})` : ''}`, from: e.from })), 'none recorded');
  row('freshness', `${d.freshness.state}: ${d.freshness.why}`, d.freshness.from);
  row('acceptance', `${d.acceptance.state}${d.acceptance.by ? ` by ${d.acceptance.by}` : ''}${d.acceptance.at ? ` at ${d.acceptance.at}` : ''}`, d.acceptance.from);
  row('predicted', d.prediction ? `${d.prediction.words} (frozen ${d.prediction.frozenAt ?? 'at an unrecorded time'}, before the run)` : 'nothing was predicted before it ran',
    d.prediction ? `receipt ${d.prediction.receipt}` : undefined);
  rows('checks', d.checks.map((c) => ({
    value: `${c.name}: predicted ${c.predicted ?? 'nothing'}, actual ${c.actual}${c.differs === true ? ': DIFFERS' : c.differs === null ? ' (whether it differs is not known)' : ''}`, from: c.from,
  })), 'no check of it is recorded');
  rows('files', d.files.map((x) => ({ value: `${x.role.padEnd(9)} ${x.path}${x.sha256 ? ` sha256:${x.sha256.slice(0, 12)}` : ''}`, from: x.from })), 'no file of it is recorded');
  const worker: Array<{ value: string; from?: string }> = [];
  if (d.worker.model) worker.push({ value: `model ${d.worker.model.value}`, from: d.worker.model.from });
  if (d.worker.harness) worker.push({ value: `harness ${d.worker.harness.value}`, from: d.worker.harness.from });
  if (d.worker.environment) worker.push({ value: `environment ${d.worker.environment.value}`, from: d.worker.environment.from });
  rows('worker', worker, 'not recorded');
  row('time', `started ${d.time.startedAt ?? 'unknown'} · ${d.time.endedAt ? `ended ${d.time.endedAt} · took` : d.verdict.state === 'running' || d.verdict.state === 'queued' ? 'not ended · elapsed' : 'its end is not recorded · elapsed'} ${durWords(d.time.elapsedMs)}`);
  row('cost', d.cost.measured ? `$${d.cost.usd.toFixed(4)} as reported` : `unknown: ${d.cost.why}`, d.cost.measured ? d.cost.from : undefined);
  row('receipts', d.receipts.length ? d.receipts.map((r) => `${r.id} ${r.kind}`).join(', ') : 'no receipt names it');
  row('summary', d.summary.path ?? `none kept (timmy op ${d.operation} --summary --save keeps one)`);
  row('next', d.next ? `${d.next.words}${d.next.command ? ` → ${d.next.command}` : ''}` : 'nothing to do');
  rows('not known', d.unknown.map((u) => ({ value: `${u.field}: ${u.why}` })), 'nothing');
  return `${L.join('\n')}\n`;
}

/** `timmy op …`: its exit code (the CLI exits with it). */
export async function opMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  const parsed = parseOpArgs(argv, o);
  const json = o.json === true || argv.includes('--json');
  const refuse = (code: 1 | 2, operation: string | null, refusal: string, why: string, extra: Record<string, unknown> = {}): number => {
    process.stderr.write(`${code === 2 ? why : `  timmy op: ${refusal}: ${why}`}\n`);
    if (json) process.stdout.write(`${JSON.stringify({ schema: RUN_DETAIL_SCHEMA, operation, ok: false, refusal, why, ...extra, exit_code: code })}\n`);
    return code;
  };
  if ('error' in parsed) return refuse(2, null, 'usage', parsed.error);
  if (parsed.help) { process.stdout.write(opHelp()); return 0; }

  let root = process.cwd();
  if (parsed.project !== undefined) {
    const chosen = chooseProject(parsed.project);
    if ('error' in chosen) return refuse(2, null, 'usage', `--project ${parsed.project}: ${chosen.error}. Usage: ${OP_USAGE}`);
    root = chosen.root;
  }
  try { root = fs.realpathSync(root); } catch { /* as given */ }
  // The runs chain is read from the project's folder, as `timmy act` reads and seals it there (src/utils/receipts.ts).
  try { process.chdir(root); } catch (e) { return refuse(2, null, 'usage', `The project folder cannot be entered: ${e instanceof Error ? e.message : String(e)}`); }

  const fromEnv = process.env[OPERATION_ENV]?.trim();
  const id = parsed.id ?? fromEnv;
  if (!id) return refuse(2, null, 'usage', `Name the operation (o and 8 hex digits; /ops lists them), or run it where ${OPERATION_ENV} is set. Usage: ${OP_USAGE}`);
  if (!OPERATION_ID.test(id)) return refuse(2, null, 'not an id', `${parsed.id !== undefined ? id : `${OPERATION_ENV} ${JSON.stringify(id)}`} is not an operation id (o and 8 hex digits): /ops lists them. Usage: ${OP_USAGE}`);

  let r: RunDetailResult = readRunDetail(id, { project: root });
  if (!r.ok) return refuse(r.refusal === 'not an id' ? 2 : 1, id, r.refusal, r.why, r.elsewhere ? { elsewhere: r.elsewhere } : {});
  let d = r.detail;

  let saved: { rel: string; sha256: string } | undefined;
  let markdown: string | undefined;
  if (parsed.summary || parsed.save) markdown = runSummaryMarkdown(d, runRecipe(d));
  if (parsed.save) {
    const w = writeRunSummary(d.project.root, d.operation, markdown!);
    if (!w.ok) return refuse(1, id, 'not saved', w.why, { path: w.rel });
    saved = { rel: w.rel, sha256: w.sha256 };
    // The detail as it is now: it names the summary just kept.
    r = readRunDetail(id, { project: root });
    if (r.ok) d = r.detail;
  }
  if (json) process.stdout.write(`${JSON.stringify(runDetailJson(d))}\n`);
  else if (parsed.summary) process.stdout.write(markdown!);
  else process.stdout.write(runDetailWords(d));
  if (saved) process.stderr.write(`  kept the executive summary: ${saved.rel} (sha256 ${saved.sha256.slice(0, 12)}); ${summaryRel(id)} is never written over\n`);
  return 0;
}
