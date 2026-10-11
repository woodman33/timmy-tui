/**
 * Round R4 (H65): Results and review (/review, /restore): what each operation changed, read from the records Timmy's own
 * writers keep, each file checked now, with a restore done only where it is exact. Real records written by the existing
 * writers in temporary projects (an /iterate scad flow and its kept copy, an OpenHands write-back and its before/ copies,
 * the live board's parameter, OpenSCAD parameter and workflow saves and their history copies), each sealed on the
 * project's own REAL receipts chain (appendReceipt: hash-chained and signed), and real child processes.
 *
 * FAKE pieces, each labelled where used:
 * - tests/fixtures/fake-code-agent.mjs, a TEST DOUBLE code agent (no model, nothing sent), run as Qwen Code on a local
 *   endpoint; tests/fixtures/fake-openscad.mjs, a TEST DOUBLE of OpenSCAD with no geometry engine (tests/helpers/ops-sandbox,
 *   whose `timmy` on PATH is the real CLI through tsx);
 * - tests/fixtures/fake-docker.mjs, a TEST DOUBLE of the docker client (no container, no OpenHands, no model; a SCRIPTED
 *   agent edits the copy), and a FAKE Ollama on 127.0.0.1 that only lists models (as tests/openhands-agent.test.ts uses them).
 * No model, network service, Docker or OpenSCAD runs here.
 */
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendReceipt, readChain, verifyChain, verifyReceiptIn } from '../src/utils/receipts.js';
import { folderProject, projectId } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { realOnPath } from '../src/repl/center.js';
import { glyphSet } from '../src/term/glyphs.js';
import { applyBoardEdit } from '../src/repl/board-edits.js';
import { BOARD_FILE } from '../src/repl/board.js';
import { readCard } from '../src/recipes/index.js';
import { parseWorkflow } from '../src/workflows/upmd.js';
import { takeProjectHold } from '../src/ops/flow-hold.js';
import { needsPerson } from '../src/ops/act.js';
import { AGENTS_DIR } from '../src/code-agents/index.js';
import { OPENHANDS_IMAGE } from '../src/code-agents/openhands.js';
import { checkRestoreAction } from '../src/review/html.js';
import { parseRestoreArgs, restoreArg, restoreCommand, visible, editActor } from '../src/review/changes.js';
import { act, json, opsKit, replOf, sandbox, text, until, type OpsKit, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  await kit.cleanup();
}, 60_000);

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const read = (s: Sandbox, rel: string): string => fs.readFileSync(path.join(s.root, rel), 'utf8');
const chainOf = (s: Sandbox) => readChain('runs', s.root);
/** Control and direction characters for hostile names and lines, made at run time (no such byte sits in this file). */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e);

/** A real /iterate scad flow (the FAKE agent sets width 60 → 100; the FAKE OpenSCAD exports), ended, in its operation. */
async function scadFlow(k: OpsKit, s: Sandbox, ws?: Workspace) {
  const w = ws ?? replOf(k, s).ws;
  const instruction = 'make it 100 wide PYFILE:box.params.json PYREPLACE:60,=>100,';
  const out = text(await w.operate(`/iterate scad box.scad "${instruction}"`, 'repl', () => w.iterate(`scad box.scad "${instruction}"`)));
  const h = w.ops.latest!;
  const flow = /\b(f[0-9a-f]{8})\b/.exec(out)?.[1];
  if (!flow) throw new Error(out);
  await w.ops.done(h);
  return { ws: w, op: h.id, flow, record: json(path.join(s.root, 'results', 'flows', `${flow}.json`)) };
}
/** /restore as the REPL runs a typed line: inside its own operation. */
async function restoreLine(ws: Workspace, args: string): Promise<string> {
  return text(await ws.operate(`/restore ${args}`, 'repl', () => ws.restore(args)));
}

