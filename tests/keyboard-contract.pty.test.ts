// v1.0.5-keyboard-arch — PTY-level contract. Unit tests stayed green through
// BOTH live regressions; only a real `npx tsx timmy.ts` under tmux closes
// this class of bug. BUG 1 (leak) + BUG 2 (trap) against the live shell.
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { ptyAvailable } from './service-gate.js';

const S = 'kbcontract';
const tmux = (args: string) => execSync(`tmux ${args}`, { encoding: 'utf8' });
const cap = () => tmux(`capture-pane -p -t ${S}`);
const send = (k: string) => tmux(`send-keys -t ${S} ${k}`);
const type = (t: string) => tmux(`send-keys -t ${S} -l ${JSON.stringify(t)}`);
const sleep = (ms: number) => execSync(`sleep ${ms / 1000}`);

afterAll(() => { try { tmux(`kill-session -t ${S}`); } catch { /* gone */ } });

describe.skipIf(!ptyAvailable())('keyboard contract at PTY level', () => {
  it('BUG1 leak + BUG2 trap against the live shell', () => {
    try { tmux(`kill-session -t ${S}`); } catch { /* fresh */ }
    tmux(`new-session -d -s ${S} -x 120 -y 40 "cd ${process.cwd()} && npx tsx timmy.ts; sleep 60"`);
    sleep(7000);

    // BUG 1: Enter claims INPUT, then nav-laden text must never hijack
    send('Enter'); sleep(500);
    expect(cap()).toContain('MODE:INPUT:COMMAND');
    type('g1q? 1234 hello — v1.0.5'); sleep(700);
    let f = cap();
    expect(f).toContain('g1q? 1234 hello — v1.0.5');
    expect(f).not.toContain('SLATE DAG');

    // BUG 2: Esc → NAV; 2 → MISSION; 1 → COMMAND; type again → INPUT
    send('Escape'); sleep(500);
    expect(cap()).toContain('MODE:NAV');
    send('2'); sleep(600);
    expect(cap()).toContain('SLATE DAG');
    send('1'); sleep(600);
    expect(cap()).toContain('COMMAND POST');
    send('Enter'); sleep(500);
    expect(cap()).toContain('MODE:INPUT:COMMAND');
    type('round two'); sleep(500);
    expect(cap()).toContain('round two');

    // Tab at NAV cycles pane focus (border glyph follows), ^K palette modal
    send('Escape'); sleep(400);
    send('Tab'); sleep(400);
    f = cap();
    expect(f).toContain('MODE:NAV');
    send('C-k'); sleep(500);
    expect(cap()).toContain('MODE:MODAL:PALETTE');
    send('Escape'); sleep(400);
    expect(cap()).toContain('MODE:NAV');
  }, 60000);

  it('views 5-9 switch from NAV; Enter/Esc input contract holds', () => {
    try { tmux(`kill-session -t ${S}`); } catch { /* fresh */ }
    tmux(`new-session -d -s ${S} -x 120 -y 40 "cd ${process.cwd()} && npx tsx timmy.ts; sleep 60"`);
    sleep(7000);
    // body markers per view (TTY ink can clip the chrome row on
    // capture-heavy panels; the footer MODE + body content are stable)
    const marks: [string, string][] = [
      ['5', 'first time here?'],
      ['6', 'spawns carbonyl on any URL'],
      ['7', 'PROJECTS — PER-PROJECT TREE'],
      ['8', 'TIMMY Settings & Options'],
      ['9', 'SANDBOX']
    ];
    for (const [k, mark] of marks) {
      send(k); sleep(700);
      const f = cap();
      expect(f).toContain(mark);
      expect(f).toContain('MODE:NAV');
    }
    send('1'); sleep(600);
    send('Enter'); sleep(500);
    expect(cap()).toContain('MODE:INPUT:COMMAND');
    send('Escape'); sleep(400);
    expect(cap()).toContain('MODE:NAV');
    send('q'); sleep(1500);
    expect(cap()).not.toContain('TIMMY TRUST OS');
  }, 90000);
});
