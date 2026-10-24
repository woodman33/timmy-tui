/**
 * R11 round 5 (H174): the Rive components' assets, served by the companion (and, mounted there too, by the Studio canvas's
 * server, whose tldraw page is its own origin): the editable SOURCE of each component beside its runtime asset.
 *
 *   src/companion/assets/rive/<component>/   scene.rml (the Rive source, the format of assets/mark/scene.rml), rive.yaml,
 *                                            README.md (the artboard, the state machine, the inputs, what each state means),
 *                                            and <component>.riv WHEN one exists — compiled by the operator's Rive tooling from
 *                                            the source beside it, or received in his package; never made up here.
 *
 *   GET /api/rive/assets                     (behind the guards given) → { ok, runtime, components: [{ component, riv: { name,
 *                                            bytes, sha256 } | null, sources: [names], words }], words }: what the page may load
 *                                            and what the Inspect view lists; sha256 is the first 12 hex of the file's digest.
 *   GET /assets/rive/<component>/<file>      the file by exact name (a component folder's own .riv / .rml / .rev / .yaml / .md;
 *                                            no path, no other name) — the same rules as page.ts's /assets/<file>; a file not
 *                                            there → 404 in words (never a path of this computer).
 *
 * The page's policy gets 'wasm-unsafe-eval' only when a .riv AND the runtime are here (setPagePolicyWasm(true); this module
 * never turns it off: the T mark's mountMark decides for its own file).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type express from 'express';
import { failRequest } from '../utils/server-failure.js';
import { MARK_ABSENT, markDir, RIVE_ABSENT, riveDir, setPagePolicyWasm } from './page.js';

export const RIVE_ASSETS_PATH = '/assets/rive/';
export const RIVE_ASSETS_API = '/api/rive/assets';
/** The file kinds a component folder may serve, by extension, with their types. */
const RIVE_FILE_TYPES: Readonly<Record<string, string>> = {
  '.riv': 'application/octet-stream',
  '.rml': 'text/plain; charset=utf-8',
  '.rev': 'application/octet-stream',
  '.yaml': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  // R11 round 5 (the operator's package): the generator script and the font's license beside the asset; the font file itself
  // (Outfit.ttf since round 7; Montserrat.ttf before) stays in the folder and is not served (the .riv embeds what it needs)
  '.py': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  // R11 round 7: the contract (CONTRACT.json) and the build's records (BUILD.txt, rive.log, problems.log) beside the asset
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};
const SOURCE_EXT = new Set(['.rml', '.rev', '.yaml', '.md', '.py', '.txt', '.json', '.log']);
/** A component's folder name and a file's name: plain names only (no path, no dot segment). */
const COMPONENT_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export const RIVE_ASSET_ABSENT = 'The animation’s file is not in this installation: the page shows its state as the word beside the component instead.';
export const RIVE_COMPONENT_ABSENT = 'No Rive component of that name is in this installation.';
export const RIVE_NO_RIV = 'Its editable source is here; its compiled .riv is not (it is compiled by the Rive tooling from that source, not here), so the page shows the state word in place of the animation.';
export const RIVE_WITH_RIV = 'Its .riv and its editable source are both here: the runtime draws it when the runtime is served.';

export interface RiveComponentListing {
  component: string;
  riv: { name: string; bytes: number; sha256: string } | null;
  sources: string[];
  /** From the folder's rive.yaml (plain `key: value` lines): the artboard, the state machine and the inputs the source declares. */
  meta: {
    artboard?: string; artboards?: string[]; stateMachine?: string; inputs?: string[];
    /** RIVE CONTRACT v2 (round 7): the SOURCE's contract version, the preview artboards, the font, the named runs per production artboard. */
    contract?: string; previewArtboards?: string[]; font?: string; runs?: Record<string, string[]>;
    /**
     * What the SERVED .riv is (CONTRACT.json `asset.contractOfTheServedFile`): the source may be a contract ahead of the compiled
     * file beside it (the build is the operator's machine's). The bindings pick artboards from THIS, never from the source's list.
     */
    served?: { contract: number; artboards: string[]; previewArtboards: string[]; sha256?: string };
    [k: string]: string | string[] | Record<string, string[]> | { contract: number; artboards: string[]; previewArtboards: string[]; sha256?: string } | undefined;
  };
  words: string;
}

