/**
 * R11 Phase 2 (H172): the three capability words are the same on both surfaces. For FAKE homes in every state, the terminal's
 * Tools & integrations screen (H167's, tab 9 of the Workbench) and the browser companion's Tools & integrations page (H171's)
 * show, for the same row, the SAME standing word (available / configured / exercised, as H170's capabilityInventory reads the
 * home: never a fourth) and the same next step; a row says "exercised" only when a receipt of a real run is on the project's
 * runs chain AND that chain verifies here (a chain changed on disk takes the word away on both surfaces); and no key's value is
 * anywhere in either surface's text or DOM (only its fingerprint and where it is kept).
 *
 * Written to FAIL until all three land (as tests/no-unchosen-paid-model.test.ts was for Phase 0): H170's inventory
 * (src/capabilities/inventory.ts capabilityInventory; inventory-words.ts standingWord), H167's screen (its header "what this installation has"
 * and "nothing here was run to make this list"; one block per row that starts with the row's name) and H171's page (one card
 * per row carrying data-inventory-row="<id>" and data-state="<word>", its next step inside it; the inventory itself in
 * GET /api/panel/tools/state under its schema timmy.capability-inventory/1).
 *
 * The homes are FAKE and real at once: real files under a temporary Timmy home, written as `timmy init` writes them
 * (applySetup), a real project with a real receipts chain (appendReceipt; its words say FAKE), a FAKE `ollama` on the PATH that
 * is a file and never run, a FAKE OpenRouter key made at run time (the value this test looks for and must never see). Nothing
 * is asked over the network: the surfaces read files, and the FAKE Ollama address is a closed port on 127.0.0.1. Chromium is
 * real (playwright); where none is found the DOM checks are skipped, saying so, and the words are still checked through the
 * page's route.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { applySetup } from '../src/utils/init.js';
import { appendReceipt, receiptsPath, type ReceiptInput } from '../src/utils/receipts.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import type { Frame } from '../src/workbench/screen.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

// ── H170's inventory, as its interface was posted (handoff 13:52 PT): read by path so this file compiles before it lands ──

type Word = 'available' | 'configured' | 'exercised';
const WORDS: readonly Word[] = ['available', 'configured', 'exercised'];
interface Fact { ok: boolean; found: string; source: string; words: string }
type Exercised = ({ ok: true; receipt: string; hash: string; when: string; what: string } | { ok: false; found: string }) & { source: string; words: string };
interface InventoryRow { id: string; name: string; group: string; available: Fact; configured: Fact; exercised: Exercised; next?: string }
interface InventoryContext { env?: Record<string, string | undefined>; cwd?: string; home?: string; platform?: NodeJS.Platform; packaged?: (rel: string) => boolean }
interface InventoryModule { capabilityInventory: (ctx?: InventoryContext) => InventoryRow[] }
interface WordsModule { standingWord: (r: InventoryRow) => Word | 'none' }

const INVENTORY_PATH = '../src/capabilities/inventory.js';
const WORDS_PATH = '../src/capabilities/inventory-words.js';
let inventoryModule: InventoryModule | null = null;
let wordsModule: WordsModule | null = null;
let inventoryMissing = '';

/** The one word a row stands at: exercised when its receipt counts, else configured, else available, else none (H170's standingWord). */
const standing = (r: InventoryRow): Word | 'none' => (wordsModule?.standingWord ? wordsModule.standingWord(r) : r.exercised.ok ? 'exercised' : r.configured.ok ? 'configured' : r.available.ok ? 'available' : 'none');
const okWords = (r: InventoryRow): Word[] => WORDS.filter((w) => r[w].ok);
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The words a block of a surface claims for its row: each bare word that is not "not <word>" (the sentences say "not configured, …"). */
const claimed = (block: string): Word[] => WORDS.filter((w) => new RegExp(`(?<!not )\\b${w}\\b`, 'i').test(block));

// ── the FAKE homes ────────────────────────────────────────────────────────────

const MODEL = 'granite4.2:latest';
/** FAKE: the OpenRouter key this test keeps in providers.json; the value must never reach a surface */
const FAKE_KEY = `sk-or-v1-FAKE${'0123456789abcdef'.repeat(4)}`;
const TOKEN = 'e2'.repeat(32);
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