describe('/review and /restore on a real /iterate scad flow (FAKE agent, FAKE OpenSCAD)', () => {
  it('lists what the flow changed with its record and receipt, checked now; Restore when unchanged writes the kept bytes back, keeps the version it replaced and seals an edit receipt; the review then offers the way back', async () => {
    const s = sandbox(kit, 'review-scad-');
    const original = fs.readFileSync(path.join(s.root, 'box.params.json'));
    const { ws, op, flow, record } = await scadFlow(kit, s);
    expect(record).toMatchObject({ outcome: 'succeeded', operation: op });
    const kept = `.timmy/flows/${flow}/params.before.json`;
    const changed = fs.readFileSync(path.join(s.root, 'box.params.json'));
    expect(changed.toString()).toContain('"width": 100');
    // The flow's own copy as read: the bytes the review diffs against and a restore writes back.
    expect(fs.readFileSync(path.join(s.root, kept))).toEqual(original);
    const stl = (record.openscad as { stl: { path: string; sha256: string } }).stl;

    let out = text(ws.review(''));
    expect(out).toMatch(new RegExp(`Operation ${op}  succeeded  /iterate scad box\\.scad`));
    expect(out).toContain('    changed  box.params.json');
    expect(out).toMatch(new RegExp(`by flow ${flow} \\(/iterate scad\\), its agent qwen a[0-9a-f]{8} · its parameter file, the one file its agent may change`));
    expect(out).toContain(`sha256 ${sha(original).slice(0, 12)} → ${sha(changed).slice(0, 12)} · now: unchanged since the run: sha256 ${sha(changed).slice(0, 12)}`);
    expect(out).toContain(`previous version kept at ${kept} (its sha256 is the previous version's, ${sha(original).slice(0, 12)})`);
    expect(out).toMatch(new RegExp(`record results/flows/${flow}\\.json · verified: receipt [0-9a-f]{8} sealed this record's bytes`));
    expect(out).toContain('line diff, the kept version → the file as the run left it: +1 −1 in 1 place');
    expect(out).toContain('-     "width": 60,');
    expect(out).toContain('+     "width": 100,');
    expect(out).toContain(`/restore box.params.json --from ${kept}`);
    // What OpenSCAD's run wrote: added (as its own run recorded it), nothing to restore.
    expect(out).toContain(`    added    ${stl.path}`);
    expect(out).toContain(`sha256 ${stl.sha256.slice(0, 12)} (it was not there before) · now: unchanged since the run`);
    expect(out).toContain('restore: not offered: nothing to restore: the run added it (there was no previous version)');
    // The one operation in full.
    expect(text(ws.review(op))).toContain(`/restore box.params.json --from ${kept}`);
    expect(text(ws.review('nonsense'))).toContain('nonsense is not an operation id');
    expect(text(ws.review('o00000000'))).toContain('No operation o00000000 in this project');

    // Restore: the kept bytes back, the current version kept first, an edit receipt sealed (human-gated) that verifies.
    const before = chainOf(s).length;
    out = await restoreLine(ws, `box.params.json --from ${kept}`);
    const restoreOp = ws.ops.latest!.id;
    expect(fs.readFileSync(path.join(s.root, 'box.params.json'))).toEqual(original);
    const history = /kept at (\.timmy\/restore-history\/box\.params\.json\/\S+\.json\.bak)/.exec(out)?.[1];
    expect(history, out).toBeDefined();
    expect(out).toContain('  Restored   box.params.json  from ' + kept);
    expect(out).toContain(`sha256 ${sha(original).slice(0, 12)} now (it was ${sha(changed).slice(0, 12)}, as flow ${flow} (/iterate scad), its agent`);
    expect(fs.readFileSync(path.join(s.root, history!))).toEqual(changed);
    expect(fs.statSync(path.join(s.root, history!)).mode & 0o222).toBe(0);
    const chain = chainOf(s);
    expect(chain.length).toBe(before + 1);
    const r = chain.at(-1)!;
    expect(r).toMatchObject({
      kind: 'edit', policy: 'human-gated', status: 'ok', project_id: projectId(s.root), operation_id: restoreOp,
      subject: `edit · box.params.json · restored from ${kept} (/restore)`,
      files: [{ path: 'box.params.json', sha256: sha(original), previous_sha256: sha(changed), created: false, bytes: original.length }],
    });
    expect(r.sources).toEqual(expect.arrayContaining([
      { path: kept, sha256: sha(original), role: 'restored from' },
      { path: history, sha256: sha(changed), role: 'previous version' },
    ]));
    expect(out).toContain(`receipt ${r.hash.slice(7, 15)} (edit, human-gated)`);
    expect(verifyReceiptIn(chain, r.hash).ok).toBe(true);
    expect(verifyChain('runs', s.root).ok).toBe(true);

    // The review now: the restore first, with the way back offered; the flow's change says it changed since, not offered.
    out = text(ws.review(''));
    expect(out.indexOf(`Operation ${restoreOp}`)).toBeLessThan(out.indexOf(`Operation ${op}`));
    expect(out).toContain(`by /restore (from ${kept})`);
    expect(out).not.toContain('by restored from');
    expect(out).toContain(`its receipt is its record · verified: receipt ${r.hash.slice(7, 15)} is this edit's record, and it verifies on the chain`);
    expect(out).toContain(`/restore box.params.json --from ${history}`);
    expect(out).toContain(`now: changed since the run: sha256 ${sha(original).slice(0, 12)} now, ${sha(changed).slice(0, 12)} as the run left it`);
    expect(out).toContain('no line diff: it changed since the run, so the run\'s own change cannot be drawn');
    expect(out).toContain(`restore: not offered: it changed since the run (sha256 ${sha(original).slice(0, 12)} now; the run left ${sha(changed).slice(0, 12)}): restoring would replace a later version`);
    // ... and the way back works: the agent's version again, from the restore's own history copy.
    out = await restoreLine(ws, `box.params.json --from ${history}`);
    expect(out).toContain('  Restored   box.params.json');
    expect(fs.readFileSync(path.join(s.root, 'box.params.json'))).toEqual(changed);
    expect(verifyChain('runs', s.root).ok).toBe(true);
    // A restore needs a person: timmy act (a real child process, the CLI) refuses it with the line to type, writing nothing;
    // /review only reads.
    expect(needsPerson('/review')).toBeUndefined();
    const sealedBefore = chainOf(s).length;
    const line = `/restore box.params.json --from ${kept}`;
    const refusedAct = await act(kit, s, [line]).done;
    expect(refusedAct.code).toBe(2);
    expect(refusedAct.stdout).toContain(`Not run: /restore writes a kept previous version over a project file, an edit a person makes (human-gated), which needs a person. Type this in the REPL instead: ${line}`);
    expect(fs.readFileSync(path.join(s.root, 'box.params.json'))).toEqual(changed);
    expect(chainOf(s).length).toBe(sealedBefore);
  }, 120_000);

  it('refuses, each with the reason, nothing written and nothing sealed: usage, outside, private, Timmy\'s own, not a kept place, a pair no record names, changed since, a link, a changed copy, an unsealed record', async () => {
    const s = sandbox(kit, 'review-refuse-');
    const { ws, flow } = await scadFlow(kit, s);
    const kept = `.timmy/flows/${flow}/params.before.json`;
    const left = fs.readFileSync(path.join(s.root, 'box.params.json'));
    fs.writeFileSync(path.join(s.root, '.env'), 'NAME=only-for-this-test\n');
    const chainBefore = chainOf(s).length;
    const refused = async (args: string, why: RegExp | string): Promise<void> => {
      const out = await restoreLine(ws, args);
      if (typeof why === 'string') expect(out, args).toContain(why); else expect(out, args).toMatch(why);
      expect(out, args).not.toContain('Restored');
    };
    expect(text(ws.restore(''))).toContain('Usage: /restore <file> --from <kept previous version>');
    expect(text(ws.restore('box.params.json'))).toContain('Usage: /restore');
    expect(text(ws.restore(`box.params.json --from "${kept}`))).toContain('A quote is not closed');
    await refused(`../outside.txt --from ${kept}`, /\.\.\/outside\.txt: \.\.\/outside\.txt is outside the project\. Nothing was written\./);
    await refused(`.env --from ${kept}`, '.env: .env is private: keys, .env files and .timmy/private stay out of reach');
    await refused(`.timmy/receipts/runs.jsonl --from ${kept}`, ".timmy/receipts/runs.jsonl is one of Timmy's own records: a restore writes only the project's files");
    await refused('box.params.json --from box.scad', 'box.scad is not a previous version Timmy keeps');
    await refused(`box.scad --from ${kept}`, `flow ${flow}'s record (results/flows/${flow}.json) does not name ${kept} as the previous version of box.scad`);
    // Changed since the run: refused, and the later version is left as it is.
    fs.writeFileSync(path.join(s.root, 'box.params.json'), left.toString().replace('100', '120'));
    await refused(`box.params.json --from ${kept}`, /changed since the run \(sha256 [0-9a-f]{12} now; the run left [0-9a-f]{12}\): restoring would replace a later version/);
    expect(read(s, 'box.params.json')).toContain('120');
    // A link in its place, to a file holding exactly what the run left: the review follows it, the restore never writes through it.
    fs.writeFileSync(path.join(s.root, 'other.json'), left);
    fs.rmSync(path.join(s.root, 'box.params.json'));
    fs.symlinkSync('other.json', path.join(s.root, 'box.params.json'));
    await refused(`box.params.json --from ${kept}`, 'box.params.json is a symbolic link: a restore reads and writes only in place');
    expect(fs.lstatSync(path.join(s.root, 'box.params.json')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(s.root, 'other.json'))).toEqual(left);
    fs.rmSync(path.join(s.root, 'box.params.json'));
    fs.writeFileSync(path.join(s.root, 'box.params.json'), left);
    // The kept copy changed: the review says so and offers nothing; the restore refuses.
    const keptAbs = path.join(s.root, kept);
    const keptBytes = fs.readFileSync(keptAbs);
    fs.chmodSync(keptAbs, 0o644);
    fs.writeFileSync(keptAbs, keptBytes.toString().replace('60', '61'));
    expect(text(ws.review(''))).toMatch(new RegExp(`the copy at ${kept.replace(/\./g, '\\.')} is not the previous version any more: sha256 [0-9a-f]{12}, its record says [0-9a-f]{12}`));
    await refused(`box.params.json --from ${kept}`, 'is not the previous version any more');
    fs.writeFileSync(keptAbs, keptBytes);
    // The flow record changed after its receipt sealed it: nothing it names is restored.
    const recordAbs = path.join(s.root, 'results', 'flows', `${flow}.json`);
    const recordBytes = fs.readFileSync(recordAbs);
    fs.writeFileSync(recordAbs, `${recordBytes.toString().trimEnd()}\n\n`);
    expect(text(ws.review(''))).toContain('restore: not offered: its record is not sealed by a receipt that verifies (the file changed after it was sealed');
    await refused(`box.params.json --from ${kept}`, 'its record is not sealed by a receipt that verifies');
    fs.writeFileSync(recordAbs, recordBytes);
    // Nothing was written or sealed by any of them; with everything back as the run left it, the restore is offered again.
    expect(chainOf(s).length).toBe(chainBefore);
    expect(fs.existsSync(path.join(s.root, '.timmy', 'restore-history'))).toBe(false);
    expect(fs.readFileSync(path.join(s.root, 'box.params.json'))).toEqual(left);
    expect(text(ws.review(''))).toContain(`/restore box.params.json --from ${kept}`);
  }, 120_000);

  it('never while a flow runs in the project: this REPL\'s flow, or a hold another Timmy process keeps; taken once the flow has ended', async () => {
    const s = sandbox(kit, 'review-hold-');
    const { ws, flow } = await scadFlow(kit, s);
    const kept = `.timmy/flows/${flow}/params.before.json`;
    // A second flow whose FAKE agent sleeps: the project is held while it runs.
    const out = text(await ws.operate('/iterate scad box.scad "SLEEP PYFILE:box.params.json"', 'repl', () => ws.iterate('scad box.scad "SLEEP PYFILE:box.params.json"')));
    const second = /\b(f[0-9a-f]{8})\b/.exec(out)?.[1];
    expect(second, out).toBeDefined();
    let answer = await restoreLine(ws, `box.params.json --from ${kept}`);
    expect(answer).toContain(`Refused    flow ${second} is running in this project: restore after it ends, or /stop it. Nothing was written.`);
    expect(text(ws.review(''))).toContain(`flow ${second} is running (its agent step): what it changes is listed once it ends`);
    await ws.stop(second!);
    await until(() => fs.existsSync(path.join(s.root, 'results', 'flows', `${second}.json`)), 30_000, 'the stopped flow\'s record');
    // A hold file another Timmy process would keep (src/ops/flow-hold.ts, its own writer), not this REPL's own lock.
    const hold = takeProjectHold(s.root, { kind: 'scad', operation: 'o0000beef' });
    if (!hold.ok || !hold.hold) throw new Error('no hold');
    hold.hold.name('f0000beef');
    answer = await restoreLine(ws, `box.params.json --from ${kept}`);
    expect(answer).toContain(`Refused    flow f0000beef is running in this project in another Timmy process (pid ${process.pid}, operation o0000beef): restore after it ends. Nothing was written.`);
    hold.hold.release();
    answer = await restoreLine(ws, `box.params.json --from ${kept}`);
    expect(answer).toContain('  Restored   box.params.json');
  }, 120_000);
});

