import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initProject, listProjects, readProject,
  addGenToProject, addRefToProject, renderProjectSite, projectDir,
  addCastToProject, castPromptBlock, renderBlockingSvg, saveProject, renderRightsLog,
  renderCanvasPage, CANVAS_MOVED
} from '../src/utils/projects.js';
import { esc } from '../src/repl/board-kit.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-proj-'));
});
// R4 (H97): each test's folder is removed after it
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('Slate projects', () => {
  it('initializes the visual project folder skeleton', () => {
    initProject('launch', {}, dir);
    for (const sub of ['refs', 'gens', 'frames', 'receipts', 'site']) {
      expect(existsSync(join(projectDir('launch', dir), sub))).toBe(true);
    }
    expect(listProjects(dir)).toContain('launch');
    expect(readProject('launch', dir)?.refs).toEqual([]);
  });

  it('stores labeled generations and refs', () => {
    initProject('launch', {}, dir);
    writeFileSync(join(dir, 'char.png'), 'png-bytes');
    expect(addRefToProject('launch', join(dir, 'char.png'), 'hero character', dir)).toContain('refs/');
    const gen = addGenToProject('launch', { id: 'gen_1', provider: 'nano-banana-2', prompt: 'foil card', label: 'card v1' }, dir);
    expect(gen?.created_at).toBeTruthy();
    const proj = readProject('launch', dir)!;
    expect(proj.refs[0].label).toBe('hero character');
    expect(proj.gens[0].label).toBe('card v1');
  });

  it('renders the site with refs, gens, receipt footer and the mcp fleet', () => {
    initProject('launch', {}, dir);
    writeFileSync(join(dir, 'char.png'), 'png-bytes');
    addRefToProject('launch', join(dir, 'char.png'), 'hero', dir);
    addGenToProject('launch', { id: 'gen_1', provider: 'nano-banana-2', prompt: 'foil card on velvet', label: 'card v1' }, dir);
    const site = renderProjectSite('launch', dir)!;
    const html = readFileSync(site, 'utf8');
    expect(html).toContain('TIMMY Slate — launch');
    expect(html).toContain('hero');
    expect(html).toContain('foil card on velvet');
    expect(html).toContain('receipts for everything');
  });

  it('call-sheet cast cards inject into generation prompts', () => {
    initProject('film', {}, dir);
    addCastToProject('film', { id: 'c1', name: 'Mara', hair: 'buzzcut', wardrobe: 'orange jumpsuit', emotion: 'wired', age: '30s', props: ['tablet', 'badge'] }, dir);
    const proj = readProject('film', dir)!;
    const block = castPromptBlock(proj);
    expect(block).toContain('CALL SHEET — film');
    expect(block).toContain('C1 (Mara) hair: buzzcut; wardrobe: orange jumpsuit; emotion: wired; age: 30s; props: tablet, badge;');
  });

  it('renders a stick-figure blocking diagram as conditioning SVG', () => {
    initProject('film', {}, dir);
    addCastToProject('film', { id: 'C1', name: 'Mara', emotion: 'wired', wardrobe: 'orange jumpsuit' }, dir);
    const proj = readProject('film', dir)!;
    proj.beats = [{ at: 0, dur: 3, label: 'HOOK', text: 'Mara enters' }];
    saveProject(proj, dir);
    const svg = renderBlockingSvg('film', dir)!;
    const body = readFileSync(svg, 'utf8');
    expect(body).toContain('<circle');
    expect(body).toContain('C1 wired');
    expect(body).toContain('orange jumpsuit');
  });

  it('exports an outsider-verifiable rights/receipts log', () => {
    initProject('film', {}, dir);
    addGenToProject('film', { id: 'gen_9', provider: 'nano-banana-2', prompt: 'C1 enters', label: 'sc12' }, dir);
    const md = renderRightsLog('film', dir)!;
    const body = readFileSync(md, 'utf8');
    expect(body).toContain('RIGHTS / RECEIPTS LOG — film');
    expect(body).toContain('sc12');
    expect(existsSync(join(projectDir('film', dir), 'RIGHTS-LOG.json'))).toBe(true);
  });

  it('keeps Porter strictly separate — no MCP fleet data in Slate sites', () => {
    initProject('launch', {}, dir);
    const site = renderProjectSite('launch', dir)!;
    expect(existsSync(site)).toBe(true);
    expect(existsSync(join(projectDir('launch', dir), 'site', 'mcp.json'))).toBe(false);
    expect(readFileSync(site, 'utf8')).toContain('TIMMY Slate — launch');
  });

  // R4 (H97): the legacy Slate panel's canvas pane asked unpkg and esm.sh for tldraw and React; now it loads nothing and says
  // where the canvas is (tests/dash-pages-browser.test.ts opens it in a real browser through the dashboard's server)
  it('writes the legacy canvas page with no script and no address elsewhere, saying the canvas lives in Timmy Canvas (/canvas open)', () => {
    initProject('film', {}, dir);
    const proj = readProject('film', dir)!;
    proj.beats = [{ at: 0, dur: 3, label: 'OPEN', text: 'The <script>x()</script> wakes' }];
    saveProject(proj, dir);
    addCastToProject('film', { id: 'c1', name: 'Keeper', wardrobe: 'yellow coat' }, dir);
    const html = readFileSync(renderCanvasPage('film', dir)!, 'utf8');
    expect(html).toContain(esc(CANVAS_MOVED));
    expect(CANVAS_MOVED).toContain('/canvas open');
    expect(html).not.toMatch(/<script|https?:\/\/|\bimport\b|tldraw|esm\.sh|unpkg/i);
    expect(html).toContain('<b>0s–3s [OPEN]</b> The &lt;script&gt;x()&lt;/script&gt; wakes');
    expect(html).toContain('C1 Keeper');
    expect(renderCanvasPage('nope', dir)).toBeNull();
  });
});
