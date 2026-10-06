// `timmy pro`: buy, activate, check, rotate and manage Timmy Pro from the terminal.
//
// Arguments, copy and the upgrade wait live here; license rules live in
// LicenseManager. Everything the commands touch arrives in ProCliContext, so
// tests run them against the real service handler with a recording IO.

import { ProServiceError, type ProService } from './client.js';
import type { Entitlement } from './entitlement.js';
import { LicenseInputError, ProUnavailableError, type LicenseManager, type PurchaseClaim } from './manager.js';
import { PRO_FEATURE_LABELS, PRO_PLAN } from './plan.js';
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
  service: ProService | null;
  settings: ProSettings;
  io: ProCliIO;
}

/** First wait between checks for a finished checkout; the worker allows 20 checks a minute per address. */
export const UPGRADE_POLL_MS = 5_000;
/** Longest wait between checks after the service says "too many requests". */
export const MAX_POLL_MS = 30_000;
/** How long `upgrade` waits for payment before handing over to `timmy pro activate`. */
export const UPGRADE_TIMEOUT_MS = 30 * 60_000;

const PRICE = `$${PRO_PLAN.priceUsdMonthly}/month`;

const USAGE = `Usage: timmy pro [command]

  status [--json]       Show whether Timmy Pro is active on this machine (default)
  upgrade [--no-open]   Buy Timmy Pro (${PRICE}) with Stripe Checkout
  activate [<key>|-]    Activate a license key (- reads it from stdin; no key renews the saved one)
  rotate                Replace your license key; the old key stops working at once
  billing [--no-open]   Open Stripe's customer portal to manage or cancel
  deactivate            Remove the license from this machine

Environment: TIMMY_PRO_URL, TIMMY_PRO_PUBLIC_KEY, TIMMY_HOME (see docs/PRO.md)`;

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
  help: { flags: [], maxArgs: 0, run: async (_invocation, ctx) => { ctx.io.out(USAGE); return 0; } },
};

/** Runs one `timmy pro` command. Exit codes: 0 done, 1 failed, 2 usage or input error. */
export async function runProCli(argv: readonly string[], ctx: ProCliContext): Promise<number> {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const name = positional[0] ?? 'status';
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  const args = positional.slice(1);
  if (!command || args.length > command.maxArgs || [...flags].some((flag) => !command.flags.includes(flag))) {
    ctx.io.err(USAGE);
    return 2;
  }
  try {
    return await command.run({ args, flags }, ctx);
  } catch (error) {
    return reportFailure(error, ctx.io);
  }
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
  const service = requireService(ctx);
  const current = await ctx.manager.current();
  if (current.active) {
    ctx.io.out(`You already have ${PRO_PLAN.name} (valid until ${isoDate(current.claims.exp)}). Manage it with \`timmy pro billing\`.`);
    return 0;
  }
  const checkout = await service.startCheckout();
  ctx.io.out(`${PRO_PLAN.name} is ${PRICE}. Finish checkout in your browser:`);
  ctx.io.out(`  ${checkout.url}`);
  if (!flags.has('--no-open')) ctx.io.openUrl(checkout.url);
  ctx.io.out('Waiting for payment… (Ctrl-C stops waiting; the welcome page also shows your key)');

  let interval = UPGRADE_POLL_MS;
  for (let waited = 0; waited < UPGRADE_TIMEOUT_MS; waited += interval) {
    await ctx.io.sleep(interval);
    try {
      const claim = await ctx.manager.claimPurchase(checkout.sessionId);
      if (claim.state === 'ready') return announcePurchase(claim, ctx);
      interval = UPGRADE_POLL_MS;
    } catch (error) {
      if (!isTransient(error)) throw error;
      if (error.status === 429) interval = Math.min(interval * 2, MAX_POLL_MS);
    }
  }
  ctx.io.err('No payment arrived in 30 minutes. If you finish checkout later, copy the key from the welcome page and run `timmy pro activate <key>`.');
  return 1;
}

async function activate({ args }: Invocation, ctx: ProCliContext): Promise<number> {
  const raw = args[0] === '-' ? await ctx.io.readStdin() : args[0];
  const entitlement = await ctx.manager.activate(raw);
  if (entitlement.active || entitlement.reason === 'no_public_key') {
    ctx.io.out(describeEntitlement(entitlement));
    return 0;
  }
  ctx.io.err(`Activation failed: ${entitlement.detail}.`);
  return 1;
}