type StateId = 'nothing' | 'available' | 'configured' | 'exercised' | 'tampered' | 'key-no-model';
interface Home { id: StateId; box: string; home: string; timmyHome: string; project: { name: string; root: string; id: string }; env: NodeJS.ProcessEnv; chainChanged?: boolean }

const kept: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'TIMMY_STORE', 'PATH', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OLLAMA_HOST', 'ROBOFLOW_API_KEY', 'TIMMY_REPO', 'TIMMY_WORKBENCH_CHAT', 'TIMMY_CHAT_MODEL'];
let root = '';
let closedPort = 0;
let browserPath: string | undefined;

beforeAll(async () => {
  for (const k of ENV_KEYS) kept[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'capability-words-'));
  // a port on 127.0.0.1 where nothing listens: the FAKE Ollama address (no surface contacts it: the inventory reads files)
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  closedPort = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  try { inventoryModule = await import(INVENTORY_PATH) as InventoryModule; wordsModule = await import(WORDS_PATH) as WordsModule; } catch (e) { inventoryMissing = e instanceof Error ? e.message : String(e); }
  browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!browserPath) console.warn('capability-words: no Chromium found, so the DOM checks are skipped here (the route checks still run)');
}, 30_000);

afterAll(() => {
  for (const k of ENV_KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; }
  if (root) rmSync(root, { recursive: true, force: true });
});

let homes = 0;
/** A FAKE home in one state: real files, nothing run. The process's environment points at it (both surfaces read it there). */
function makeHome(id: StateId): Home {
  const box = join(root, `${id}-${++homes}`);
  const home = join(box, 'home');
  const timmyHome = join(home, 'timmy');
  const bin = join(box, 'bin');
  for (const d of [timmyHome, bin, join(box, 'settings'), join(box, 'tmp')]) mkdirSync(d, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, TIMMY_HOME: timmyHome, TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'),
    OPENROUTER_API_KEY: '', PATH: `${bin}:${kept.PATH ?? ''}`,
  };
  for (const k of ['OPENROUTER_MODEL', 'OLLAMA_HOST', 'ROBOFLOW_API_KEY', 'TIMMY_REPO', 'TIMMY_WORKBENCH_CHAT', 'TIMMY_CHAT_MODEL']) delete env[k];
  Object.assign(process.env, env);
  for (const k of ['OPENROUTER_MODEL', 'OLLAMA_HOST', 'ROBOFLOW_API_KEY', 'TIMMY_REPO', 'TIMMY_WORKBENCH_CHAT', 'TIMMY_CHAT_MODEL']) delete process.env[k];
  // the project (under the Timmy home, as the Workbench and the companion find it), its own store pinned (as timmy init pins it)
  const made = createProject(`FAKE-caps-${id}-${homes}`);
  if ('error' in made) throw new Error(made.error);
  saveActiveProject(made);
  const store = join(made.root, '.timmy', 'receipts');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(made.root, '.timmy', 'store-pin'), store);
  env.TIMMY_STORE = store;
  process.env.TIMMY_STORE = store;
  const project = { name: made.name, root: made.root, id: projectId(made.root) };
  if (id === 'nothing') return { id, box, home, timmyHome, project, env };
  // available: a FAKE ollama on the PATH, a file that is never run (its words say so if it ever were)
  writeFileSync(join(bin, 'ollama'), '#!/bin/sh\necho "FAKE ollama: a file on the PATH for a test; nothing runs it" >&2\nexit 1\n');
  chmodSync(join(bin, 'ollama'), 0o755);
  if (id === 'available') return { id, box, home, timmyHome, project, env };
  if (id === 'key-no-model') {
    // a key present (FAKE), the chat set to OpenRouter, no model chosen anywhere
    applySetup({ operator: 'FAKE operator', chat: 'openrouter', key: FAKE_KEY }, { by: 'capability-words test (a FAKE home)', repoRoot: made.root });
    return { id, box, home, timmyHome, project, env };
  }
  // configured: the chat set to a local model at the FAKE address, and a FAKE OpenRouter key kept too (never its value shown)
  applySetup({ operator: 'FAKE operator', chat: 'local', model: MODEL, ollama: `127.0.0.1:${closedPort}`, key: FAKE_KEY }, { by: 'capability-words test (a FAKE home)', repoRoot: made.root });
  if (id === 'configured') return { id, box, home, timmyHome, project, env };
  // exercised: a sealed chat turn through the Ollama on this computer, on the project's runs chain (real appendReceipt, FAKE words)
  appendReceipt('runs', {
    policy: 'auto', status: 'ok', project: project.name, project_id: project.id, kind: 'turn', via: 'ollama',
    model_requested: MODEL, model_resolved: MODEL, sources: [{ kind: 'ollama', host: `127.0.0.1:${closedPort}` }],
    subject: `FAKE sealed turn: ${MODEL} answered (a test's receipt; no model ran)`,
  } as unknown as ReceiptInput);
  if (id === 'exercised') return { id, box, home, timmyHome, project, env };
  // tampered: the same chain with one receipt's subject changed on disk, so the chain no longer verifies
  const file = receiptsPath('runs');
  writeFileSync(file, readFileSync(file, 'utf8').replace('FAKE sealed turn', 'FAKE sealed turn, changed on disk'));
  return { id, box, home, timmyHome, project, env, chainChanged: true };
}

