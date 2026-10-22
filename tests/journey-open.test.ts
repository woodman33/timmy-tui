// R10 (H164): where each kind of recent work opens (src/journey/open.ts openTarget), one function for the Workbench, the
// companion and Studio, and the address it opens at (openUrl), never with a token. R9's review F5: `c` on a recording opened
// tab 6 on the first mesh (its address named no recording): a recording's target names it (recording=<hex>). F6: a `mesh=`
// the page does not show was replaced silently by the first mesh: askedOf reads what an address asks for (what the page reads,
// the same hex), and shownFor says what is shown and, when it is not what was asked, a notice saying so. Pure functions: no
// file, no server.
import { describe, expect, it } from 'vitest';
import { askedOf, hexOfPath, openTarget, openUrl, pathOfHex, shownFor } from '../src/journey/index.js';

const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');
/** src/workbench/servers.ts PAGE_QUERY: what Companion · Show passes to the page (names and plain values only) */
const PAGE_QUERY = /^[a-z]+=[A-Za-z0-9_-]+(?:&[a-z]+=[A-Za-z0-9_-]+)*$/;

describe('openTarget: where each kind opens', () => {
  it('a mesh: the companion\'s tab 6 with it chosen (mesh=<its path as hex>, as the page reads it)', () => {
    const t = openTarget({ kind: 'mesh', id: 'refs/demo-tray.stl' });
    expect(t).toEqual({
      surface: 'companion', tab: 'create', select: { name: 'mesh', value: 'refs/demo-tray.stl' },
      query: `tab=create&mesh=${hex('refs/demo-tray.stl')}`, path: `/?tab=create&mesh=${hex('refs/demo-tray.stl')}`,
      preview: 'mesh', words: 'the companion\'s 3D view, this mesh chosen',
    });
    // the same address the Workbench's c gives a mesh today (src/workbench/create-tab.ts createCompanionHint)
    expect(t.query).toBe('tab=create&mesh=726566732f64656d6f2d747261792e73746c');
  });

  it('F5: a recording opens tab 6 with that recording chosen, not the first mesh', () => {
    const t = openTarget({ kind: 'recording', id: 'refs/demo-tray.rrd' });
    expect(t).toMatchObject({ surface: 'companion', tab: 'create', select: { name: 'recording', value: 'refs/demo-tray.rrd' }, query: `tab=create&recording=${hex('refs/demo-tray.rrd')}`, preview: 'recording' });
    expect(t.query).not.toMatch(/mesh=/);
  });

  it('a run: its run detail (progress, result and receipt); a turn: Chat at its receipt; a receipt: Logs & Receipts', () => {
    expect(openTarget({ kind: 'run', id: 'o1a2b3c4d' })).toMatchObject({ surface: 'companion', tab: 'workflows', select: { name: 'run', value: 'o1a2b3c4d' }, query: 'tab=workflows&run=o1a2b3c4d', words: 'the companion\'s run detail: progress, result and receipt' });
    expect(openTarget({ kind: 'turn', id: '0a1b2c3d' })).toMatchObject({ tab: 'chat', select: { name: 'receipt', value: '0a1b2c3d' }, query: 'tab=chat&receipt=0a1b2c3d' });
    expect(openTarget({ kind: 'receipt', id: '0a1b2c3d' })).toMatchObject({ tab: 'logs', select: { name: 'receipt', value: '0a1b2c3d' }, query: 'tab=logs&receipt=0a1b2c3d' });
    expect(openTarget({ kind: 'observation', id: 'v1a2b3c4d' })).toMatchObject({ tab: 'voxvision', select: { name: 'vox', value: 'v1a2b3c4d' }, query: 'tab=voxvision&vox=v1a2b3c4d' });
  });

  it('an image or a reference: the companion\'s preview (file=<its path as hex>), with what kind of preview it takes', () => {
    expect(openTarget({ kind: 'reference', id: 'refs/preview.png' })).toMatchObject({ surface: 'companion', tab: 'home', select: { name: 'file', value: 'refs/preview.png' }, query: `tab=home&file=${hex('refs/preview.png')}`, preview: 'image', words: 'the companion\'s preview' });
    expect(openTarget({ kind: 'result', id: 'out/report.md' })).toMatchObject({ tab: 'home', preview: 'text' });
    expect(openTarget({ kind: 'result', id: 'out/model.blend' })).toMatchObject({ tab: 'home', preview: 'none' });
    // a result a run wrote opens in that run's detail, beside its receipt
    expect(openTarget({ kind: 'result', id: 'out/report.md', operation: 'o1a2b3c4d' })).toMatchObject({ tab: 'workflows', select: { name: 'run', value: 'o1a2b3c4d' }, query: 'tab=workflows&run=o1a2b3c4d' });
  });

  it('a Studio draft or card: Studio, on the project\'s board (Studio has no address that selects one: said so)', () => {
    expect(openTarget({ kind: 'draft', id: 'draft-0a1b2c3d' })).toEqual({ surface: 'studio', tab: null, select: { name: 'draft', value: 'draft-0a1b2c3d' }, query: '', path: '/', preview: 'none', words: 'Studio, on the project\'s board, where the draft waits for Accept or Discard (Studio has no address that selects it)' });
    expect(openTarget({ kind: 'card', id: 'shape:abc' })).toMatchObject({ surface: 'studio', tab: null, path: '/' });
  });

  it('every companion query is one Companion · Show passes on (names and plain values only), whatever the path holds', () => {
    for (const id of ['refs/demo tray (1).stl', 'refs/ünïcödé.obj', 'a/b/c/d/e.ply']) {
      expect(openTarget({ kind: 'mesh', id }).query).toMatch(PAGE_QUERY);
      expect(pathOfHex(hexOfPath(id))).toBe(id);
    }
    for (const kind of ['run', 'turn', 'receipt', 'observation', 'recording', 'reference', 'result'] as const) {
      const id = kind === 'run' ? 'o1a2b3c4d' : kind === 'observation' ? 'v1a2b3c4d' : kind === 'turn' || kind === 'receipt' ? '0a1b2c3d' : 'refs/x.rrd';
      expect(openTarget({ kind, id }).query).toMatch(PAGE_QUERY);
    }
  });

  it('an id that is not one of its kind opens the tab alone, and says why (never an address built from it)', () => {
    expect(openTarget({ kind: 'run', id: '../etc' })).toMatchObject({ tab: 'workflows', select: null, query: 'tab=workflows', words: 'the companion\'s Workflows tab (../etc is not an operation id, so no run is chosen)' });
    expect(openTarget({ kind: 'mesh', id: '/etc/hostname' })).toMatchObject({ tab: 'create', select: null, query: 'tab=create' });
    expect(openTarget({ kind: 'mesh', id: '../../secret.stl' })).toMatchObject({ select: null, query: 'tab=create' });
  });
});

