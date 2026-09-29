// Higgsfield lane configuration. Credentials resolve from HF_CREDENTIALS env
// ("KEY_ID:KEY_SECRET") ONLY — never from files, never logged, never in receipts.
// This is the env-only counterpart of src/mcp/server.ts readApiKey minus its
// .env/file ladder: no file fallback exists on this lane.
// redact() is local (not src/utils/redact.ts) because env-specific exact-match
// replacement beats generic regex patterns for this lane's credential shapes.

export interface HfCredentials { keyId: string; keySecret: string }
export interface EndpointEntry { endpoint: string; stage: 't2i' | 'i2v' | 'speak'; cost_class: 'probe' | 'full'; probe_eligible: boolean }
export type Readiness = { status: 'ready' | 'needs_key' | 'misconfigured'; detail: string; endpoints?: number };

// Advisory catalog hint (exported/tested; not an execution or spending gate).
// Classification remains caller-driven. The legacy unknown/no-catalog default
// is true; that fallback establishes neither actual endpoint capability nor
// price, safety, consent, or authorization. Callers must gate those separately.
export function probeEligible(endpoint: string, catalog?: EndpointEntry[]): boolean {
  const entry = catalog?.find((e) => e.endpoint === endpoint);
  return entry ? entry.probe_eligible : true;
}

// Reject controls before trimming: even surrounding CR/LF cannot enter headers.
// Single source of parse truth: trim, then require KEY_ID:KEY_SECRET with a
// non-empty keyId before the first colon and a non-empty secret after it.
// keySecret is everything after the FIRST colon, so secrets may contain colons.
export function parseHfCredentials(raw: string | undefined): HfCredentials | null {
  if (raw === undefined || /[\x00-\x1f\x7f-\x9f]/.test(raw)) return null;
  const trimmed = raw.trim();
  const i = trimmed.indexOf(':');
  if (i <= 0 || i === trimmed.length - 1) return null;
  return { keyId: trimmed.slice(0, i), keySecret: trimmed.slice(i + 1) };
}

export function resolveHfCredentials(): HfCredentials {
  const raw = process.env.HF_CREDENTIALS;
  if (!raw) throw new Error('HF_CREDENTIALS not set (KEY_ID:KEY_SECRET from platform.higgsfield.ai)');
  const c = parseHfCredentials(raw);
  if (!c) throw new Error('HF_CREDENTIALS must be KEY_ID:KEY_SECRET');
  return c;
}

export function hfReadiness(): Readiness {
  const raw = process.env.HF_CREDENTIALS;
  if (!raw) return { status: 'needs_key', detail: 'HF_CREDENTIALS not set (KEY_ID:KEY_SECRET from platform.higgsfield.ai)' };
  const c = parseHfCredentials(raw);
  if (!c) return { status: 'misconfigured', detail: 'HF_CREDENTIALS must be KEY_ID:KEY_SECRET' };
  return { status: 'ready', detail: 'credentials resolved from env', endpoints: 0 };
}

// Never throws: replace the full raw credential string, then the bare secret
// (both derived from the same parse, so a multi-colon secret is redacted whole).
export function redact(s: string, raw: string | undefined = process.env.HF_CREDENTIALS): string {
  if (!raw) return s;
  let out = s;
  const c = parseHfCredentials(raw);
  const literals = c ? [raw, `${c.keyId}:${c.keySecret}`, c.keySecret] : [raw];
  // Errors can stringify request metadata; cover JSON-escaped values as well.
  const segs = [...new Set(literals.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  for (const seg of segs) {
    if (!seg) continue; // never split on an empty segment
    out = out.split(seg).join('[redacted]');
  }
  return out;
}