// ── the terminal (H167's screen, tab 9) ──────────────────────────────────────

const opened: Controller[] = [];
afterEach(() => { for (const c of opened.splice(0)) c.dispose(); });

function workbench(h: Home): Controller {
  const jobsDir = join(h.timmyHome, 'jobs');
  const ws = new Workspace({
    glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t,
    seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined,
  }, { name: h.project.name, root: h.project.root, chosen: true });
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started by the Workbench in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(h.box, 'studio-store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) as never }),
    // FAKE: the ladder's rows (tab 9's old TOOLS list) come from no machine probe here; the inventory is read from the home's files
    capabilities: async () => [], tickMs: 100, slowMs: 400,
  });
  opened.push(c);
  return c;
}

/** A region's rows as text, inside its border. */
function regionRows(f: Frame, region: 'center' | 'right'): string[] {
  const rect = f.regions[region]?.rect;
  if (!rect) return [];
  const rows = screenText(f.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of rows[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out;
}

interface SurfaceRow { word: Word | 'none'; claimed: Word[]; next: string | null; text: string }

/** The row's block on the screen: from the line that starts with its name to the next row's line; the chip word it shows. */
function terminalRow(lines: string[], row: InventoryRow, names: string[]): string | null {
  const starts = (line: string, name: string): boolean => new RegExp(`^\\W{0,4}${esc(name)}(?!\\w)`).test(line.trimStart());
  const at = lines.findIndex((l) => starts(l, row.name));
  if (at < 0) return null;
  const block: string[] = [lines[at]];
  for (let i = at + 1; i < lines.length && block.length < 8; i++) {
    if (names.some((n) => n !== row.name && starts(lines[i], n))) break;
    block.push(lines[i]);
  }
  return collapse(block.join(' '));
}

/** Tab 9 at the size given: every inventory row read as the screen shows it (Down scrolls the list to the rows below). */
function terminalRows(c: Controller, w: number, h: number, ref: InventoryRow[]): { header: string; rows: Map<string, SurfaceRow>; screens: string[] } {
  // 9 opens tab 9 (the same key again would show the tab's next workspace, so it is pressed only from another tab)
  if (c.ui.page !== 'tools') c.key('9', {});
  let f = c.frame(w, h);
  const screens = [screenText(f.screen).join('\n')];
  const header = collapse(regionRows(f, 'center').slice(0, 4).join(' '));
  const names = ref.map((r) => r.name);
  const rows = new Map<string, SurfaceRow>();
  for (const r of ref) {
    let block: string | null = null;
    for (let presses = 0; presses < 120 && !block; presses++) {
      block = terminalRow(regionRows(f, 'center'), r, names);
      if (block) break;
      c.key('Down', {});
      f = c.frame(w, h);
      screens.push(screenText(f.screen).join('\n'));
    }
    if (!block) continue;
    const words = claimed(block);
    const word = words.includes('exercised') ? 'exercised' : words.includes('configured') ? 'configured' : words.includes('available') ? 'available' : 'none';
    rows.set(r.id, { word, claimed: words, next: r.next && block.includes(collapse(r.next)) ? collapse(r.next) : null, text: block });
  }
  return { header, rows, screens };
}

// ── the page (H171's, over the companion's existing route) ───────────────────

let companion: CompanionServer | null = null;
let browser: Browser | null = null;
afterEach(async () => { await companion?.shutdown(); companion = null; });
afterAll(async () => { await browser?.close(); });

async function startPage(h: Home): Promise<CompanionServer> {
  companion = await startCompanionServer(4494, { token: TOKEN, chatEnv: h.env, workspace: { env: h.env, shareMs: 0 } });
  return companion;
}

/** The inventory the page's route carries: the object under its schema, wherever the state keeps it. */
function inventoryIn(value: unknown): { rows: InventoryRow[] } | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): { rows: InventoryRow[] } | null => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (o.schema === 'timmy.capability-inventory/1' && Array.isArray(o.rows)) return { rows: o.rows as InventoryRow[] };
    for (const inner of Object.values(o)) { const found = walk(inner); if (found) return found; }
    return null;
  };
  return walk(value);
}

