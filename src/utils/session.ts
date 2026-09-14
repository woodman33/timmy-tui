// status-r1e4 — HANDS ARE PART OF THE RECEIPT: the executing model is read
// from the CLI's own session (own env + parent-process env), never hand-typed.
export interface Session { actor: string; hands: string; short: 'claude' | 'qwen' | 'will' }

import { spawnSync } from 'child_process';
const ps = (pid: number, args: string[]): string => {
  try {
    const r = spawnSync('ps', args.concat('-p', String(pid)), { encoding: 'utf8', timeout: 3000 });
    return r.status === 0 ? String(r.stdout) : '';
  } catch { return ''; }
};
const envOf = (pid: number): string => ps(pid, ['eww']);
const commOf = (pid: number): string => ps(pid, ['-o', 'comm=']).trim();
const parentPid = (pid: number): number => {
  const out = ps(pid, ['-o', 'ppid=']).trim();
  return Number(out) || 0;
};

// walk the parent-process chain: the CLI that owns this session names itself
// (qwen / claude / codex …); its env carries the model doing the work.
export function detectSession(): Session {
  const self = process.env;
  let blob = Object.entries(self).map(([k, v]) => `${k}=${v}`).join(' ');
  let pid = process.ppid ?? 0;
  const chain: { comm: string; env: string }[] = [];
  for (let i = 0; i < 5 && pid > 1; i++) {
    const comm = commOf(pid);
    const env = envOf(pid);
    chain.push({ comm, env });
    blob += ` ${comm} ${env}`;
    pid = parentPid(pid);
  }
  const handsFrom = (env: string, keys: string[]): string | null => {
    for (const k of keys) {
      const m = env.match(new RegExp(`${k}=([^ ]+)`));
      if (m) return m[1];
    }
    return null;
  };
  if (self.CLAUDECODE || /CLAUDECODE=/.test(blob) || chain.some(c => /claude/i.test(c.comm))) {
    const hands = self.ANTHROPIC_MODEL ?? handsFrom(blob, ['ANTHROPIC_MODEL']) ?? 'claude-session-model';
    return { actor: 'claude-code', hands, short: 'claude' };
  }
  if (self.QWEN_CODE || self.QWEN_MODEL || /QWEN_CODE=|QWEN_MODEL=/.test(blob) || chain.some(c => /qwen/i.test(c.comm))) {
    const hands = self.OPENROUTER_MODEL ?? self.QWEN_MODEL ?? handsFrom(blob, ['OPENROUTER_MODEL', 'QWEN_MODEL']) ?? 'qwen-session-model';
    return { actor: 'qwen-cli', hands, short: 'qwen' };
  }
  return { actor: 'will-terminal', hands: 'human-hands', short: 'will' };
}
