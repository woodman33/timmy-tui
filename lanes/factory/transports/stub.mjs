// lanes/factory/transports/stub.mjs — an explicit local stand-in so the pipeline can be exercised
// end to end without Omma. Takes are STUB, never GENERATED, and cost nothing. Deterministic per
// (intent, inputs, take index) so hashes are reproducible.
import { createHash } from 'node:crypto';
export const name = 'stub';
export const status = 'STUB';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const seedOf = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

export async function send({ intent, inputs, prediction, take }) {
  const seed = seedOf(`${prediction.intent_sha256}|${inputs?.sha256 ?? ''}|${take}`);
  const rows = inputs?.kind === 'csv' ? inputs.rows : inputs?.kind === 'json' ? (Array.isArray(inputs.data) ? inputs.data : Object.entries(inputs.data ?? {}).map(([k, v]) => ({ key: k, value: v }))) : [];
  if (prediction.target === 'scene') {
    const nodes = [];
    const n = Math.max(1, Math.min(rows.length, 48));
    for (let i = 0; i < n; i++) nodes.push({ name: rows[i]?.name ?? rows[i]?.key ?? `node-${i + 1}`, type: inputs?.kind === 'glb' ? 'mesh' : 'box', position: [i * 2, 0, 0], take, seed });
    for (const t of prediction.named_text) nodes.push({ name: t, type: 'text', text: t });
    return { output: JSON.stringify({ schema: 'timmy.stub-scene/1', intent_sha256: prediction.intent_sha256, glb: inputs?.kind === 'glb' ? { sha256: inputs.sha256, bytes: inputs.bytes } : null, nodes }, null, 1), contentType: 'application/json', cost: { usd: 0, credits: 0, model: 'stub' } };
  }
  const pages = prediction.page_names.length ? prediction.page_names : Array.from({ length: prediction.pages }, (_, i) => `page-${i + 1}`);
  const sections = pages.map((p, pi) => `  <section data-page="${esc(p)}">\n    <h1>${esc(p)}</h1>\n${pi === 0 ? rows.slice(0, 48).map((r) => `    <p>${esc(Object.values(r).join(' · '))}</p>`).join('\n') : ''}\n  </section>`).join('\n');
  const named = prediction.named_text.map((t) => `  <p data-named="${esc(t)}">${esc(t)}</p>`).join('\n');
  return { output: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(pages[0])}</title></head>\n<body data-take="${take}" data-seed="${seed}">\n${sections}\n${named}\n</body></html>\n`, contentType: 'text/html', cost: { usd: 0, credits: 0, model: 'stub' } };
}