async function pageState(h: Home): Promise<{ text: string; inventory: { rows: InventoryRow[] } | null }> {
  const res = await fetch(new URL(`/api/panel/tools/state?project=${encodeURIComponent(h.project.id)}`, companion!.address), { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON: said below */ }
  return { text, inventory: inventoryIn(parsed) };
}

/** The page's cards in a real Chromium: data-inventory-row, data-state and the card's text (its next step inside it). */
async function pageCards(h: Home): Promise<{ html: string; cards: Map<string, { state: string; text: string }> }> {
  browser ??= await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto(companion!.url.replace('/#t=', `/?tab=tools&project=${encodeURIComponent(h.project.id)}#t=`));
    await page.waitForSelector('[data-inventory-row]', { timeout: 15_000 }).catch(() => undefined);
    const cards = new Map<string, { state: string; text: string }>();
    for (const card of await page.$$eval('[data-inventory-row]', (els) => els.map((e) => ({ id: e.getAttribute('data-inventory-row') ?? '', state: e.getAttribute('data-state') ?? '', text: e.textContent ?? '' })))) cards.set(card.id, { state: card.state, text: collapse(card.text) });
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    return { html, cards };
  } finally { await page.close(); }
}

// ── the checks ────────────────────────────────────────────────────────────────

const STATES: StateId[] = ['nothing', 'available', 'configured', 'exercised', 'tampered', 'key-no-model'];