describe('openUrl: the address, never a token', () => {
  it('the base\'s origin and the target\'s path; a base\'s fragment (where the token rides) and query are dropped', () => {
    const t = openTarget({ kind: 'run', id: 'o1a2b3c4d' });
    expect(openUrl(t, 'http://127.0.0.1:4482/')).toBe('http://127.0.0.1:4482/?tab=workflows&run=o1a2b3c4d');
    const token = 'f'.repeat(64);
    const withToken = openUrl(t, `http://127.0.0.1:4482/?tab=home#t=${token}`);
    expect(withToken).toBe('http://127.0.0.1:4482/?tab=workflows&run=o1a2b3c4d');
    expect(withToken).not.toContain(token);
    expect(openUrl(openTarget({ kind: 'draft', id: 'draft-0a1b2c3d' }), 'http://127.0.0.1:4480/board?x=1#grant=abc')).toBe('http://127.0.0.1:4480/');
    expect(openUrl(t, 'http://user:pw@127.0.0.1:4482/')).toBe('http://127.0.0.1:4482/?tab=workflows&run=o1a2b3c4d');
  });

  it('a base that is not an http address is refused', () => {
    expect(() => openUrl(openTarget({ kind: 'run', id: 'o1a2b3c4d' }), 'file:///tmp/x.html')).toThrow(/not an http/);
    expect(() => openUrl(openTarget({ kind: 'run', id: 'o1a2b3c4d' }), 'not a url')).toThrow(/not an http/);
  });
});

