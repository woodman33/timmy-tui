/**
 * Timmy Cloud's backend: the provider interface, provider-neutral.
 *
 * An adapter implements `CloudProvider` for one hosting provider. This slice has one adapter, for the simulated provider
 * (simulated-adapter.ts); a private adapter for the operator's real provider could implement the same interface later.
 * The interface is shaped by what the provider's documentation says, and by what it does not offer:
 *
 * - there is no operation that cancels a purchase or a provisioning operation, none that shares account access and none
 *   that makes sub-accounts; no adapter invents one (OPERATIONS_THAT_DO_NOT_EXIST);
 * - a purchase may answer "payment still processing" (HTTP 202 at the documented provider), settled later by a read;
 * - a site setup runs in the background: it answers with a setup id, read until it completes (then a site id);
 * - deploying an archive overwrites a site's contents and cannot be undone, and deleting a site is immediate: both are
 *   IRREVERSIBLE_OPS, called only after a person approves (deletion) or not at all in this slice (deployment is on HOLD);
 * - the provider's API has a shared rate limit (429 with Retry-After), honoured for every call and read.
 *
 * Adapters never throw for a provider's answer: every call ends in a `CallOutcome`, every read in a `ReadOutcome`.
 * Adapters never put the agency credential in an outcome's words (the backend redacts again before anything is kept).
 */

/** A provider call that changes something. Each carries the backend's call id as its client reference. */
export type ProviderCall =
  | { op: 'purchase'; client_reference: string; kind: 'domain' | 'vps'; item_id: string; domain: string | null }
  | { op: 'complete_domain_registration'; client_reference: string; domain: string }
  | { op: 'start_site_setup'; client_reference: string }
  | { op: 'link_domain'; client_reference: string; site_id: string; domain: string }
  | { op: 'start_certificate'; client_reference: string; site_id: string; domain: string }
  | { op: 'start_vps_setup'; client_reference: string; purchase_reference: string }
  | { op: 'delete_site'; client_reference: string; site_id: string }
  | { op: 'deploy_archive'; client_reference: string; site_id: string; archive_sha256: string };

export type ProviderCallOp = ProviderCall['op'];

/** Every provider call, at run time (the type check keeps this list equal to ProviderCall's ops). */
export const PROVIDER_CALL_OPS = [
  'purchase', 'complete_domain_registration', 'start_site_setup', 'link_domain', 'start_certificate', 'start_vps_setup',
  'delete_site', 'deploy_archive',
] as const satisfies readonly ProviderCallOp[];
type MissingOp = Exclude<ProviderCallOp, (typeof PROVIDER_CALL_OPS)[number]>;
const allOpsListed: MissingOp extends never ? true : never = true;
void allOpsListed;

/** What the provider's API does not offer, and no adapter may invent (the owner: "Do not invent a subaccount API"). */
export const OPERATIONS_THAT_DO_NOT_EXIST = [
  'cancel a purchase',
  'cancel a provisioning operation (a site setup, a registration, a VPS setup)',
  'share access to the account or a resource',
  'create a sub-account',
] as const;

/** Irreversible operations: deleting a site (immediate) and deploying an archive (overwrites the site's contents). */
export const IRREVERSIBLE_OPS: readonly ProviderCallOp[] = ['delete_site', 'deploy_archive'];

export type PaymentState = 'paid' | 'processing' | 'failed';

export interface PurchaseView {
  reference: string;
  payment: PaymentState;
  /** The amount the provider reported, in cents; null when it reported none. */
  charged_cents: number | null;
  currency: string | null;
  words: string | null;
  /** A domain purchase: whether the domain is registered now (a purchase answered "processing" registers nothing yet). */
  registered: boolean | null;
}

export interface DomainView {
  domain: string;
  state: 'awaiting_payment' | 'awaiting_setup' | 'registering' | 'registered' | 'failed';
  expires_at: string | null;
  purchase_reference: string | null;
  words: string | null;
}

export interface SiteSetupView { setup_id: string; status: 'running' | 'completed' | 'failed'; site_id: string | null; words: string | null }
export interface SiteView { site_id: string; state: 'active' | 'deleting' | 'deleted'; hostname: string | null; domains: string[] }
export interface CertificateView { status: 'not_installed' | 'installing' | 'active' | 'failed' | 'expired'; words: string | null }
export interface HealthView { answers: boolean; http_status: number | null; words: string }
export interface VpsView { vps_id: string; state: 'installing' | 'running' | 'stopped' | 'error'; purchase_reference: string; words: string | null }

