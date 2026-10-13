/**
 * Pi Durable S1 (R4 H118), fix S1 of H119's review: what the Pi worker owns is out of reach of agent file tools.
 *
 * Before the fix it all lived in <project>/.timmy/pi/, which Timmy's own read and listing (src/project: they refuse only
 * .timmy/private) and Pi's own file tools could reach: an agent could read the live socket token into a model's context,
 * and slow_write could overwrite the effect ledger, erasing every started and unknown record. Now everything the worker
 * owns is in .timmy/private/pi/ (worker.token, worker.json, the store, the ledger, run records and events, starts.jsonl,
 * trial copies), and Pi's file tools refuse any path inside .timmy/, by the name asked for and by the file a link
 * leads to, and write nothing.
 *
 * REAL: Pi's file tools (slow_read, slow_write) called in this process on a fixture project and its ledger (no worker,
 * no model); Pi worker processes started by the supervisor and the files they write; Timmy's own project read and
 * listing (src/project, imported here, not changed). FAKE: the model (pi-ai's scripted faux provider), the fixture
 * projects and the fixture files planted in their .timmy folders.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PiApi, ToolResult, ToolSpec } from '../src/pi-durable/adapter/pi-api.js';
import { EffectLedger } from '../src/pi-durable/effects.js';
import { piPaths } from '../src/pi-durable/paths.js';
import { slowTools } from '../src/pi-durable/slow-tools.js';
import { listProjectFiles, readProjectFile } from '../src/project/index.js';
import { anyAlive, cleanup, delegate, effects, ended, INSTALLED, project, sha, SKIP_WHY, start, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts, under a loaded suite
afterAll(() => { cleanup(); });

/** The tools as the worker builds them, with a stand-in for pi-ai's schema builder (execute() never reads it). */
const stubPi = { schema: { object: (f: unknown) => f, string: () => ({}), integer: () => ({}), boolean: () => ({}), array: () => ({}), optional: (s: unknown) => s } } as unknown as PiApi;
const api = (n: number) => ({ taskId: n, conversationId: 1, callId: `call-${n}` });
const said = (r: ToolResult): string => r.content.map((c) => c.text).join('');
const REFUSED = /^refused: .* is inside \.timmy\/, Timmy's own folder \(its Pi worker's token, store and effect ledger live there\): Pi's file tools never read or write it$/;
const read = (path: string): string | undefined => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };

describe('Pi\'s file tools never reach .timmy/ (fix S1), called in this process', () => {
  it('slow_read and slow_write refuse every path inside .timmy/ (by the name asked for, its spelling, and the file a link leads to) and write nothing', async () => {
    const root = project('private-tools', { 'a.txt': 'project bytes' });
    // FAKE fixture files where the worker keeps (and kept) what it owns, and elsewhere in Timmy's folder
    const planted: Record<string, string> = {
      '.timmy/pi/effects.jsonl': '{"key":"slow_write:x.txt:aaaaaaaa","state":"started"}\n',
      '.timmy/pi/worker.token': 'OLD-PLACE-TOKEN\n',
      '.timmy/private/pi/effects.jsonl': '{"key":"slow_write:y.txt:aaaaaaaa","state":"unknown"}\n',
      '.timmy/private/pi/worker.token': 'NEW-PLACE-TOKEN\n',
      '.timmy/notes.txt': 'Timmy\'s own notes\n',
    };
    for (const [rel, text] of Object.entries(planted)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); }
    symlinkSync('.timmy/pi/effects.jsonl', join(root, 'ledger-link.txt'));
    symlinkSync('.timmy/pi', join(root, 'pi-folder-link'));
    const p = piPaths(root);
    mkdirSync(p.dir, { recursive: true });
    const ledger = new EffectLedger(p.effects);
    const tools = slowTools(stubPi, { root, ledger, readsLog: join(p.dir, 'reads.jsonl'), runOf: () => 'aaaaaaaa' });
    const slowRead = tools.find((t) => t.name === 'slow_read') as ToolSpec;
    const slowWrite = tools.find((t) => t.name === 'slow_write') as ToolSpec;
    const asked = [
      '.timmy/pi/effects.jsonl', '.timmy/pi/worker.token', '.timmy/private/pi/effects.jsonl', '.timmy/private/pi/worker.token', '.timmy/notes.txt',
      './.timmy/../.timmy/pi/effects.jsonl', '.Timmy/pi/effects.jsonl', 'ledger-link.txt', 'pi-folder-link/effects.jsonl', join(root, '.timmy', 'pi', 'effects.jsonl'),
      '.timmy/pi/new-file.txt',
    ];
    const before = Object.fromEntries(Object.keys(planted).map((rel) => [rel, read(join(root, rel))]));
    let n = 0;
    for (const path of asked) {
      const current = read(join(root, path.startsWith('/') ? relative(root, path) : path));
      const w = await slowWrite.execute({ path, content: 'ERASED BY A PI TOOL', expected_sha256: current === undefined ? 'absent' : sha(current) }, api(++n), {});
      expect([path, w.isError, said(w)]).toEqual([path, true, expect.stringMatching(REFUSED)]);
      const r = await slowRead.execute({ path }, api(++n), {});
      expect([path, r.isError, said(r)]).toEqual([path, true, expect.stringMatching(REFUSED)]);
      expect(said(r)).not.toMatch(/TOKEN|sha256/);
    }
    // nothing was written: the planted files are as they were, no new file appeared, no effect and no read were recorded
    expect(Object.fromEntries(Object.keys(planted).map((rel) => [rel, read(join(root, rel))]))).toEqual(before);
    expect(existsSync(join(root, '.timmy', 'pi', 'new-file.txt'))).toBe(false);
    expect(ledger.all().filter((e) => e.run === 'aaaaaaaa' && e.tool === 'slow_write')).toEqual([]);
    expect(read(join(p.dir, 'reads.jsonl'))).toBeUndefined();
    // the tools still work outside .timmy/
    expect(said(await slowWrite.execute({ path: 'a.txt', content: 'new bytes', expected_sha256: sha('project bytes') }, api(++n), {}))).toBe(`wrote a.txt (sha256 ${sha('new bytes')})`);
    expect(said(await slowRead.execute({ path: 'a.txt' }, api(++n), {}))).toBe(`read a.txt: sha256 ${sha('new bytes')}`);
  });
});

