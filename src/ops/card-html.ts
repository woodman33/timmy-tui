/**
 * Round R4 (H51): the operation cards at the top of the board's Control Room (snapshot and live board alike): one card per
 * recent operation, running first. Each card holds the request, the workflow and its block runs, each flow with its
 * verdict in words and its steps (with each step's role), the native outputs with their sha256 and how they were checked,
 * the VoxVision records about them, the lessons that name them, and each run of the operation with its role. Every item
 * shows how it was checked (verified, stale, unverified, missing) and the command that acts on it.
 *
 * Every string is escaped (src/repl/board-kit.ts esc); a file is a relative link on the snapshot and text on the live board;
 * no style attribute is written (the live page's Content-Security-Policy allows none). Colour never stands alone: each state
 * and check is a word; green is kept for the commands, never for an outcome.
 */
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import { esc, stamp, type Kit } from '../repl/board-kit.js';
import type { CardCheck, CardStep, OperationCard } from './card.js';

const checkHtml = (c: CardCheck): string => `<span class="op-check op-check-${c.status}"><b>${esc(c.status)}</b> ${esc(c.words)}</span>`;
const stepHtml = (s: CardStep, i: number): string => `<li class="op-step op-step-${esc(String(s.state).replace(/[^a-z]+/gi, '').toLowerCase())}"><span class="op-n">${i + 1}</span> <span class="op-step-name">${esc(s.name)}</span>`
  + `${s.role ? ` <span class="op-role">${esc(s.role)}</span>` : ''} <span class="op-step-state">${esc(s.state)}${s.code !== undefined && s.state === 'failed' ? esc(` (exit ${s.code})`) : ''}</span>`
  + `${s.owner ? ` <span class="op-meta">${esc(s.owner)}</span>` : ''}${s.receipt ? ` <span class="op-meta">${esc(`receipt ${s.receipt}`)}</span>` : ''}</li>`;

