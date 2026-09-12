import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// warroom-t3b1: tmux is the compositor for harness panes. The war room is a
// tmux session whose panes run the harness CLIs; activity weight drives pane
// height (responding 3 · thinking 2 · idle 1 · off 0).
export interface WarHarness { id: string; model: string | null; weight: number }
export interface WarProfile {
  name: string;
  harnesses: WarHarness[];
  commander: { model: string; ws: string | null };
}
export const WAR_SESSION = 'timmy-war';
export const ACTIVITY_WEIGHT: Record<string, number> = { responding: 3, thinking: 2, idle: 1, off: 0 };

const tmux = (args: string[]): { status: number; out: string } => {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: 5000 });
  return { status: r.status ?? 1, out: r.stdout ?? '' };
};
const CMD: Record<string, string> = {
  jcode: 'jcode', opencode: 'opencode', pi: 'pi', hermes: 'hermes', minds: 'minds', openhands: 'openhands',
};
const cmdFor = (id: string): string => id.startsWith('sh:') ? id.slice(3) : (CMD[id] ?? id);

export function warRunning(): boolean { return tmux(['has-session', '-t', WAR_SESSION]).status === 0; }

export function startWarRoom(p: WarProfile): { ok: boolean; note?: string } {
  if (warRunning()) return { ok: true, note: 'already running' };
  const first = p.harnesses[0];
  if (!first) return { ok: false, note: 'empty profile' };
  const r = tmux(['new-session', '-d', '-s', WAR_SESSION, '-n', first.id, cmdFor(first.id)]);
  if (r.status !== 0) return { ok: false, note: r.out.trim() || 'tmux new-session failed' };
  tmux(['select-pane', '-t', `${WAR_SESSION}:0.0`, '-T', first.id]);
  for (const h of p.harnesses.slice(1)) {
    tmux(['split-window', '-t', WAR_SESSION, '-v', cmdFor(h.id)]);
    tmux(['select-pane', '-t', `${WAR_SESSION}:0.${p.harnesses.indexOf(h)}`, '-T', h.id]);
  }
  applyWeights(p);
  return { ok: true };
}

export interface WarPane { id: string; name: string; height: number }
export function panes(): WarPane[] {
  const r = tmux(['list-panes', '-t', WAR_SESSION, '-F', '#{pane_id}|#{pane_title}|#{pane_height}']);
  if (r.status !== 0) return [];
  return r.out.trim().split('\n').filter(Boolean).map(l => {
    const [id, name, height] = l.split('|');
    return { id, name, height: Number(height) || 0 };
  });
}

export function applyWeights(p: WarProfile): void {
  for (const pane of panes()) {
    const h = p.harnesses.find(x => x.id === pane.name);
    const w = h?.weight ?? 1;
    tmux(['resize-pane', '-t', pane.id, '-y', String(Math.max(3, w * 4))]);
  }
}

export function setActivity(p: WarProfile, harness: string, state: 'responding' | 'thinking' | 'idle' | 'off'): WarProfile {
  const next: WarProfile = {
    ...p,
    harnesses: p.harnesses.map(h => (h.id === harness ? { ...h, weight: ACTIVITY_WEIGHT[state] ?? 1 } : h)),
  };
  applyWeights(next);
  return next;
}

export function killWar(): { ok: boolean } { return { ok: tmux(['kill-session', '-t', WAR_SESSION]).status === 0 }; }
export function focusPane(idx: number): void { const ps = panes(); if (ps[idx]) tmux(['select-pane', '-t', ps[idx].id]); }
export function togglePane(idx: number): void { const ps = panes(); if (ps[idx]) tmux(['resize-pane', '-t', ps[idx].id, '-y', '3']); }

export const profilePath = (name: string): string => join(homedir(), 'timmy', 'projects', name, 'profile.cue');

const toCue = (p: WarProfile): string => [
  `name: "${p.name}"`,
  'commander: {',
  `  model: "${p.commander.model}"`,
  `  ws: ${p.commander.ws ? `"${p.commander.ws}"` : 'null'}`,
  '}',
  'harnesses: [',
  ...p.harnesses.map(h => `  {id: "${h.id}", model: ${h.model ? `"${h.model}"` : 'null'}, weight: ${h.weight}},`),
  ']',
  '',
].join('\n');

const fromCue = (s: string): WarProfile => {
  const name = s.match(/name:\s*"([^"]+)"/)?.[1] ?? 'default';
  const model = s.match(/model:\s*"([^"]+)"/)?.[1] ?? 'openrouter/auto';
  const ws = s.match(/ws:\s*"([^"]+)"/)?.[1] ?? null;
  const harnesses: WarHarness[] = [...s.matchAll(/\{id:\s*"([^"]+)",\s*model:\s*(?:"([^"]+)"|null),\s*weight:\s*(\d+)\}/g)]
    .map(m => ({ id: m[1], model: m[2] ?? null, weight: Number(m[3]) }));
  return { name, harnesses, commander: { model, ws } };
};

export function saveProfile(p: WarProfile): string {
  const f = profilePath(p.name);
  mkdirSync(join(homedir(), 'timmy', 'projects', p.name), { recursive: true });
  writeFileSync(f, toCue(p));
  return f;
}
export function loadProfile(name: string): WarProfile | null {
  const f = profilePath(name);
  if (!existsSync(f)) return null;
  return fromCue(readFileSync(f, 'utf8'));
}
export const defaultProfile = (): WarProfile => ({
  name: 'default',
  harnesses: ['jcode', 'opencode', 'pi', 'hermes', 'minds', 'openhands'].map(id => ({ id, model: null, weight: 1 })),
  commander: { model: process.env.TIMMY_COMMANDER_MODEL ?? 'openrouter/auto', ws: process.env.TIMMY_COMMANDER_WS ?? null },
});
