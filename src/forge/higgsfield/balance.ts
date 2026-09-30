// Credit-balance resolution for the autonomous-mode gate (Task 10).
// Two sources, kept strictly distinguishable per the evidence rules:
// - 'measured': a live probe of the Higgsfield balance endpoint with HF
//   credentials. Only ever set from an actual HTTP 2xx carrying a parseable
//   USD number.
// - 'declared': the operator-declared balance in the DispatchPlan. Labeled
//   declared everywhere it surfaces — NEVER presented as measured.
// - 'unavailable': neither source produced a number. usd is null;
//   autonomous spending must stop until a balance source is available.
//
// The fetcher is injected so tests never touch the network (the injected
// fetcher replaces HTTP). Note probeBalance still reads the HF_CREDENTIALS
// env var to decide whether a probe is even attempted — tests manage it via
// house env hygiene (withHfEnv saves/restores).
import { parseHfCredentials } from './config.js';

export type BalanceSource = 'measured' | 'declared' | 'unavailable';
export interface Balance {
  usd: number | null;
  source: BalanceSource;
  detail: string;
}

export interface FetchResponse {
  status: number;
  json: () => Promise<unknown>;
}
export type Fetcher = (url: string, opts: { headers: Record<string, string> }) => Promise<FetchResponse>;

// UNVERIFIED: best-guess Higgsfield account-balance endpoint, subject to
// correction on the first live run. Response parsing below is deliberately
// limited to explicitly USD-denominated shapes ({balance_usd},
// {balance: {usd}}) so a shape drift degrades to 'unavailable' (honest) via
// the unparseable-body path rather than to a guessed number.
export const HF_BALANCE_URL = 'https://api.higgsfield.ai/v1/account/balance';

// Tolerant extraction across common shapes. Returns a finite non-negative
// number or null — never a coerced NaN, never a negative.
function extractUsd(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const candidates: unknown[] = [o.balance_usd];
  const bal = o.balance;
  if (bal && typeof bal === 'object') candidates.push((bal as Record<string, unknown>).usd);
  for (const c of candidates) {
    const n = typeof c === 'number' ? c :
      typeof c === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(c.trim()) ? Number(c) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

export async function probeBalance(fetcher: Fetcher): Promise<Balance> {
  const raw = process.env.HF_CREDENTIALS;
  const creds = raw ? parseHfCredentials(raw) : null;
  if (!creds) {
    return { usd: null, source: 'unavailable', detail: 'HF_CREDENTIALS not set — measured balance unavailable' };
  }
  let res: FetchResponse;
  try {
    res = await fetcher(HF_BALANCE_URL, {
      headers: { authorization: `Bearer ${creds.keyId}:${creds.keySecret}` },
    });
  } catch {
    // Provider/fetch errors may embed request headers or credentials.
    return { usd: null, source: 'unavailable', detail: 'balance probe network error' };
  }
  if (!res || !Number.isInteger(res.status)) {
    return { usd: null, source: 'unavailable', detail: 'balance probe invalid response' };
  }
  if (res.status < 200 || res.status >= 300) {
    return { usd: null, source: 'unavailable', detail: `balance probe HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { usd: null, source: 'unavailable', detail: 'balance probe unparseable body' };
  }
  const usd = extractUsd(body);
  if (usd === null) {
    return { usd: null, source: 'unavailable', detail: 'balance probe: no USD field in response' };
  }
  return { usd, source: 'measured', detail: `measured via balance endpoint (${HF_BALANCE_URL})` };
}

// Resolution order: measured first (only when creds are present), then the
// operator-declared plan balance (source 'declared' — the evidence-rule
// contract requires this label downstream), else unavailable.
export async function resolveBalance(fetcher: Fetcher, planDeclaredUsd?: number): Promise<Balance> {
  const measured = await probeBalance(fetcher);
  if (measured.source === 'measured') return measured;
  if (planDeclaredUsd !== undefined && Number.isFinite(planDeclaredUsd) && planDeclaredUsd >= 0) {
    return {
      usd: planDeclaredUsd,
      source: 'declared',
      detail: 'operator-declared balance from DispatchPlan (declared, not measured)',
    };
  }
  return { usd: null, source: 'unavailable', detail: measured.detail };
}