describe('the three capability words, the same on the terminal and the page (R11 Phase 2, H172)', { timeout: 120_000 }, () => {
  it('H170\'s inventory is here: capabilityInventory (src/capabilities/inventory.ts) and standingWord (inventory-words.ts)', () => {
    expect(inventoryModule, `the inventory module could not be read: ${inventoryMissing}`).not.toBeNull();
    expect(typeof inventoryModule?.capabilityInventory).toBe('function');
    expect(typeof wordsModule?.standingWord).toBe('function');
  });

  it('a key present but no model: the inventory names the key by its fingerprint and place, never its value; no row stands exercised', () => {
    const h = makeHome('key-no-model');
    const rows = inventoryModule?.capabilityInventory({ env: h.env, cwd: h.project.root, home: h.home }) ?? [];
    expect(rows.length, 'the inventory read rows').toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(FAKE_KEY);
    const or = rows.find((r) => r.id === 'model:openrouter');
    expect(or?.configured.ok).toBe(true);
    expect(or?.configured.found).toMatch(/a key is present/);
    expect(rows.every((r) => !r.exercised.ok)).toBe(true);
  });

  it('the bridge absent: the inventory\'s own seam (the real build carries it, so no FAKE home can lack it): the words say missing, next says reinstall', () => {
    const h = makeHome('nothing');
    const rows = inventoryModule?.capabilityInventory({ env: h.env, cwd: h.project.root, home: h.home, packaged: () => false }) ?? [];
    const bridge = rows.find((r) => r.id === 'vision:bridge');
    expect(bridge, 'the vision bridge row').toBeTruthy();
    expect(bridge?.available.ok).toBe(false);
    expect(standing(bridge!)).toBe('none');
    expect(bridge?.available.words).toMatch(/not available, missing from this installation/);
    expect(bridge?.next).toMatch(/reinstall Timmy/);
  });

  for (const id of STATES) {
    it(`FAKE home "${id}": the same standing word and next step for every row on the terminal (122x37, 80x24) and on the page; exercised only on a chain that verifies; the FAKE key's value nowhere`, async () => {
      const h = makeHome(id);
      const ref = inventoryModule?.capabilityInventory({ env: h.env, cwd: h.project.root, home: h.home }) ?? [];
      expect(ref.length, 'the inventory read rows for this home').toBeGreaterThan(0);
      // the reference itself: the chain's word, and never the key
      if (id === 'exercised') expect(ref.find((r) => r.id === 'model:ollama-local')?.exercised.ok, 'the sealed local turn counts').toBe(true);
      if (id === 'tampered') {
        expect(ref.every((r) => !r.exercised.ok), 'a chain changed on disk vouches for nothing').toBe(true);
        expect(ref.find((r) => r.id === 'model:ollama-local')?.exercised.words).toMatch(/does not verify/);
      }
      if (id === 'nothing' || id === 'available') expect(ref.every((r) => !r.exercised.ok)).toBe(true);
      expect(JSON.stringify(ref)).not.toContain(FAKE_KEY);

      // the terminal, at the target's size and at the small one
      const c = workbench(h);
      for (const [w, hh] of [[122, 37], [80, 24]] as const) {
        const t = terminalRows(c, w, hh, ref);
        expect(t.header, `tab 9's header at ${w}x${hh}`).toMatch(/what this installation has/i);
        expect(t.header).toMatch(/nothing here was run to make this list/i);
        for (const r of ref) {
          const shown = t.rows.get(r.id);
          expect(shown, `the terminal's row for ${r.name} (${r.id}) at ${w}x${hh}`).toBeTruthy();
          expect(shown!.word, `the terminal's standing word for ${r.name} at ${w}x${hh}: ${shown!.text}`).toBe(standing(r));
          expect(shown!.claimed, `the words the terminal claims for ${r.name} at ${w}x${hh}`).toEqual(okWords(r));
          if (r.next) expect(shown!.next, `the terminal's next step for ${r.name} at ${w}x${hh}: ${shown!.text}`).toBe(collapse(r.next));
        }
        for (const s of t.screens) expect(s).not.toContain(FAKE_KEY);
      }
      const terminal = terminalRows(c, 122, 37, ref).rows;

      // the page's route: the inventory under its schema, the same rows and words
      await startPage(h);
      const state = await pageState(h);
      expect(state.inventory, 'GET /api/panel/tools/state carries the inventory (schema timmy.capability-inventory/1)').toBeTruthy();
      expect(state.text).not.toContain(FAKE_KEY);
      for (const r of ref) {
        const p = state.inventory!.rows.find((x) => x.id === r.id);
        expect(p, `the page's route has the row ${r.id}`).toBeTruthy();
        expect(standing(p!), `the page's standing word for ${r.name}`).toBe(standing(r));
        expect(okWords(p!)).toEqual(okWords(r));
        expect(p!.next ?? null).toBe(r.next ?? null);
        expect(WORDS.map((w) => p![w].words)).toEqual(WORDS.map((w) => r[w].words));
      }

      // the page's DOM: one card per row, its state word and its next step as the terminal shows them; the key's value nowhere
      if (!browserPath) { console.warn(`capability-words (${id}): no Chromium, so the page's cards are not read here (not a pass)`); return; }
      const dom = await pageCards(h);
      expect(dom.html).not.toContain(FAKE_KEY);
      expect(dom.cards.size, 'the page draws one card per row ([data-inventory-row])').toBeGreaterThan(0);
      for (const r of ref) {
        const card = dom.cards.get(r.id);
        expect(card, `the page's card for ${r.name} (${r.id})`).toBeTruthy();
        expect(card!.state, `the page's state word for ${r.name}`).toBe(standing(r));
        expect(card!.state).toBe(terminal.get(r.id)?.word);
        if (r.next) {
          expect(card!.text, `the page's next step for ${r.name}`).toContain(collapse(r.next));
          expect(terminal.get(r.id)?.next).toBe(collapse(r.next));
        }
      }
    });
  }
});
