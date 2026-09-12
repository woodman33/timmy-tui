#!/usr/bin/env node
// timmy project — the project folder standard (project-folder/v0, mindship-v5c2 step 5).
//
//   timmy project new <name> [--owner who] [--harness a,b,c] [--preferred x] [--budget usd] [--tags a,b] [--root dir] [--no-seal]
//                    [--zdr] [--no-data-collection] [--mint-key]
//     --zdr / --no-data-collection  → profile routing flags every call under the project carries (zero-data-retention,
//                                     provider-logging-data-collection); the commander and the Timmys read them
//     --mint-key                    → management-api-keys: a per-project OpenRouter key whose limit IS the budget,
//                                     minted with OPENROUTER_PROVISIONING_KEY (stored in <project>/.env, never printed);
//                                     without a provisioning key the receipt says "not provisioned"
//   timmy project menu <name> [--harness x] [--root dir]      → prints the harness menu and writes <project>/out/menu.json
//   timmy project list [--root dir]
//   timmy project standard                                    → prints the standard
//
// Layout: ~/timmy/projects/<name>/{skills,plans,boards,drop,out,profile.cue}
// Harness menus read from the folder through fleet/harness-menu.mjs; nothing
// else defines what a harness may see or spend inside a project.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { LAYOUT, NAME_RE, PROJECTS_ROOT, STANDARD, harnessMenu, projectNames, readProject, writeMenu } from '../../fleet/harness-menu.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const BOOL_FLAGS = ['--no-seal', '--zdr', '--no-data-collection', '--mint-key'];
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !BOOL_FLAGS.includes(args[i - 1])));
const root = flag('--root', PROJECTS_ROOT);
const cmd = positional[0];

function rootStore() {
  const pin = join(ROOT, '.timmy', 'store-pin');
  if (existsSync(pin)) return readFileSync(pin, 'utf8').trim();
  return join(ROOT, '.timmy', 'receipts');
}

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${v}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write(r.stdout ?? '');
  if (r.status !== 0) process.stderr.write(r.stderr ?? '');
}

/**
 * management-api-keys: mint a per-project OpenRouter key whose limit is the
 * project budget, so the cap is enforced by OpenRouter and not only by us.
 * Needs a provisioning key (OPENROUTER_PROVISIONING_KEY); the minted key goes
 * to <project>/.env and is never printed or sealed — the receipt carries its
 * hash prefix, its limit and its name.
 */
async function mintProjectKey(name, budget, dir) {
  const prov = process.env.OPENROUTER_PROVISIONING_KEY;
  if (!prov) return { status: 'not provisioned', note: 'OPENROUTER_PROVISIONING_KEY not in env; the budget is enforced by the commander and the Timmys only' };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${prov}`, 'HTTP-Referer': 'https://custody.timmy.dev', 'X-Title': 'TIMMY project' },
      body: JSON.stringify({ name: `timmy-project-${name}`, limit: budget, limit_reset: null })
    });
    const j = await r.json();
    if (!r.ok) return { status: 'refused', note: `upstream ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}` };
    const key = j.key ?? j.data?.key;
    if (!key) return { status: 'refused', note: 'no key in the response' };
    const envPath = join(dir, '.env');
    writeFileSync(envPath, `# minted by timmy project new --mint-key · limit ${budget} USD · never commit\nOPENROUTER_API_KEY=${key}\n`, { mode: 0o600 });
    return { status: 'minted', note: `${envPath} (mode 600)`, key_sha256: createHash('sha256').update(key).digest('hex').slice(0, 16), key_hash: j.data?.hash ?? j.hash ?? null, limit: j.data?.limit ?? budget, name: j.data?.name ?? `timmy-project-${name}` };
  } catch (e) {
    return { status: 'failed', note: e instanceof Error ? e.message : String(e) };
  }
}

async function runners() {
  try {
    const m = await import(pathToFileURL(join(ROOT, 'src', 'agent', 'lanes.ts')).href);
    return m.LANE_RUNNERS ?? {};
  } catch {
    return {};
  }
}

const usage = () => { console.error('usage: timmy project new <name> [--owner w] [--harness a,b] [--preferred x] [--budget usd] [--tags a,b] | menu <name> [--harness x] | list | standard'); process.exit(2); };

