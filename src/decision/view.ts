/**
 * Round R4 (H120): a decision record in plain lines for terminal surfaces, each with a role the surface colours:
 *
 *   recommendation   amber: the model's recommendation, said to be one ("a model recommendation, not evidence")
 *   fallback         the deterministic path: used, proposed, or the alternative if a recommendation is declined
 *   policy           what a person must do (NEEDS YOU), admission, options left out and why
 *   muted            the record's identity, the scores, media, transport, usage and cost
 *
 * The operator's rule it keeps: a recommendation is never shown with a passed, verified or green role, and is always called
 * a recommendation; an abstention says a person decides; a cost is an estimate, never a measured amount. Nothing here reads
 * a file, and nothing in a record holds a secret to show.
 */
import { NEEDS_REVIEW } from './judge.js';
import { DECISION_NOTE, type DecisionRecord } from './types.js';

export const LINE_ROLES = ['recommendation', 'fallback', 'policy', 'muted'] as const;
export type LineRole = (typeof LINE_ROLES)[number];
export interface DecisionLine { text: string; role: LineRole }

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const short = (rev: string): string => (rev.length > 12 ? rev.slice(0, 12) : rev || 'none');

const ENDPOINT_WORDS: Record<string, string> = {
  'workers-ai-rest': 'Workers AI (Cloudflare, paid)',
  'systemone-loopback': 'SystemOne on this computer',
  'systemone-remote': 'SystemOne on another computer',
  'fixture-file': 'a fixture file (no service was called)',
};

export function decisionLines(r: DecisionRecord): DecisionLine[] {
  const L: DecisionLine[] = [];
  const push = (role: LineRole, text: string): void => { L.push({ role, text }); };
  const label = (id: string): string => r.options.permitted.find((o) => o.id === id)?.label ?? r.options.excluded.find((o) => o.id === id)?.label ?? id;
  const named = (id: string): string => (label(id) === id ? id : `${label(id)} (${id})`);

  push('muted', `Decision ${r.id} · ${r.kind} · operation ${r.operationId} · revision ${short(r.project.revision)}${r.project.dirty ? ' (with uncommitted changes)' : ''}`);
  const fb = r.fallback;
  if (r.outcome === 'recommend' && r.recommendation) {
    const rec = r.recommendation;
    push('recommendation', `Recommendation: ${named(rec.option)}, ${pct(rec.top)}, ahead by ${pct(rec.margin)} — ${DECISION_NOTE}`);
    if (fb.option && fb.option !== rec.option) push('fallback', `If declined: ${named(fb.option)} by ${fb.rule}`);
  } else if (r.outcome === 'abstain') {
    push('policy', `Needs a person: ${r.judge?.kind === 'abstain' ? r.judge.reason : 'the model did not recommend an option'}`);
    push('fallback', fb.option ? `Fallback proposal: ${named(fb.option)} by ${fb.rule}` : `No fallback proposal: ${fb.rule}`);
  } else {
    push('fallback', fb.option ? `Fallback used: ${named(fb.option)} by ${fb.rule}` : `No option was chosen: ${fb.rule}`);
    if (fb.reason) push('fallback', `Why: ${fb.reason}`);
  }

  const a = r.admission;
  if (a.needsReview) {
    push('policy', a.of === 'nothing' || !a.option
      ? 'NEEDS YOU: a person chooses before anything runs'
      : `NEEDS YOU: a person approves ${named(a.option)} before anything is dispatched`);
  }
  push('policy', a.of === 'nothing' || !a.option ? 'Admission: nothing to admit until a person chooses'
    : a.admitted ? `Admission: admitted (every check supplied and met)${a.needsReview ? ', waiting for a person' : ''}`
      : `Admission: not admitted: ${a.reasons.filter((x) => !/^Require review/.test(x)).join('; ')}`);
  for (const e of r.options.excluded) push('policy', `Not offered: ${named(e.id)}: ${e.reason}`);

  if (r.distribution) {
    const scores = Object.entries(r.distribution).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([id, p]) => `${id === NEEDS_REVIEW ? 'a person should decide' : id} ${pct(p)}`).join(' · ');
    push('muted', `Scores: ${scores}${r.humanReview !== undefined ? ` · review asked for ${pct(r.humanReview)}` : ''}`);
  }
  for (const m of r.inputs.media) push('muted', `${m.sent ? 'Sent' : 'Not sent'}: ${m.ref}${m.reason ? ` (${m.reason})` : ''}`);
  const via = r.provider.endpoint ? ENDPOINT_WORDS[r.provider.endpoint] ?? r.provider.endpoint : 'no transport';
  const usage = r.usage ? ` · ${r.usage.input_tokens} input tokens reported${r.usage.sharedBy ? ` for ${r.usage.sharedBy} questions` : ''}` : '';
  const cost = r.cost.estimate_usd > 0 ? ` · cost not measured (estimate $${r.cost.estimate_usd.toFixed(6)})` : ' · cost not measured';
  const took = r.latencyMs !== undefined ? ` · ${r.latencyMs} ms` : '';
  const who = r.provider.model ? `${r.provider.model} via ${via}` : r.latencyMs !== undefined ? `Asked ${via}: no usable answer` : `Not asked (${via})`;
  push('muted', `${who}${usage}${cost}${took}`);
  if (r.distribution) push('muted', `Kept as ${r.evidence_kind}: ${DECISION_NOTE}`);
  return L;
}
