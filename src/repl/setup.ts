/**
 * The setup check (C-14): what a first run needs, one line each within 60 columns: identity, model
 * key, receipts and palette, where the palette line is the palette offer. The check is sealed as a
 * receipt through `appendReceipt` (AGENTS.md §6), and its receipt line turns green only when the chain
 * verifies after the write (C-8): the one green that means proof.
 */
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { appendReceipt, verifyChain, type VerifyResult } from '../utils/receipts.js';

export interface SetupFacts {
  /** The operator from identity.json, or null on a blank slate. */
  operator: string | null;
  /** A model key is set. */
  key: boolean;
  /** Timmy's palette in use (TIMMY_PALETTE or measured), or null when it is not or is unknown. */
  palette: 'night' | 'day' | null;
  /** Where the theme files are; the palette offer points there. */
  themes: string;
}

export interface SetupResult {
  lines: Segment[][];
  receipt: { hash: string; verified: boolean };
}

type Verify = (stream: string, dir?: string) => Pick<VerifyResult, 'ok' | 'count' | 'reason'>;

const PALETTES = { night: 'Timmy Night', day: 'Timmy Day' } as const;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function setupCheck(facts: SetupFacts, g: GlyphSet, dir?: string, verify: Verify = verifyChain): SetupResult {
  const missing: string[] = [];
  const ok = (label: string, detail: string): Segment[] => [{ text: `  ${g.bullet} ` }, { text: label.padEnd(10), role: 'strong' }, { text: ` ${detail}`, role: 'secondary' }];
  const lack = (label: string, detail: string): Segment[] => {
    missing.push(label);
    return [{ text: '  ' }, { text: `${g.fail} ${label.padEnd(10)}`, role: 'failure' }, { text: ` ${detail}` }];
  };
  const dot = ` ${g.sep} `; // the middle dot, or its ASCII stand-in
  const lines: Segment[][] = [[{ text: '  SETUP CHECK', role: 'strong' }]];
  lines.push(facts.operator ? ok('identity', facts.operator) : lack('identity', `none yet${dot}run timmy init`));
  lines.push(facts.key ? ok('model key', 'set') : lack('model key', `none${dot}timmy init or OPENROUTER_API_KEY`));
  const before = verify('runs', dir);
  lines.push(
    !before.ok ? lack('receipts', `chain broken${dot}/receipts says where`)
      : before.count === 0 ? ok('receipts', `none yet${dot}this check is the first`)
        : ok('receipts', `chain verified${dot}${plural(before.count, 'receipt')}`),
  );
  if (facts.palette) lines.push(ok('palette', PALETTES[facts.palette]));
  else {
    missing.push('palette');
    lines.push([{ text: '  ' }, { text: `${g.warn} ${'palette'.padEnd(10)}`, role: 'estimate' }, { text: ' not Timmy Night or Day' }]);
    lines.push([{ text: `    ${'install'.padEnd(9)}`, role: 'secondary' }, { text: 'timmy theme install', role: 'strong' }]);
  }
  const subject = `setup · ${missing.length ? `missing ${missing.join(', ')}` : 'ready'}`;
  const sealed = appendReceipt('runs', { kind: 'check', subject, policy: 'human-gated', status: 'ok', discrepancies: missing }, dir);
  const after = verify('runs', dir);
  const verified = after.ok && after.count > 0;
  const short = sealed.hash.slice(7, 15);
  lines.push(verified
    ? [{ text: '  ' }, { text: `${g.ok} RECEIPT ${short}`, role: 'verified' }, { text: '  setup check sealed and verified', role: 'secondary' }]
    : [{ text: '  ' }, { text: `${g.fail} RECEIPT ${short}`, role: 'failure' }, { text: `  not verified: ${after.reason ?? 'chain check failed'}`, role: 'secondary' }]);
  return { lines, receipt: { hash: sealed.hash, verified } };
}