switch (cmd) {
  case 'new': {
    const name = positional[1];
    if (!name || !NAME_RE.test(name)) { console.error(`name must match ${NAME_RE}`); process.exit(2); }
    const dir = join(root, name);
    if (existsSync(dir)) { console.error(`refusing: ${dir} already exists`); process.exit(3); }
    const owner = flag('--owner', process.env.USER ?? 'owner');
    const allowed = (flag('--harness', 'opencode,hermes,pi,openhands,jcode,minds')).split(',').map((s) => s.trim()).filter(Boolean);
    const preferred = flag('--preferred', allowed[0] ?? '');
    const budget = Number(flag('--budget', 2));
    const tags = (flag('--tags', '')).split(',').map((s) => s.trim()).filter(Boolean);
    const created = new Date().toISOString();
    const store = rootStore();
    for (const d of LAYOUT) mkdirSync(join(dir, d), { recursive: true });
    for (const d of LAYOUT) writeFileSync(join(dir, d, '.keep'), '');
    const tpl = readFileSync(join(ROOT, 'lanes', 'project', 'templates', 'profile.cue'), 'utf8');
    const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
    const zdr = has('--zdr');
    const dataCollection = has('--no-data-collection') ? 'deny' : 'allow';
    const minted = has('--mint-key') ? await mintProjectKey(name, Number.isFinite(budget) ? budget : 2, dir) : { status: 'none', note: 'not requested (--mint-key)' };
    const profile = tpl
      .replace('__NAME__', name).replace('__OWNER__', owner).replace('__CREATED__', created)
      .replace('__ALLOWED__', allowed.map(q).join(', ')).replace('__PREFERRED__', preferred)
      .replace('__BUDGET__', String(Number.isFinite(budget) ? budget : 2)).replace('__STORE__', store)
      .replace('__TAGS__', tags.map(q).join(', '))
      .replace('__ZDR__', String(zdr)).replace('__DATA_COLLECTION__', dataCollection).replace('__PROJECT_KEY__', minted.status === 'minted' ? 'minted' : 'none');
    writeFileSync(join(dir, 'profile.cue'), profile);
    writeFileSync(join(dir, 'README.md'), `# ${name}\n\nTIMMY project folder (${STANDARD}). Created ${created} by ${owner}.\n\n| dir | holds |\n|---|---|\n| skills/ | SKILL.md folders a harness may load |\n| plans/ | plans and orders (proposals until the controller arms them) |\n| boards/ | Slate boards: mission, story, blueprint |\n| drop/ | inputs dropped in for a run |\n| out/ | everything a run produces, plus out/menu.json |\n| profile.cue | who may work here, budget, models, the receipt store |\n\nHarness menus read this folder: \`timmy project menu ${name} --harness <name>\`.\nReceipts seal into the root store named in profile.cue, never here.\n`);
    const vet = spawnSync('cue', ['vet', join(dir, 'profile.cue')], { encoding: 'utf8' });
    const vetNote = vet.error ? 'cue not installed' : vet.status === 0 ? 'cue vet ok' : `cue vet failed: ${(vet.stderr ?? '').split('\n')[0]}`;
    const project = readProject(name, root);
    const menuPath = writeMenu(project, harnessMenu(project, preferred, await runners()));
    const profileSha = createHash('sha256').update(profile).digest('hex');
    console.log(JSON.stringify({ ok: project.ok, dir, standard: STANDARD, layout: LAYOUT, profile: 'profile.cue', profile_sha256: profileSha.slice(0, 16), vet: vetNote, menu: menuPath, allowed, preferred, budget, store, routing: { zdr, data_collection: dataCollection }, project_key: minted }, null, 1));
    if (!has('--no-seal')) seal('project.new', { name, dir, standard: STANDARD, owner, harnesses: allowed.join(','), preferred, budget_usd: budget, store, profile_sha256: profileSha, vet: vetNote, zdr: String(zdr), data_collection: dataCollection, project_key: minted.status, project_key_note: minted.note, project_key_sha256: minted.key_sha256 ?? '', project_key_limit: minted.limit ?? '' });
    process.exit(project.ok ? 0 : 1);
  }
  case 'menu': {
    const name = positional[1];
    if (!name) usage();
    const project = readProject(name, root);
    if (!project.ok && project.error) { console.error(project.error); process.exit(1); }
    const harness = flag('--harness', project.profile?.harnesses?.preferred || undefined);
    const menu = harnessMenu(project, harness, await runners());
    const p = writeMenu(project, menu);
    console.log(JSON.stringify({ ...menu, menu_file: p, missing: project.missing, profile_via: project.profile_via, profile_error: project.profile_error }, null, 1));
    process.exit(project.ok && menu.permitted ? 0 : 1);
  }
  case 'list': {
    const names = projectNames(root);
    const rows = names.map((n) => { const p = readProject(n, root); return { name: n, ok: p.ok, owner: p.profile?.owner ?? null, harnesses: p.profile?.harnesses?.allowed ?? [], budget_usd: p.profile?.budget?.max_spend_usd ?? null, skills: p.skills.length, plans: p.plans.length, boards: p.boards.length, drop: p.drop.length, out: p.out.length }; });
    console.log(JSON.stringify({ root, standard: STANDARD, projects: rows }, null, 1));
    break;
  }
  case 'standard':
    process.stdout.write(readFileSync(join(ROOT, 'lanes', 'project', 'README.md'), 'utf8'));
    break;
  default:
    usage();
}
