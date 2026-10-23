/**
 * R11 phase 2 (H167): the Tools & integrations screen the rail's item opens (the workspace `tools`): the honest inventory of
 * what this installation has, in the three words the common brief fixes and no fourth:
 *
 *   available    the files or binaries are here (the ladder's installed evidence; nothing set, nothing asked)
 *   configured   a key, a setting or an address is set for it (the installed evidence names a setting, or a probe answered)
 *   exercised    a receipt of a real run of Timmy's own exists, on a chain that verified (the ladder's exercised evidence):
 *                green, and only then; its receipt's short id on the row
 *   (no chip)    nothing of it is here: what the check found, and the next step
 *
 * One row per capability: name · state chip · what was found · the next step, in the product's own setup words (never a
 * command the person did not ask for: the command stays in the details, [i] or Enter); a step that needs a key or an
 * address says where it is set (Models & accounts, the .env file) and does nothing itself. The groups
 * are the rail's (CHAT · WORK · CREATE · CONNECT), in its order. The header says what this installation has, and the row
 * under it that nothing here was run to make the list. Enter on a row opens its details in the right pane (the Inspector:
 * the facts and the receipt id). At 80x24 the list scrolls; the chip is never cut.
 *
 * The rows come from H170's capability inventory (src/capabilities/inventory.ts: files, settings and receipts read for the
 * project; nothing run, nothing contacted), through `fromInventory`, when the controller read one (src/workbench/run.ts
 * wires inventory({ env, cwd })); a Data without one (the other tabs' tests, a Controller without the dependency) reads
 * src/capabilities' rows (the /tools ladder) through `fromCapabilities` into the same screen rows.
 */
import type { CapabilityRow } from '../capabilities/index.js';
import type { Inventory, InventoryRow } from '../capabilities/inventory.js';
import type { Glyphs } from './frame.js';
import { inWords } from './home-journey.js';
import type { Lazy } from './model.js';
import { fieldRows, heading, onBar, para, S, selectedIn, type TabCtx, type TabView } from './tab-columns.js';
import { lazyRows } from './tab-parts.js';
import { callRows, KINDS, MCP_ROUTES, searchRows, TOOLS_LIST, type McpCallRow, type ToolsData, type ToolsSearch } from './tools-tab.js';
import { clock, count, cut, fit, pick, type Line, type Role, type Seg } from './text.js';

/** The three words, and no fourth. */
export type InventoryState = 'available' | 'configured' | 'exercised';
export const STATES: readonly InventoryState[] = ['available', 'configured', 'exercised'];

export type RailGroupId = 'chat' | 'work' | 'create' | 'connect';
/** The groups in the rail's order, with the rail's labels. */
export const GROUPS: ReadonlyArray<{ id: RailGroupId; label: string }> = [
  { id: 'chat', label: 'CHAT' }, { id: 'work', label: 'WORK' }, { id: 'create', label: 'CREATE' }, { id: 'connect', label: 'CONNECT' },
];

export interface ScreenRow {
  id: string;
  group: RailGroupId;
  /** the group's own name where the source has one (H170's Models · Tools · Integrations · Lanes · Vision · Receipts) */
  under?: string;
  name: string;
  /** null: nothing of it is here (the chip's place stays empty; `found` says what the check found) */
  state: InventoryState | null;
  /** what was found, in words (never a key, an address or a command) */
  found: string;
  /** the next step in the product's own words, when there is one; empty when nothing is to be done */
  next: string;
  /** where a key or an address is set, when the step needs one: said, never done here */
  where?: string;
  /** the step's short form, for a row whose column is narrow (the details keep the whole) */
  short?: string;
  /** the receipt's short id, when exercised */
  receipt?: string;
  /** when it was last exercised (ISO) */
  at?: string;
  /** the facts for the details: the evidence each rung carries, in its own words */
  facts: Array<[string, string]>;
  /** the ladder's row, where this came from one (the family views' Inspector keeps its own rows) */
  row?: CapabilityRow;
}

