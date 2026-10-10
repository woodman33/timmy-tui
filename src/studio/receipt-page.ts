/**
 * The receipt page (C-13): Timmy serves each receipt itself, on the same 127.0.0.1 server as Timmy
 * Canvas, with a text fallback (`?format=text`, or a client that asks for text). It says "signed and
 * verified" only when the chain verifies and the receipt's own signature checks out. Every value is
 * escaped; the page loads nothing from anywhere (a `default-src 'none'` policy) and links only to
 * itself; colors come from the law file (lanes/visual/tokens.json).
 */
import { themeCss } from '../theme/tokens.js';
import { createHash } from 'node:crypto';
import type express from 'express';
import visualLaw from '../../lanes/visual/tokens.json' with { type: 'json' };
import { readChain, verifyChain, verifySignature, type Receipt, type VerifyResult } from '../utils/receipts.js';

export interface ReceiptSource {
  read(): Receipt[];
  verify(): Pick<VerifyResult, 'ok' | 'reason'>;
}

export const chainSource = (): ReceiptSource => ({ read: () => readChain('runs'), verify: () => verifyChain('runs') });

const KEY = /^(?:[0-9a-f]{8,64}|rc_[0-9a-z_]{4,40})$/;
const short = (hash: string): string => hash.slice(7, 15);
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const law = (name: keyof typeof visualLaw.color): string => visualLaw.color[name].value;

/** A receipt by its id or any prefix of its hash of 8 or more hex digits. */
export function findReceipt(chain: Receipt[], key: string): Receipt | undefined {
  return chain.find((r) => r.id === key || r.hash.slice(7).startsWith(key));
}

/** What the page lists, in order: label and value, nothing raw (the prompt and answer are hashes). */
const CANCEL_AT: Record<NonNullable<Receipt['cancelled_at']>, string> = {
  'before-tools': 'before any tool started',
  'during-tool': 'while a tool ran',
  'after-tools': 'after its tools, before the answer',
};

/** A dollar amount to four places; a nonzero amount is never shown as zero. */
const usd = (n: number): string => (n > 0 && n < 0.0001 ? `$${n.toPrecision(2)}` : `$${n.toFixed(4)}`);

/**
 * R4 (H30): what a receipt says was spent. The reported amount; "cost unknown" when a request went out and no cost
 * came back (`cost_measured: false`, or a null cost), never a number then: the sealed figure is only a placeholder
 * or a lower bound; nothing when no request went out (neither a cost nor the flag).
 */
export function spendText(r: { cost_usd?: number | null; cost_measured?: boolean }): string | undefined {
  if (r.cost_measured === false || r.cost_usd === null) {
    return typeof r.cost_usd === 'number' && r.cost_usd > 0
      ? 'cost unknown (a request went out; its full cost was not reported)'
      : 'cost unknown (a request went out; no cost was reported)';
  }
  if (typeof r.cost_usd !== 'number') return undefined;
  return Number.isFinite(r.cost_usd) && r.cost_usd >= 0 ? usd(r.cost_usd) : 'cost unknown (the receipt records no usable amount)';
}

export function receiptFacts(r: Receipt): Array<[string, string]> {
  // R4 (H30): a tool that spends on its own (describe_image) is sealed on its own receipt, which the turn names.
  const ownReceipts = r.tool_outcomes?.some((t) => typeof t.receipt === 'string' && t.receipt) === true;
  const spend = spendText(r as { cost_usd?: number | null; cost_measured?: boolean });
  const facts: Array<[string, string | undefined]> = [
    ['kind', r.kind],
    ['subject', r.subject],
    ['status', r.status],
    // A cancelled turn (third order, checkpoint 1): where the cancel came, each tool as it ended.
    ['cancelled', r.cancelled_at ? CANCEL_AT[r.cancelled_at] : undefined],
    ['tools', r.tool_outcomes?.length ? r.tool_outcomes.map((t) => `${t.name} ${t.outcome}${t.outcome === 'unknown' ? ' (it may have run in part or in full)' : ''}${typeof t.receipt === 'string' && t.receipt ? ` (receipt ${t.receipt} seals its own cost)` : ''}`).join(', ') : undefined],
    ['rollback', r.rollback === 'none' ? 'none: a cancel stops what is left; it never undoes' : undefined],
    ['sealed', r.ts],
    ['model', r.model_requested],
    ['spend', spend && ownReceipts ? `${spend}; not counting the tools sealed on their own receipts (see tools)` : spend],
    ['time', typeof r.ms === 'number' ? `${(r.ms / 1000).toFixed(1)}s` : undefined],
    ['prompt', r.prompt_hash ? `sha256 ${r.prompt_hash.slice(0, 16)}` : undefined],
    ['answer', r.response_hash ? `sha256 ${r.response_hash.slice(0, 16)}` : undefined],
    ['missing', r.discrepancies?.length ? r.discrepancies.join(', ') : undefined],
    ['signer', r.signer ? `ed25519 ${createHash('sha256').update(r.signer).digest('hex').slice(0, 16)}` : undefined],
    ['previous', r.prev_hash.startsWith('genesis') ? r.prev_hash : short(r.prev_hash)],
    ['hash', r.hash],
  ];
  return facts.filter((f): f is [string, string] => typeof f[1] === 'string' && f[1] !== '');
}

const verdict = (verified: boolean): string => (verified ? 'signed and verified' : 'chain broken');

