import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBindingId, createShapeId, createTLSchema, toRichText } from '@tldraw/tlschema';
import { getIndices } from '@tldraw/utils';
import { describe, expect, it } from 'vitest';
import { asStarter, checkStarterBindings, guidedTemplates, STARTER_SEEDS, STARTER_WORKBENCH, starterProblems, starterTemplates, type StarterTemplate } from '../src/studio/templates.js';
import { checkBindings, COLORS, defaultProps, emptySlot, richTextOf, SLOT_SHAPES, slotFit, slotPosition, starterRecords, STARTER_WORKBENCH as PAGE_WORKBENCH } from '../companion/studio-canvas/src/starters.js';

// R11 round 7 (H176): TEMPLATE SCHEMA v1. The three guided blank public starters (src/studio/templates/H*.json: the Houdini
// handoff from P67's structure, the cookbook from T22's, the pipeline atlas from T24's typed-port pipeline) are read by
// src/studio/templates.ts under the guided boards' rules, refused whole when anything of them is not as the schema says, and
// drawn by companion/studio-canvas/src/starters.js as tldraw records: here every record is validated against the INSTALLED
// tldraw's own schema (5.5.2, @tldraw/tlschema, the package the bundle is built from), the typed ports and their order are
// checked, and a starter's slots take the matching drawn card.
const repo = fileURLToPath(new URL('..', import.meta.url));
const schema = createTLSchema();
type Rec = Record<string, unknown> & { id: string; typeName: string };
const store = { get: () => undefined } as never;
/** Validates one record as tldraw's store would on put (its own validators, migrations' latest version). */
const validate = (r: Rec): Rec => schema.validateRecord(store, r as never, 'initialize', null) as Rec;
const ids = { shapeId: () => createShapeId() };
const words = (rich: unknown): string => { const out: string[] = []; const walk = (n: { text?: string; content?: unknown[] } | undefined): void => { if (!n) return; if (typeof n.text === 'string') out.push(n.text); for (const c of n.content ?? []) walk(c as never); }; walk(rich as never); return out.join(' '); };
/** The G boards' rule for what a person reads: no example metric, address, path, image or asset. */
const EXAMPLE = /https?:|www\.|\/Users\/|\/home\/|~\/|\$|%|\d+(\.\d+)?\s*(ms|s|mm|cm|GB|MB|USD)\b|\.(png|jpe?g|svg|webp|glb|usd[az]?|blend|hip)\b/i;

