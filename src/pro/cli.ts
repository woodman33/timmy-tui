// `timmy pro`: buy, activate, check, rotate and manage Timmy Pro from the terminal.
//
// Arguments, wording and the upgrade wait live here; license rules live in
// LicenseManager and entitlement.ts. Everything the commands touch arrives in
// ProCliContext, so tests run them against the real service handler with a
// recording IO.

import { accessMessage, nextStep, type Entitlement, type InactiveReason, type NextStep } from './entitlement.js';
import { LICENSE_KEY_PREFIX } from './license.js';
import { LicenseInputError, ProUnavailableError, type LicenseManager, type PurchaseClaim } from './manager.js';
import { PRO_FEATURE_LABELS, PRO_PLAN, type ProFeature } from './plan.js';
import { ProServiceError } from './ports.js';
import type { ProSettings } from './settings.js';

export interface ProCliIO {
  out(text: string): void;
  err(text: string): void;
  openUrl(url: string): void;
  sleep(ms: number): Promise<void>;
  readStdin(): Promise<string>;
}

export interface ProCliContext {
  manager: LicenseManager;
  settings: ProSettings;
  io: ProCliIO;
}

/** First wait between checks for a finished checkout; the worker allows 20 checks a minute per address. */
export const UPGRADE_POLL_INTERVAL_MS = 5_000;
/** Longest wait between checks after the service says "too many requests". */
export const UPGRADE_MAX_POLL_INTERVAL_MS = 30_000;
/** How long `upgrade` waits for payment before handing over to `timmy pro activate`. */
export const UPGRADE_TIMEOUT_MS = 30 * 60_000;

const PRICE = `$${PRO_PLAN.priceUsdMonthly}/month`;

const USAGE = `Usage: timmy pro [command]

  status [--json]       Show whether Timmy Pro is active on this machine (default)
  upgrade [--no-open]   Buy Timmy Pro (${PRICE}) with Stripe Checkout
  activate [<key>|-]    Activate a license key; - reads it from stdin, no key renews the saved one
  rotate                Replace your license key; the old key stops working at once
  billing [--no-open]   Open Stripe's customer portal to manage or cancel
  deactivate            Remove the license from this machine
  help                  Show this help

Environment: TIMMY_PRO_URL, TIMMY_PRO_PUBLIC_KEY, TIMMY_HOME (see docs/PRO.md)`;

/** The `status --json` contract. Bump schemaVersion on any breaking change. */
export interface ProStatusReport {
  schemaVersion: 1;
  active: boolean;
  reason: InactiveReason | null;
  detail: string | null;
  nextStep: NextStep;
  plan: typeof PRO_PLAN.id;
  priceUsdMonthly: number;
  features: ProFeature[];
  /** `tpro_` + the first and last four characters of the stored key. */
  licenseKeyMasked: string | null;
  /** ISO time the offline token runs out; it renews before then while online. Not the subscription's end. */
  tokenExpiresAt: string | null;
  refreshDue: boolean;
  serviceUrl: string | null;
  publicKeySource: ProSettings['publicKeySource'];
}

interface Invocation {
  args: readonly string[];
  flags: ReadonlySet<string>;
}

interface Command {
  flags: readonly string[];
  maxArgs: number;
  run(invocation: Invocation, ctx: ProCliContext): Promise<number>;
}

const COMMANDS: Readonly<Record<string, Command>> = {
  status: { flags: ['--json'], maxArgs: 0, run: status },
  upgrade: { flags: ['--no-open'], maxArgs: 0, run: upgrade },
  activate: { flags: [], maxArgs: 1, run: activate },
  rotate: { flags: [], maxArgs: 0, run: rotate },
  billing: { flags: ['--no-open'], maxArgs: 0, run: billing },
  deactivate: { flags: [], maxArgs: 0, run: deactivate },
  help: { flags: [], maxArgs: 0, run: async (_invocation, ctx) => help(ctx) },
};

/** Runs one `timmy pro` command. Exit codes: 0 done, 1 failed, 2 usage or input error. */
export async function runProCli(argv: readonly string[], ctx: ProCliContext): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) return help(ctx);
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const name = positional[0] ?? 'status';
  const args = positional.slice(1);
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) return usageError(`timmy pro: unknown command "${name}"`, ctx);
  const unknownFlag = [...flags].find((flag) => !command.flags.includes(flag));
  if (unknownFlag) return usageError(`timmy pro ${name}: unknown option ${unknownFlag}`, ctx);
  if (args.length > command.maxArgs) {
    return usageError(`timmy pro ${name}: ${command.maxArgs === 0 ? 'takes no arguments' : `takes at most ${command.maxArgs} argument`}`, ctx);
  }
  try {
    return await command.run({ args, flags }, ctx);
  } catch (error) {
    return reportFailure(error, ctx.io);
  }
}