/** One operation's card. */
export function operationCardHtml(c: OperationCard, k: Kit): string {
  const part = (title: string, body: string, n?: number): string => (body ? `<section class="op-part"><h5>${esc(title)}${n !== undefined ? ` <span class="count">${n}</span>` : ''}</h5>${body}</section>` : '');
  const item = (head: string, rest: string): string => `<li class="op-item">${head}${rest}</li>`;
  const workflows = c.workflows.map((w) => item(
    `<div class="op-head"><span class="op-name">${esc(`${w.doc} › ${w.block}`)}</span> <span class="op-state op-${w.tone}">${esc(w.state)}</span></div>`,
    `<div class="op-meta">${esc(`job ${w.job}`)}</div>${w.steps.length ? `<ol class="op-steps">${w.steps.map(stepHtml).join('')}</ol>` : ''}<div>${checkHtml(w.check)}</div>${k.cmds(w.commands)}`,
  )).join('');
  const flows = c.flows.map((f) => item(
    `<div class="op-head"><span class="op-name">${esc(`flow ${f.id}`)}</span> <span class="op-kind">${esc(f.kind)}</span> <span class="op-state op-${f.tone}">${esc(f.outcome)}</span></div>`,
    `${f.instruction ? `<p class="op-instruction">${esc(f.instruction)}</p>` : ''}<p class="op-verdict">${esc(f.verdict)}</p>`
    + `${f.steps.length ? `<ol class="op-steps" aria-label="${esc(`the steps of flow ${f.id}`)}">${f.steps.map(stepHtml).join('')}</ol>` : ''}<div>record ${k.fileLink(f.file, 'file')} ${checkHtml(f.check)}</div>${k.cmds(f.commands)}`,
  )).join('');
  const outputs = c.outputs.map((o) => item(
    `<div class="op-head">${k.fileLink(o.path, 'file')} <span class="op-kind">${esc(o.role)}</span></div>`,
    `<div class="op-meta">${esc(`by ${o.by}${o.sha256 ? ` · sha256 ${o.sha256.slice(0, 12)}` : ''}`)}</div><div>${checkHtml(o.check)}</div>${k.cmds(o.commands)}`,
  )).join('');
  const vox = c.vox.map((v) => item(
    `<div class="op-head"><span class="op-name">${esc(`${v.action} ${v.inputs.join(' and ')}`)}</span> <span class="op-state op-${v.tone}">${esc(v.status)}</span></div>`,
    `<div class="op-meta">${esc(`${v.id} · about ${v.about}`)} · ${k.fileLink(v.file, 'file')}</div>${v.values.length ? `<ul class="op-values">${v.values.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}<div>${checkHtml(v.check)}</div>${k.cmds(v.commands)}`,
  )).join('');
  const lessons = c.lessons.map((l) => item(
    `<div class="op-head"><span class="op-name">${esc(l.id)}</span> <span class="op-state op-${l.tone}">${esc(l.status)}</span></div>`,
    `<p class="op-lesson">${esc(l.text)}</p>${l.evidence.length ? `<ul class="op-values">${l.evidence.map((e) => `<li>${esc(e.what)}: ${checkHtml(e.check)}</li>`).join('')}</ul>` : ''}${k.cmds(l.commands)}`,
  )).join('');
  const errors = c.lessonErrors.map((e) => `<li class="op-item">${esc(`unreadable: ${e}`)}</li>`).join('');
  const runs = c.runs.map((r) => `<li><span class="op-run">${esc(`${r.kind} ${r.id}`)}</span> <span class="op-role">${esc(r.role)}</span> <span class="op-state op-${r.tone}">${esc(r.state)}</span></li>`).join('');
  const when = [c.via ? `from ${c.via}` : '', c.started ? `started ${stamp(c.started)}` : '', c.ended ? `ended ${stamp(c.ended)}` : '', c.parent ? `continues ${c.parent}` : ''].filter(Boolean).join(' · ');
  // R4 (H60): what of it waits on a person (the Control Room's "Waiting on you" has each in full).
  const waiting = c.waiting?.length
    ? `<div class="op-waiting"><span class="op-label">waiting on you</span> ${esc(c.waiting.slice(0, 3).join(' · '))}${c.waiting.length > 3 ? esc(` · and ${c.waiting.length - 3} more`) : ''} <a href="#room-decisions">${esc('Waiting on you')}</a></div>`
    : '';
  return `<article class="card op-card op-tone-${c.tone}${c.waiting?.length ? ' op-has-waiting' : ''}" data-op="${esc(c.id)}"${c.waiting?.length ? ` data-waiting="${c.waiting.length}"` : ''}>`
    + `<div class="jobhead"><strong class="op-id">${esc(`Operation ${c.id}`)}</strong> <span class="op-state op-${c.tone}">${esc(c.state)}</span></div>`
    + waiting
    + `<p class="op-request"><span class="op-label">request</span> <code>${esc(c.request)}</code></p>`
    + `${when ? `<p class="op-meta">${esc(when)}</p>` : ''}${c.why ? `<p class="op-why">${esc(c.why)}</p>` : ''}${c.note ? `<p class="op-note">${esc(c.note)}</p>` : ''}`
    + `<p class="op-meta">${c.record ? `record ${k.fileLink(c.record, 'file')}` : esc(c.recordError ?? 'no record here')}${esc(` · ${c.receipts.length} receipt${c.receipts.length === 1 ? '' : 's'} sealed under it`)}</p>`
    + part('Workflow', workflows ? `<ul class="op-list">${workflows}</ul>` : '', c.workflows.length)
    + part('Flows', flows ? `<ul class="op-list">${flows}</ul>` : '', c.flows.length)
    + part('Native outputs', outputs ? `<ul class="op-list">${outputs}</ul>` : '', c.outputs.length)
    + part('VoxVision', vox ? `<ul class="op-list">${vox}</ul>` : '', c.vox.length)
    + part('Lessons', lessons || errors ? `<ul class="op-list">${lessons}${errors}</ul>` : `<p class="empty">${esc('No lesson in .timmy/memory/lessons names this operation or its records.')}</p>`, c.lessons.length)
    + part('Runs, by role', runs ? `<ul class="op-runs">${runs}</ul>` : '', c.runs.length)
    + `${k.cmds(c.commands)}</article>`;
}

/** The operations at the top of the Control Room: running first, then the newest. */
export function operationsHtml(cards: readonly OperationCard[], k: Kit): string {
  const running = cards.filter((c) => c.tone === 'running').length;
  return `<h3 id="room-operations">Operations <span class="count">${esc(running ? `${running} running` : String(cards.length))}</span></h3>`
    + `<p class="meta">${esc('One request each, followed through its workflow, flows, outputs, VoxVision records and lessons; each item checked against its receipt, stale when its file changed since.')}</p>`
    + (cards.length ? `<div class="grid wide room-ops">${cards.map((c) => operationCardHtml(c, k)).join('')}</div>` : `<p class="empty">${esc('No operation recorded in this project yet: a command that starts or seals something leaves one (.timmy/operations/).')}</p>`);
}

export const OPS_CSS = `
.room .op-card { gap: 6px; border-left: 3px solid ${HOMEBREW.lineStrong}; }
.room .op-card.op-tone-running { border-left-color: ${HOMEBREW.attention}; }
.room .op-card.op-tone-failed { border-left-color: ${HOMEBREW.failure}; }
.room .op-id { overflow-wrap: anywhere; }
.room .op-state { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.text}; }
.room .op-running, .room .op-attention { color: ${HOMEBREW.attention}; }
.room .op-failed { color: ${HOMEBREW.failure}; }
.room .op-stopped, .room .op-neutral { color: ${HOMEBREW.textSecondary}; }
.room .op-request { margin: 0; overflow-wrap: anywhere; }
.room .op-request code { font: inherit; color: ${HOMEBREW.text}; }
.room .op-label { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; color: ${HOMEBREW.textSecondary}; margin-right: 6px; }
.room .op-meta, .room .op-why { margin: 0; color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.room .op-note { margin: 0; color: ${HOMEBREW.attention}; font-size: ${TYPE.size.small}px; }
.room .op-part h5 { margin: 8px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: ${HOMEBREW.textSecondary}; }
.room ul.op-list, .room ul.op-runs, .room ul.op-values { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: ${TYPE.size.small}px; }
.room .op-item { border-top: 1px solid ${HOMEBREW.line}; padding-top: 6px; min-width: 0; overflow-wrap: anywhere; }
.room .op-item:first-child { border-top: 0; padding-top: 0; }
.room .op-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.room .op-name { font-weight: ${TYPE.weight.strong}; }
.room .op-kind, .room .op-role { text-transform: uppercase; letter-spacing: .05em; font-size: 10.5px; color: ${HOMEBREW.textSecondary}; }
.room .op-instruction, .room .op-verdict, .room .op-lesson { margin: 2px 0; }
.room ol.op-steps { list-style: none; margin: 4px 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.room .op-n { display: inline-block; min-width: 1.4em; color: ${HOMEBREW.textSecondary}; }
.room .op-step-name { text-transform: uppercase; letter-spacing: .05em; }
.room .op-step-state { color: ${HOMEBREW.text}; }
.room .op-step-failed .op-step-state { color: ${HOMEBREW.failure}; }
.room .op-step-running .op-step-state { color: ${HOMEBREW.attention}; }
.room .op-check b { text-transform: uppercase; letter-spacing: .05em; font-size: 10.5px; margin-right: 4px; color: ${HOMEBREW.text}; }
.room .op-check { color: ${HOMEBREW.textSecondary}; }
.room .op-check-stale b, .room .op-check-unverified b { color: ${HOMEBREW.attention}; }
.room .op-check-missing b { color: ${HOMEBREW.failure}; }
.room .op-run { color: ${HOMEBREW.text}; }
.room .op-card.op-has-waiting { border-left-color: ${HOMEBREW.attention}; }
.room .op-waiting { margin: 0; color: ${HOMEBREW.text}; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.room .op-waiting .op-label { color: ${HOMEBREW.attention}; }
.room .op-waiting a { color: ${HOMEBREW.link}; }
`;