describe('the shipped starters', () => {
  it('are H1 the handoff, H2 the cookbook and H3 the pipeline atlas, each sound, each from its recovered export, listed after the guided boards', () => {
    expect(starterProblems()).toEqual({});
    const listed = starterTemplates();
    expect(listed.map((t) => [t.id, t.kind, t.title, t.from.template, t.from.key, t.shapes.length, t.bindings.length])).toEqual([
      ['H1', 'starter', 'Houdini handoff', 'P67', 'kimi-houdini-handoff', 7, 4],
      ['H2', 'starter', 'Houdini cookbook', 'T22', 'foundry-houdini-cookbook', 12, 0],
      ['H3', 'starter', 'Houdini pipeline atlas', 'T24', 'foundry-h22-systems-atlas', 16, 5],
    ]);
    for (const t of listed) {
      expect(t.workbench).toBe(STARTER_WORKBENCH);
      expect(t.steps.map((s) => [s.n, s.verb, s.slot])).toEqual([['01', 'Define the geometry', 'result'], ['02', 'Set the parameters', 'params'], ['03', 'Cook in Houdini', 'workflow']]);
      // the words a person reads: the guided boards' rule (no example metric, address, path, image or asset)
      expect(JSON.stringify([t.title, t.intro, t.steps, t.shapes.map((s) => s.text)]), t.id).not.toMatch(EXAMPLE);
      // blank: no snippet code, no value, no shot, no system in the public copy
      for (const s of t.shapes) for (const [k, v] of Object.entries(s.data)) if (['code', 'law', 'title', 'detail', 'source', 'camera', 'cinematic', 'systemId', 'snippetId', 'shotId', 'landmineId'].includes(k)) expect(v, `${t.id} ${s.key} ${k}`).toBe('');
      // nothing on a starter is observed live, passed or sealed: no green, and no other hue than tldraw's grey
      for (const s of t.shapes) expect(s.color ?? 'black', `${t.id} ${s.key}`).toBe('grey');
    }
    // the public list: the guided boards first, the starters after them, in one answer of GET /api/canvas/templates
    const all = guidedTemplates();
    expect(all.map((t) => t.id)).toEqual(['G1', 'G2', 'G3', 'H1', 'H2', 'H3']);
    expect(all.slice(3).every((t) => (t as StarterTemplate).kind === 'starter')).toBe(true);
    expect(STARTER_WORKBENCH).toBe(PAGE_WORKBENCH);
  });

  it('say apart what runs and what is a snippet: the cook step names no native Houdini operation, a snippet card says it is text', () => {
    for (const t of starterTemplates()) {
      const cook = t.steps[2];
      expect(cook.guide, t.id).toMatch(/No native Houdini operation is configured in Studio/);
      expect(cook.guide, t.id).toMatch(/goes through the live board/);
      expect(t.steps[1].guide, t.id).toMatch(/Save and Rebuild go through the live board/);
      for (const s of t.shapes.filter((x) => x.role === 'cookbook-snippet')) expect(s.text.join(' '), `${t.id} ${s.key}`).toMatch(/Nothing here runs them/);
    }
    // the handoff's rule card and the atlas's receipts node keep the honest words of the recovered contracts
    const h1 = starterTemplates().find((t) => t.id === 'H1')!;
    expect(h1.shapes.find((s) => s.role === 'bridge-stop')!.text.join(' ')).toMatch(/never calls Houdini/);
    const h3 = starterTemplates().find((t) => t.id === 'H3')!;
    expect(h3.shapes.find((s) => s.key === 'node-receipts')!.text.join(' ')).toMatch(/proves what ran, not that the picture is right/);
  });

  it('the files on disk are the seeds the loader reads (no edit reaches a board unread)', () => {
    for (const [id, seed] of STARTER_SEEDS) {
      expect(JSON.parse(readFileSync(`${repo}src/studio/templates/${id}.json`, 'utf8'))).toEqual(seed);
    }
  });
});