function help(ctx: ProCliContext): number {
  ctx.io.out(USAGE);
  return 0;
}

function usageError(problem: string, ctx: ProCliContext): number {
  ctx.io.err(problem);
  ctx.io.err(USAGE);
  return 2;
}

// ── commands ─────────────────────────────────────────────────────────────

async function status({ flags }: Invocation, ctx: ProCliContext): Promise<number> {
  const entitlement = await ctx.manager.refreshIfDue();
  const key = ctx.manager.storedKey();
  if (flags.has('--json')) {
    ctx.io.out(JSON.stringify(statusReport(entitlement, key, ctx.settings), null, 2));
    return 0;
  }
  for (const line of statusLines(entitlement, key)) ctx.io.out(line);
  return 0;
}

async function upgrade({ flags }: Invocation, ctx: ProCliContext): Promise<number> {
  const current = await ctx.manager.refreshIfDue();
  if (current.active) {
    ctx.io.out(`You already have ${PRO_PLAN.name}. Manage it with \`timmy pro billing\`.`);
    return 0;
  }
  // Checkout does not know who you are, so paying again would start a second subscription.
  const step = nextStep(current);
  if (step !== 'buy' && step !== 'billing') {
    ctx.io.err(`There is already a ${PRO_PLAN.name} license key on this machine. ${accessMessage(current)}`);
    ctx.io.err('To buy a separate subscription anyway, run `timmy pro deactivate` first.');
    return 1;
  }
  const checkout = await ctx.manager.startPurchase();
  ctx.io.out(`${PRO_PLAN.name} is ${PRICE}. Finish checkout in your browser:`);
  ctx.io.out(`  ${checkout.url}`);
  if (!flags.has('--no-open')) ctx.io.openUrl(checkout.url);
  ctx.io.out('Waiting for payment… (Ctrl-C stops waiting; the welcome page also shows your key)');

  let interval = UPGRADE_POLL_INTERVAL_MS;
  for (let waited = 0; waited < UPGRADE_TIMEOUT_MS;) {
    const pause = interval;
    await ctx.io.sleep(pause);
    waited += pause;
    try {
      const claim = await ctx.manager.claimPurchase(checkout.sessionId);
      if (claim.state === 'ready') return announcePurchase(claim, ctx);
      interval = UPGRADE_POLL_INTERVAL_MS;
    } catch (error) {
      if (!(error instanceof ProServiceError) || !error.retryable) throw error;
      if (error.kind === 'rate_limited') interval = Math.min(interval * 2, UPGRADE_MAX_POLL_INTERVAL_MS);
    }
  }
  ctx.io.err(`No payment arrived in ${UPGRADE_TIMEOUT_MS / 60_000} minutes. If you finish checkout later, copy the key from the welcome page and run \`timmy pro activate -\`.`);
  return 1;
}

async function activate({ args }: Invocation, ctx: ProCliContext): Promise<number> {
  const entitlement = args[0] === undefined
    ? await ctx.manager.renew()
    : await ctx.manager.activate(args[0] === '-' ? await ctx.io.readStdin() : args[0]);
  if (entitlement.active) {
    ctx.io.out(`${PRO_PLAN.name} is active on this machine.`);
    return 0;
  }
  if (entitlement.reason === 'no_public_key') {
    ctx.io.out(`License key saved. ${accessMessage(entitlement)}`);
    return 0;
  }
  ctx.io.err(`Activation failed: ${entitlement.detail}. ${accessMessage(entitlement)}`);
  return 1;
}

async function rotate(_invocation: Invocation, ctx: ProCliContext): Promise<number> {
  const result = await ctx.manager.rotate();
  printKey('New Timmy Pro license key (the old key stopped working):', result.key, ctx);
  if (!result.saved) {
    ctx.io.err(`Could not save it to ${ctx.settings.licensePath} (${result.followUpError?.message ?? 'unknown error'}). Copy the key above now: the old key no longer works.`);
    return 1;
  }
  ctx.io.out(`Saved to ${ctx.settings.licensePath} (readable only by you).`);
  if (result.followUpError) {
    ctx.io.err(`It is not activated on this machine yet: ${explainFailure(result.followUpError)} Run \`timmy pro activate\` to try again.`);
    return 0;
  }
  ctx.io.out(`${PRO_PLAN.name} is active on this machine.`);
  return 0;
}

async function billing({ flags }: Invocation, ctx: ProCliContext): Promise<number> {
  const url = await ctx.manager.billingPortalUrl();
  ctx.io.out('Manage or cancel Timmy Pro in Stripe\'s customer portal (sign in with your purchase email):');
  ctx.io.out(`  ${url}`);
  if (!flags.has('--no-open')) ctx.io.openUrl(url);
  return 0;
}

