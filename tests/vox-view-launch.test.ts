// Timmy VoxVision's /vox view, round R4 (helper H70): what the Mac run r20 found. The window warning is on the screen
// before Rerun starts, then Rerun starts, then the answer says what started (the REPL and the live board's View in
// Rerun); Rerun is told to listen on this computer only (--bind 127.0.0.1), and a rerun whose --help lacks that option is
// not started; a STEP record is shown as its tessellation by OCP, kept in the record's folder with its sha256 and
// tolerance, said as a tessellation and never the STEP itself, and sealed with the view; the board still draws a record's
// highlights after a view.
//
// FAKE: Rerun here is the FAKE `rerun` of tests/helpers/vox-fakes.ts (no window, no socket: it logs its arguments, the
// screen as it starts, and its --help calls), and OCP's STEP readback and tessellation are that helper's FAKE workers (no
// OCP: a box STL of the readback's size). Real: the records, receipts, files, jobs, child processes and HTTP, Timmy's STL
// reader, and, at the end, workers/readback/step_tessellate.py itself with this machine's python3 (which has no OCP).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectId } from '../src/project/index.js';
import { readVoxRecord } from '../src/repl/board-vox.js';
import { realOnPath } from '../src/repl/center.js';
import type { Segment } from '../src/term/theme.js';
import type { Receipt } from '../src/utils/receipts.js';
import { resetLookChecks } from '../src/vision/look.js';
import { DOCTRINE_15, type VoxRecord } from '../src/vox/record.js';
import { parseTessellation, TESSELLATE_SCRIPT, TESSELLATION } from '../src/vox/tessellate.js';
import { cubeStl, fakeRerun, fakeTools, put, settled, sha, tempKit, text, workspace } from './helpers/vox-fakes.js';

const kit = tempKit();
afterEach(async () => { resetLookChecks(); await kit.cleanup(); });