describe('/review of the other runs: a plain /agent run, a /scad run, a workflow /run', () => {
  it('a plain agent run\'s changes with nothing kept ("previous version not kept"), a /scad run\'s outputs as its judgement recorded them, a workflow job\'s output-folder files', async () => {
    const s = sandbox(kit, 'review-runs-');
    const { ws } = replOf(kit, s);
    fs.mkdirSync(path.join(s.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'src/a.txt'), 'one\n');
    fs.writeFileSync(path.join(s.root, 'old.txt'), 'old\n');
    // A plain /agent run (FAKE agent, EDIT: changes src/a.txt, adds new/added.txt, deletes old.txt).
    const started = text(await ws.operate('/agent qwen EDIT the files', 'repl', () => ws.agent('qwen EDIT the files')));
    const agentOp = ws.ops.latest!;
    await ws.jobs.done(/\b(j[0-9a-f]{6})\b/.exec(started)![1]);
    await ws.ops.done(agentOp);
    // A /scad run (FAKE OpenSCAD) and a workflow /run (FAKE upmd: each block through sh -c) writing an output file.
    const scadOut = text(await ws.operate('/scad box.scad', 'repl', () => ws.scad!('box.scad')));
    const scadOp = ws.ops.latest!;
    await ws.jobs.done(/\b(j[0-9a-f]{6})\b/.exec(scadOut)![1]);
    await ws.ops.done(scadOp);
    fs.writeFileSync(path.join(s.root, 'flow.md'), ['# Build', '', '```bash [name:build]', 'mkdir -p out && echo built > out/x.txt', '```', ''].join('\n'));
    const runOut = text(await ws.operate('/run flow.md build', 'repl', () => ws.run('flow.md build')));
    const runOp = ws.ops.latest!;
    const runJob = /\b(j[0-9a-f]{6})\b/.exec(runOut)?.[1];
    expect(runJob, runOut).toBeDefined();
    await ws.jobs.done(runJob!);
    await ws.ops.done(runOp);

    const agentReview = text(ws.review(agentOp.id));
    expect(agentReview).toMatch(/changed  src\/a\.txt\n\s+by agent qwen a[0-9a-f]{8}\n/);
    expect(agentReview).toContain(`sha256 ${sha('one\n').slice(0, 12)} → `);
    expect(agentReview).toContain('previous version not kept');
    expect(agentReview).toContain('restore: not offered: no previous version is kept');
    expect(agentReview).toMatch(/record \.timmy\/agents\/a[0-9a-f]{8}\/result\.json · verified: receipt [0-9a-f]{8} sealed this result's bytes/);
    expect(agentReview).toMatch(/deleted  old\.txt[\s\S]+now: not there, as the run left it/);
    expect(agentReview).toContain('added    new/added.txt');
    const scadReview = text(ws.review(scadOp.id));
    expect(scadReview).toMatch(/added    out\/scad\/[0-9a-f]{8}\/box\.stl\n\s+by openscad run [0-9a-f]{8}\n/);
    expect(scadReview).toMatch(/record \.timmy\/native\/[0-9a-f-]{36}\/verdicts\.jsonl · verified: receipt [0-9a-f]{8} names these files with these sha256/);
    const runReview = text(ws.review(runOp.id));
    expect(runReview).toMatch(new RegExp(`written  out/x\\.txt\\n\\s+by job ${runJob} \\(flow\\.md › build\\) · an output-folder file whose time falls in the job's run`));
    expect(runReview).toContain(`sha256 ${sha('built\n').slice(0, 12)}; before: not recorded`);
    expect(runReview).toContain('restore: not offered: no previous version is kept');
    expect(runReview).toContain(`workflow run ${runJob}: a block's own command may change files Timmy does not record`);
  }, 120_000);

  it('an operation that changed more files than a list shows: the first 40 listed and the rest counted, all of them under /review <operation>', async () => {
    const s = sandbox(kit, 'review-many-');
    const { ws } = replOf(kit, s);
    fs.writeFileSync(path.join(s.root, 'many.md'), ['# Many', '', '```bash [name:many]', 'mkdir -p out && for i in $(seq 1 45); do echo "$i" > "out/f$i.txt"; done', '```', ''].join('\n'));
    const runOut = text(await ws.operate('/run many.md many', 'repl', () => ws.run('many.md many')));
    const runOp = ws.ops.latest!;
    const runJob = /\b(j[0-9a-f]{6})\b/.exec(runOut)?.[1];
    expect(runJob, runOut).toBeDefined();
    await ws.jobs.done(runJob!);
    await ws.ops.done(runOp);
    const listed = (t: string) => (t.match(/^\s+written {2}out\/f\d+\.txt$/gm) ?? []).length;
    const overview = text(ws.review(''));
    expect(listed(overview)).toBe(40);
    expect(overview).toContain(`and 5 more changes: /review ${runOp.id} lists up to 400`);
    const one = text(ws.review(runOp.id));
    expect(listed(one)).toBe(45);
    expect(one).not.toContain('more changes');
  }, 120_000);
});

// ── an OpenHands run's write-back (FAKE docker) ─────────────────────────────────

/** A FAKE Ollama on 127.0.0.1: GET /api/tags lists `models`; anything else is 404 (as tests/openhands-agent.test.ts). */
async function fakeOllama(models: string[]): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: models.map((name) => ({ name })) })); return; }
    res.writeHead(404); res.end('not here (a FAKE Ollama)');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`;
}

describe('/review and /restore on an OpenHands run\'s write-back (FAKE docker, FAKE Ollama)', () => {
  it('lists the changed, deleted and added files with their before/ copies and diffs; restore puts a deleted file back where nothing is and a changed file\'s kept bytes back, each sealed', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-oh-')));
    kit.dirs.push(base);
    const root = path.join(base, 'project');
    const state = path.join(base, 'docker-state');
    const bin = path.join(base, 'bin');
    for (const d of [root, state, bin, path.join(root, 'src')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.txt'), 'first line\n');
    fs.writeFileSync(path.join(root, 'old.txt'), 'to be deleted\n');
    // FAKE docker on PATH, its FAKE daemon holding the image as Timmy's Dockerfile labels it.
    fs.symlinkSync(path.resolve('tests/fixtures/fake-docker.mjs'), path.join(bin, 'docker'));
    fs.writeFileSync(path.join(state, 'images.json'), JSON.stringify({ [OPENHANDS_IMAGE]: { id: `sha256:${'ab'.repeat(32)}`, labels: { 'timmy.openhands.sdk': '1.21.0' } } }));
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, DOCKER_CONFIG: state, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_AGENT_BASE_URL: await fakeOllama(['qwen3:4b']) };
    vi.stubEnv('TIMMY_OPERATION', '');
    const ws = new Workspace({
      glyphs: glyphSet(true), env, onPath: (cmd) => realOnPath(cmd, env), notify: () => {}, openWeb: (u) => u, link: (t) => t,
      seal: (input) => appendReceipt('runs', input, root).hash.slice(7, 15), receipts: () => readChain('runs', root),
      jobsDir: path.join(base, 'jobs'), chdir: () => {}, recoverAtStart: false, roomTools: async () => [],
    }, folderProject(root));
    kit.spaces.push(ws);
    const task = 'ADD DELETE: append a line to src/a.txt, add a new file and delete old.txt';
    const started = text(await ws.operate(`/agent openhands --local ${task}`, 'repl', () => ws.agent(`openhands --local ${task}`)));
    const h = ws.ops.latest!;
    const job = /\b(j[0-9a-f]{6})\b/.exec(started)?.[1];
    expect(job, started).toBeDefined();
    await ws.jobs.done(job!);
    await ws.ops.done(h);
    const run = fs.readdirSync(path.join(root, AGENTS_DIR)).find((n) => /^a[0-9a-f]{8}$/.test(n))!;
    const before = `${AGENTS_DIR}/${run}/before`;
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('first line\none more line (a FAKE OpenHands)\n');
    expect(fs.existsSync(path.join(root, 'old.txt'))).toBe(false);

    let out = text(ws.review(h.id));
    expect(out).toContain('    changed  src/a.txt');
    expect(out).toContain(`by OpenHands run ${run}, written back from its copy`);
    expect(out).toContain(`previous version kept at ${before}/src/a.txt`);
    expect(out).toContain('+ one more line (a FAKE OpenHands)');
    expect(out).toMatch(new RegExp(`record \\.timmy/agents/${run}/result\\.json · verified: receipt [0-9a-f]{8} sealed this result's bytes`));
    expect(out).toContain(`/restore src/a.txt --from ${before}/src/a.txt`);
    expect(out).toContain('    deleted  old.txt');
    expect(out).toContain(`sha256 ${sha('to be deleted\n').slice(0, 12)} before; deleted · now: not there, as the run left it`);
    expect(out).toContain('line diff, the kept version → deleted: +0 −1 in 1 place');
    expect(out).toContain('- to be deleted');
    expect(out).toContain(`/restore old.txt --from ${before}/old.txt`);
    expect(out).toContain('    added    src/new.txt');
    expect(out).toContain('there was no previous version: the run added it');

    // The deleted file is put back where nothing is: no history copy (nothing was there), a receipt naming it created.
    out = await restoreLine(ws, `old.txt --from ${before}/old.txt`);
    expect(out).toContain('  Restored   old.txt');
    expect(out).toContain('it was not there: put back with mode 644');
    expect(fs.readFileSync(path.join(root, 'old.txt'), 'utf8')).toBe('to be deleted\n');
    expect(fs.statSync(path.join(root, 'old.txt')).mode & 0o777).toBe(0o644);
    let r = readChain('runs', root).at(-1)!;
    expect(r).toMatchObject({ kind: 'edit', policy: 'human-gated', files: [{ path: 'old.txt', sha256: sha('to be deleted\n'), created: true }] });
    expect(r.files![0].previous_sha256).toBeUndefined();
    // A second restore of it is refused: it is there again.
    expect(await restoreLine(ws, `old.txt --from ${before}/old.txt`)).toContain('Refused');
    // The changed file: its kept bytes back, OpenHands' version kept first.
    out = await restoreLine(ws, `src/a.txt --from ${before}/src/a.txt`);
    expect(out).toContain('  Restored   src/a.txt');
    expect(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('first line\n');
    const history = /kept at (\.timmy\/restore-history\/src\/a\.txt\/\S+)/.exec(out)![1];
    expect(fs.readFileSync(path.join(root, history), 'utf8')).toBe('first line\none more line (a FAKE OpenHands)\n');
    r = readChain('runs', root).at(-1)!;
    expect(r).toMatchObject({ kind: 'edit', files: [{ path: 'src/a.txt', sha256: sha('first line\n'), previous_sha256: sha('first line\none more line (a FAKE OpenHands)\n'), created: false }] });
    expect(verifyChain('runs', root).ok).toBe(true);
  }, 120_000);
});