/** One row of "where to inspect", in the words the REPL prints after a turn (src/repl/main.ts). */
export interface InspectRow {
  label: 'Receipt' | 'Canvas';
  text: string;
  /** Where the row leads, on this server. */
  href?: string;
  hint?: string;
}

/**
 * Round R1: the receipt page's "where to inspect", read from the receipt alone. Receipt: this page's
 * address (and the command that lists them). Canvas: each Timmy Canvas job the turn sealed, with the
 * revision it left, and where the canvas is. A receipt without canvas jobs has no Canvas row; nothing
 * here is a guess.
 */
export function receiptInspect(r: Receipt): InspectRow[] {
  const path = `/receipts/${short(r.hash)}`;
  const rows: InspectRow[] = [{ label: 'Receipt', text: path, href: path, hint: 'or timmy receipts' }];
  for (const s of Array.isArray(r.sources) ? r.sources : []) {
    const c = s as { kind?: unknown; job?: unknown; revision?: unknown } | null;
    if (!c || typeof c !== 'object' || c.kind !== 'timmy-canvas') continue;
    if (typeof c.job !== 'string' || !c.job || !Number.isInteger(c.revision) || (c.revision as number) < 0) continue;
    rows.push({ label: 'Canvas', text: `job ${c.job}, rev ${c.revision}`, href: '/', hint: 'open the canvas' });
  }
  return rows;
}

export function receiptText(r: Receipt, verified: boolean): string {
  const where = receiptInspect(r).map((row) => `${row.label.padEnd(9)} ${row.text}${row.label === 'Canvas' ? ` · ${row.hint}: ${row.href}` : row.hint ? ` · ${row.hint}` : ''}`);
  return [`${verified ? '✓' : '✖'} RECEIPT ${short(r.hash)} ${verdict(verified)}`, '', ...where, '', ...receiptFacts(r).map(([k, v]) => `${k.padEnd(9)} ${v}`), ''].join('\n');
}

export function receiptHtml(r: Receipt, verified: boolean): string {
  const id = short(r.hash);
  const prev = r.prev_hash.startsWith('genesis') ? '' : `<a href="/receipts/${esc(short(r.prev_hash))}">previous receipt</a> · `;
  const rows = receiptFacts(r).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const where = receiptInspect(r).map((row) => {
    const link = row.href ? `<a href="${esc(row.href)}">${esc(row.label === 'Receipt' ? row.text : row.hint ?? row.href)}</a>` : '';
    // Receipt: the address is the link, and the command is the hint. Canvas: the words, then the link.
    const value = row.label === 'Receipt' ? `${link}${row.hint ? ` · ${esc(row.hint)}` : ''}` : `${esc(row.text)} · ${link}`;
    return `<dt>${esc(row.label)}</dt><dd>${value}</dd>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${esc(id)}</title>
<style>
${themeCss()}
body{margin:0;padding:24px 16px;background:var(--timmy-ground);color:var(--timmy-text);font:var(--timmy-weight-body) var(--timmy-size-body)/var(--timmy-line-height) var(--timmy-font-mono)}
main{max-width:72ch}
h1{margin:0 0 16px;font:var(--timmy-weight-heading) var(--timmy-size-h2)/1.2 var(--timmy-font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--timmy-accent)}
.verdict{margin:0 0 24px;font-weight:var(--timmy-weight-heading)}
.ok{color:${law('seal')}}.bad{color:var(--timmy-failure)}
h2{margin:0 0 8px;font:var(--timmy-weight-heading) var(--timmy-size-body)/1.2 var(--timmy-font-mono);color:var(--timmy-text)}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 24px;margin:0 0 24px}
dt{font-weight:var(--timmy-weight-strong);color:var(--timmy-text-secondary)}dd{margin:0;overflow-wrap:anywhere}
a{color:var(--timmy-link)}
/* Phone width: a label sits above its value, so the value gets the whole line. */
@media (max-width:520px){dl{grid-template-columns:minmax(0,1fr);gap:0}dt{margin-top:10px}dt:first-child{margin-top:0}}
</style></head>
<body><main>
<h1>Receipt</h1>
<p class="verdict ${verified ? 'ok' : 'bad'}">${verified ? '✓' : '✖'} RECEIPT ${esc(id)} ${verdict(verified)}</p>
<h2>Inspect</h2>
<dl>${where}</dl>
<h2>Details</h2>
<dl>${rows}</dl>
<p>${prev}<a href="?format=text">text version</a></p>
</main></body></html>
`;
}

export function mountReceiptPages(app: express.Express, source: ReceiptSource = chainSource()): void {
  app.get('/receipts/:key', (req, res) => {
    const key = String(req.params.key).toLowerCase();
    res.set('Cache-Control', 'no-store');
    const rec = KEY.test(key) ? findReceipt(source.read(), key) : undefined;
    if (!rec) {
      res.status(404).type('text/plain').send(`No receipt ${KEY.test(key) ? key : 'like that'} in this chain.`);
      return;
    }
    const verified = source.verify().ok && verifySignature(rec);
    if (req.query.format === 'text' || req.accepts(['html', 'text']) === 'text') {
      res.type('text/plain').send(receiptText(rec, verified));
      return;
    }
    // Round R1: fonts from this server only (Monaspace Argon's files, when it is not installed).
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.type('html').send(receiptHtml(rec, verified));
  });
}