const SYSTEM_PATH = '/usr/bin:/bin';
const BIND = ['--bind', '127.0.0.1'];
const WARNING = "  Rerun      opens a window on your computer: Rerun's own viewer, started apart from Timmy (detached), which Timmy does not stop; close its window when done. It shows the files as they are and measures nothing.";
const ADDRESS = '  address    told to listen on this computer only (--bind 127.0.0.1) · a Rerun viewer already listening on its port is given the files instead and keeps its own address';
const chainOf = (sealed: unknown[]): Receipt[] => sealed.map((r, i) => ({ ...(r as object), hash: `sha256:${String(i + 1).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[];
const fileSha = (root: string, rel: string): string => sha(readFileSync(join(root, rel)));
const recordAt = (root: string, id: string): VoxRecord => JSON.parse(readFileSync(join(root, `results/vox/${id}.json`), 'utf8')) as VoxRecord;

/** What the FAKE rerun logged as it started: its arguments and the screen then; null while it has not run. */
async function rerunLog(path: string, ms = 5000): Promise<{ args: string[]; screen: string[] } | null> {
  const end = Date.now() + ms;
  while (!existsSync(path) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  return { args: lines.filter((l) => l.startsWith('arg ')).map((l) => l.slice(4)), screen: lines.filter((l) => l.startsWith('screen ')).map((l) => l.slice(7)) };
}

/**
 * A project with an STL and a STEP, each measured (the STEP by the FAKE readback: 10 × 20 × 30 mm), a FAKE rerun on the
 * PATH, and a screen: every line the REPL prints (the workspace's notify now, the command's answer when `print` is called),
 * kept in order and appended to a file the FAKE rerun copies as it starts.
 */
async function viewProject() {
  const root = realpathSync(kit.temp('vox-launch-'));
  put(root, 'models/cube.stl', cubeStl(1));
  put(root, 'cad/part.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
  const fake = fakeTools(kit.temp('vox-fake-'));
  const bin = kit.temp('vox-rerun-');
  fakeRerun(bin);
  const logs = kit.temp('vox-rerun-log-');
  const screenFile = join(logs, 'screen.txt');
  const screen: string[] = [];
  const print = (l: Segment[]): void => { const t = l.map((s) => s.text).join(''); screen.push(t); appendFileSync(screenFile, `${t}\n`); };
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${SYSTEM_PATH}`, FAKE_RERUN_LOG: join(logs, 'rerun.log'), FAKE_RERUN_HELP_LOG: join(logs, 'help.log'), FAKE_RERUN_SCREEN: screenFile,
    TIMMY_CADQUERY_PYTHON: fake.step,
  };
  const w = workspace(root, kit, { env, onPath: (c) => realOnPath(c, env), extra: { notify: print } });
  await w.ws.measure('models/cube.stl');
  await w.ws.measure('cad/part.step');
  await settled(w.ws);
  const ids = readdirSync(join(root, 'results', 'vox')).filter((f) => /^v[0-9a-f]{8}\.json$/.test(f)).map((f) => f.slice(0, 9));
  const id = (kind: string): string => ids.find((x) => recordAt(root, x).inputs[0].kind === kind)!;
  /** The command as a person sees it: the lines printed while it ran, then its answer (printed when it returns). */
  const view = async (args: string): Promise<{ out: Segment[][]; said: string[]; screen: string }> => {
    const n = screen.length;
    const out = await w.ws.voxView(args);
    const said = screen.slice(n);
    for (const l of out) print(l);
    return { out, said, screen: screen.slice(n).join('\n') };
  };
  return { root, env, fake, log: env.FAKE_RERUN_LOG!, helpLog: env.FAKE_RERUN_HELP_LOG!, screen, print, view, ...w, stl: id('stl'), step: id('step') };
}

describe('/vox view says the window first, then starts Rerun, then says what started (r20 (5))', () => {
  it('the warning is on the screen when Rerun starts; the answer is only what started; Rerun is told --bind 127.0.0.1', async () => {
    const p = await viewProject();
    const n = p.screen.length;
    const out = await p.ws.voxView(`view ${p.stl}`);
    const said = p.screen.slice(n);
    // What was on the screen as the FAKE rerun started (it copies the screen file first thing): the warning, where it is
    // told to listen, what is passed, the notice. Before H70 these came back with the answer, after Rerun had started.
    const got = (await rerunLog(p.log))!;
    expect(got.screen).toEqual(expect.arrayContaining([WARNING, ADDRESS, '  passed     models/cube.stl (mesh, stl)', `  notice     ${DOCTRINE_15}`]));
    // Then the REPL prints the answer: what started, and only that.
    for (const l of out) p.print(l);
    expect(said).toEqual([
      WARNING, ADDRESS, '  passed     models/cube.stl (mesh, stl)',
      `  not passed results/vox/${p.stl}/bbox.svg: an SVG drawing: Rerun's viewer reads no SVG (the board shows it)`, `  notice     ${DOCTRINE_15}`,
    ]);
    expect(text(out)).toMatch(new RegExp(`^  started    pid \\d+ · rerun on the PATH · recorded on results/vox/${p.stl}\\.json · receipt r\\d+$`));
    expect(p.screen.slice(n).findIndex((l) => l.startsWith('  started '))).toBe(said.length);
    // Rerun's command line: told to listen on this computer only, then the file; its --help was read once first.
    expect(got.args).toEqual([...BIND, join(p.root, 'models/cube.stl')]);
    expect(readFileSync(p.helpLog, 'utf8')).toBe('help\n');
    // Recorded and sealed with the address; the receipt names the record's highlight as it is, after the record.
    const rec = recordAt(p.root, p.stl);
    expect(rec.views![0].bind).toBe('127.0.0.1');
    const rc = p.sealed.at(-1)!;
    expect(rc.sources![0]).toMatchObject({ event: 'view', bind: '127.0.0.1' });
    expect(rc.outputs!.map((o) => o.path)).toEqual([`results/vox/${p.stl}.json`, `results/vox/${p.stl}/bbox.svg`]);
  });

  it('a rerun whose --help lists no --bind, or whose --help fails, is not started, and nothing is said of a window', async () => {
    const p = await viewProject();
    const rel = `results/vox/${p.stl}.json`;
    const s = fileSha(p.root, rel);
    const n = p.sealed.length;
    p.env.FAKE_RERUN_NO_BIND = '1';
    const v = await p.view(`view ${p.stl}`);
    expect(v.said).toEqual([]);
    expect(text(v.out)).toBe([
      "  not started Rerun's viewer (/vox view), rerun on the PATH: its --help lists no --bind option, so started it would listen on all interfaces · Timmy starts it only told to listen on this computer (--bind 127.0.0.1, as in Rerun 0.37.1's and 0.38.1's --help, and Rerun's current CLI reference) · update Rerun: cargo install rerun-cli --locked, or Rerun's release from its site",
      '  Nothing was started and nothing was written.',
    ].join('\n'));
    delete p.env.FAKE_RERUN_NO_BIND;
    p.env.FAKE_RERUN_HELP_FAIL = '1';
    expect(text((await p.view(`view ${p.stl}`)).out)).toContain('its --help ended with exit 2, so whether it takes --bind is not known');
    expect(await rerunLog(p.log, 300)).toBeNull();
    expect([fileSha(p.root, rel), p.sealed.length]).toEqual([s, n]);
    expect(readFileSync(p.helpLog, 'utf8')).toBe('help\nhelp\n');
  });

  it('on the live board, View in Rerun puts the warning in the transcript before Rerun starts, and first in the page\'s answer', async () => {
    const p = await viewProject();
    await p.ws.boardLive('live');
    const { port, url } = p.ws.liveBoard!;
    const token = url.split('#t=')[1];
    const post = (body: string): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/action', method: 'POST', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
        let t = '';
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
      });
      req.on('error', reject);
      req.end(body);
    });
    const n = p.screen.length;
    const out = await post(JSON.stringify({ action: 'vox', verb: 'view', id: p.stl }));
    expect(out.status).toBe(200);
    const page = out.text.split('\n');
    expect(page.slice(0, 3)).toEqual([`board /vox view ${p.stl} rerun`, WARNING, ADDRESS]);
    expect(page.at(-1)).toMatch(/^ {2}started {4}pid \d+ · rerun on the PATH · recorded on/);
    // The transcript: the board's line, the warning (before Rerun started), then what started.
    const shown = p.screen.slice(n);
    expect(shown.slice(0, 3)).toEqual([`  board  /vox view ${p.stl} rerun`, WARNING, ADDRESS]);
    expect(shown.findIndex((l) => l.startsWith('  started '))).toBeGreaterThan(shown.indexOf(WARNING));
    const got = (await rerunLog(p.log))!;
    expect(got.screen).toContain(WARNING);
    expect(got.args).toEqual([...BIND, join(p.root, 'models/cube.stl')]);
  });
});