// ── the live board's saves (their real writers), hostile names and lines ────────

describe('/review of the board\'s saves: the parameter, OpenSCAD parameter and workflow saves with their history copies; hostile names and lines', () => {
  it('lists each save with its kept previous version and line diff; control and direction characters show as codes; the snapshot escapes every string; Restore of the hostile workflow is done exactly', async () => {
    const s = sandbox(kit, 'review-board-');
    const { ws } = replOf(kit, s);
    const F = '```';
    const doc = 'wf <b>"x" & y.md';
    const hostile = `echo "<script>alert(1)</script>" ${ESC}]8;;http://x${BEL}link${ESC}]8;;${BEL} ${RLO}txt.exe`;
    const first = ['# A workflow', '', `${F}bash [name:build]`, hostile, F, ''].join('\n');
    fs.writeFileSync(path.join(s.root, doc), first);
    const seal = (input: Parameters<typeof appendReceipt>[1]): string => appendReceipt('runs', input, s.root).hash.slice(7, 15);
    const ctx = { root: s.root, project: 'project', projectId: projectId(s.root), workflows: [doc], recipes: ['tray'], scadModels: ['box.scad'], seal, flowIn: () => undefined };
    const save = (body: Record<string, unknown>) => ws.operate(`board edit: ${String(body.action)}`, 'board', () => applyBoardEdit(body, ctx));
    // The workflow save (src/repl/board-nodes.ts saveWorkflow, keepPrevious): a new command for the hostile block.
    const block = parseWorkflow(first).find((b) => b.name === 'build')!;
    let a = await save({ action: 'save-workflow', doc, sha256: sha(first), blocks: [{ from: block.index, name: 'build', lang: 'bash', needs: [], command: 'echo safe <img src=x onerror=alert(2)>' }] });
    expect(a.status, a.text).toBe(200);
    const wfOp = ws.ops.latest!.id;
    // The OpenSCAD parameter save (saveScadParams): width 60 → 70, the previous file kept under .timmy/params-history/scad/.
    const scad = fs.readFileSync(path.join(s.root, 'box.params.json'));
    a = await save({ action: 'set-scad-params', model: 'box.scad', base: sha(scad), parameters: { width: 70, depth: 40, height: 30, wall: 2, lid_gap: 0.3, part: 'both' } });
    expect(a.status, a.text).toBe(200);
    // The tray parameter save twice (saveParams, writeParams): a new file, then a change with its previous file kept.
    const defaults = readCard().parameters;
    a = await save({ action: 'set-params', recipe: 'tray', base: null, parameters: { ...defaults } });
    expect(a.status, a.text).toBe(200);
    const trayFirst = fs.readFileSync(path.join(s.root, 'recipes/tray.params.json'));
    a = await save({ action: 'set-params', recipe: 'tray', base: sha(trayFirst), parameters: { ...defaults, width: defaults.width + 10 } });
    expect(a.status, a.text).toBe(200);

    const out = text(ws.review(''));
    // The tray file: added by the first save (nothing to restore), changed by the second with its previous file kept.
    expect(out).toMatch(/changed  recipes\/tray\.params\.json\n\s+by the live board \(parameters\)\n/);
    expect(out).toMatch(/previous version kept at \.timmy\/params-history\/tray\/\S+\.json/);
    expect(out).toContain(`- ${'    '}"width": ${defaults.width},`);
    expect(out).toContain(`+ ${'    '}"width": ${defaults.width + 10},`);
    expect(out).toMatch(/added    recipes\/tray\.params\.json\n\s+by the live board \(parameters\)\n/);
    expect(out).toMatch(/changed  box\.params\.json\n\s+by the live board \(OpenSCAD parameters\)\n/);
    expect(out).toMatch(/\/restore box\.params\.json --from \.timmy\/params-history\/scad\/box\.params\.json\/\S+\.json/);
    // The hostile workflow: its name quoted for /restore; its lines with every control and direction character as a code.
    expect(out).toContain(`changed  ${doc}`);
    expect(out).toContain('by the live board (workflow blocks)');
    expect(out).toContain('- echo "<script>alert(1)</script>" \\x1b]8;;http://x\\x07link\\x1b]8;;\\x07 \\u202etxt.exe');
    expect(out).toContain('+ echo safe <img src=x onerror=alert(2)>');
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(RLO);
    const cmd = /\/restore '(wf <b>"x" & y\.md)' --from '(\.timmy\/workflow-history\/wf <b>"x" & y\.md\/[^']+\.md\.bak)'/.exec(out);
    expect(cmd, out).not.toBeNull();
    // The snapshot: every string escaped, no raw control or direction character, no markup from a name or a line.
    ws.board('');
    const html = fs.readFileSync(path.join(s.root, BOARD_FILE), 'utf8');
    const section = html.slice(html.indexOf('<h2 id="review">'), html.indexOf('<h2 id="references">'));
    expect(section).toContain(`data-review-op="${wfOp}"`);
    expect(section).toContain('wf &lt;b&gt;&quot;x&quot; &amp; y.md');
    expect(section).toContain('echo &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot; \\x1b]8;;http://x\\x07link');
    expect(section).toContain('echo safe &lt;img src=x onerror=alert(2)&gt;');
    expect(section).not.toMatch(/<script|<img|<b>"x"/);
    expect(section).not.toContain(ESC);
    expect(section).not.toContain(RLO);
    expect(html.indexOf('<h2 id="review">')).toBeGreaterThan(html.indexOf('<h2 id="room">'));
    // Restore of the hostile workflow, by the command the review wrote: the first version back, exactly.
    const restored = await restoreLine(ws, cmd![0].slice('/restore '.length));
    expect(restored).toContain('  Restored');
    expect(fs.readFileSync(path.join(s.root, doc), 'utf8')).toBe(first);
    expect(verifyChain('runs', s.root).ok).toBe(true);
  }, 120_000);
});