describe('the loader refuses a starter that is not as the schema says, whole', () => {
  const base = (): Record<string, unknown> => JSON.parse(JSON.stringify(STARTER_SEEDS[2][1]));
  const refuse = (change: (s: Record<string, unknown>) => void): string[] => {
    const s = base();
    change(s);
    const r = asStarter(s, 'H3');
    expect(r.ok).toBe(false);
    return r.ok ? [] : r.why;
  };
  it('a sound seed is read whole; a changed id, kind or workbench is not', () => {
    expect(asStarter(base(), 'H3').ok).toBe(true);
    expect(refuse((s) => { s.id = 'H4'; })).toEqual(['id is not H3']);
    expect(refuse((s) => { s.kind = 'guided'; })).toEqual(['kind is not starter']);
    expect(refuse((s) => { s.workbench = 'kimi-foundry-workbench-v1'; })).toEqual([`workbench is not ${STARTER_WORKBENCH}`]);
  });
  it('an address, a home folder or markup in what a person reads refuses the seed', () => {
    expect(refuse((s) => { s.intro = 'See https://example.com for more.'; })[0]).toMatch(/intro is not plain/);
    expect(refuse((s) => { (s.shapes as Array<Record<string, unknown>>)[1].text = [`Put ${['', 'Users', 'someone', 'art'].join('/')} here.`]; })[0]).toMatch(/text is not up to 24 plain lines/);
    expect(refuse((s) => { s.title = '<img src=x onerror=alert(1)>'; })[0]).toMatch(/title is not plain/);
    expect(refuse((s) => { (s.steps as Array<Record<string, unknown>>)[0].guide = 'a'.repeat(321); })[0]).toMatch(/step 01's guide/);
  });
  it('a style tldraw does not draw, a fourth step, a slot off a frame or a data value that is not flat refuses it', () => {
    expect(refuse((s) => { (s.shapes as Array<Record<string, unknown>>)[1].color = 'teal'; })[0]).toMatch(/a style is not one tldraw draws/);
    expect(refuse((s) => { (s.steps as unknown[]).push({ n: '04', verb: 'Render', guide: 'x', slot: 'result' }); })[0]).toMatch(/steps are not three/);
    expect(refuse((s) => { (s.shapes as Array<Record<string, unknown>>)[1].slot = 'params'; })[0]).toMatch(/a slot goes on a frame/);
    expect(refuse((s) => { (s.shapes as Array<Record<string, unknown>>)[1].data = { nested: { a: 1 } }; })[0]).toMatch(/data is not flat primitives/);
    expect(refuse((s) => { (s.shapes as Array<Record<string, unknown>>)[1].lane = 'elsewhere'; })[0]).toMatch(/lane is not one of the starter's lanes/);
    expect(refuse((s) => { (s.shapes as Array<Record<string, unknown>>).push({ key: 'free', type: 'arrow', x: 0, y: 0, w: 10, h: 10, text: [], role: 'flow', lane: 'steps', data: {} }); })[0]).toMatch(/an arrow is drawn from a binding/);
  });
  it('a typed binding must name an out port and an in port of its data type, and the bindings must not form a cycle', () => {
    expect(refuse((s) => { (s.bindings as Array<Record<string, unknown>>)[0].dataType = 'stage'; })).toEqual(['binding f-manifest carries stage, but node-manifest.out-manifest gives manifest', 'binding f-manifest carries stage, but node-skeleton.in-manifest takes manifest']);
    expect(refuse((s) => { (s.bindings as Array<Record<string, unknown>>)[0].toPort = 'in-stage'; })).toEqual(['binding f-manifest: node-skeleton has no in port in-stage']);
    expect(refuse((s) => { (s.bindings as Array<Record<string, unknown>>).push({ key: 'back', from: 'node-receipts', to: 'node-manifest' }); })).toEqual(['the bindings form a cycle (node-manifest, node-skeleton, node-overrides, node-proof, node-gate, node-receipts)']);
    expect(refuse((s) => { (s.bindings as Array<Record<string, unknown>>).push({ key: 'off', from: 'node-receipts', to: 'nowhere' }); })).toEqual(['binding off ends at "nowhere", which is not a card of this starter']);
    expect(refuse((s) => { (s.bindings as Array<Record<string, unknown>>)[0].key = 'f-skeleton'; })[0]).toMatch(/named twice/);
    // the page's own check (starters.js) says the same of the same seed
    const s = base();
    (s.bindings as Array<Record<string, unknown>>)[0].dataType = 'stage';
    expect(checkBindings(s).problems).toEqual(checkStarterBindings(s as never));
  });
});

describe('a starter as tldraw 5.5.2 records (companion/studio-canvas/src/starters.js)', () => {
  it("every shape and binding of each starter validates against the installed tldraw's own schema, with fresh ids and the recovered meta", () => {
    for (const t of starterTemplates()) {
      const built = starterRecords(t, ids);
      const pageId = 'page:starter';
      const seen = new Set<string>();
      const indices = getIndices(built.shapes.length);
      for (const [i, s] of built.shapes.entries()) {
        expect(seen.has(s.id), `${t.id}: ${s.id} twice`).toBe(false);
        seen.add(s.id);
        const record = validate({ ...s, typeName: 'shape', parentId: s.parentId ?? pageId, index: indices[i + 1], rotation: 0, isLocked: false, opacity: 1 } as Rec);
        // validated as it is: tldraw adds nothing, drops nothing (every prop of 5.5.2's validator is written)
        expect(record.props).toEqual(s.props);
        // the recovered loader's five keys at the top of meta, Timmy's beside them
        const meta = s.meta as Record<string, unknown>;
        expect(Object.keys(meta).sort(), `${t.id} ${s.id}`).toEqual(['data', 'lane', 'page', 'role', 'timmyGuide', 'timmyStarter', 'timmyTemplate', 'workbench']);
        expect(meta.workbench).toBe('timmy-starter-v1');
        expect(meta.page).toBe('houdini');
        expect(meta.timmyTemplate).toBe(t.id);
        expect(t.lanes, `${t.id} ${s.id}: lane ${String(meta.lane)}`).toContain(meta.lane);
        for (const v of Object.values(meta.data as Record<string, unknown>)) expect(['string', 'number', 'boolean'], `${t.id} ${s.id}: data is flat`).toContain(typeof v);
      }
      for (const b of built.bindings) {
        expect(seen.has(b.fromId) && seen.has(b.toId), `${t.id}: a binding names a shape of this opening`).toBe(true);
        validate({ ...b, id: createBindingId(), typeName: 'binding', meta: {} } as Rec);
      }
      // a second opening gets other ids: two starters on one board never collide
      const again = starterRecords(t, ids);
      expect(again.shapes.some((s) => seen.has(s.id))).toBe(false);
    }
  });

  it('the default props it writes are exactly what tldraw 5.5.2 validates (a key tldraw adds or drops fails here, not on a board)', () => {
    for (const type of ['geo', 'text', 'frame', 'arrow'] as const) {
      const props = defaultProps(type, { w: 100, h: 50 });
      const record = validate({ id: createShapeId(), typeName: 'shape', type, x: 0, y: 0, parentId: 'page:p', index: 'a1', rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as Rec);
      expect(record.props).toEqual(props);
      expect(() => validate({ id: createShapeId(), typeName: 'shape', type, x: 0, y: 0, parentId: 'page:p', index: 'a1', rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { ...props, unknownProp: 1 } } as Rec)).toThrow();
    }
    expect(richTextOf(['a', '', 'b'])).toEqual(toRichText('a\n\nb'));
    expect(() => validate({ id: createShapeId(), typeName: 'shape', type: 'geo', x: 0, y: 0, parentId: 'page:p', index: 'a1', rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { ...defaultProps('geo'), color: 'teal' } } as Rec)).toThrow(/color/);
    expect(COLORS).toHaveLength(13);
  });

  it('draws the title, the intro, three step frames with a hint each and the flow bound between them, then the cards and the bound arrows of the bindings', () => {
    const t = starterTemplates().find((x) => x.id === 'H3')!;
    const built = starterRecords(t, ids);
    const byRole = (role: string) => built.shapes.filter((s) => (s.meta as { role: string }).role === role);
    expect(words(byRole('title')[0].props.richText)).toBe('Houdini pipeline atlas');
    expect(byRole('step').map((s) => [s.type, (s.props as { name: string }).name, (s.meta as { timmyStarter: { slot: string } }).timmyStarter.slot])).toEqual([
      ['frame', '01 · Define the geometry', 'result'], ['frame', '02 · Set the parameters', 'params'], ['frame', '03 · Cook in Houdini', 'workflow'],
    ]);
    const steps = byRole('step');
    expect(byRole('hint').map((h) => h.parentId)).toEqual(steps.map((s) => s.id));
    // the flow between the steps: two arrows, each bound at both ends (start to the step before, end to the step after)
    const flows = byRole('flow');
    expect(flows).toHaveLength(2);
    const ends = (arrow: { id: string }) => built.bindings.filter((b) => b.fromId === arrow.id).map((b) => [b.props.terminal, b.toId]);
    expect(ends(flows[0])).toEqual([['start', steps[0].id], ['end', steps[1].id]]);
    expect(ends(flows[1])).toEqual([['start', steps[1].id], ['end', steps[2].id]]);
    // the typed-port pipeline: six nodes with their ports, five port bindings each bound to its two nodes and labelled by its type
    const nodes = byRole('flow-node');
    expect(nodes.map((n) => (n.meta as { data: { nodeId: string; dagPosition: number } }).data.nodeId)).toEqual(['manifest', 'skeleton', 'overrides', 'proof', 'gate', 'receipts']);
    expect(nodes.map((n) => (n.meta as { data: { dagPosition: number } }).data.dagPosition)).toEqual([0, 1, 2, 3, 4, 5]);
    const ports = byRole('port-binding');
    expect(ports.map((p) => words(p.props.richText))).toEqual(['manifest', 'stage', 'stage', 'evidence', 'verdict']);
    for (const [i, p] of ports.entries()) {
      const data = (p.meta as { data: Record<string, string> }).data;
      expect(JSON.parse(data.binding)).toEqual({ id: data.bindingId, fromNode: data.fromNode, fromPort: data.fromPort, toNode: data.toNode, toPort: data.toPort, dataType: data.dataType });
      expect(ends(p)).toEqual([['start', nodes[i].id], ['end', nodes[i + 1].id]]);
    }
    // the order card says the order computed from the bindings
    const order = byRole('dag-order')[0];
    expect(words(order.props.richText)).toBe('ORDER, computed from the port bindings (Kahn over the arrows): manifest → skeleton → overrides → proof → gate → receipts');
    expect((order.meta as { data: { order: string; bindingCount: number } }).data).toEqual({ order: 'manifest → skeleton → overrides → proof → gate → receipts', bindingCount: 5 });
    // nothing green, nothing amber: every colour the starter draws is tldraw's grey (the chrome's colours are the page's)
    expect(new Set(built.shapes.map((s) => (s.props as { color: string }).color))).toEqual(new Set(['grey', 'black']));
    // (black: the title's text and the step frames' default, which tldraw draws as its frame chrome; every card, hint and arrow is grey)
    expect(built.shapes.filter((s) => (s.props as { color: string }).color === 'black').every((s) => s.type === 'frame' || (s.type === 'text' && (s.meta as { role: string }).role === 'title'))).toBe(true);
  });

  it('a starter whose bindings are not sound is not drawn at all', () => {
    const t = JSON.parse(JSON.stringify(starterTemplates()[2])) as StarterTemplate;
    t.bindings.push({ key: 'back', from: 'node-receipts', to: 'node-manifest' });
    expect(() => starterRecords(t, ids)).toThrow(/Starter H3 is not drawn: the bindings form a cycle/);
  });
});

describe('the slots: where a drawn card lands on a starter', () => {
  const page = (built: ReturnType<typeof starterRecords>) => built.shapes.map((s) => ({ ...s, parentId: s.parentId ?? 'page:p' }));
  it('a timmy-params card lands in the empty params slot (step 02), a workflow card in step 03, a result card in step 01; a full slot takes none', () => {
    const t = starterTemplates()[0];
    const shapes = page(starterRecords(t, ids));
    const step = (n: string) => shapes.find((s) => s.type === 'frame' && (s.props as { name: string }).name.startsWith(n))!;
    expect(emptySlot(shapes, 'timmy-params')?.id).toBe(step('02').id);
    expect(emptySlot(shapes, 'timmy-workflow')?.id).toBe(step('03').id);
    expect(emptySlot(shapes, 'timmy-result')?.id).toBe(step('01').id);
    expect(emptySlot(shapes, 'timmy-artifact')).toBeNull();
    expect(SLOT_SHAPES).toEqual({ params: 'timmy-params', workflow: 'timmy-workflow', result: 'timmy-result' });
    // a card already in the slot fills it: the next one goes where the free-spot rule puts it (null here)
    const card = { id: 'shape:card', type: 'timmy-params', parentId: step('02').id, x: 20, y: 96, props: { w: 360, h: 420 } };
    expect(emptySlot([...shapes, card], 'timmy-params')).toBeNull();
    // two starters on one page: the topmost (then leftmost) empty slot takes the card
    const second = page(starterRecords(t, ids)).map((s) => ({ ...s, y: s.y + 2000 }));
    expect(emptySlot([...shapes, card, ...second], 'timmy-params')?.id).toBe(second.find((s) => s.type === 'frame' && (s.props as { name: string }).name.startsWith('02'))!.id);
    expect(slotPosition()).toEqual({ x: 20, y: 96 });
  });
  it('the slot frame grows to show the card whole, and never shrinks', () => {
    const frame = { id: 'shape:f', type: 'frame', props: { w: 340, h: 250 } };
    const card = { id: 'shape:card', type: 'timmy-params', parentId: 'shape:f', x: 20, y: 96, props: { w: 360, h: 420 } };
    expect(slotFit(frame, [card])).toEqual({ w: 400, h: 536 });
    expect(slotFit({ ...frame, props: { w: 400, h: 536 } }, [card])).toBeNull();
    expect(slotFit({ ...frame, props: { w: 600, h: 800 } }, [card])).toBeNull();
    expect(slotFit(frame, [{ ...card, parentId: 'shape:other' }])).toBeNull();
  });
});
