/**
 * `timmy receipts` (C-8): verify the chain, then list the latest receipts, inline and append-only
 * (playbook §16.3: write-once scrollback). `--follow` keeps printing each receipt as it is sealed,
 * with a rail between receipts, until Ctrl+C (130) or SIGTERM (143). A broken chain is said in red
 * with ✖ and exits 65 (bad data); the green check is only for a chain that verified.
 */
import { currentCapabilities } from '../term/capabilities.js';
import { measuredFromPalette, namedPalette } from '../term/palettes.js';
import { EXIT } from '../term/session.js';
import { buildTheme, serialize, type Segment, type Theme } from '../term/theme.js';
import { readChain, verifyChain, type Receipt, type VerifyResult } from '../utils/receipts.js';

export interface ReceiptsOptions {
  follow: boolean;
  /** How many of the latest receipts to list first. */
  last: number;
  theme: Theme;
  write(line: string): void;
  read?: () => Receipt[];
  verify?: () => Pick<VerifyResult, 'ok' | 'count' | 'reason'>;
  intervalMs?: number;
  signal?: AbortSignal;
  /** `json`: one envelope (then one receipt a line while following); `quiet`: the hashes alone. */
  format?: 'human' | 'json' | 'quiet';
}

/** A receipt as `--json` gives it: stable keys, the full hash. */
const asJson = (r: Receipt): { hash: string; kind: string; subject: string; at: string } => ({ hash: r.hash, kind: r.kind, subject: r.subject, at: r.ts });

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export async function showReceipts(o: ReceiptsOptions): Promise<number> {
  const g = o.theme.glyphs;
  const read = o.read ?? (() => readChain('runs'));
  const verify = o.verify ?? (() => verifyChain('runs'));
  const say = (segments: Segment[]): void => o.write(serialize(segments, o.theme));
  const status = (): boolean => {
    const v = verify();
    if (!v.ok) say([{ text: `${g.fail} Chain broken`, role: 'failure' }, { text: `  ${v.reason ?? 'verification failed'}`, role: 'secondary' }]);
    else if (v.count === 0) say([{ text: 'No receipts yet.', role: 'secondary' }]);
    else say([{ text: `${g.ok} Chain verified`, role: 'verified' }, { text: `  ${v.count} receipt${v.count === 1 ? '' : 's'}`, role: 'secondary' }]);
    return v.ok;
  };
  const line = (r: Receipt, first: boolean): void => {
    if (!first) say([{ text: `  ${g.rail}`, role: 'rule' }]);
    say([{ text: `  ${g.bullet} ` }, { text: r.hash.slice(7, 15), role: 'strong' }, { text: `  ${r.kind}  ${r.subject}  ${hhmm(r.ts)}`, role: 'secondary' }]);
  };
  const format = o.format ?? 'human';
  if (format !== 'human') {
    // For scripts (playbook §19.5): no glyph, no color, no rail.
    const v = verify();
    const chain = read();
    const latest = chain.slice(-o.last);
    if (format === 'json') {
      o.write(JSON.stringify({ ok: v.ok, verified: v.ok, count: v.count, receipts: latest.map(asJson), ...(v.ok ? {} : { error: v.reason ?? 'verification failed' }) }));
    } else {
      for (const r of latest) o.write(r.hash);
    }
    if (!o.follow) return v.ok ? EXIT.ok : EXIT.dataErr;
    let seen = chain.length;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const now = read();
        for (const r of now.slice(seen)) o.write(format === 'json' ? JSON.stringify(asJson(r)) : r.hash);
        seen = now.length;
      }, o.intervalMs ?? 500);
      o.signal?.addEventListener('abort', () => { clearInterval(timer); resolve(EXIT.cancelled); }, { once: true });
    });
  }
  let ok = status();
  const chain = read();
  chain.slice(-o.last).forEach((r, i) => line(r, i === 0));
  if (!o.follow) return ok ? EXIT.ok : EXIT.dataErr;
  let seen = chain.length;
  return new Promise((resolve) => {
    const tick = (): void => {
      const now = read();
      for (const r of now.slice(seen)) line(r, seen++ === 0);
      if (now.length < seen) seen = now.length;
      const v = verify();
      if (ok && !v.ok) status();
      ok = v.ok;
    };
    const timer = setInterval(tick, o.intervalMs ?? 500);
    o.signal?.addEventListener('abort', () => { clearInterval(timer); resolve(EXIT.cancelled); }, { once: true });
  });
}

export function receiptsHelp(): string {
  return [
    'timmy receipts: verify the receipt chain, then list the latest receipts.',
    '',
    'Usage: timmy receipts [--follow] [--last <n>] [--json | --quiet]',
    '  -f, --follow   keep printing each receipt as it is sealed (Ctrl+C ends it)',
    '  --last <n>     how many of the latest to list first (default 10)',
    '  --json         one JSON envelope {ok, verified, count, receipts}; with --follow, then one receipt a line',
    '  --quiet        the full hashes alone, one a line',
    '',
    'Exit codes: 0 verified or empty, 65 the chain is broken, 130 Ctrl+C, 143 SIGTERM.',
  ].join('\n');
}

export async function receiptsMain(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${receiptsHelp()}\n`);
    return EXIT.ok;
  }
  const at = args.indexOf('--last');
  const last = at >= 0 ? Number(args[at + 1]) : 10;
  if (!Number.isInteger(last) || last < 1) {
    process.stderr.write('timmy receipts: --last needs a whole number of 1 or more.\n');
    return EXIT.usage;
  }
  const caps = currentCapabilities();
  const named = namedPalette(env.TIMMY_PALETTE);
  const theme = buildTheme(caps, named ? measuredFromPalette(named) : undefined);
  const controller = new AbortController();
  let code: number = EXIT.cancelled;
  process.once('SIGINT', () => { code = EXIT.cancelled; controller.abort(); });
  process.once('SIGTERM', () => { code = EXIT.terminated; controller.abort(); });
  const format = args.includes('--json') ? 'json' : args.includes('--quiet') ? 'quiet' : 'human';
  const result = await showReceipts({ follow: args.includes('--follow') || args.includes('-f'), last, theme, format, write: (l) => process.stdout.write(`${l}\n`), signal: controller.signal });
  return result === EXIT.cancelled ? code : result;
}
