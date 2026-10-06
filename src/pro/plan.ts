// Timmy Pro: one plan, one price, four hosted features.
//
// Free Timmy stays 100% local (README "Trust notes"). Pro adds services that
// run on Timmy's servers, so the server — not this file — is what enforces
// them; the local license check only decides what the TUI offers.

export const PRO_PLAN = {
  id: 'pro',
  name: 'Timmy Pro',
  priceUsdMonthly: 19,
  /** Stripe Price lookup key, so test and live prices resolve without hard-coded IDs. */
  lookupKey: 'timmy_pro_monthly',
} as const;

export const PRO_FEATURES = ['cloud_logs', 'verify_links', 'release_receipts', 'hosted_runs'] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export const PRO_FEATURE_LABELS: Record<ProFeature, string> = {
  cloud_logs: 'Cloud Logs dashboard (opt-in sync of runs and receipts)',
  verify_links: 'Shareable verify links for single receipts',
  release_receipts: 'Verified release receipts and Pro badge',
  hosted_runs: 'Hosted agent runs',
};

/**
 * Stripe subscription statuses that keep Pro on. `past_due` keeps access while
 * Stripe retries the card; `canceled`, `unpaid`, `incomplete`,
 * `incomplete_expired` and `paused` turn it off.
 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

export function isActiveStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && ACTIVE_STATUSES.has(status);
}

/** A card that keeps failing keeps Pro for at most this long, whatever Stripe's retry settings are. */
export const PAST_DUE_GRACE_SECONDS = 14 * 86_400;

/** Pro is on for active and trialing plans, and for past_due ones only inside the grace window. */
export function isProActive(status: string, pastDueSince: number | null, nowSeconds: number): boolean {
  if (status === 'past_due') return pastDueSince !== null && nowSeconds - pastDueSince <= PAST_DUE_GRACE_SECONDS;
  return isActiveStatus(status);
}

export function isProFeature(value: string): value is ProFeature {
  return (PRO_FEATURES as readonly string[]).includes(value);
}