/** The plain `key: value` lines of a component's rive.yaml (no parser: the file is ours and flat). `inputs` is a comma list. */
export function readRiveMeta(path: string): RiveComponentListing['meta'] {
  const meta: RiveComponentListing['meta'] = {};
  if (!existsSync(path)) return meta;
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return meta; }
  const list = (value: string): string[] => value.split(',').map((v) => v.trim()).filter(Boolean);
  for (const raw of text.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_.-]*):\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'inputs' || key === 'artboards' || key === 'previewArtboards') meta[key] = list(value);
    else if (key === 'artboard' || key === 'stateMachine' || key === 'name' || key === 'file' || key === 'contract' || key === 'font') meta[key] = value;
    else if (key.startsWith('runs.')) { const runs = (meta.runs ??= {}); runs[key.slice('runs.'.length)] = list(value); }
  }
  return meta;
}

/** CONTRACT.json's `meta` block (create-controls.py writes it): the listing's facts about the native asset. Empty without the file. */
export function readContractMeta(path: string): RiveComponentListing['meta'] {
  if (!existsSync(path)) return {};
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as { meta?: Record<string, unknown> };
    const m = c?.meta && typeof c.meta === 'object' ? c.meta : {};
    const out: RiveComponentListing['meta'] = {};
    const str = (k: string): void => { if (typeof m[k] === 'string') out[k] = m[k] as string; };
    const list = (k: string): void => { if (Array.isArray(m[k])) out[k] = (m[k] as unknown[]).filter((v): v is string => typeof v === 'string'); };
    for (const k of ['name', 'file', 'contract', 'artboard', 'stateMachine', 'font']) str(k);
    for (const k of ['artboards', 'previewArtboards', 'inputs']) list(k);
    if (m.runs && typeof m.runs === 'object') {
      const runs: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(m.runs as Record<string, unknown>)) if (Array.isArray(v)) runs[k] = v.filter((x): x is string => typeof x === 'string');
      out.runs = runs;
    }
    return out;
  } catch { return {}; }
}

/** The v1 build's artboards (the round-5 asset): what a page may ask a v1 file for. */
const V1_ARTBOARDS = ['AgentConsole', 'ProviderCard', 'ActionButton'];
/**
 * The served file's facts from CONTRACT.json beside it: its contract (`asset.contractOfTheServedFile`), hence which artboards and
 * preview artboards a page may ask it for. Null without a CONTRACT.json (a drafted folder).
 */
export function readServed(path: string, meta: RiveComponentListing['meta']): RiveComponentListing['meta']['served'] | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as { asset?: { contractOfTheServedFile?: unknown; sha256?: unknown } };
    const contract = Number(c?.asset?.contractOfTheServedFile) || 1;
    const sha256 = typeof c?.asset?.sha256 === 'string' ? c.asset.sha256 : undefined;
    if (contract >= 2) return { contract, artboards: meta.artboards ?? V1_ARTBOARDS, previewArtboards: meta.previewArtboards ?? [], ...(sha256 ? { sha256 } : {}) };
    return { contract, artboards: V1_ARTBOARDS, previewArtboards: [], ...(sha256 ? { sha256 } : {}) };
  } catch { return null; }
}

/** Where the components' folders are (a test may give its own). */
export function riveAssetsDir(dir?: string): string {
  return dir ?? join(dirname(fileURLToPath(import.meta.url)), 'assets', 'rive');
}

const extOf = (name: string): string => { const at = name.lastIndexOf('.'); return at < 0 ? '' : name.slice(at).toLowerCase(); };