export interface ScreenGroup { id: RailGroupId; label: string; rows: ScreenRow[] }

// ── the grouping: the rail's groups, by row id (the kinds of src/capabilities decide what has no place of its own) ──────

const CHAT_IDS = new Set(['repl', 'openrouter', 'ollama', 'spatial-review']);
const WORK_IDS = new Set(['workflows', 'receipts', 'project-files', 'canvas', 'canvas-tools', 'workspace', 'builtin', 'recipe-tray']);
const CREATE_IDS = new Set(['look', 'adapters', 'c4dpy', 'blender', 'openscad', 'freecad', 'unreal', 'aerender', 'afterfx', 'rea', 'mission-map']);

export function groupOf(r: Pick<CapabilityRow, 'id' | 'kind'>): RailGroupId {
  if (CHAT_IDS.has(r.id) || r.kind === 'model') return 'chat';
  if (WORK_IDS.has(r.id)) return 'work';
  if (CREATE_IDS.has(r.id) || r.kind === 'vox' || r.kind === 'adapter' || r.id.startsWith('rea:') || r.id.startsWith('vox:') || r.id.startsWith('native:')) return 'create';
  return 'connect';
}

// ── the state: the three words from the ladder's evidence, nothing inferred ───────────────────────────────────────────

/** State words of src/capabilities' rows that say a key, an address or a model is set (never its value): "key set; not
 *  contacted", "model key from providers.json", "address set; no answer", the REPL's "chat: local <model> · <address>". */
const SETTING_WORDS = /\b(?:key set|address set|host set|key from|checkout found)\b|^chat: (?:local \S+ ·|OpenRouter)/i;

/** The state, what was found and the receipt, read from the row's rung and its ladder (src/capabilities/ladder.ts). */
export function stateOf(r: CapabilityRow): { state: InventoryState | null; receipt?: string; at?: string } {
  const l = r.ladder;
  // exercised: the rung stands now (a past run never raises a missing tool: the ladder's own rule) and its receipt is named
  if ((r.rung === 'exercised' || r.rung === 'qualified') && l?.exercised?.receipt) return { state: 'exercised', receipt: l.exercised.receipt, at: l.exercised.at };
  if (r.rung === 'exercised' || r.rung === 'qualified') return { state: 'exercised' };
  // configured: a probe answered (an address or a key was set for it to), or the installed evidence names a setting
  if (r.rung === 'reachable') return { state: 'configured' };
  if (r.rung === 'installed') {
    const inst = l?.installed;
    const viaSetting = !!inst && (/setting|environment|key|\.env/i.test(inst.how ?? '') || /^[A-Z][A-Z0-9_]+$/.test(inst.where ?? ''));
    return { state: viaSetting || SETTING_WORDS.test(r.detail) ? 'configured' : 'available' };
  }
  return { state: null };
}

/** The words of a state, and its role: exercised green only with a receipt; configured plain; available dim. */
export function stateSeg(state: InventoryState | null, receipt: string | undefined, sel: { selected?: true } = {}): Seg {
  if (!state) return S(' '.repeat(10), 'text', sel);
  const role: Role = state === 'exercised' ? (receipt ? 'live' : 'text') : state === 'configured' ? 'text' : 'secondary';
  return S(state.padEnd(10), role, sel);
}

// ── the next step, in the product's own words ─────────────────────────────────────────────────────────────────────────

const KEY_LIKE = /KEY|SECRET|TOKEN|PASSWORD/;

/** A setup line (src/capabilities' `setup`: often a command) as the product's own next step, and where a key or an address
 *  is set. The command itself stays in the details. */