async function rotate(_invocation: Invocation, ctx: ProCliContext): Promise<number> {
  const result = await ctx.manager.rotate();
  printKey('New Timmy Pro license key (the old key stopped working):', result.key, ctx);
  if (result.activationError) {
    ctx.io.err(`It is not activated on this machine yet (${result.activationError}). Run \`timmy pro activate\` when you are back online.`);
  } else {
    ctx.io.out(describeEntitlement(result.entitlement));
  }
  return 0;
}

async function billing({ flags }: Invocation, ctx: ProCliContext): Promise<number> {
  const url = await requireService(ctx).billingUrl();
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
  ctx.io.out(describeEntitlement(claim.entitlement));
  return 0;
}

function printKey(heading: string, key: string, ctx: ProCliContext): void {
  ctx.io.out('');
  ctx.io.out(heading);
  ctx.io.out('');
  ctx.io.out(`    ${key}`);
  ctx.io.out('');
  ctx.io.out(`Saved to ${ctx.settings.licensePath} (readable only by you). Keep a copy somewhere safe.`);
}

function describeEntitlement(entitlement: Entitlement): string {
  if (entitlement.active) return `${PRO_PLAN.name} is active until ${isoDate(entitlement.claims.exp)} (renews automatically while online).`;
  if (entitlement.reason === 'no_public_key') {
    return 'License key saved. This build cannot check Pro licenses (no public key), so local Pro features stay off; hosted Pro features still accept your key.';
  }
  return `${PRO_PLAN.name} is not active: ${entitlement.detail}.`;
}

function statusLines(entitlement: Entitlement, key: string | null): string[] {
  if (entitlement.active) {
    const [first, ...rest] = entitlement.claims.features.map((feature) => PRO_FEATURE_LABELS[feature]);
    return [
      `${PRO_PLAN.name}: active`,
      `  Features     ${first ?? '—'}`,
      ...rest.map((label) => `               ${label}`),
      `  License      ${key ? maskKey(key) : '—'}`,
      `  Valid until  ${isoDate(entitlement.claims.exp)} (renews automatically while online)`,
    ];
  }
  return [
    `${PRO_PLAN.name}: not active (${entitlement.detail})`,
    ...(key ? [`  License      ${maskKey(key)}`, '  Retry        timmy pro activate'] : []),
    `  Get Pro      timmy pro upgrade  (${PRICE})`,
    '  Have a key   timmy pro activate <key>',
  ];
}

function statusReport(entitlement: Entitlement, key: string | null, settings: ProSettings) {
  const common = { plan: PRO_PLAN.id, price: PRICE, license: key ? maskKey(key) : null, service: settings.serviceUrl, publicKey: settings.publicKeySource };
  if (entitlement.active) {
    return { active: true, ...common, features: entitlement.claims.features, validUntil: new Date(entitlement.claims.exp * 1000).toISOString(), refreshDue: entitlement.refreshDue };
  }
  return { active: false, reason: entitlement.reason, detail: entitlement.detail, ...common, features: [] };
}

/** `tpro_` + the first and last four characters: enough to tell keys apart, useless to anyone else. */
function maskKey(key: string): string {
  const body = key.slice('tpro_'.length);
  return `tpro_${body.slice(0, 4)}…${body.slice(-4)}`;
}

const isoDate = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

// ── failures ─────────────────────────────────────────────────────────────

function requireService(ctx: ProCliContext): ProService {
  if (!ctx.service) throw new ProUnavailableError();
  return ctx.service;
}

function isTransient(error: unknown): error is ProServiceError {
  return error instanceof ProServiceError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

function reportFailure(error: unknown, io: ProCliIO): number {
  if (error instanceof LicenseInputError) {
    io.err(error.message);
    return 2;
  }
  if (error instanceof ProUnavailableError) {
    io.err(error.message);
    return 1;
  }
  if (error instanceof ProServiceError) {
    io.err(explainServiceError(error));
    return 1;
  }
  throw error;
}

function explainServiceError(error: ProServiceError): string {
  if (error.status === 403) return 'Your Timmy Pro subscription is not active. Check it with `timmy pro billing`.';
  if (error.status === 404 && error.message === 'unknown license key') return 'That license key is not recognized. If it was rotated, use the newest key.';
  if (error.status === 410) return "This checkout's key was already shown once. Use the key from your welcome page: `timmy pro activate <key>`.";
  return `Timmy Pro: ${error.message}`;
}
