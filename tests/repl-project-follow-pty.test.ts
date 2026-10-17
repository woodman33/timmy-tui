// R7 (H149): the REPL itself (`timmy repl`, src/repl/main.ts) in a real terminal (tmux, 140 x 50) follows the active project
// another process chooses (src/repl/project-follow.ts), and what was running keeps the project it started in.
//
// In order: the REPL starts in tray and serves tray's preview (a job: /preview); a chat turn starts in tray and, while it is
// answered, a second node process writes the active-project record for blank as the Workbench's picker writes it
// (src/project/index.ts saveActiveProject, by the Workbench). The REPL says it follows blank once the turn ends; the turn ends in
// tray (its receipt names tray, its conversation is kept in tray's .sessions); then the REPL follows blank and says the preview
// keeps running in tray. /project shows blank (and the job as tray's); /add writes into blank; /stop stops the preview job, whose
// record and receipt stay tray's.
//
// FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: no model behind it) whose
// answer comes slowly, a chunk at a time. Captures (plain text of the screen) only when TIMMY_R7_CAPTURES names a folder.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectId } from '../src/project/index.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const PROJECT_INDEX = resolve('src/project/index.ts');
const CAPTURES = process.env.TIMMY_R7_CAPTURES?.trim() || '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 30_000);

function terminal(dir: string, cwd: string, env: NodeJS.ProcessEnv, label: string) {
  const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env: tenv, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '140', '-y', '50', '-c', cwd, 'bash', '--norc', '-c', `${TSX} ${CLI} repl; echo EXIT1=$?; sleep 60`);
  const screen = () => tmux('capture-pane', '-p', '-J', '-S', '-2000', '-t', 't');
  const waitFor = async (re: RegExp, ms = 30_000): Promise<string> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = screen();
      if (re.test(s)) return s;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${re}:\n${screen()}`);
  };
  const type = (text: string) => { if (text) tmux('send-keys', '-t', 't', '-l', text); tmux('send-keys', '-t', 't', 'Enter'); };
  return { screen, waitFor, type, close: () => { try { tmux('kill-server'); } catch { /* gone */ } } };
}

/** The screen as plain text, without the canvas's grant or a token, for a capture. */
const scrubbed = (s: string, dir: string): string => s.split(dir).join('<test folder>').replace(/#(code|t)=[0-9a-f]+/g, '#$1=<scrubbed>').replace(/([?&]t=)[0-9a-f]+/g, '$1<scrubbed>');
function capture(name: string, s: string, dir: string): void {
  if (!CAPTURES) return;
  mkdirSync(CAPTURES, { recursive: true });
  writeFileSync(join(CAPTURES, `${name}.txt`), `FAKE model (a FAKE Ollama); the record written by a second node process, as the Workbench's picker writes it.\n\n${scrubbed(s, dir)}`);
}

const flat = (s: string): string => s.replace(/\s+/g, ' ');
const receipts = (store: string): Array<Record<string, any>> => {
  try { return readFileSync(join(store, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>); } catch { return []; }
};
const sessionsText = (root: string): string => {
  const dir = join(root, '.sessions');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).map((f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } }).join('\n');
};