export function nextWords(r: Pick<CapabilityRow, 'id' | 'rung' | 'setup' | 'detail'>): { next: string; where?: string; short?: string } {
  if (r.rung !== 'needs setup' && r.rung !== 'proposed') return { next: '' };
  const s = (r.setup ?? '').trim();
  if (!s) return { next: r.rung === 'proposed' ? 'planned; no code here runs it yet' : '' };
  // (`short`: the row's form where its column is narrow; the details keep the whole)
  if (/OPENROUTER_API_KEY|timmy init|\/setup chat|\/model\b|--chat/.test(s)) return { next: 'choose the chat\'s model and its key', short: 'a model and its key', where: 'Models & accounts' };
  if (/ollama (?:serve|pull)/i.test(s)) return { next: 'start Ollama and pull a model', short: 'Ollama and a model', where: 'Models & accounts' };
  // "set NAME" and "export NAME=<value>" (src/recipes' row) both ask for a setting: named, never the shell line
  const set = /^set ([A-Z][A-Z0-9_]*)(?:(?:,| and) ([A-Z][A-Z0-9_]*))?/.exec(s) ?? /^export ([A-Z][A-Z0-9_]*)=/.exec(s);
  if (set) {
    const names = [set[1], set[2]].filter((x): x is string => !!x);
    const kind = names.some((n) => KEY_LIKE.test(n)) ? 'a key' : /URL|HOST|PATH|BASE|ADDR/.test(names.join(' ')) ? 'an address' : 'a setting';
    return { next: `${kind} is needed (${names.join(', ')})`, short: `${kind} (${names.join(', ')})`, where: 'the .env file' };
  }
  if (/\b(?:brew|npm|npx|pip3?|cargo|apt|python3 -m venv)\b/.test(s)) return { next: 'install it on this computer; the command is in its details', short: 'install it; the command is in its details' };
  if (/^\/canvas/.test(s)) return { next: 'open the canvas', where: 'Canvas' };
  if (/^\/lanes/.test(s)) return { next: 'each lane says its own step; the list is in its details', short: 'each lane says its own step' };
  if (/run Timmy from a checkout/i.test(s)) return { next: 'run Timmy from a checkout of its repository' };
  return { next: inWords(s) };
}

// ── the reading: capability rows as inventory rows, grouped ───────────────────────────────────────────────────────────

/** What was found, in words: the row's state words through inWords (no address, no command), the exercised run's time. */
function foundWords(r: CapabilityRow, st: ReturnType<typeof stateOf>, sep: string): string {
  const base = inWords(r.detail.replace(/\s+/g, ' ')).replace(/^chat: /, '');
  if (st.state === 'exercised' && st.at) return `${base} ${sep} last run ${clock(st.at)}`;
  return base;
}

