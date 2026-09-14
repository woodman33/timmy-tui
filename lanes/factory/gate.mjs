// lanes/factory/gate.mjs — the pre-send privacy gate (ORDER factory-f1d0 C2b).
// Every prompt — intent plus the serialized inputs — passes here BEFORE a transport exists.
// Refuses on any pii.* / identity.* finding at any severity (a personal string), or any finding at
// medium or above (secrets, site addresses). Findings are returned masked (the scanner never keeps
// the raw match), so a refusal can be logged without repeating what it refused.
import { loadPatterns, scanText } from '../privacy/scan.mjs';

let cached = null;
export const patterns = () => (cached ??= loadPatterns());
const BLOCK = new Set(['critical', 'high', 'medium']);
const personal = (f) => /^(pii|identity)\./.test(f.pattern);

/** @returns {{ ok: boolean, findings: Array<{pattern:string, severity:string, line:number, match:string}>, reason?: string }} */
export function gatePrompt(text, P = patterns()) {
  const findings = scanText(String(text), 'prompt', P, 'prompt').map(({ pattern, severity, line, match }) => ({ pattern, severity, line, match }));
  const blocking = findings.filter((f) => personal(f) || BLOCK.has(f.severity));
  if (blocking.length) return { ok: false, findings: blocking, reason: `refused before send: ${blocking.length} finding(s) — ${[...new Set(blocking.map((f) => f.pattern))].join(', ')}` };
  return { ok: true, findings: [] };
}

/** The exact bytes a transport would receive: intent, then the inputs as the transport sees them. */
export const promptText = (intent, inputs) => `${intent}\n\n${inputs?.text ?? ''}`;