describe('/vox view of a STEP: its tessellation by OCP (FAKE worker), never the STEP itself', () => {
  it('meshes the STEP as a job, checks the mesh, keeps it in the record\'s folder, passes it, and seals it with the view', async () => {
    const p = await viewProject();
    const rel = `results/vox/${p.step}.json`;
    const mesh = `results/vox/${p.step}/tessellation.stl`;
    const jobs = p.ws.jobs.list().length;
    const v = await p.view(`view ${p.step}`);
    const got = (await rerunLog(p.log))!;
    expect(got.args).toEqual([...BIND, join(p.root, mesh)]);
    const stl = readFileSync(join(p.root, mesh));
    const stepSha = fileSha(p.root, 'cad/part.step');
    // Said in order, before Rerun started: the warning, the address, the job, its end, what is passed, what the mesh is.
    const words = `${mesh} is a tessellation of cad/part.step, not the STEP itself: timmy-step-tessellate fake (OCP 7.9-fake) meshed its surfaces within 0.1 mm (linear deflection) and 0.5 rad (angular) · 12 triangles · sha256 ${sha(stl).slice(0, 12)}… · Timmy's reading of it (10 × 20 × 30 mm) is within 0.201 mm of OCP's box of the STEP (10 × 20 × 30 mm)`;
    expect(v.said[0]).toBe(WARNING);
    expect(v.said[1]).toBe(ADDRESS);
    expect(v.said[2]).toMatch(/^ {2}tessellate cad\/part\.step: OCP meshes it for the viewer, within 0\.1 mm \(linear deflection\) and 0\.5 rad \(angular\) · job j[0-9a-f]{6}$/);
    const job = /job (j[0-9a-f]{6})$/.exec(v.said[2])![1];
    expect(v.said.slice(3)).toEqual([
      expect.stringMatching(new RegExp(`^ {2}✓ ${job} completed {2}vox view ${p.step} · tessellate cad/part\\.step \\(OCP\\)`)),
      `  passed     ${mesh} (mesh, stl)`,
      `  mesh       ${words}`,
      `  not passed cad/part.step: Rerun's viewer has no STEP loader (a STEP is CAD, not a mesh): its tessellation ${mesh} is passed instead`,
      `  not passed results/vox/${p.step}/bbox.svg: an SVG drawing: Rerun's viewer reads no SVG (the board shows it)`,
      `  notice     ${DOCTRINE_15}`,
    ]);
    expect(got.screen).toContain(`  mesh       ${words}`);
    expect(p.ws.jobs.list().length).toBe(jobs + 1);
    expect(p.ws.jobs.get(job)).toMatchObject({ state: 'completed', exitCode: 0 });
    // The record keeps the mesh beside the launch: its sha256, its tolerance, what it was made from and how it was checked.
    const rec = recordAt(p.root, p.step);
    const raw = `.timmy/vox/${p.step}/tessellate-${job}.log`;
    expect(rec.views![0]).toMatchObject({
      bind: '127.0.0.1', passed: [{ path: mesh, sha256: sha(stl), loader: 'mesh (stl)' }],
      not_passed: [{ path: 'cad/part.step', why: `Rerun's viewer has no STEP loader (a STEP is CAD, not a mesh): its tessellation ${mesh} is passed instead` }, { path: `results/vox/${p.step}/bbox.svg`, why: expect.any(String) }],
    });
    expect(rec.views![0].derived).toEqual([{
      path: mesh, sha256: sha(stl), bytes: stl.length, kind: 'tessellation', format: 'stl', from: { path: 'cad/part.step', sha256: stepSha },
      method: "FAKE: a box of the readback's size, not a mesh of the STEP; written by FAKE", tolerance: { linear_deflection_mm: 0.1, angular_deflection_rad: 0.5, relative: false },
      triangles: 12, made_by: 'timmy-step-tessellate fake (OCP 7.9-fake)', made: 'now', job, raw: { path: raw, sha256: fileSha(p.root, raw), bytes: statSync(join(p.root, raw)).size },
      check: { by: "timmy-stl-readback/1 (Timmy's own STL reader)", triangles: 12, box: [10, 20, 30], against: { box: [10, 20, 30], within_mm: 0.201, max_difference_mm: 0 } },
      words,
    }]);
    // Sealed as the launch is: the record first (so the board reads it), its highlight as it is, the mesh, the job's output.
    const rc = p.sealed.at(-1)!;
    expect(rc.outputs).toEqual([
      { path: rel, sha256: fileSha(p.root, rel), bytes: statSync(join(p.root, rel)).size },
      { path: `results/vox/${p.step}/bbox.svg`, sha256: fileSha(p.root, `results/vox/${p.step}/bbox.svg`), bytes: statSync(join(p.root, `results/vox/${p.step}/bbox.svg`)).size },
      { path: mesh, sha256: sha(stl), bytes: stl.length }, { path: raw, sha256: fileSha(p.root, raw), bytes: statSync(join(p.root, raw)).size },
    ]);
    expect(rc.files).toEqual([{ path: mesh, sha256: sha(stl), kind: 'mesh' }]);
    expect(rc.job).toMatchObject({ id: job, state: 'completed', exit_code: 0 });
    expect(rc.sources![0]).toMatchObject({ derived: [{ path: mesh, sha256: sha(stl), kind: 'tessellation', from: { path: 'cad/part.step', sha256: stepSha }, tolerance: { linear_deflection_mm: 0.1, angular_deflection_rad: 0.5, relative: false }, made: 'now', job }] });
    expect(JSON.stringify([rec, rc])).not.toContain(p.root);
    // The card: verified, its drawing still shown, its view naming the tessellation in words.
    const card = readVoxRecord({ root: p.root, file: rel, text: readFileSync(join(p.root, rel), 'utf8'), fileSha256: fileSha(p.root, rel), chain: chainOf(p.sealed), projectId: projectId(p.root) })!;
    expect(card.check.status).toBe('verified');
    expect(card.highlights.map((h) => [h.path, h.shown])).toEqual([[`results/vox/${p.step}/bbox.svg`, true]]);
    expect(card.views![0]).toMatchObject({ bind: '127.0.0.1', passed: [mesh], derived: [{ path: mesh, from: 'cad/part.step', words }] });

    // A second view uses that tessellation again (its bytes unchanged): no job runs and no new file is made.
    rmSync(p.log);
    const again = await p.view(`view ${p.step}`);
    expect((await rerunLog(p.log))!.args).toEqual([...BIND, join(p.root, mesh)]);
    expect(p.ws.jobs.list().length).toBe(jobs + 1);
    expect(again.said.some((l) => l.startsWith('  tessellate '))).toBe(false);
    expect(again.said).toContain(`  mesh       ${mesh} is a tessellation of cad/part.step, not the STEP itself: timmy-step-tessellate fake (OCP 7.9-fake) meshed its surfaces within 0.1 mm (linear deflection) and 0.5 rad (angular); made by an earlier view (${rec.views![0].at}), its bytes unchanged · 12 triangles · sha256 ${sha(stl).slice(0, 12)}… · Timmy's reading of it (10 × 20 × 30 mm) is within 0.201 mm of OCP's box of the STEP (10 × 20 × 30 mm)`);
    expect(recordAt(p.root, p.step).views![1].derived![0]).toMatchObject({ path: mesh, sha256: sha(stl), made: 'reused' });
    expect(readdirSync(join(p.root, `results/vox/${p.step}`)).sort()).toEqual(['bbox.svg', 'tessellation.stl']);
  });

  it('refusals: needs setup without TIMMY_CADQUERY_PYTHON or OCP; a mesh that is not the bytes reported, or not the STEP\'s box, is kept aside and not passed', async () => {
    const p = await viewProject();
    const rel = `results/vox/${p.step}.json`;
    const s = fileSha(p.root, rel);
    const n = p.sealed.length;
    // No TIMMY_CADQUERY_PYTHON (and no earlier tessellation): needs setup with its step; nothing printed, run or written.
    const python = p.env.TIMMY_CADQUERY_PYTHON;
    delete p.env.TIMMY_CADQUERY_PYTHON;
    const jobs = p.ws.jobs.list().length;
    const none = await p.view(`view ${p.step}`);
    expect(none.said).toEqual([]);
    expect(text(none.out)).toBe([
      `  Nothing of ${p.step} can be opened in Rerun's viewer (it reads images (PNG, JPEG, GIF, WebP), meshes (.stl, .obj, .glb, .gltf), point clouds (.ply), video (.mp4)):`,
      "  not passed cad/part.step: Rerun's viewer has no STEP loader (a STEP is CAD, not a mesh), and its tessellation for the viewer needs setup",
      `  not passed results/vox/${p.step}/bbox.svg: an SVG drawing: Rerun's viewer reads no SVG (the board shows it)`,
      '  needs setup its tessellation for the viewer (OCP), of cad/part.step: TIMMY_CADQUERY_PYTHON is not set · set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery (its OCP reads the STEP)',
      '  Nothing was started and nothing was written.',
    ].join('\n'));
    expect(p.ws.jobs.list().length).toBe(jobs);
    p.env.TIMMY_CADQUERY_PYTHON = python;
    // That Python without OCP (the worker's exit 3): needs setup, said after the job; its output kept beside the record.
    p.env.FAKE_NO_OCP = '1';
    const noOcp = await p.view(`view ${p.step}`);
    expect(text(noOcp.out)).toContain('  needs setup its tessellation for the viewer (OCP), of cad/part.step: OCP is not importable (FAKE) · set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery (its OCP reads the STEP)');
    expect(text(noOcp.out)).toContain('  Nothing was started and the record was not changed; what its tessellation printed is kept beside it.');
    expect(readdirSync(join(p.root, `.timmy/vox/${p.step}`)).filter((f) => f.startsWith('tessellate-'))).toHaveLength(1);
    delete p.env.FAKE_NO_OCP;
    // A worker that reports a sha256 other than the file's: not passed; the file kept as written in the private folder.
    p.env.FAKE_TESS_BAD_SHA = '1';
    const bad = text((await p.view(`view ${p.step}`)).out);
    expect(bad).toMatch(new RegExp(`failed {5}the tessellation of cad/part\\.step: results/vox/${p.step}/tessellation\\.stl is not the bytes reported \\(sha256 [0-9a-f]{12} now, 000000000000 reported\\); the file is kept as written in \\.timmy/vox/${p.step}/rejected-j[0-9a-f]{6}-tessellation\\.stl`));
    delete p.env.FAKE_TESS_BAD_SHA;
    // A mesh whose box is not the STEP's (31 mm, not 30): it does not show that STEP, so it is not passed either.
    p.env.FAKE_TESS_SIZE = '10,20,31';
    const off = text((await p.view(`view ${p.step}`)).out);
    expect(off).toContain("its box (10 × 20 × 31 mm) is 1 mm from OCP's box of the STEP (10 × 20 × 30 mm), more than 0.201 mm (twice the linear deflection): it does not show that STEP");
    delete p.env.FAKE_TESS_SIZE;
    expect(readdirSync(join(p.root, `.timmy/vox/${p.step}`)).filter((f) => f.startsWith('rejected-'))).toHaveLength(2);
    expect(existsSync(join(p.root, `results/vox/${p.step}/tessellation.stl`))).toBe(false);
    expect(await rerunLog(p.log, 300)).toBeNull();
    expect([fileSha(p.root, rel), p.sealed.length]).toEqual([s, n]);
    // A STEP changed since the record is not meshed: Rerun would show other bytes than were measured.
    put(p.root, 'cad/part.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\n/* changed */\n');
    const changed = text((await p.view(`view ${p.step}`)).out);
    expect(changed).toMatch(/not passed cad\/part\.step: it changed since the record \(sha256 [0-9a-f]{12} now, [0-9a-f]{12} recorded\)/);
    expect(changed).toContain('Nothing was started and nothing was written.');
    expect(p.ws.jobs.list().filter((j) => j.label.includes('tessellate'))).toHaveLength(3);
  });
});