/** The facts for the details: each rung's own evidence (the ladder), its demonstrations, what it covers. */
function factsOf(r: CapabilityRow, calls: readonly McpCallRow[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const l = r.ladder;
  out.push(['Rung', r.rung]);
  if (l?.installed) out.push(['Found', [l.installed.found, l.installed.where ? `at ${l.installed.where}` : '', l.installed.how ? `(${l.installed.how})` : '', l.installed.version ? `version ${l.installed.version}${l.installed.versionFrom ? `, as ${l.installed.versionFrom} says` : ''}` : ''].filter(Boolean).join(' ')]);
  else if (r.notReached?.installed) out.push(['Not found', r.notReached.installed]);
  if (l?.reachable) out.push(['Answered', `${l.reachable.answer} (asked: ${l.reachable.asked}, ${clock(l.reachable.at)})`]);
  else if (r.notReached?.reachable) out.push(['Not asked', r.notReached.reachable]);
  if (l?.exercised) out.push(['Exercised', `${l.exercised.what}; ${clock(l.exercised.at)}; receipt ${l.exercised.receipt}; ${l.exercised.chain}${l.exercised.record ? `; record ${l.exercised.record}` : ''}`]);
  else if (r.notReached?.exercised) out.push(['Not exercised', r.notReached.exercised]);
  if (l?.qualified) out.push(['Qualified', `${l.qualified.what}; ${l.qualified.scope}; ${l.qualified.record}; receipt ${l.qualified.receipt}`]);
  if (l?.proposed) out.push(['Planned', `${l.proposed.plan} § ${l.proposed.section}: ${l.proposed.says}`]);
  if (r.demonstrated?.length) out.push(['Demonstrated', `${count(r.demonstrated.length, 'demonstration')} on the operator's Mac (never a rung here)`]);
  if (r.tools?.length) out.push(['Covers', r.tools.join(', ')]);
  if (r.setup) out.push(['Command', r.setup]);
  if (r.id.startsWith('mcp-cli')) {
    const own = calls.filter((c) => (r.id === 'mcp-cli' || r.id === `mcp-cli:${c.read.record.route}`));
    if (own.length) out.push(['MCP calls', own.slice(0, 3).map((c) => `${c.read.record.tool} ${clock(c.read.record.started_at)}${c.seal ? ` · receipt ${c.seal.hash.slice(7, 15)}` : ' · not sealed'}`).join('; ')]);
  }
  return out;
}

/** Screen rows grouped in the rail's order (the empty groups left out). */
export function grouped(rows: readonly ScreenRow[]): ScreenGroup[] {
  const groups: ScreenGroup[] = GROUPS.map((gr) => ({ ...gr, rows: [] }));
  for (const r of rows) groups.find((gr) => gr.id === r.group)!.rows.push(r);
  return groups.filter((gr) => gr.rows.length);
}

/** The inventory from src/capabilities' rows: grouped in the rail's order, each group's rows in /tools' order. */
export function fromCapabilities(caps: readonly CapabilityRow[], extra: { calls?: readonly McpCallRow[]; sep?: string } = {}): ScreenGroup[] {
  const rows: ScreenRow[] = [];
  // (All tools' order: by kind, then as the ladder lists them)
  const ordered = KINDS.flatMap((k) => caps.filter((r) => r.kind === k));
  for (const r of ordered) {
    const st = stateOf(r);
    const nx = nextWords(r);
    const row: ScreenRow = {
      id: r.id, group: groupOf(r), name: r.name.trim(), state: st.state, found: foundWords(r, st, extra.sep ?? '·'), next: nx.next,
      ...(nx.where ? { where: nx.where } : {}), ...(nx.short ? { short: nx.short } : {}), ...(st.receipt ? { receipt: st.receipt } : {}), ...(st.at ? { at: st.at } : {}),
      facts: factsOf(r, extra.calls ?? []), row: r,
    };
    rows.push(row);
  }
  return grouped(rows);
}

// ── H170's capability inventory (src/capabilities/inventory.ts): the same screen rows from its rows ──────────────────

/** H170's groups under the rail's: Models in CHAT, Receipts in WORK, the vox Tools and Vision in CREATE, the rest in CONNECT. */
const RAIL_OF: Readonly<Record<InventoryRow['group'], RailGroupId>> = { Models: 'chat', Receipts: 'work', Tools: 'create', Vision: 'create', Integrations: 'connect', Lanes: 'connect' };

/** The inventory's next step (its own setup words, which name commands and addresses) as the row's words: the step, its short
 *  form, and where a key, an address or a setting is set (said, never done here). The inventory's words whole are the details'. */
export function inventoryNext(next: string | undefined): { next: string; short?: string; where?: string } {
  const t = (next ?? '').trim();
  if (!t) return { next: '' };
  if (/Sign in with OpenRouter|openrouter\.ai\/keys/i.test(t)) return { next: 'sign in with OpenRouter, or paste a key', short: 'sign in or paste a key', where: 'Models & accounts' };
  if (/Set the chat to OpenRouter/i.test(t)) return { next: 'set the chat to OpenRouter', where: 'Models & accounts' };
  if (/Choose a local model|timmy init --chat local/i.test(t)) return { next: 'choose a local model', where: 'Models & accounts' };
  if (/Install Ollama|^Install it: .*ollama/i.test(t)) return { next: 'install Ollama, then start it', short: 'install Ollama', where: 'Models & accounts' };
  if (/^Download a (?:local )?model/i.test(t)) return { next: 'download a model into Ollama', short: 'download a model', where: 'Models & accounts' };
  if (/Paste an Ollama API key|ollama\.com\/settings\/keys/i.test(t)) return { next: 'paste an Ollama API key', where: 'Models & accounts' };
  if (/Choose a cloud-backed model/i.test(t)) return { next: 'choose a cloud-backed model', short: 'a cloud-backed model', where: 'Models & accounts' };
  if (/^Send a message in the chat/i.test(t)) return { next: 'send a message in the chat; each answered turn seals a receipt', short: 'send a message in the chat' };
  // (a run that would exercise it, before a setting its sentence names in passing)
  if (/^Run it once: |^\/mcp call|^\/agent |^\/lanes dispatch|^timmy vision run|^any sealed run/i.test(t)) return { next: 'run it once (it asks first); its receipt seals the run', short: 'run it once; its receipt seals the run' };
  const set = /\b(?:set|export) ([A-Z][A-Z0-9_]*)/.exec(t);
  if (set) {
    const kind = KEY_LIKE.test(set[1]) ? 'a key' : /URL|HOST|PATH|BASE|ADDR/.test(set[1]) ? 'an address' : 'a setting';
    const opt = /^optional\b/i.test(t) ? 'optional: ' : '';
    return { next: `${opt}${kind} is needed (${set[1]})`, short: `${opt}${kind} (${set[1]})`, where: 'the .env file' };
  }
  if (/\bname .* in MCPorter|^Name a server in/i.test(t)) return { next: 'name the server in MCPorter\'s config', short: 'name the server', where: 'MCPorter\'s config (mcporter.json)' };
  if (/^timmy init \(it makes the store/i.test(t)) return { next: 'run the setup once: it makes the store and its pin', short: 'run the setup once' };
  if (/reinstall Timmy|run it from a checkout/i.test(t)) return { next: 'reinstall Timmy, or run it from a checkout of its repository', short: 'reinstall, or run from a checkout' };
  if (/github\.com\/|https?:\/\/|\bdownload\b/i.test(t) && !/\b(?:brew|npm|npx|pip3?|cargo|apt|uv tool)\b/i.test(t)) return { next: 'install it on this computer; its address is in its details', short: 'install it; its address is in its details' };
  if (/\b(?:brew|npm|npx|pip3?|cargo|apt|uv tool|python3 -m venv)\b|^install /i.test(t)) return { next: 'install it on this computer; the command is in its details', short: 'install it; the command is in its details' };
  if (/^see \//i.test(t)) return { next: 'its own page says the step; it is in its details', short: 'the step is in its details' };
  return { next: inWords(t) };
}

/** A fact's long sentence as a row's words: the chat's route said short, a FAKE model named FAKE, a key by where it is from. */
const rowFound = (t: string): string => t.replace(/\s+/g, ' ')
  .replace(/^the chat is set to local (\S+)(?: \([^)]*\))?(?: from [^;]+)?/, 'local $1')
  // (a FAKE model is named FAKE on screen, wherever its name stands in the fact: the review's stand-ins are fake-…)
  .replace(/(?<![\w-])(?<!FAKE )(fake(?:-[\w.:-]+|:[\w.:-]+))/gi, 'FAKE $1')
  .replace(/^the chat is set to local, and no model is chosen/, 'local; no model chosen')
  .replace(/^the chat is set to OpenRouter/, 'the chat: OpenRouter')
  .replace(/\ba key is present \([^)]*\), from /, 'a key from ');

/** The inventory from H170's rows: the chip is the highest state whose fact holds (exercised green with its receipt), what
 *  was found is that fact's own words through inWords (no address, no command on the row; the sentence whole is the
 *  details'), the next step the row's own in the product's words (the inventory's words whole in the details). */
export function fromInventory(rows: readonly InventoryRow[], extra: { sep?: string } = {}): ScreenGroup[] {
  const sep = extra.sep ?? '·';
  return grouped(rows.map((r): ScreenRow => {
    const state: InventoryState | null = r.exercised.ok ? 'exercised' : r.configured.ok ? 'configured' : r.available.ok ? 'available' : null;
    const foundRaw = r.exercised.ok ? r.exercised.what : r.configured.ok ? r.configured.found : r.available.found;
    const base = inWords(rowFound(foundRaw));
    const found = r.exercised.ok ? `${base} ${sep} last run ${clock(r.exercised.when)}` : base;
    const nx = inventoryNext(r.next);
    const facts: Array<[string, string]> = [
      ['Available', `${r.available.ok ? 'yes' : 'no'}: ${r.available.found} (${r.available.source})`],
      ['Configured', `${r.configured.ok ? 'yes' : 'no'}: ${r.configured.found} (${r.configured.source})`],
      ['Exercised', r.exercised.ok ? `${r.exercised.what}; ${clock(r.exercised.when)}; receipt ${r.exercised.receipt}${r.exercised.record ? `; record ${r.exercised.record}` : ''} (${r.exercised.source})` : `no: ${r.exercised.found} (${r.exercised.source})`],
      ...(r.next ? [['Step', r.next] as [string, string]] : []),
    ];
    return {
      id: r.id, group: RAIL_OF[r.group], under: r.group, name: r.name, state, found, next: nx.next,
      ...(nx.where ? { where: nx.where } : {}), ...(nx.short ? { short: nx.short } : {}),
      ...(r.exercised.ok ? { receipt: r.exercised.receipt, at: r.exercised.when } : {}), facts,
    };
  }));
}

/** The rows a search keeps (every word of it in the row's name, id, group, state, what was found or its step), by group. */
export function matchingGroups(groups: readonly ScreenGroup[], query: string): ScreenGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...groups];
  const text = (r: ScreenRow): string => `${r.name} ${r.id} ${r.under ?? ''} ${r.state ?? ''} ${r.found} ${r.next} ${r.row ? `${r.row.kind} ${r.row.rung} ${r.row.detail} ${r.row.setup ?? ''}` : ''}`.toLowerCase();
  return groups.map((gr) => ({ ...gr, rows: gr.rows.filter((r) => words.every((w) => text(r).includes(w))) })).filter((gr) => gr.rows.length);
}

