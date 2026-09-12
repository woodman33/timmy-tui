#!/usr/bin/env node
// THE SHIP v0 — story simulator (mindship-v5c2 step 6).
//
//   timmy sim run    --board companion/boards/ship.story.json [--turns N] [--sim-model m] [--actor-model m | --free]
//                    [--layers all|L1] [--project ship] [--dry] [--no-seal]
//   timmy sim replay <run-id | path/to/run.jsonl> [--store <root receipts dir>]
//   timmy sim export [--out lanes/sim/datasets/behavior-v0.jsonl] [--no-seal]
//   timmy sim list
//
// Rules the lane enforces:
//   · the SIMULATOR model narrates and referees; it is never an actor, and it
//     must differ from every actor model (refused otherwise)
//   · every turn seals ONE sim.turn receipt in the root store carrying
//     asked / known / did / stakes / model (hashes + previews; the texts live
//     in the run's JSONL beside the receipts index)
//   · a nested run (layer L2) cites the parent turn it branches from:
//     parent_turn = the L1 receipt hash, parent_run = the L1 run id
//   · replay reads the JSONL alone, finds every receipt in the root store,
//     re-hashes the texts against the receipts, and walks the parent chain
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUNS = join(ROOT, 'lanes', 'sim', 'runs');
const DATASETS = join(ROOT, 'lanes', 'sim', 'datasets');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--dry', '--no-seal'].includes(args[i - 1])));
const cmd = positional[0] ?? 'run';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const DRY = has('--dry');

function rootStore() {
  const pin = join(ROOT, '.timmy', 'store-pin');
  return existsSync(pin) ? readFileSync(pin, 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
}

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ')}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const m = (r.stdout ?? '').match(/sha256_[0-9a-f]+/);
  const full = (r.stdout ?? '').match(/sealed (sha256_[0-9a-f]+)/);
  return { short: m ? m[0] : null, printed: (r.stdout ?? '').trim(), hash: full ? full[1] : (m ? m[0] : null) };
}