describe('the board after a view', () => {
  it('still draws a record\'s highlights when its newest receipt is a view sealed before H70 (it named only the record)', async () => {
    const p = await viewProject();
    const rel = `results/vox/${p.stl}.json`;
    const svg = `results/vox/${p.stl}/bbox.svg`;
    // A view as H61 recorded and sealed it: the record with its view, and a receipt naming the record only.
    const rec = recordAt(p.root, p.stl);
    const at = new Date().toISOString();
    rec.views = [{ viewer: 'rerun', at, program: 'rerun on the PATH', passed: [{ path: 'models/cube.stl', sha256: fileSha(p.root, 'models/cube.stl'), loader: 'mesh (stl)' }], not_passed: [{ path: svg, why: 'an SVG drawing' }], detached: true, pid: 1 }];
    writeFileSync(join(p.root, rel), `${JSON.stringify(rec, null, 2)}\n`);
    p.sealed.push({ kind: 'vox', subject: `vox · view · ${p.stl} · rerun · started`, policy: 'human-gated', status: 'ok', project_id: projectId(p.root), outputs: [{ path: rel, sha256: fileSha(p.root, rel), bytes: statSync(join(p.root, rel)).size }], sources: [{ vox: p.stl, event: 'view', viewer: 'rerun', at }] });
    const card = readVoxRecord({ root: p.root, file: rel, text: readFileSync(join(p.root, rel), 'utf8'), fileSha256: fileSha(p.root, rel), chain: chainOf(p.sealed), projectId: projectId(p.root) })!;
    expect(card.check.status).toBe('verified');
    expect(card.highlights.map((h) => [h.path, h.shown, h.why])).toEqual([[svg, true, undefined]]);
    // Bytes no receipt of this record sealed are still not drawn.
    writeFileSync(join(p.root, svg), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const changed = readVoxRecord({ root: p.root, file: rel, text: readFileSync(join(p.root, rel), 'utf8'), fileSha256: fileSha(p.root, rel), chain: chainOf(p.sealed), projectId: projectId(p.root) })!;
    expect(changed.highlights.map((h) => [h.shown, h.why])).toEqual([[false, 'its file is not the bytes the record and its receipt name']]);
  });
});

describe('the tessellation worker\'s answer', () => {
  const good = {
    ok: true, worker: { name: 'timmy-step-tessellate', version: '0.1.0' }, engine: { ocp: '7.9.3.1' }, source: { name: 'cad/a.step', sha256: 'a'.repeat(64), bytes: 30 }, units: 'mm', unit_in_effect: 'MM',
    tessellation: { method: 'BRepMesh', linear_deflection_mm: 0.1, angular_deflection_rad: 0.5, relative: false, triangles: 12 },
    output: { file: 'tessellation.stl', format: 'stl-binary', sha256: 'b'.repeat(64), bytes: 684, triangles: 12, writer: 'StlAPI_Writer (binary)' },
  };
  it('is read from its last JSON line; anything it does not say is a failure with the reason, never filled in', () => {
    expect(parseTessellation(`noise\n${JSON.stringify(good)}\n`)).toMatchObject({ ok: true, output: { file: 'tessellation.stl', triangles: 12 }, tessellation: { linear_deflection_mm: 0.1 } });
    expect(parseTessellation('')).toEqual({ ok: false, code: 'no-output', error: 'the worker printed nothing' });
    expect(parseTessellation(JSON.stringify({ ...good, ok: false, error: { code: 'no-ocp', message: 'OCP is not importable' } }))).toMatchObject({ ok: false, code: 'no-ocp', error: 'OCP is not importable' });
    expect(parseTessellation(JSON.stringify({ ...good, units: 'm' }))).toMatchObject({ ok: false, code: 'malformed', error: "the result line's units are m, not mm" });
    expect(parseTessellation(JSON.stringify({ ...good, tessellation: { ...good.tessellation, relative: true } }))).toMatchObject({ ok: false, code: 'malformed' });
    expect(parseTessellation(JSON.stringify({ ...good, output: { ...good.output, sha256: 'x' } }))).toMatchObject({ ok: false, code: 'malformed' });
    expect(TESSELLATION).toEqual({ linear_deflection_mm: 0.1, angular_deflection_rad: 0.5 });
  });
});

const python3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0 ? 'python3' : null;
describe.skipIf(!python3)('workers/readback/step_tessellate.py, the real worker, with this machine\'s python3', () => {
  const run = (args: string[]): { status: number | null; json: Record<string, unknown> | null } => {
    const r = spawnSync(python3!, [TESSELLATE_SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000 });
    const last = r.stdout.trim().split('\n').pop() ?? '';
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(last) as Record<string, unknown>; } catch { json = null; }
    return { status: r.status, json };
  };
  it('says a usage error, a missing file and an output already there; without OCP it stops at exit 3 having read the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vox-tess-worker-'));
    try {
      expect(run([])).toMatchObject({ status: 64, json: { ok: false, error: { code: 'usage' } } });
      expect(run([join(dir, 'a.step')])).toMatchObject({ status: 64, json: { ok: false, error: { code: 'usage' } } });
      expect(run([join(dir, 'missing.step'), '--out', join(dir, 'm.stl')])).toMatchObject({ status: 2, json: { ok: false, error: { code: 'unreadable' } } });
      const step = join(dir, 'a.step');
      writeFileSync(step, 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
      writeFileSync(join(dir, 'there.stl'), 'a file of the user');
      expect(run([step, '--out', join(dir, 'there.stl')])).toMatchObject({ status: 2, json: { ok: false, error: { code: 'exists' } } });
      expect(readFileSync(join(dir, 'there.stl'), 'utf8')).toBe('a file of the user');
      const hasOcp = spawnSync(python3!, ['-c', 'import OCP'], { encoding: 'utf8' }).status === 0;
      if (!hasOcp) {
        const r = run([step, '--out', join(dir, 'a.stl'), '--as', 'cad/a.step']);
        expect(r).toMatchObject({ status: 3, json: { ok: false, error: { code: 'no-ocp' }, source: { name: 'cad/a.step', sha256: sha(readFileSync(step)), bytes: statSync(step).size } } });
        expect(parseTessellation(JSON.stringify(r.json))).toMatchObject({ ok: false, code: 'no-ocp' });
        expect(existsSync(join(dir, 'a.stl'))).toBe(false);
      }
      expect(readdirSync(dir).sort()).toEqual(['a.step', 'there.stl']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