/** The components in `dir`: each folder with its .riv (when there) and its source files by name. */
export function listRiveComponents(dir: string): RiveComponentListing[] {
  if (!existsSync(dir)) return [];
  const out: RiveComponentListing[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!COMPONENT_NAME.test(name)) continue;
    const folder = join(dir, name);
    let files: string[];
    try { if (!statSync(folder).isDirectory()) continue; files = readdirSync(folder).filter((f) => FILE_NAME.test(f)).sort(); } catch { continue; }
    const rivName = files.find((f) => extOf(f) === '.riv') ?? null;
    let riv: RiveComponentListing['riv'] = null;
    if (rivName) {
      try { const bytes = readFileSync(join(folder, rivName)); riv = { name: rivName, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 12) }; } catch { riv = null; }
    }
    // the yaml's plain keys first (the drafted folders' own); CONTRACT.json's `meta` block over them (the native asset's: its
    // rive.yaml is the Rive CLI's four-line one, which takes nothing else)
    const meta = { ...readRiveMeta(join(folder, 'rive.yaml')), ...readContractMeta(join(folder, 'CONTRACT.json')) };
    const served = readServed(join(folder, 'CONTRACT.json'), meta);
    if (served) meta.served = served;
    out.push({ component: name, riv, sources: files.filter((f) => SOURCE_EXT.has(extOf(f))), meta, words: riv ? RIVE_WITH_RIV : RIVE_NO_RIV });
  }
  return out;
}

/** Whether the runtime's two files are installed here (the companion serves them at /vendor/rive/). */
export function riveRuntimeHere(): boolean {
  const d = riveDir();
  return d !== null && existsSync(join(d, 'rive.js')) && existsSync(join(d, 'rive.wasm'));
}

export interface RiveAssetsDeps {
  /** The launch token's guard (the companion's); absent on a server that has none (the Studio). */
  withToken?: express.RequestHandler;
  /** The user's guard; applied to the listing when given. */
  withUser?: express.RequestHandler;
  /** The components' folder (a test's). */
  dir?: string;
  /** The T mark's folder (a test's); the companion's src/companion/assets/mark by default. */
  markDir?: string;
}

/**
 * Mounts the listing and the files. Returns what it found at mount time (the listing is read again on every request, so a
 * .riv placed beside its source while the companion runs is served on the next ask).
 */
export function mountRiveAssets(app: express.Application, deps: RiveAssetsDeps = {}): { dir: string; components: RiveComponentListing[] } {
  const dir = riveAssetsDir(deps.dir);
  const guards = [deps.withToken, deps.withUser].filter((g): g is express.RequestHandler => typeof g === 'function');
  const runtime = riveRuntimeHere();
  const first = listRiveComponents(dir);
  // the policy's WebAssembly keyword when there is a component to draw and a runtime to draw it with (never turned off here)
  if (runtime && first.some((c) => c.riv !== null)) setPagePolicyWasm(true);
  // the T mark's facts travel with the listing (R11 round 7: the Studio serves this listing but not the companion's
  // /assets/mark.json, so a page that asked that first recorded a 404 after every placeRive — traced in
  // studio-rive-shape-browser to that URL; the bindings now read the mark here and ask mark.json only when no listing answers)
  const markRiv = join(markDir(deps.markDir), 'timmy-mark.riv');
  app.get(RIVE_ASSETS_API, ...guards, (_req, res) => {
    const components = listRiveComponents(dir);
    const any = components.some((c) => c.riv !== null);
    if (runtime && any) setPagePolicyWasm(true);
    const mark = existsSync(markRiv);
    res.set('Cache-Control', 'no-store').json({
      ok: true, runtime, components,
      mark: { riv: mark, words: mark ? 'The T mark is drawn by its Rive file.' : MARK_ABSENT },
      words: !runtime ? RIVE_ABSENT : any ? 'The components with a .riv are drawn by the runtime; the others show their state word.' : 'No component has its .riv here yet: every component shows its state word, and its editable source is listed beside it.',
    });
  });
  app.get(`${RIVE_ASSETS_PATH}:component/:file`, (req, res, next) => {
    const component = String(req.params.component);
    const file = String(req.params.file);
    if (!COMPONENT_NAME.test(component) || !FILE_NAME.test(file)) { next(); return; }
    const type = RIVE_FILE_TYPES[extOf(file)];
    if (!type) { next(); return; }
    const folder = join(dir, component);
    if (!existsSync(folder)) { failRequest(res, 404, RIVE_COMPONENT_ABSENT, 'text'); return; }
    const path = join(folder, file);
    if (!existsSync(path)) { failRequest(res, 404, RIVE_ASSET_ABSENT, 'text'); return; }
    res.set('Cache-Control', 'no-store').type(type).sendFile(path, (err?: Error) => { if (err) failRequest(res, 404, RIVE_ASSET_ABSENT, 'text'); });
  });
  return { dir, components: first };
}