/** The canonical CLI prints a truncated hash; the store holds the full one. Resolve by reading the last line. */
function lastReceipt(store) {
  const p = join(store, 'runs.jsonl');
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// ------------------------------------------------------------------ models

// swarm-b3k7 step 6: app attribution on every call; `extra` carries the referee's
// structured-output contract (response_format) and the response-healing plugin.
async function openrouter(model, messages, maxTokens = 600, extra = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not in env (use --dry for a scripted run)');
  const started = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://custody.timmy.dev', 'X-Title': 'TIMMY ship sim', 'X-OpenRouter-Categories': 'cli-agents,programming', 'X-OpenRouter-Metadata': 'enabled' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.8, usage: { include: true }, ...extra })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${model}: upstream ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  return { content: j.choices?.[0]?.message?.content ?? '', usd: Number(j.usage?.cost ?? 0), tokens_in: j.usage?.prompt_tokens ?? 0, tokens_out: j.usage?.completion_tokens ?? 0, ms: Date.now() - started };
}

function dryActor(ch, world) {
  const goal = ch.role_card.goal.split(/[.;]/)[0].toLowerCase();
  return { content: `I ${goal}. I look at ${world.locations[world.where[ch.id]].name.toLowerCase()} and say: "${ch.name} here. Log it."`, usd: 0, tokens_in: 0, tokens_out: 0, ms: 0 };
}

function dryReferee(ch, world, did) {
  const loc = world.where[ch.id];
  return { content: JSON.stringify({ narration: `${ch.name} acts: ${did.slice(0, 60)}… The others take note.`, location_events: [{ location: loc, text: `${ch.name}: ${did.slice(0, 80)}` }], stakes: world.stakes.map((s) => ({ id: s.id, at_risk: s.at_risk, note: 'unchanged (dry)' })), moves: [], private: [] }), usd: 0, tokens_in: 0, tokens_out: 0, ms: 0 };
}

function firstJson(text) {
  const i = text.indexOf('{');
  const k = text.lastIndexOf('}');
  if (i < 0 || k < i) return null;
  try { return JSON.parse(text.slice(i, k + 1)); } catch { return null; }
}

// ------------------------------------------------------------------ world

function worldFor(board, layerId, opening) {
  const layer = board.layers.find((l) => l.id === layerId);
  const chars = board.characters.filter((c) => c.layer === 'L1'); // the same four people play every layer
  const locations = Object.fromEntries(board.locations.map((l) => [l.id, l]));
  const where = {};
  for (const c of chars) where[c.id] = layerId === 'L1' ? c.location : (board.seed.nested?.location ?? c.location);
  return {
    layer: layerId,
    layer_title: layer?.title ?? layerId,
    locations,
    where,
    stakes: board.stakes.map((s) => ({ ...s })),
    events: [{ location: null, text: opening }],
    private: {},
    chars
  };
}

function knownFor(ch, world) {
  const loc = world.where[ch.id];
  const publicHere = world.events.filter((e) => e.location === null || e.location === loc).map((e) => e.text);
  const priv = world.private[ch.id] ?? [];
  const holds = world.stakes.filter((s) => s.holder === ch.id).map((s) => `${s.desc} (at risk: ${s.at_risk})`);
  return [
    `You are ${ch.name}, the ${ch.role_card.role}, in ${world.locations[loc]?.name ?? loc}: ${world.locations[loc]?.desc ?? ''}.`,
    `Layer: ${world.layer_title}.`,
    `Who else is here: ${world.chars.filter((c) => c.id !== ch.id && world.where[c.id] === loc).map((c) => `${c.name} (${c.role_card.role})`).join(', ') || 'nobody'}.`,
    `What you know: ${ch.role_card.knows.join('; ')}.`,
    `What you have seen so far: ${publicHere.join(' | ')}`,
    priv.length ? `What only you have learned: ${priv.join(' | ')}` : '',
    holds.length ? `What is at stake for you: ${holds.join('; ')}` : ''
  ].filter(Boolean).join('\n');
}

function askedFor(ch, known) {
  return [
    `ROLE CARD — goal: ${ch.role_card.goal} secret (never state it outright): ${ch.role_card.secret} voice: ${ch.role_card.voice}. limits: ${ch.role_card.limits.join('; ')}.`,
    known,
    'It is your turn. In first person, in your voice, take ONE action and say at most one line aloud. At most 80 words. No narration of other people. Plain text.'
  ].join('\n\n');
}

/** structured-outputs + response-healing-plugin: the referee's JSON is a contract, healed server-side when malformed (firstJson stays as the last resort). */
const REFEREE_CONTRACT = { response_format: { type: 'json_object' }, plugins: [{ id: 'response-healing' }] };

function refereePrompt(board, world, ch, did) {
  return [
    `You are the simulator of "${board.name}". Premise: ${board.premise}`,
    `Layer ${world.layer_title}. Locations: ${Object.values(world.locations).filter((l) => l.layer === world.layer).map((l) => `${l.id}=${l.name}`).join(', ')}.`,
    `Where everyone is: ${Object.entries(world.where).map(([k, v]) => `${k}@${v}`).join(', ')}.`,
    `Stakes: ${world.stakes.map((s) => `${s.id} (${s.holder}): ${s.desc} [at_risk=${s.at_risk}]`).join('; ')}.`,
    `Branches: ${board.branches.map((b) => `${b.id}: when ${b.when} → ${b.leads_to}; else ${b.else}`).join(' | ')}.`,
    `Recent events: ${world.events.slice(-6).map((e) => `[${e.location ?? 'all'}] ${e.text}`).join(' | ')}`,
    `${ch.name} (${ch.role_card.role}, at ${world.where[ch.id]}) just did: """${did}"""`,
    'Resolve it. Reply with ONE JSON object and nothing else: {"narration": string (<=60 words, third person, what actually happens), "location_events": [{"location": id, "text": string}], "stakes": [{"id": string, "at_risk": "low"|"medium"|"high"|"lost"|"won", "note": string}], "moves": [{"character": id, "to": location id}], "private": [{"character": id, "text": string}]}. Only list stakes that change. Never speak as a character.'
  ].join('\n');
}

function applyOutcome(world, out) {
  if (!out) return;
  for (const e of out.location_events ?? []) if (e?.text) world.events.push({ location: e.location ?? null, text: String(e.text) });
  if (out.narration) world.events.push({ location: null, text: String(out.narration) });
  for (const s of out.stakes ?? []) { const t = world.stakes.find((x) => x.id === s.id); if (t && s.at_risk) t.at_risk = String(s.at_risk); }
  for (const m of out.moves ?? []) if (m?.character in world.where && m.to in world.locations) world.where[m.character] = m.to;
  for (const p of out.private ?? []) if (p?.character && p.text) (world.private[p.character] ??= []).push(String(p.text));
}

const stakesMap = (world) => Object.fromEntries(world.stakes.map((s) => [s.id, s.at_risk]));

// ------------------------------------------------------------------ run

async function runLayer(ctx, board, layerId, order, turns, opening, parent) {
  const world = worldFor(board, layerId, opening);
  const { models, runId, file, store } = ctx;
  let prevHash = parent?.turn ?? null;
  const sealed = [];
  for (let t = 1; t <= turns; t++) {
    const ch = world.chars.find((c) => c.id === order[(t - 1) % order.length]);
    const known = knownFor(ch, world);
    const asked = askedFor(ch, known);
    const actor = DRY ? dryActor(ch, world) : await openrouter(models.actor, [{ role: 'system', content: 'You play one character in a story simulation. Stay in character.' }, { role: 'user', content: asked }], 300);
    const did = actor.content.trim();
    const stakesBefore = stakesMap(world);
    const ref = DRY ? dryReferee(ch, world, did) : await openrouter(models.sim, [{ role: 'system', content: 'You are a strict story referee. JSON only.' }, { role: 'user', content: refereePrompt(board, world, ch, did) }], 700, REFEREE_CONTRACT);
    const outcome = firstJson(ref.content) ?? { narration: ref.content.slice(0, 300), unparsed: true };
    applyOutcome(world, outcome);
    const stakesAfter = stakesMap(world);
    const usd = (actor.usd ?? 0) + (ref.usd ?? 0);
    const turnNo = ctx.turnCounter++;
    let receipt = null;
    if (!ctx.noSeal) {
      seal('sim.turn', {
        run: runId, turn: turnNo, layer: layerId, character: ch.id, role: ch.role_card.role, location: world.where[ch.id],
        asked_sha256: sha(asked), known_sha256: sha(known), did_sha256: sha(did), did: did.slice(0, 160),
        stakes: JSON.stringify(stakesAfter), stakes_before: JSON.stringify(stakesBefore),
        model_actor: DRY ? 'dry/actor' : models.actor, model_sim: DRY ? 'dry/sim' : models.sim, usd: usd.toFixed(6),
        outcome_sha256: sha(JSON.stringify(outcome)), parent_turn: prevHash ?? 'none', parent_run: parent?.run ?? runId, board_sha256: ctx.boardSha, dry: DRY ? 'true' : null
      });
      receipt = lastReceipt(store).hash;
    }
    const row = { turn: turnNo, layer: layerId, character: ch.id, name: ch.name, role: ch.role_card.role, location: world.where[ch.id], asked, known, did, outcome, stakes_before: stakesBefore, stakes_after: stakesAfter, model_actor: DRY ? 'dry/actor' : models.actor, model_sim: DRY ? 'dry/sim' : models.sim, usd, ms: (actor.ms ?? 0) + (ref.ms ?? 0), receipt, parent_turn: prevHash, parent_run: parent?.run ?? null };
    appendFileSync(file, JSON.stringify(row) + '\n');
    sealed.push({ turn: turnNo, layer: layerId, character: ch.id, receipt, parent_turn: prevHash, usd });
    console.error(`${layerId} t${turnNo} ${ch.name.padEnd(14)} ${did.slice(0, 70).replace(/\n/g, ' ')}… → ${outcome.narration ? String(outcome.narration).slice(0, 60) : '(no narration)'} [${receipt ? receipt.slice(0, 18) : 'unsealed'}]`);
    prevHash = receipt ?? prevHash;
    // nested layer branches off this turn
    const nested = board.seed.nested;
    if (layerId === 'L1' && nested && ctx.layers === 'all' && t === nested.at_turn) {
      const sub = await runLayer(ctx, board, nested.layer, nested.turn_order, nested.turns, nested.opening, { turn: receipt, run: runId });
      sealed.push(...sub);
      world.events.push({ location: null, text: `(the rehearsal ends; ${sub.length} rehearsed moves on the chart table)` });
    }
  }
  return sealed;
}

async function run() {
  const boardPath = resolve(flag('--board', join(ROOT, 'companion', 'boards', 'ship.story.json')));
  const boardText = readFileSync(boardPath, 'utf8');
  const board = JSON.parse(boardText);
  if (board.kind !== 'story') { console.error(`board kind must be story, got ${board.kind}`); process.exit(2); }
  // free-models-router: --free puts the actors on openrouter/free (the $0 tier) for rehearsal runs; the simulator stays paid
  const models = { sim: flag('--sim-model', board.simulator?.model ?? 'x-ai/grok-4.6'), actor: has('--free') ? 'openrouter/free' : flag('--actor-model', board.actors?.model ?? 'google/gemini-3.7-flash') };
  if (models.sim === models.actor) { console.error(`refusing: simulator model (${models.sim}) must differ from the actor model`); process.exit(3); }
  const turns = Number(flag('--turns', board.seed.max_turns ?? 4));
  const runId = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(RUNS, { recursive: true });
  const file = join(RUNS, `${runId}.jsonl`);
  const store = rootStore();
  const ctx = { models, runId, file, store, boardSha: sha(boardText), turnCounter: 1, noSeal: has('--no-seal'), layers: flag('--layers', 'all') };
  writeFileSync(file, JSON.stringify({ header: true, run: runId, board: boardPath.replace(ROOT + '/', ''), board_sha256: ctx.boardSha, name: board.name, layers: board.layers.map((l) => l.id), models: DRY ? { sim: 'dry/sim', actor: 'dry/actor' } : models, dry: DRY, started: new Date().toISOString(), store }) + '\n');
  console.error(`run ${runId} · ${board.name} · sim ${DRY ? 'dry/sim' : models.sim} · actors ${DRY ? 'dry/actor' : models.actor}`);
  const sealed = await runLayer(ctx, board, 'L1', board.seed.turn_order, turns, board.seed.opening, null);
  const usd = sealed.reduce((a, s) => a + s.usd, 0);
  const summary = { run: runId, file: file.replace(ROOT + '/', ''), turns: sealed.length, layers: [...new Set(sealed.map((s) => s.layer))], usd: Number(usd.toFixed(6)), receipts: sealed.map((s) => s.receipt), nested_cite: sealed.find((s) => s.layer !== 'L1')?.parent_turn ?? null, models: DRY ? { sim: 'dry/sim', actor: 'dry/actor' } : models, dry: DRY };
  appendFileSync(file, JSON.stringify({ footer: true, ...summary, finished: new Date().toISOString() }) + '\n');
  const project = flag('--project');
  if (project) {
    const outDir = join(process.env.TIMMY_PROJECTS_ROOT ?? join(process.env.HOME, 'timmy', 'projects'), project, 'out');
    if (existsSync(outDir)) { copyFileSync(file, join(outDir, basename(file))); summary.project_out = join(outDir, basename(file)); }
  }
  if (!ctx.noSeal) {
    seal('sim.run', { run: runId, board: summary.file, board_sha256: ctx.boardSha, turns: sealed.length, layers: summary.layers.join('+'), usd: summary.usd.toFixed(6), model_sim: summary.models.sim, model_actor: summary.models.actor, first_turn: sealed[0]?.receipt ?? 'none', last_turn: sealed[sealed.length - 1]?.receipt ?? 'none', nested_cite: summary.nested_cite ?? 'none', dry: DRY ? 'true' : null });
    summary.run_receipt = lastReceipt(store).hash;
  }
  console.log(JSON.stringify(summary, null, 1));
}

// ------------------------------------------------------------------ replay

function loadRun(ref) {
  const p = existsSync(ref) ? ref : join(RUNS, `${ref}.jsonl`);
  if (!existsSync(p)) throw new Error(`no run at ${p}`);
  const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { path: p, header: lines.find((l) => l.header), footer: lines.find((l) => l.footer), turns: lines.filter((l) => !l.header && !l.footer) };
}

function replay() {
  const ref = positional[1];
  if (!ref) { console.error('usage: timmy sim replay <run-id | path>'); process.exit(2); }
  const { path, header, turns } = loadRun(ref);
  const store = flag('--store', header?.store ?? rootStore());
  const storeLines = readFileSync(join(store, 'runs.jsonl'), 'utf8').split('\n');
  const byHash = new Map();
  for (const l of storeLines) { if (!l) continue; try { const j = JSON.parse(l); if (j.hash) byHash.set(j.hash, j); } catch { /* skip */ } }
  const checks = [];
  let prevByLayer = {};
  const l1Hashes = new Set();
  console.log(`# replay ${header?.run ?? ref} · ${header?.name ?? ''} · board ${String(header?.board_sha256 ?? '').slice(0, 12)} · ${turns.length} turns · models ${header?.models?.sim} / ${header?.models?.actor}`);
  for (const t of turns) {
    const indent = t.layer === 'L1' ? '' : '    ';
    const rec = t.receipt ? byHash.get(t.receipt) : null;
    const meta = rec?.sources?.[0] ?? {};
    const c = { turn: t.turn, layer: t.layer, character: t.character, receipt_found: !!rec, did_matches: rec ? meta.did_sha256 === sha(t.did) : null, asked_matches: rec ? meta.asked_sha256 === sha(t.asked) : null, known_matches: rec ? meta.known_sha256 === sha(t.known) : null, stakes_match: rec ? meta.stakes === JSON.stringify(t.stakes_after) : null, models_match: rec ? meta.model_actor === t.model_actor && meta.model_sim === t.model_sim : null, sim_ne_actor: t.model_sim !== t.model_actor, parent_ok: null };
    const expectedParent = t.layer === 'L1' ? (prevByLayer.L1 ?? null) : (prevByLayer[t.layer] ?? t.parent_turn);
    c.parent_ok = t.parent_turn === expectedParent && (t.layer === 'L1' || l1Hashes.has(t.parent_turn) || prevByLayer[t.layer] === t.parent_turn);
    if (rec && meta.parent_turn !== (t.parent_turn ?? 'none')) c.parent_ok = false;
    prevByLayer[t.layer] = t.receipt ?? prevByLayer[t.layer];
    if (t.layer === 'L1' && t.receipt) l1Hashes.add(t.receipt);
    checks.push(c);
    const ok = Object.values(c).every((v) => v !== false);
    console.log(`${indent}[${t.layer} t${t.turn}] ${t.name} (${t.role}) @${t.location} ${ok ? '✓' : '✗'} ${t.receipt ? t.receipt.slice(0, 18) : 'unsealed'}${t.parent_turn ? ` ← ${String(t.parent_turn).slice(0, 18)}` : ''}`);
    console.log(`${indent}  asked: ${t.asked.split('\n').slice(-1)[0].slice(0, 90)}`);
    console.log(`${indent}  known: ${t.known.split('\n')[0].slice(0, 110)}`);
    console.log(`${indent}  did:   ${t.did.replace(/\n/g, ' ').slice(0, 220)}`);
    console.log(`${indent}  world: ${String(t.outcome?.narration ?? '').replace(/\n/g, ' ').slice(0, 200)}`);
    console.log(`${indent}  stakes: ${Object.entries(t.stakes_after).map(([k, v]) => `${k}=${v}`).join(' ')} · models ${t.model_actor} / ${t.model_sim}${t.usd ? ` · $${t.usd.toFixed(4)}` : ''}`);
  }
  const bad = checks.filter((c) => Object.values(c).some((v) => v === false));
  console.log(`# ${checks.length} turns · receipts found ${checks.filter((c) => c.receipt_found).length} · text hashes match ${checks.filter((c) => c.did_matches && c.asked_matches && c.known_matches).length} · parent chain ok ${checks.filter((c) => c.parent_ok).length} · ${bad.length ? `FAILED ${bad.length}` : 'ok'}`);
  if (bad.length) { console.log(JSON.stringify(bad, null, 1)); process.exit(1); }
  return { path, checks };
}

// ------------------------------------------------------------------ export

function exportDataset() {
  mkdirSync(DATASETS, { recursive: true });
  const out = resolve(flag('--out', join(DATASETS, 'behavior-v0.jsonl')));
  const files = existsSync(RUNS) ? readdirSync(RUNS).filter((f) => f.endsWith('.jsonl')).sort() : [];
  const rows = [];
  const runs = [];
  for (const f of files) {
    const { header, turns } = loadRun(join(RUNS, f));
    if (header?.dry && !has('--include-dry')) continue;
    runs.push(header.run);
    for (const t of turns) rows.push({ v: 'behavior-v0', run: header.run, board_sha256: header.board_sha256, turn: t.turn, layer: t.layer, character: t.character, role: t.role, location: t.location, asked: t.asked, known: t.known, did: t.did, outcome: t.outcome, stakes_before: t.stakes_before, stakes_after: t.stakes_after, model_actor: t.model_actor, model_sim: t.model_sim, receipt: t.receipt, parent_turn: t.parent_turn, parent_run: t.parent_run });
  }
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(out, text);
  const digest = sha(text);
  const summary = { dataset: 'behavior-v0', out: out.replace(ROOT + '/', ''), rows: rows.length, runs, sha256: digest, fields: ['asked', 'known', 'did', 'outcome', 'stakes_before', 'stakes_after', 'model_actor', 'model_sim', 'receipt', 'parent_turn'], layers: [...new Set(rows.map((r) => r.layer))], characters: [...new Set(rows.map((r) => r.character))] };
  if (!has('--no-seal')) { seal('dataset.behavior-v0', { dataset: 'behavior-v0', file: summary.out, rows: rows.length, runs: runs.join(','), sha256: digest, layers: summary.layers.join('+'), characters: summary.characters.join(','), fields: summary.fields.join(',') }); summary.receipt = lastReceipt(rootStore()).hash; }
  console.log(JSON.stringify(summary, null, 1));
}

switch (cmd) {
  case 'run': await run(); break;
  case 'replay': replay(); break;
  case 'export': exportDataset(); break;
  case 'list': console.log(JSON.stringify((existsSync(RUNS) ? readdirSync(RUNS) : []).filter((f) => f.endsWith('.jsonl')).map((f) => { const { header, footer } = loadRun(join(RUNS, f)); return { run: header?.run, name: header?.name, dry: !!header?.dry, turns: footer?.turns ?? null, usd: footer?.usd ?? null, started: header?.started }; }), null, 1)); break;
  default: console.error('usage: timmy sim run|replay|export|list'); process.exit(2);
}
