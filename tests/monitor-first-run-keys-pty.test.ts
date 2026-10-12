// R4 (H87): the monitor's FIRST RUN screen answers its keys. Found on the Mac (r23b): when `timmy watch` opened it on a home
// that was not set up, Enter, q and Esc did nothing and the terminal stayed in canonical, echoing mode. In a tmux PTY here:
// q on the splash ended only the screen (Ink's exit), not the monitor: the last frame stayed, the terminal went back to
// canonical, echoing mode with the monitor still running, so every key after it did nothing; Esc and Ctrl+C did nothing at
// all on that screen. Now Enter begins the setup, q and Esc leave (the monitor ends, 0, and the terminal comes back as it
// was), and Ctrl+C ends it with 130.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { LOADER, MONITOR, monitorHome } from './fixtures/ui-monitor-home.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port nothing listens on now (the monitor's companion takes it: `timmy watch` runs with its companion). */
async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function firstRunAnd(key: 'Enter' | 'C-j' | 'q' | 'Escape' | 'C-c') {
  const h = monitorHome('first-run', { git: true });
  // as `timmy watch` runs: with its browser companion (whose server alone kept the old monitor alive after q)
  const script = `sleep 0.5; S0=$(stty -g); ${process.execPath} --import ${LOADER} ${MONITOR} --companion-port ${await freePort()}; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same || echo TTY=changed; sleep 60`;
  try {
    h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', h.repo, 'bash', '--norc', '-c', script);
    await h.waitFor(/\[Enter\] Begin setup/);
    await sleep(800);
    const tty = h.tmux('display', '-p', '-t', 't', '#{pane_tty}').trim();
    // while the screen is up, the terminal is in raw mode: a key is the monitor's, never echoed
    const raw = /-icanon/.test(execFileSync('sh', ['-c', `stty -a < '${tty}'`], { encoding: 'utf8' }));
    h.tmux('send-keys', '-t', 't', key);
    if (key === 'Enter' || key === 'C-j') {
      // R4 (H98): the first question without an answer (an older init's home: the chat model), the local model preselected
      await h.waitFor(/Chat model[\s\S]*▸ \[l\] local model only/, 10_000);
      return { key, raw, acted: 'setup began' };
    }
    const exit = Number((await h.waitFor(/EXIT=(\d+)/, 15_000))[1]);
    const back = (await h.waitFor(/TTY=(\w+)/, 5_000))[1];
    return { key, raw, exit, tty: back, alternate: h.tmux('display', '-p', '-t', 't', '#{alternate_on}').trim() };
  } finally {
    await h.dispose();
  }
}

describe('the monitor\'s FIRST RUN screen in a PTY (R4 H87)', () => {
  it('Enter begins the setup', async () => {
    expect(await firstRunAnd('Enter')).toEqual({ key: 'Enter', raw: true, acted: 'setup began' });
  }, 90_000);
  // Ink reads a newline (Ctrl+J, or an Enter typed while the terminal was still line by line, which turns it into one) as
  // "enter", not "return": the first page took only "return"
  it('a newline (Ctrl+J) begins the setup too', async () => {
    expect(await firstRunAnd('C-j')).toEqual({ key: 'C-j', raw: true, acted: 'setup began' });
  }, 90_000);
  it('q leaves: the monitor ends (0) and the terminal comes back as it was', async () => {
    expect(await firstRunAnd('q')).toEqual({ key: 'q', raw: true, exit: 0, tty: 'same', alternate: '0' });
  }, 90_000);
  it('Esc leaves: the monitor ends (0) and the terminal comes back as it was', async () => {
    expect(await firstRunAnd('Escape')).toEqual({ key: 'Escape', raw: true, exit: 0, tty: 'same', alternate: '0' });
  }, 90_000);
  it('Ctrl+C ends it with 130 and the terminal comes back as it was', async () => {
    expect(await firstRunAnd('C-c')).toEqual({ key: 'C-c', raw: true, exit: 130, tty: 'same', alternate: '0' });
  }, 90_000);
});

// R4 (H98): the FIRST RUN asks only what the home has no answer for (here the chat model and the logs, as after an older
// `timmy init`), in the words `timmy init` uses, the local model and local-only logs preselected; it saves the answers in
// the Timmy home and opens HOME on the same screen with one line of what was chosen. On HOME, q has one meaning, shown in the
// footer: the companion's address (a QR code only with --lan), and the pairing card shows the address, no QR code.
describe('the monitor\'s FIRST RUN, answered (R4 H98)', () => {
  it('asks the two questions, saves them in the Timmy home, opens HOME with one line; q on HOME shows the address', async () => {
    const h = monitorHome('first-run', { git: true });
    const script = `sleep 0.5; ${process.execPath} --import ${LOADER} ${MONITOR} --companion-port ${await freePort()}; echo EXIT=$?; sleep 60`;
    try {
      h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', h.repo, 'bash', '--norc', '-c', script);
      const [splash] = await h.waitFor(/2 setup questions have no answer yet: Chat model, Logs and run events\./);
      h.tmux('send-keys', '-t', 't', 'Enter');
      await h.waitFor(/question 1 of 2[\s\S]*Chat model[\s\S]*▸ \[l\] local model only[\s\S]*◇ \[o\] OpenRouter: a paid cloud service/);
      // q is not quit here: nothing happens, the question stays
      h.tmux('send-keys', '-t', 't', 'q');
      await sleep(400);
      const stayed = /Chat model/.test(h.tmux('capture-pane', '-p', '-t', 't'));
      h.tmux('send-keys', '-t', 't', 'Enter');
      await h.waitFor(/question 2 of 2[\s\S]*Logs and run events[\s\S]*▸ \[l\] this computer only/);
      h.tmux('send-keys', '-t', 't', 'Enter');
      await h.waitFor(/Save these answers\?/);
      h.tmux('send-keys', '-t', 't', 'Enter');
      await h.waitFor(/YOUR JOURNEY/);
      const home = h.tmux('capture-pane', '-p', '-t', 't');
      h.tmux('send-keys', '-t', 't', 'q');
      await h.waitFor(/COMPANION PAIR/);
      const card = h.tmux('capture-pane', '-p', '-t', 't');
      h.tmux('send-keys', '-t', 't', 'C-c');
      const exit = Number((await h.waitFor(/EXIT=(\d+)/, 15_000))[1]);
      const rec = JSON.parse(readFileSync(join(h.env.TIMMY_HOME!, 'setup.json'), 'utf8'));
      expect({
        splash: Boolean(splash), stayed, exit,
        line: /Set up here: chat local model \(no key\) · logs this computer only · project demo/.test(home),
        top: /chat: no model key · \/setup/.test(home.split('\n')[0]),
        footer: /\[q\] address/.test(home), journey: /\[q\] its address · a phone: timmy watch --lan/.test(home), lanes: /found \(not checked\)/.test(home),
        cardAddress: /http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]+/.test(card), qrDrawn: /[▀▄█]{6,}/.test(card),
        saved: [rec.by, rec.answers.chat, rec.answers.logs],
      }).toEqual({
        splash: true, stayed: true, exit: 130, line: true, top: true, footer: true, journey: true, lanes: true,
        cardAddress: true, qrDrawn: false, saved: ['the monitor', 'local', 'local'],
      });
    } finally {
      await h.dispose();
    }
  }, 120_000);
});