// ── the view ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const ago = (t: number | undefined, now: number): string => {
  if (!t) return 'not yet';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** The columns of a row at `w` cells: the name, the chip (10, never cut), what was found, the next step (its share only
 *  where the row has one). */
function columnsAt(w: number, hasNext: boolean): { name: number; found: number; next: number } {
  // 2 (the mark) + name + 2 + 10 (the chip) + 2 + found [+ 2 + next]
  const name = w >= 110 ? 26 : w >= 90 ? 22 : 20;
  const rest = Math.max(12, w - 2 - name - 2 - 10 - 2);
  if (!hasNext) return { name, found: rest, next: 0 };
  // (wide: the next step's column holds the step's short form with where it is set, "a key (NAME): the .env file")
  const found = Math.floor((rest - 2) * (w >= 90 ? 0.45 : 0.55));
  return { name, found, next: rest - 2 - found };
}

/** One capability as a row: "> " · the name · the chip · what was found · the next step (where it is set in brackets). */
export function inventoryRow(r: ScreenRow, w: number, selected: boolean, g: Glyphs): Line {
  const sel = selected ? { selected: true as const } : {};
  // (the next step in the fullest form its column holds: the whole with where it is set, its short form, where alone)
  const col = columnsAt(w, !!r.next);
  const forms = r.next ? [r.where ? `${r.next}: ${r.where}` : r.next, ...(r.short ? [r.where ? `${r.short}: ${r.where}` : r.short] : []), ...(r.where ? [r.where] : [])] : [];
  const nextText = forms.find((t) => [...t].length <= col.next) ?? forms[0] ?? '';
  const mark = selected ? S(`${g.cursor} `, 'accent', sel) : S('  ');
  const name = S(cut(r.name, col.name, g.ellipsis).padEnd(col.name), r.state ? 'strong' : 'secondary', sel);
  const chip = stateSeg(r.state, r.receipt, sel);
  // (an exercised row's receipt id first: it is never lost to the cut)
  const foundText = r.state === 'exercised' && r.receipt ? `receipt ${r.receipt} ${g.sep} ${r.found}` : r.found;
  const parts: Seg[] = [mark, name, S('  '), chip, S('  '), S(cut(foundText, col.found, g.ellipsis).padEnd(col.found), r.state ? 'text' : 'secondary', sel)];
  if (col.next > 0 && nextText) parts.push(S('  '), S(cut(nextText, col.next, g.ellipsis), 'secondary', sel));
  const line = fit(parts, w, g.ellipsis);
  return selected ? onBar(line) : line;
}