async function deactivate(_invocation: Invocation, ctx: ProCliContext): Promise<number> {
  ctx.io.out(ctx.manager.deactivate() ? 'Removed the Timmy Pro license from this machine.' : 'There was no Timmy Pro license on this machine.');
  ctx.io.out('Your subscription is unchanged. To cancel it, run `timmy pro billing`.');
  return 0;
}

// ── presentation ─────────────────────────────────────────────────────────

function announcePurchase(claim: Extract<PurchaseClaim, { state: 'ready' }>, ctx: ProCliContext): number {
  printKey('Payment received. Your Timmy Pro license key:', claim.key, ctx);
  ctx.io.out(`Saved to ${ctx.settings.licensePath} (readable only by you). Keep a copy somewhere safe.`);
  ctx.io.out(claim.entitlement.active ? `${PRO_PLAN.name} is active on this machine.` : accessMessage(claim.entitlement));
  return 0;
}

function printKey(heading: string, key: string, ctx: ProCliContext): void {
  ctx.io.out('');
  ctx.io.out(heading);
  ctx.io.out('');
  ctx.io.out(`    ${key}`);
  ctx.io.out('');
}

function statusLines(entitlement: Entitlement, key: string | null): string[] {
  const license = key ? [`  License        ${maskKey(key)}`] : [];
  if (entitlement.active) {
    const [first, ...rest] = entitlement.features.map((feature) => PRO_FEATURE_LABELS[feature]);
    return [
      `${PRO_PLAN.name}: active`,
      `  Features       ${first ?? '—'}`,
      ...rest.map((label) => `                 ${label}`),
      ...license,
      `  Offline until  ${isoDate(entitlement.tokenExpiresAt)} (renews automatically while online)`,
    ];
  }
  return [`${PRO_PLAN.name}: not active (${entitlement.detail})`, ...license, `  Next           ${accessMessage(entitlement)}`];
}

function statusReport(entitlement: Entitlement, key: string | null, settings: ProSettings): ProStatusReport {
  return {
    schemaVersion: 1,
    active: entitlement.active,
    reason: entitlement.active ? null : entitlement.reason,
    detail: entitlement.active ? null : entitlement.detail,
    nextStep: nextStep(entitlement),
    plan: PRO_PLAN.id,
    priceUsdMonthly: PRO_PLAN.priceUsdMonthly,
    features: entitlement.active ? [...entitlement.features] : [],
    licenseKeyMasked: key ? maskKey(key) : null,
    tokenExpiresAt: entitlement.active ? new Date(entitlement.tokenExpiresAt * 1000).toISOString() : null,
    refreshDue: entitlement.active && entitlement.refreshDue,
    serviceUrl: settings.serviceUrl,
    publicKeySource: settings.publicKeySource,
  };
}

/** The prefix plus the first and last four characters: enough to tell keys apart, useless to anyone else. */
function maskKey(key: string): string {
  const body = key.slice(LICENSE_KEY_PREFIX.length);
  return `${LICENSE_KEY_PREFIX}${body.slice(0, 4)}…${body.slice(-4)}`;
}

const isoDate = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

// ── failures ─────────────────────────────────────────────────────────────

function reportFailure(error: unknown, io: ProCliIO): number {
  if (error instanceof LicenseInputError) {
    io.err(error.message);
    return 2;
  }
  if (error instanceof ProUnavailableError || error instanceof ProServiceError) {
    io.err(explainFailure(error));
    return 1;
  }
  throw error;
}

/** The one place a failure becomes words for the user. */
function explainFailure(error: Error): string {
  if (!(error instanceof ProServiceError)) return error.message;
  switch (error.kind) {
    case 'unreachable':
      return `Could not reach the Timmy Pro service (${error.message}). Check your connection and try again.`;
    case 'rate_limited':
      return 'The Timmy Pro service is busy (too many requests). Wait a minute and try again.';
    case 'server_error':
      return 'The Timmy Pro service had a problem. Try again in a few minutes.';
    case 'unexpected_response':
      return `Something other than the Timmy Pro service answered (${error.message}). Check TIMMY_PRO_URL, any proxy, and your network.`;
    case 'refused':
      return explainRefusal(error);
  }
}

function explainRefusal(error: ProServiceError): string {
  switch (error.code) {
    case 'subscription_inactive':
      return 'Your Timmy Pro subscription is not active. Check it with `timmy pro billing`.';
    case 'unknown_key':
      return 'That license key is not recognized. If it was replaced, activate the newest key with `timmy pro activate -`.';
    case 'invalid_key':
      return 'That is not a Timmy Pro license key.';
    case 'key_already_issued':
      return "This checkout's key can no longer be shown here (its 24-hour window closed or the key was replaced). Use the key from your welcome page: `timmy pro activate -`.";
    case 'unknown_checkout':
      return 'That checkout did not produce a Timmy Pro purchase.';
    default:
      return `Timmy Pro: ${error.message}`;
  }
}