describe('F6: what an address asks for, and a notice when the page shows something else', () => {
  const have = { meshes: ['refs/demo-tray.obj', 'refs/demo-tray.ply', 'refs/demo-tray.stl'], recordings: ['refs/demo-tray.rrd'] };

  it('reads mesh=, recording=, run=, vox=, receipt= and file= from the query or beside the token after #, never the token', () => {
    const token = 'a'.repeat(64);
    expect(askedOf(`?tab=create&mesh=${hex('refs/demo-tray.stl')}`)).toEqual({ tab: 'create', select: { name: 'mesh', value: 'refs/demo-tray.stl' }, problems: [] });
    expect(askedOf(`#t=${token}&tab=create&recording=${hex('refs/demo-tray.rrd')}`)).toEqual({ tab: 'create', select: { name: 'recording', value: 'refs/demo-tray.rrd' }, problems: [] });
    expect(askedOf('?tab=workflows&run=o1a2b3c4d')).toMatchObject({ tab: 'workflows', select: { name: 'run', value: 'o1a2b3c4d' } });
    expect(JSON.stringify(askedOf(`?tab=create#t=${token}`))).not.toContain(token);
  });

  it('the asked mesh is listed: it is shown, no notice', () => {
    expect(shownFor(askedOf(`?tab=create&mesh=${hex('refs/demo-tray.stl')}`), have)).toEqual({ shown: { name: 'mesh', value: 'refs/demo-tray.stl' }, notice: null });
    expect(shownFor(askedOf(`?tab=create&recording=${hex('refs/demo-tray.rrd')}`), have)).toEqual({ shown: { name: 'recording', value: 'refs/demo-tray.rrd' }, notice: null });
  });

  it('each of the review\'s four addresses gets a notice naming what was asked and what is shown instead', () => {
    const cases: Array<[string, RegExp]> = [
      [hex('refs/nope.stl'), /^refs\/nope\.stl is not one of this project's meshes, so it is not shown: refs\/demo-tray\.obj is shown instead\.$/],
      [hex('../../../../../../etc/passwd'), /^The address names a path outside this project \(\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/etc\/passwd\), so nothing of it is shown: refs\/demo-tray\.obj is shown instead\.$/],
      [hex('/etc/hostname'), /^The address names a path outside this project \(\/etc\/hostname\), so nothing of it is shown: refs\/demo-tray\.obj is shown instead\.$/],
      ['zz-not-hex', /^The address asks for a mesh as "zz-not-hex", which is not a path written as hex, so it names nothing: refs\/demo-tray\.obj is shown instead\.$/],
    ];
    for (const [value, words] of cases) {
      const r = shownFor(askedOf(`?tab=create&mesh=${value}`), have);
      expect(r.shown).toEqual({ name: 'mesh', value: 'refs/demo-tray.obj' });
      expect(r.notice).toMatch(words);
    }
  });

  it('a recording not listed, and a project with no mesh at all', () => {
    expect(shownFor(askedOf(`?tab=create&recording=${hex('refs/gone.rrd')}`), have)).toEqual({ shown: { name: 'mesh', value: 'refs/demo-tray.obj' }, notice: 'refs/gone.rrd is not one of this project\'s recordings, so it is not shown: refs/demo-tray.obj is shown instead.' });
    expect(shownFor(askedOf(`?tab=create&mesh=${hex('refs/nope.stl')}`), { meshes: [], recordings: [] })).toEqual({ shown: null, notice: 'refs/nope.stl is not one of this project\'s meshes, so it is not shown: this project has no mesh to show.' });
  });

  it('an address that asks for nothing in particular: the first is shown, no notice (as the page always did)', () => {
    expect(shownFor(askedOf('?tab=create'), have)).toEqual({ shown: { name: 'mesh', value: 'refs/demo-tray.obj' }, notice: null });
    expect(shownFor(askedOf(''), have)).toEqual({ shown: { name: 'mesh', value: 'refs/demo-tray.obj' }, notice: null });
  });
});