export interface CatalogItem {
  item_id: string;
  kind: 'site' | 'domain' | 'vps';
  name: string;
  price_cents: number;
  currency: string;
  period: string;
}

export type CallAnswer =
  | { op: 'purchase'; purchase: PurchaseView }
  | { op: 'complete_domain_registration'; domain: DomainView }
  | { op: 'start_site_setup'; setup: SiteSetupView }
  | { op: 'link_domain'; site: SiteView }
  | { op: 'start_certificate'; certificate: CertificateView }
  | { op: 'start_vps_setup'; vps: VpsView }
  | { op: 'delete_site'; site: SiteView }
  | { op: 'deploy_archive'; site_id: string; archive_sha256: string; words: string };

/** What came of a provider call that changes something. */
export type CallOutcome =
  | { kind: 'answered'; http_status: number; answer: CallAnswer }
  /** The provider refused (a 4xx other than a busy 409 and 429): it did nothing. */
  | { kind: 'refused'; http_status: number; words: string }
  /** The provider's shared rate limit (429): it did nothing; nothing is sent to it before retry_after_ms. */
  | { kind: 'rate_limited'; http_status: number; retry_after_ms: number; words: string }
  /** The provider is busy with the same thing (409 with Retry-After): it did nothing new; try again later. */
  | { kind: 'busy'; http_status: number; retry_after_ms: number; words: string }
  /** The request never left: the connection was refused before a byte was written. */
  | { kind: 'not_sent'; words: string }
  /** The answer was lost (a timeout, a reset connection), could not be read, or was a 5xx: the provider may have acted. */
  | { kind: 'unknown'; http_status: number | null; words: string };

export type ProviderRead =
  | { read: 'catalog' }
  | { read: 'purchase'; reference: string }
  | { read: 'domain'; domain: string }
  | { read: 'site_setup'; setup_id: string }
  | { read: 'site'; site_id: string }
  | { read: 'certificate'; site_id: string; domain: string }
  | { read: 'health'; site_id: string }
  | { read: 'vps'; vps_id: string };

export type ReadAnswer =
  | { read: 'catalog'; items: CatalogItem[]; source: string }
  | { read: 'purchase'; purchase: PurchaseView | null }
  | { read: 'domain'; domain: DomainView | null }
  | { read: 'site_setup'; setup: SiteSetupView | null }
  | { read: 'site'; site: SiteView | null }
  | { read: 'certificate'; certificate: CertificateView }
  | { read: 'health'; health: HealthView }
  | { read: 'vps'; vps: VpsView | null };

export type ReadOutcome<T> =
  | { kind: 'answered'; value: T }
  | { kind: 'rate_limited'; retry_after_ms: number; words: string }
  /** No answer, or an error: nothing was learned. */
  | { kind: 'failed'; words: string };

/**
 * What reconcile learned about a call whose answer was lost, by reading the provider for what the call asked for.
 * `proven: true` only when the provider's own records show the call never took effect; anything less is not proof.
 */
export type Finding =
  | { found: true; answer: CallAnswer; how: string }
  | { found: false; proven: true; how: string }
  | { found: false; proven: false; how: string };

export interface ProviderInfo {
  name: string;
  /** True for the simulated provider: nothing real is bought or run. */
  simulated: boolean;
  /**
   * Whether a lookup can prove that a purchase never happened. 'client_reference': the provider keeps the client
   * reference sent with each purchase and finds by it, so a miss is proof. 'none': it does not (the documented provider
   * takes no client reference on a purchase), so a purchase whose answer was lost can be found but never proven absent.
   */
  purchase_absence_proof: 'client_reference' | 'none';
}

export interface CloudProvider {
  readonly info: ProviderInfo;
  /** One provider call that changes something. The backend has written it ahead before calling. */
  call(call: ProviderCall): Promise<CallOutcome>;
  /** One read, by the provider's own reference. */
  read<R extends ProviderRead>(read: R): Promise<ReadOutcome<Extract<ReadAnswer, { read: R['read'] }>>>;
  /** Reconcile: did this call take effect? Read by what it asked for (and its client reference, where the provider keeps one). */
  findEffect(call: ProviderCall, since: string): Promise<ReadOutcome<Finding>>;
}