/** The header's rows: the title, the honesty line (with when the checks were made and how to make them again). */
export function inventoryHead(w: number, g: Glyphs, n: number, checkedAt: number | undefined, now: number, query: string): Line[] {
  const title: Line = [heading('Tools & integrations'), S(` ${g.sep} what this installation has`, 'secondary')];
  const under: Line = pick([
    [S('nothing here was run to make this list', 'text')],
    [S(`${count(n, 'tool')}${query ? ` ${n === 1 ? 'matches' : 'match'} "${query}"` : ''}`, 'secondary')],
    [S(`checked ${ago(checkedAt, now)}`, 'secondary')],
    [S('[r]', 'action'), S(' checks again', 'secondary')],
  ], w, S(` ${g.sep} `, 'secondary'));
  // (the legend's own words: green stays for the rows' chips, an observed receipt, never a sample)
  const legend: Line = pick([
    [S('available', 'secondary'), S(' the files are here', 'secondary')],
    [S('configured', 'text'), S(' a key or an address is set', 'secondary')],
    [S('exercised', 'text', { bold: true }), S(' a receipt of a real run (green)', 'secondary')],
  ], w, S(`  ${g.sep} `, 'secondary'));
  return [fit(title, w, g.ellipsis), under, legend];
}

/**
 * The body: the header, then the groups in the rail's order, one row a capability; the selected row on the selection bar.
 * The screen scrolls the list to the selection (the items say their lines); the header stays as the body's first rows.
 */
