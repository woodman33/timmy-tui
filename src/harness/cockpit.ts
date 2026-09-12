// ui-cockpit-k7m3 — the HANDS board. Everything this order stores (board,
// prompts, pane logs, transcripts) lives ONLY under .timmy/private/cockpit/
// (gitignored, mode 700). Nothing in src/ or lanes/ carries Will's hands,
// paths, or prompts; the HANDS view renders only when a board.json exists,
// so a fresh install never shows it.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { appendReceipt } from '../utils/receipts.js';
import { loadPatterns, scanText, type PrivacyFinding } from '../../lanes/privacy/scan.mjs';

export const ROUNDS = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;
export type Round = (typeof ROUNDS)[number];
export type HandTool = 'claude' | 'codex-cli' | 'qwen' | 'external';
export type HandState = 'idle' | 'running' | 'HOLD' | 'STOP' | 'needs-approval';

export interface HandRow {
  name: string;
  tool: HandTool;
  worktree: string;
  order: string;
  round: string;
  state: HandState;
  lastSeal: string;
}
export interface Board {
  importedAt: string;
  source: string;
  hands: HandRow[];
  /** prompts[hand][round] = the full prompt text for that cell */
  prompts: Record<string, Record<string, string>>;
}

const root = (): string => process.env.TIMMY_REPO_ROOT ?? process.cwd();

export function cockpitDir(): string {
  return join(root(), '.timmy', 'private', 'cockpit');
}
/** mode 700 all the way down — the board is Will's hands, not repo content */
export function ensureCockpitDir(): string {
  const dir = cockpitDir();
  mkdirSync(dir, { recursive: true });
  for (const p of [join(root(), '.timmy', 'private'), dir]) {
    try { chmodSync(p, 0o700); } catch { /* best effort on odd filesystems */ }
  }
  return dir;
}
export function boardPath(): string {
  return join(cockpitDir(), 'board.json');
}
export function loadBoard(): Board | null {
  try {
    const p = boardPath();
    if (!existsSync(p)) return null;
    const b = JSON.parse(readFileSync(p, 'utf8')) as Board;
    if (!b || !Array.isArray(b.hands)) return null;
    return b;
  } catch {
    return null;
  }
}

const TOOLS: HandTool[] = ['claude', 'codex-cli', 'qwen', 'external'];
const STATES: HandState[] = ['idle', 'running', 'HOLD', 'STOP', 'needs-approval'];

/**
 * ROUNDS.md shape (chart + prompt blocks):
 *   | hand | tool | worktree | order | round | state | last_seal |
 *   | --- | ... one row per hand ...
 *   ## prompt <hand> <Rn>
 *   the full prompt text, verbatim, until the next heading
 */
export function parseRounds(md: string): { hands: HandRow[]; prompts: Record<string, Record<string, string>> } {
  const hands: HandRow[] = [];
  const prompts: Record<string, Record<string, string>> = {};
  const lines = md.split(/\r?\n/);
  let cur: { hand: string; round: string; body: string[] } | null = null;
  const flush = () => {
    if (cur && cur.body.length) {
      const text = cur.body.join('\n').trim();
      if (text) (prompts[cur.hand] ??= {})[cur.round] = text;
    }
    cur = null;
  };
  for (const line of lines) {
    const m = /^##\s+prompt\s+(\S+)\s+(R\d)\s*$/i.exec(line.trim());
    if (m) {
      flush();
      cur = { hand: m[1], round: m[2].toUpperCase(), body: [] };
      continue;
    }
    if (cur) {
      if (/^#{1,3}\s/.test(line)) flush();
      else cur.body.push(line);
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 7 || cells[0] === 'hand' || /^-+$/.test(cells[0])) continue;
    const [name, tool, worktree, order, round, state, lastSeal] = cells;
    if (!name) continue;
    hands.push({
      name,
      tool: (TOOLS as string[]).includes(tool) ? (tool as HandTool) : 'external',
      worktree, order,
      round: /^R\d$/.test(round) ? round.toUpperCase() : 'R0',
      state: (STATES as string[]).includes(state) ? (state as HandState) : 'idle',
      lastSeal,
    });
  }
  flush();
  return { hands, prompts };
}

export function importRounds(mdPath: string): { ok: boolean; note?: string; path?: string; hands?: number; prompts?: number } {
  try {
    const md = readFileSync(mdPath, 'utf8');
    const { hands, prompts } = parseRounds(md);
    if (!hands.length) return { ok: false, note: 'no hand rows parsed from the chart' };
    const board: Board = { importedAt: new Date().toISOString(), source: relative(root(), mdPath) || mdPath, hands, prompts };
    const dir = ensureCockpitDir();
    const p = join(dir, 'board.json');
    writeFileSync(p, JSON.stringify(board, null, 2) + '\n', { mode: 0o600 });
    const nPrompts = Object.values(prompts).reduce((a, m) => a + Object.keys(m).length, 0);
    return { ok: true, path: p, hands: hands.length, prompts: nPrompts };
  } catch (e) {
    return { ok: false, note: String(e instanceof Error ? e.message : e) };
  }
}

/**
 * Release check (§12 negative control): a board.json or cockpit pane log
 * planted ANYWHERE in the tracked tree must fail. .timmy/ is the only legal
 * home and it is gitignored, so anything the walker sees is a leak.
 */
export function leakCheck(dir = root()): string[] {
  const leaks: string[] = [];
  const skip = new Set(['.git', 'node_modules', 'dist', '.timmy', '.qwen']);
  const walk = (d: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (skip.has(e)) continue;
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      const rel = relative(dir, p);
      if (e === 'board.json' || rel.split(sep).includes('cockpit')) leaks.push(rel);
    }
  };
  walk(dir);
  return leaks.sort();
}

/** pane-log privacy gate: medium+ findings refuse the seal that would cite them */
export function scanLog(text: string): PrivacyFinding[] {
  return scanText(text, 'cockpit-pane.log', loadPatterns(), 'cockpit').filter(f => f.severity !== 'review');
}
export const promptSha = (text: string): string => 'sha256_' + createHash('sha256').update(text).digest('hex');

/**
 * The only seal path cockpit code may use. opts.logText is the pane log the
 * report came from: if it carries a personal string the seal is REFUSED
 * before anything cites it (§12).
 */
export function sealCockpit(
  subject: string,
  meta: Record<string, string>,
  opts: { logText?: string } = {},
): { ok: boolean; note?: string; hash?: string } {
  const texts: [string, string][] = [['seal', [`subject=${subject}`, ...Object.entries(meta).map(([k, v]) => `${k}=${v}`)].join('\n')]];
  if (opts.logText !== undefined) texts.push(['cockpit-pane.log', opts.logText]);
  for (const [where, text] of texts) {
    const hits = scanText(text, where, loadPatterns(), 'cockpit').filter(f => f.severity !== 'review');
    if (hits.length) return { ok: false, note: `privacy: ${where} carries ${hits[0].pattern} (line ${hits[0].line}) — seal refused` };
  }
  // same shape as the canonical `timmy seal` verb: meta rides in sources
  const rec = appendReceipt('runs', { kind: 'seal', subject, policy: 'human-gated', sources: [meta] } as never);
  return { ok: true, hash: String(rec.hash ?? '') };
}
