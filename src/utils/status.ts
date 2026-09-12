import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { readChain } from './receipts.js';

// status-r1e4 — HANDS ARE PART OF THE RECEIPT: the executing model is read
// from the CLI's own session (parent-process env), never hand-typed.
export interface Session { actor: string; hands: string; short: 'claude' | 'qwen' | 'will' }

const envOf = (pid: number): string => {
  const r = spawnSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? r.stdout : '';
};

export function detectSession(): Session {
  const self = process.env;
  let blob = Object.entries(self).map(([k, v]) => `${k}=${v}`).join(' ');
  try { blob += ' ' + envOf(process.ppid ?? 0); } catch { /* best effort */ }
  if (self.CLAUDECODE || /CLAUDECODE=/.test(blob)) {
    return { actor: 'claude-code', hands: self.ANTHROPIC_MODEL ?? 'claude-session-model', short: 'claude' };
  }
  if (self.QWEN_CODE || /QWEN_CODE=|qwen-cli/.test(blob) || /qwen/.test(String(self.QWEN_MODEL ?? ''))) {
    return { actor: 'qwen-cli', hands: self.OPENROUTER_MODEL ?? self.QWEN_MODEL ?? 'qwen-session-model', short: 'qwen' };
  }
  return { actor: 'will-terminal', hands: 'human-hands', short: 'will' };
}

// orders.log: ORDER-ID | ts | actor | order | evidence [| actor=<cli> hands=<model>]
export interface OrderRow {
  id: string; ts: string; actor: string; title: string; evidence: string;
  state: 'done' | 'in-flight' | `blocked-on-${string}`;
  lastReceipt: string; next: string; hands?: string;
}

const citedShas = (s: string): string[] => [...s.matchAll(/sha256_([0-9a-f]{6,})/g)].map(m => `sha256_${m[1]}`);

export function parseOrders(logPath: string, chainDir?: string): OrderRow[] {
  if (!existsSync(logPath)) return [];
  const chain = readChain('runs', chainDir);
  const onChain = (h: string): boolean => chain.some(r => r.hash === h || r.hash.startsWith(h.slice(0, 24)));
  return readFileSync(logPath, 'utf8').split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#'))
    .map(line => {
      const cols = line.split('|').map(c => c.trim());
      const [id = '', ts = '', actor = '', title = '', evidence = '', handsCol = ''] = cols;
      const hands = /hands=/.test(handsCol) ? handsCol.replace(/^.*hands=/, '') : undefined;
      const cited = citedShas(evidence);
      const lastReceipt = [...cited].reverse().find(onChain) ?? (cited[0] ? `${cited[0]} (missing)` : '—');
      let state: OrderRow['state'] = 'done';
      let next = '—';
      if (/owner's word|owner’s word|awaiting|undeployed|blocked/i.test(`${title} ${evidence}`)) {
        state = 'blocked-on-will';
        next = 'will: the word (deploy/merge/continue)';
      } else if (!evidence) {
        state = 'in-flight';
        next = `${actor}: continue`;
      } else if (cited.length && !cited.some(onChain)) {
        state = 'in-flight';
        next = `${actor}: cited receipt not on chain — attest or re-seal`;
      }
      return { id, ts, actor, title, evidence, state, lastReceipt, next, hands };
    });
}

export function statusReport(logPath: string, chainDir?: string): { actors: Record<string, OrderRow[]>; blockedOnWill: OrderRow[] } {
  const rows = parseOrders(logPath, chainDir);
  const actors: Record<string, OrderRow[]> = {};
  for (const r of rows) actors[r.actor] = [...(actors[r.actor] ?? []), r];
  return { actors, blockedOnWill: rows.filter(r => r.state === 'blocked-on-will') };
}

export function renderBoard(rep: { actors: Record<string, OrderRow[]>; blockedOnWill: OrderRow[] }): string {
  const out: string[] = ['MISSION BOARD — orders.log', ''];
  for (const [actor, rows] of Object.entries(rep.actors)) {
    out.push(`lane: ${actor}`);
    for (const r of rows) {
      out.push(`  [${r.state}] ${r.id} ${r.title.slice(0, 60)}`);
      out.push(`      last: ${r.lastReceipt}  next: ${r.next}`);
    }
    out.push('');
  }
  if (rep.blockedOnWill.length) {
    out.push('BLOCKED ON WILL:');
    for (const r of rep.blockedOnWill) out.push(`  ${r.id} — ${r.next}`);
  }
  return out.join('\n');
}

export const ordersLogPath = (): string =>
  process.env.TIMMY_ORDERS_LOG ?? join(process.cwd(), 'orders.log');