/** The list's items: a screen row (the Inspector's `inventory` case details it), or one of the project's MCP calls (its
 *  `mcp-call` case: the arguments, the outcome, the receipt verified now, the wire trace as text). */
export type InventoryItem = { kind: 'inventory'; key: string; row: ScreenRow } | { kind: 'mcp-call'; key: string; call: McpCallRow };

/** What the screen reads: H170's inventory once the controller read one (src/capabilities/inventory.ts; nothing run), else
 *  the ladder's rows (the tabs that probe). */
export interface InventorySource { caps: Lazy<CapabilityRow[]>; inventory: Lazy<Inventory> }

export function inventoryView(c: TabCtx, src: InventorySource, d: ToolsData | undefined, s: ToolsSearch): TabView<InventoryItem> {
  const { g, width: W } = c;
  // (the search's rows first, as All tools has them: its words say the key and the way to the workspace finder; pinned at
  // the window's top while the list scrolls, so the search and what is typed into it stay in view)
  const lines: Line[] = searchRows(s, W, g);
  const pin = lines.length;
  const fromInv = src.inventory.state !== 'idle';
  const lazy: Lazy<unknown> = fromInv ? src.inventory : src.caps;
  const checkedAt = lazy.state === 'ready' ? lazy.at : undefined;
  const wait = lazyRows(lazy, 'Timmy\'s tools', W, c.now);
  if (wait) return { lines: [...lines, ...inventoryHead(W, g, 0, checkedAt, c.now, ''), [], ...wait], items: [], pin };
  const all = fromInv
    ? fromInventory((src.inventory as Extract<Lazy<Inventory>, { state: 'ready' }>).value.rows, { sep: g.sep })
    : fromCapabilities((src.caps as Extract<Lazy<CapabilityRow[]>, { state: 'ready' }>).value, { calls: d?.calls ?? [], sep: g.sep });
  const groups = matchingGroups(all, s.query);
  const flat = groups.flatMap((gr) => gr.rows);
  const rows = flat;
  // (the project's MCP calls, after the capabilities: the exercised evidence of the MCP routes, each with its receipt; a
  // search keeps the calls whose tool or server matches)
  const q = s.query.trim().toLowerCase();
  const calls = (d?.calls ?? []).filter((x) => !q || `${x.read.record.tool} ${x.read.record.server} ${x.read.record.route}`.toLowerCase().includes(q));
  const sel = selectedIn(c.ui, TOOLS_LIST, flat.length + calls.length);
  lines.push(...inventoryHead(W, g, rows.length, checkedAt, c.now, s.query.trim()));
  const items: TabView<InventoryItem>['items'] = [];
  let i = 0;
  for (const gr of groups) {
    lines.push([], [heading(gr.label), S(` ${g.sep} ${count(gr.rows.length, 'capability', 'capabilities')}`, 'secondary')]);
    for (const r of gr.rows) {
      items.push({ line: lines.length, item: { kind: 'inventory', key: `inv:${r.id}`, row: r } });
      lines.push(inventoryRow(r, W, i === sel, g));
      i += 1;
    }
  }
  if (!flat.length) lines.push([], ...para(s.query.trim() ? `No capability matches "${s.query.trim()}": Esc clears the search.` : 'No capability is registered here.', W));
  // the MCP calls: the newest first, two rows each (src/workbench/tools-tab.ts callRows: the tool and its outcome; the receipt's
  // verdict, when and how long); none: said, with the route's command that makes one
  lines.push([], [heading('MCP calls'), S(` ${g.sep} ${d ? (calls.length ? `the project's newest ${count(calls.length, 'call')}${d.more ? ` (${d.more} more)` : ''}, each with its receipt` : q ? 'none match' : 'none recorded in this project yet') : 'reading…'}`, 'secondary')]);
  calls.forEach((call, k) => {
    const j = flat.length + k;
    const block = callRows(call, d!, W, j === sel, g);
    items.push({ line: lines.length, item: { kind: 'mcp-call', key: `mcp:${call.read.record.id}`, call }, rows: block.length });
    lines.push(...block);
  });
  if (d && !calls.length && !q) for (const r of MCP_ROUTES) lines.push(fit([S(`  ${r.title}: `, 'secondary'), S(r.command, 'action')], W, g.ellipsis));
  lines.push([], fit([S('Enter', 'action'), S(' or ', 'secondary'), S('i', 'action'), S(' opens the selected row\'s details: the evidence of each rung and its receipt. A step that needs a key or an address is set there, not here.', 'secondary')], W, g.ellipsis));
  return { lines, items, pin };
}

/** The Inspector's rows for a capability: the three-word state and its meaning, what was found, the next step and where,
 *  the receipt, then each rung's own evidence. */
export function inventoryInspector(row: ScreenRow, w: number, g: Glyphs): Line[] {
  const out: Line[] = [[heading('Capability'), ...(row.under ? [S(` ${g.sep} ${row.under}`, 'secondary')] : [])], ...para(row.name, w, 'strong')];
  const meaning = row.state === 'exercised' ? (row.receipt ? 'a receipt of a real run exists, on a chain that verified' : 'a run is recorded; its receipt is not named here')
    : row.state === 'configured' ? 'a key, a setting or an address is set for it; it was not run'
      : row.state === 'available' ? 'the files or the program are here; nothing is set, nothing was run'
        : 'nothing of it is here';
  out.push([S('State      ', 'secondary'), ...(row.state ? [stateSeg(row.state, row.receipt)] : [S('–', 'secondary')])], ...para(meaning, w, 'secondary', '           '));
  out.push(...fieldRows('Found', row.found, w, 'text'));
  if (row.next) out.push(...fieldRows('Next', row.where ? `${row.next}: ${row.where} (nothing is set from here)` : row.next, w, 'text'));
  if (row.receipt) out.push(...fieldRows('Receipt', `${row.receipt}${row.at ? ` · ${clock(row.at)}` : ''}`, w, 'live'));
  out.push([]);
  for (const [k, v] of row.facts) out.push(...fieldRows(k, v, w, k === 'Command' ? 'action' : 'secondary', 13));
  return out;
}
