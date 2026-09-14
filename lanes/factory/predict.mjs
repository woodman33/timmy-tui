// lanes/factory/predict.mjs — the forecast, sealed before the first send (ORDER factory-f1d0 C2b).
// Deterministic from the intent and the parsed inputs: target, pages, elements, named text, takes.
import { createHash } from 'node:crypto';
export const sha = (s) => 'sha256_' + createHash('sha256').update(s).digest('hex');

export function predict(intent, inputs, { takes = 3 } = {}) {
  const text = String(intent);
  const target = inputs?.kind === 'glb' || /\b(scene|3d|three-?dimensional|model|glb)\b/i.test(text) ? 'scene' : 'site';
  const explicitPages = (text.match(/\bpages?\s*:\s*([^\n.;]+)/i) || ['', ''])[1].split(/[,/|]/).map((s) => s.trim()).filter(Boolean);
  const pages = target === 'site' ? Math.max(1, explicitPages.length || (text.match(/\bpage\b/gi) || []).length || 1) : 1;
  const namedText = [...new Set([...text.matchAll(/["“]([^"”]{2,80})["”]/g)].map((m) => m[1]))];
  const rows = inputs?.kind === 'json' ? (Array.isArray(inputs.data) ? inputs.data.length : Object.keys(inputs.data ?? {}).length)
    : inputs?.kind === 'csv' ? inputs.rows.length : inputs?.kind === 'glb' ? 1 : 0;
  // site: a section + a heading per page, one element per input row (bounded), one per named text;
  // scene: one node per input row (bounded), one per named text. measure() counts with the same rule.
  const elements = target === 'site' ? pages * 2 + Math.min(rows, 48) + namedText.length : Math.max(1, Math.min(rows, 48)) + namedText.length;
  const p = { schema: 'timmy.omma-prediction/1', target, pages, page_names: explicitPages, elements, named_text: namedText, take_count: takes,
    inputs: inputs ? { kind: inputs.kind, rows, sha256: inputs.sha256, bytes: inputs.bytes } : null, intent_sha256: sha(text) };
  return { ...p, sha256: sha(JSON.stringify(p)) };
}

/** Count what a take actually is, with the same vocabulary, so forecast and actual compare 1:1. */
export function measure(output, target) {
  if (target === 'scene') {
    let scene; try { scene = JSON.parse(output); } catch { return { pages: 0, elements: 0, named_text: [] }; }
    const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
    return { pages: 1, elements: nodes.length, named_text: nodes.map((n) => n.name).filter(Boolean) };
  }
  const html = String(output);
  const pages = Math.max(1, (html.match(/<section\b[^>]*data-page=/g) || []).length);
  const elements = (html.match(/<(h1|h2|h3|p|li|button|a|section|img|article)\b/g) || []).length;
  const named_text = [...html.matchAll(/data-named="([^"]+)"/g)].map((m) => m[1]);
  return { pages, elements, named_text };
}