describe('the REPL follows the active project another process chooses, in a terminal (R7 H149)', () => {
  it('a turn answering at the switch ends in tray, then the REPL follows blank; /project shows blank; /add writes in blank; tray\'s preview job keeps tray (record, log, receipt) and stops', async () => {
    const ollama: FakeOllama = await startFakeOllama({
      models: [{ name: 'qwen3:8b' }],
      chat: [() => ({ chunks: textChunks('qwen3:8b', ['Answering in tray.', ' Still answering.', ' Still.', ' Almost.', ' Done in tray.']), delayMs: 1200 })],
    });
    cleanups.push(() => ollama.close());
    const dir = mkdtempSync(join(tmpdir(), 'repl-follow-pty-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tray = join(dir, 'tray');
    const blank = join(dir, 'blank');
    mkdirSync(tray, { recursive: true });
    mkdirSync(blank, { recursive: true });
    writeFileSync(join(tray, 'index.html'), '<!doctype html><title>tray</title><p>tray</p>\n');
    writeFileSync(join(dir, 'note.txt'), 'a note for blank\n');
    const timmyHome = join(dir, 'timmy');
    const store = join(dir, 'store');
    // the canvas server the REPL starts for its receipt pages listens on this owner's port (R7: 4470-4479), never the default
    const env = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: timmyHome, TIMMY_STORE: store, OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night', TIMMY_STUDIO_PORT: '4471' };
    const init = await runAsync(TSX, [CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo', '--ollama', ollama.url, '--chat', 'local', '--model', 'qwen3:8b'], { cwd: tray, env, timeout: 50_000 });
    expect(init.status, init.stderr).toBe(0);
    // the second process: writes the record as the Workbench's picker does (saveActiveProject, by the Workbench)
    const chooser = join(dir, 'choose.mts');
    writeFileSync(chooser, `import { saveActiveProject } from ${JSON.stringify(PROJECT_INDEX)};\nsaveActiveProject({ name: process.argv[3], root: process.argv[2], chosen: true }, { by: 'workbench' });\n`);
    const choose = (root: string, name: string) => execFileSync(TSX, [chooser, root, name], { env, cwd: dir, timeout: 30_000 });
    // a Timmy home that has a project chosen already: tray (the REPL starts in it)
    choose(tray, 'tray');

    const t = terminal(dir, tray, env, 'h149-follow');
    cleanups.push(() => t.close());
    await t.waitFor(/^TIMMY {2}chat: local qwen3:8b · Ollama$/m);
    // the prompt is up (its key line drawn) before anything is typed
    await t.waitFor(/Enter to send/);
    await sleep(300);
    t.type('/project');
    await t.waitFor(/Project {2}tray/);

    // tray's preview: a job that keeps running
    t.type('/preview');
    const ready = await t.waitFor(/(j[0-9a-f]+) ready {2}preview the project answers at http:\/\/127\.0\.0\.1:\d+\//);
    const job = /(j[0-9a-f]+) ready {2}preview the project/.exec(ready)![1];

    // a turn in tray; while it is answered, the other process chooses blank
    t.type('what is in this project?');
    await t.waitFor(/Answering in tray\./);
    choose(blank, 'blank');
    const waiting = await t.waitFor(/this REPL follows blank once this turn ends; the turn finishes in tray\./);
    expect(flat(waiting)).toContain('The active project is now blank (chosen in the Workbench): this REPL follows blank once this turn ends; the turn finishes in tray.');
    // the turn ends in tray, sealed; then the REPL follows, and says what keeps running where
    const followed = await t.waitFor(/Done in tray\.[\s\S]*RECEIPT [0-9a-f]{8} signed and verified[\s\S]*Now in blank: the active project changed/);
    expect(flat(followed)).toContain(`Now in blank: the active project changed (chosen in the Workbench), and this REPL follows it. ${job} (preview the project), started in tray, keeps running there, with its records, logs and receipts.`);
    capture('pty-01-turn-then-follow', followed, dir);
    const turns = receipts(store).filter((r) => r.kind === 'turn' && r.hash);
    expect(turns.map((r) => ({ project: r.project, project_id: r.project_id }))).toEqual([{ project: 'tray', project_id: projectId(tray) }]);
    expect(sessionsText(tray)).toContain('what is in this project?');
    expect(sessionsText(blank)).not.toContain('what is in this project?');

    // /project shows blank, and the preview as tray's
    t.type('/project');
    const shown = await t.waitFor(/Project {2}blank[\s\S]*Jobs {5}j[0-9a-f]+ ready \(in tray\)/);
    expect(flat(shown)).toContain(`Jobs ${job} ready (in tray)`);
    // a new command writes in blank
    t.type(`/add ${join(dir, 'note.txt')}`);
    await t.waitFor(/Added 1 file to refs\//);
    expect(readFileSync(join(blank, 'refs', 'note.txt'), 'utf8')).toBe('a note for blank\n');
    expect(existsSync(join(tray, 'refs', 'note.txt'))).toBe(false);
    const intake = receipts(store).filter((r) => r.kind === 'intake');
    expect(intake.map((r) => r.project)).toEqual(['blank']);

    // the preview job stops as tray's: its record, log and receipt
    t.type(`/stop ${job}`);
    const stopped = await t.waitFor(new RegExp(`${job} cancelled {2}preview the project: it and its process group have stopped`));
    capture('pty-02-project-add-stop', stopped, dir);
    const record = JSON.parse(readFileSync(join(timmyHome, 'jobs', `${job}.json`), 'utf8')) as { root: string; project: string; state: string };
    expect({ root: record.root, project: record.project, state: record.state }).toEqual({ root: tray, project: 'tray', state: 'cancelled' });
    expect(existsSync(join(timmyHome, 'jobs', `${job}.log`))).toBe(true);
    const sealed = receipts(store).filter((r) => r.kind === 'preview');
    expect(sealed.map((r) => ({ project: r.project, project_id: r.project_id, job: r.job?.id, state: r.job?.state }))).toEqual([{ project: 'tray', project_id: projectId(tray), job, state: 'cancelled' }]);

    // the other process chooses tray again: the REPL, idle, follows at once
    choose(tray, 'tray');
    const back = await t.waitFor(/Now in tray: the active project changed \(chosen in the Workbench\), and this REPL follows it; \/project shows it\./);
    capture('pty-03-back-to-tray', back, dir);
    t.type('/exit');
    await t.waitFor(/EXIT1=0/);
  }, 180_000);
});