describe.skipIf(!INSTALLED)(`what the worker owns lives in .timmy/private/pi (fix S1)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('the token, worker.json, the store, the ledger, run records and events, starts and trial copies are in .timmy/private/pi; Timmy\'s own read and listing refuse them', async () => {
    const root = project('private-place', { 'a.txt': 'old bytes' });
    const a = await start(root, { worker: { trialShell: true } });
    const p = piPaths(root);
    expect(relative(root, p.dir)).toBe(join('.timmy', 'private', 'pi'));
    const w = await delegate(a.client, { first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes') } } });
    expect((await ended(a.client, w.run)).status).toBe('completed');
    const t = await delegate(a.client, { first: { tool: 'trial_shell', args: { argv: [process.execPath, '-e', "process.stdout.write('FAKE trial output')"] } } });
    expect((await ended(a.client, t.run)).status).toBe('completed');
    const trial = effects(root, t.run).find((e) => e.state === 'started')!;
    const owned = [p.token, p.owner, p.store, p.effects, p.starts, join(p.runs, `${w.run}.json`), join(p.runs, `${w.run}.events.jsonl`), join(root, trial.output!), join(root, `.timmy/private/pi/${t.run}/trial`)];
    for (const f of owned) expect([relative(root, f), existsSync(f)]).toEqual([relative(root, f), true]);
    for (const f of owned) expect(relative(root, f).startsWith(join('.timmy', 'private', 'pi'))).toBe(true);
    expect(effects(root, t.run).map((e) => e.key)).toEqual([`trial_shell:.timmy/private/pi/${t.run}/trial:${t.run}`, `trial_shell:.timmy/private/pi/${t.run}/trial:${t.run}`]);
    expect(existsSync(join(root, '.timmy', 'pi'))).toBe(false);
    // Timmy's own file tools (src/project) refuse what is under .timmy/private, and its listing never shows it
    for (const f of [p.token, p.owner, p.effects]) {
      const r = readProjectFile(root, relative(root, f));
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/is private: keys, \.env files and \.timmy\/private stay out of reach/);
    }
    const listed = listProjectFiles(root).files.map((f) => f.rel);
    expect(listed).toContain('a.txt');
    expect(listed.filter((rel) => rel.startsWith('.timmy/'))).toEqual([]);
    await a.client.request('shutdown');
    a.client.close();
  });

  it('a FAKE model asking a Pi file tool to overwrite the live ledger or read the live token is refused with words; the ledger keeps its records', async () => {
    const root = project('private-model', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const p = piPaths(root);
    const w = await delegate(a.client, { first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes') } } });
    expect((await ended(a.client, w.run)).status).toBe('completed');
    const ledgerBefore = readFileSync(p.effects, 'utf8');
    expect(effects(root, w.run).map((e) => e.state)).toEqual(['started', 'ended']);
    // the model names the ledger and the token where they live now (wherever that is), with the right compare-and-set hash
    const erase = await delegate(a.client, { first: { tool: 'slow_write', args: { path: relative(root, p.effects), content: 'ERASED BY THE MODEL\n', expected_sha256: sha(ledgerBefore) } }, after_error: { text: 'The tool refused (FAKE answer).' } });
    const e1 = await ended(a.client, erase.run);
    const peek = await delegate(a.client, { first: { tool: 'slow_read', args: { path: relative(root, p.token) } }, after_error: { text: 'The tool refused (FAKE answer).' } });
    const e2 = await ended(a.client, peek.run);
    for (const e of [e1, e2]) {
      const result = e.entries.find((x) => x.kind === 'pi.tool-result')?.text ?? '';
      expect(result).toMatch(/refused: \.timmy\/private\/pi\/(effects\.jsonl|worker\.token) is inside \.timmy\/, Timmy's own folder/);
      expect(e.entries.at(-1)?.text).toBe('The tool refused (FAKE answer).');
    }
    const ledgerAfter = readFileSync(p.effects, 'utf8');
    expect(ledgerAfter.startsWith(ledgerBefore)).toBe(true); // nothing erased
    expect(ledgerAfter).not.toContain('ERASED');
    expect(effects(root, w.run).map((e) => e.state)).toEqual(['started', 'ended']);
    expect(effects(root, erase.run)).toEqual([]);
    await a.client.request('shutdown');
    a.client.close();
  });

  it('leaves no worker running: every worker this file started has exited', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