describe('the parts: /restore\'s arguments, the live board\'s restore action, visible text', () => {
  it('an argument is written so /restore reads it back exactly, or not at all; the action takes only a pair the board offers', () => {
    const names = ['plain.txt', 'a b.txt', 'q"uote.md', "it's.md", 'wf <b>"x" & y.md', '--from', '"lead.txt', 'a"b', `both"'quotes`];
    for (const file of names) {
      const from = `.timmy/params-history/${file}/1.bak`;
      const cmd = restoreCommand(file, from);
      expect(cmd, file).not.toBeNull();
      expect(parseRestoreArgs(cmd!.slice('/restore '.length)), file).toEqual({ ok: true, file, from });
    }
    expect(restoreArg(`a space "and' both`)).toBeNull();
    expect(restoreArg(`ctl${ESC}x`)).toBeNull();
    expect(parseRestoreArgs('a --from')).toMatchObject({ ok: false });
    expect(parseRestoreArgs('--from --from b')).toMatchObject({ ok: false });
    const offered = [{ file: 'wf <b>"x" & y.md', from: '.timmy/workflow-history/wf <b>"x" & y.md/1.md.bak' }];
    expect(checkRestoreAction({ action: 'restore', file: offered[0].file, from: offered[0].from }, offered)).toEqual({
      ok: true, command: { name: 'restore', args: `'${offered[0].file}' --from '${offered[0].from}'`, line: `/restore '${offered[0].file}' --from '${offered[0].from}'` },
    });
    expect(checkRestoreAction({ action: 'restore', file: 'other.md', from: offered[0].from }, offered)).toMatchObject({ ok: false, status: 404 });
    expect(checkRestoreAction({ action: 'restore', file: offered[0].file, from: offered[0].from, extra: 1 }, offered)).toMatchObject({ ok: false, status: 400 });
    expect(checkRestoreAction({ action: 'restore', file: 7, from: offered[0].from }, offered)).toMatchObject({ ok: false, status: 400 });
    expect(visible(`a${ESC}[31mb${BEL}c${RLO}d\te\nf`)).toBe('a\\x1b[31mb\\x07c\\u202ed\te\\x0af');
  });
});

describe('who made an edit, in review\'s words (r21, ledger row 163)', () => {
  it('names the actor, not what was saved: /restore and the live board; any other tail as it was written', () => {
    expect(editActor('restored from .timmy/restore-history/a.json/1.json.bak (/restore)')).toBe('/restore (from .timmy/restore-history/a.json/1.json.bak)');
    expect(editActor('parameters from the live board')).toBe('the live board (parameters)');
    expect(editActor('OpenSCAD parameters from the live board')).toBe('the live board (OpenSCAD parameters)');
    expect(editActor('workflow blocks from the live board')).toBe('the live board (workflow blocks)');
    expect(editActor('something a later Timmy writes')).toBe('something a later Timmy writes');
  });
});
