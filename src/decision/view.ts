/**
 * Round R4 (H120): a decision record in plain lines for terminal surfaces, each with a role the surface colours:
 *
 *   recommendation   amber: the model's recommendation, said to be one ("a model recommendation, not evidence")
 *   fallback         the deterministic path: used, proposed, or the alternative if a recommendation is declined
 *   policy           what a person must do (NEEDS YOU), admission, options left out and why
 *   muted            the record's identity, the scores, media, transport, usage and cost
 *
 * R9 (H162): every record also says its model exactly (the model asked for, the one the answer names, its version fields,
 * the local digest or why there is none, and "asked for X; the answer names Y" when they differ), its pricing as declared
 * (free: local; a price per million input tokens with its billing; or unknown) and its limits. Every refusal is the
 * fallback's "Why:", in its own words. A record made before R9 says that it has none of these.
 *
 * The operator's rule it keeps: a recommendation is never shown with a passed, verified or green role, and is always called
 * a recommendation; an abstention says a person decides; a cost is an estimate, never a measured amount. Nothing here reads
 * a file, and nothing in a record holds a secret to show. The words name the model a record names, never Clef for another.
 */
import { NEEDS_REVIEW } from './judge.js';
import { DECISION_NOTE, type DecisionRecord } from './types.js';

export const LINE_ROLES = ['recommendation', 'fallback', 'policy', 'muted'] as const;
export type LineRole = (typeof LINE_ROLES)[number];
export interface DecisionLine { text: string; role: LineRole }

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const short = (rev: string): string => (rev.length > 12 ? rev.slice(0, 12) : rev || 'none');

/** Where a record's model was asked, in words: the kind of endpoint, never its address, and never a price (that is declared). */
export const ENDPOINT_WORDS: Readonly<Record<string, string>> = {
  'workers-ai-rest': 'Workers AI (Cloudflare)',
  'systemone-loopback': 'SystemOne on this computer',
  'systemone-remote': 'SystemOne on another computer',
  'fixture-file': 'a fixture file (no service was called)',
};

/** A digest as a line shows it: its first 12 hex digits (the record keeps all of it). */
const digestWords = (m: NonNullable<DecisionRecord['model']>): string => (m.digest === 'not available'
  ? `not available (${m.digest_source})`
  : `${m.digest.replace(/^sha256:/i, '').slice(0, 12)} (the first 12 hex digits of its sha256; the record keeps all of it) from ${m.digest_source}`);

/**
 * R9 (H162): a record's model, pricing and limits in lines; a record made before R9 says it has none of them. The model
 * named is the record's own: "clef-omni" only when Clef-Omni was asked.
 */
export function modelLines(r: DecisionRecord): DecisionLine[] {
  const m = r.model;
  if (!m) return [{ role: 'muted', text: 'Model and pricing: not recorded (a record made before R9 names neither)' }];
  const out: DecisionLine[] = [];
  const named = m.request_model && m.request_model !== m.requested ? ` (the request named it ${m.request_model})` : '';
  const answer = m.returned !== undefined ? ` · the answer names ${m.returned}` : r.latencyMs !== undefined ? ' · the answer named no model' : ' · not asked';
  const version = m.version ? ` · ${Object.entries(m.version).map(([k, v]) => `${k} ${v}`).join(', ')}` : '';
  out.push({ role: 'muted', text: `Model: ${m.requested}${named}${answer}${version}` });
  if (m.differs) out.push({ role: 'policy', text: `Model differs: ${m.differs}` });
  out.push({ role: 'muted', text: `Digest: ${digestWords(m)}` });
  const p = r.provider.pricing;
  out.push({ role: p?.kind === 'unknown' ? 'policy' : 'muted', text: `Pricing: ${p ? p.words : 'not recorded'}` });
  out.push({ role: 'muted', text: `Limits: ${m.limits.words}` });
  return out;
}

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
  L.push(...modelLines(r));
  const via = r.provider.endpoint ? ENDPOINT_WORDS[r.provider.endpoint] ?? r.provider.endpoint : 'no transport';
  const usage = r.usage ? ` · ${r.usage.input_tokens} input tokens reported${r.usage.sharedBy ? ` for ${r.usage.sharedBy} questions` : ''}` : '';
  const cost = r.cost.estimate_usd > 0 ? ` · cost not measured (estimate $${r.cost.estimate_usd.toFixed(6)})` : ' · cost not measured';
  const took = r.latencyMs !== undefined ? ` · ${r.latencyMs} ms` : '';
  const asked = r.model?.requested;
  const who = r.provider.model ? `${r.provider.model} via ${via}`
    : r.latencyMs !== undefined ? `Asked${asked ? ` ${asked}` : ''} via ${via}: no usable answer`
      : r.provider.transport === 'none' ? 'Not asked (no decision model is set up)'
        : `Not asked${asked ? `: ${asked} via ${via}` : ` (${via})`}`;
  push('muted', `${who}${usage}${cost}${took}`);
  if (r.distribution) push('muted', `Kept as ${r.evidence_kind}: ${DECISION_NOTE}`);
  return L;
}
