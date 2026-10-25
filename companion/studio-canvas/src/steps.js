// R11 round 7 (H176; the operator's order of 2026-10-24 19:18, item 6: "make Houdini starter nodes actionable"; the lead's 19:21
// reading): EACH starter step on the board carries ONE verb that does something now, drawn in front of the canvas under the step's
// frame (./starters.js draws the frames; this draws their verbs), and ONE state line read from the project's own sources (the
// Project panel's reading, as the Nodes palette has it: the card's title and state word, never invented):
//   01 Define the geometry   "Add a mesh"               the project's first result node lands in the step's slot (./nodes.js add →
//                                                       ./cards.js place: the slot rule); none in the project → /add <file> is copied
//                                                       with its words; a mesh already in the slot → "Show the mesh" selects it
//   02 Set the parameters    "Edit the parameters"      the project's parameter node lands in the slot and is selected (its fields are
//                                                       the live board's: Save and Rebuild go through the REPL that holds the project);
//                                                       in the slot already → selected; no parameter file → "Add a parameter file"
//                                                       copies /add <file> with its words
//   03 Cook in Houdini       "Copy the hython command"  the engine shelf's own headless invocation (lanes/engines/houdini/templates/
//                                                       procedural-asset/script.py, its first line) is copied, and the band says the
//                                                       honest line: nothing on this board calls Houdini and Houdini is not connected
//                                                       to this Studio — this copies the command, nothing runs. Never a fabricated run.
// Imports ./starters.js and ./face.js only (each imports nothing), so the rules run in Node's tests; the React part is made by
// createStepVerbs(deps) with tldraw's hooks handed in (as ./desk.js does).

import { faceTitle, faceWords } from './face.js';
import { SLOT_SHAPES, slotOf, STARTER_WORKBENCH } from './starters.js';

/** The typed command that copies a file into the project (Timmy's terminal). */
export const ADD_COMMAND = '/add <file>';
/** The engine shelf's headless Houdini invocation, as the script's own first line says it (lanes/engines/houdini/templates/procedural-asset/script.py). */
export const HYTHON_COMMAND = 'hython lanes/engines/houdini/templates/procedural-asset/script.py <mesh file> <out dir> <stem>';
/** The honest line beside a copied Houdini command: nothing here calls Houdini. */
export const HOUDINI_LINE = 'Nothing on this board calls Houdini, and Houdini is not connected to this Studio: this copies the command, nothing runs.';
/** What the copied /add says, for a mesh (step 01) and for a parameter file (step 02). */
export const ADD_WORDS = Object.freeze({
  mesh: `Copied ${ADD_COMMAND} for Timmy's terminal: type it with the mesh's path (an .stl, .obj or .ply file); Timmy copies the file into the project (a local change), and it is listed as a result node. Nothing ran on this board.`,
  params: `Copied ${ADD_COMMAND} for Timmy's terminal: a parameter file is a tray recipe (recipes/tray.params.json) or an OpenSCAD model with its parameters beside it; type the command with its path, and the project's parameter node then lands in this step. Nothing ran on this board.`,
});
/** The verbs, by step. */
export const VERBS = Object.freeze({ '01': 'Add a mesh', '02': 'Edit the parameters', '03': 'Copy the hython command' });
/** Below this width of the step's frame on screen (CSS px) the verb bar is not drawn (the frame is a thumbnail then). */
export const BAR_MIN_WIDTH = 150;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * The starter step frames among `shapes` (a page's), in step order, each with the drawn card its slot holds: { id, n, verb,
 * slot, card } — `card` the shape in the slot of the slot's type (./starters.js SLOT_SHAPES), or null.
 */
export function stepsOn(shapes) {
  const list = Array.isArray(shapes) ? shapes : [];
  return list
    .filter((s) => s && s.type === 'frame' && s.meta && typeof s.meta === 'object' && s.meta.workbench === STARTER_WORKBENCH && s.meta.role === 'step' && s.meta.data && typeof s.meta.data === 'object' && typeof s.meta.data.n === 'string')
    .map((f) => {
      const slot = slotOf(f);
      const card = slot ? list.find((c) => c && c.parentId === f.id && c.type === SLOT_SHAPES[slot]) ?? null : null;
      return { id: f.id, n: f.meta.data.n, verb: String(f.meta.data.verb ?? ''), slot, card };
    })
    .sort((a, b) => a.n.localeCompare(b.n));
}

/** The palette's items of one node kind (./nodes.js paletteOf: groups of { id, kind, title, state }); [] without a palette. */
const itemsOf = (palette, kind) => {
  const g = palette && Array.isArray(palette.groups) ? palette.groups.find((x) => x && x.kind === kind) : null;
  return g && Array.isArray(g.items) ? g.items : [];
};
/** A node's state line, from the project's own reading: its title and its state word (./face.js: a file by its name, no id). */
const stateOf = (it) => (it ? [faceTitle(it.title), faceWords(it.state)].filter(Boolean).join(' · ') : '');
/** The palette item a drawn card in a slot stands for (its props.card is the record's id), else null. */
const itemOfCard = (palette, card, kind) => {
  const id = card && card.props && typeof card.props.card === 'string' ? card.props.card : '';
  return id ? itemsOf(palette, kind).find((it) => it.id === id) ?? null : null;
};

/**
 * What step `step` (stepsOn) offers now, given the project's `palette` (./nodes.js: the palette drawn from the Project panel's
 * reading; null while none is read): { n, verb, state, action } — the action one of
 *   { kind: 'place', nodeKind, id }    add that node of the project (it lands in the step's slot: ./cards.js place)
 *   { kind: 'select', shape }          select the card in the slot (and bring it into view)
 *   { kind: 'copy', command, words }   copy that command and say the words
 * The state line is the project's own (a node's title and state word), or what is missing, in words; never a run that did not happen.
 */
export function stepPlan(step, palette) {
  const read = Boolean(palette && Array.isArray(palette.groups));
  if (step.n === '01') {
    if (step.card) {
      const it = itemOfCard(palette, step.card, 'result');
      return { n: '01', verb: 'Show the mesh', state: it ? stateOf(it) : `in this step: ${faceTitle(step.card.props && step.card.props.title)}`, action: { kind: 'select', shape: step.card.id } };
    }
    const results = itemsOf(palette, 'result');
    if (results.length) return { n: '01', verb: VERBS['01'], state: `${plural(results.length, 'result node')} in the project · ${stateOf(results[0])}`, action: { kind: 'place', nodeKind: 'result', id: results[0].id } };
    return { n: '01', verb: VERBS['01'], state: read ? 'no mesh in this project yet' : 'reading the project…', action: { kind: 'copy', command: ADD_COMMAND, words: ADD_WORDS.mesh } };
  }
  if (step.n === '02') {
    if (step.card) {
      const it = itemOfCard(palette, step.card, 'params');
      return { n: '02', verb: VERBS['02'], state: it ? stateOf(it) : `in this step: ${faceTitle(step.card.props && step.card.props.title)}`, action: { kind: 'select', shape: step.card.id } };
    }
    const params = itemsOf(palette, 'params');
    if (params.length) return { n: '02', verb: VERBS['02'], state: `${plural(params.length, 'parameter node')} in the project · ${stateOf(params[0])}`, action: { kind: 'place', nodeKind: 'params', id: params[0].id } };
    return { n: '02', verb: 'Add a parameter file', state: read ? 'no parameter file in this project yet' : 'reading the project…', action: { kind: 'copy', command: ADD_COMMAND, words: ADD_WORDS.params } };
  }
  // 03: the command, always; the state is the workflow node's own word when the project has one (in the slot first)
  const inSlot = step.card ? itemOfCard(palette, step.card, 'workflow') : null;
  const workflows = itemsOf(palette, 'workflow');
  const state = inSlot ? stateOf(inSlot) : step.card ? `in this step: ${faceTitle(step.card.props && step.card.props.title)}` : workflows.length ? `${plural(workflows.length, 'workflow node')} in the project · ${stateOf(workflows[0])} · no native Houdini operation` : read ? 'no workflow document in this project yet · no native Houdini operation' : 'reading the project…';
  return { n: '03', verb: VERBS['03'], state, action: { kind: 'copy', command: HYTHON_COMMAND, words: `Copied the hython command for a terminal on a computer with Houdini: ${HYTHON_COMMAND}. ${HOUDINI_LINE}` } };
}

/**
 * The React part: the verb bars in front of the canvas, one under each step frame of the page shown. `deps`: React, useEditor,
 * useValue (tldraw's), palette() (./nodes.js palette, or null), add(kind, id) (./nodes.js add: a Promise of { words, shape }),
 * copy(text) (a Promise of true when copied), say(words, bad) (the band), blocked() (./identity.js: Studio switching or paused —
 * the bars are not drawn then), onPlaced() (the slots refit: canvas.js fitSlots).
 */
export function createStepVerbs(deps) {
  const { React, useEditor, useValue } = deps;
  const h = React.createElement;
  const stop = (e) => { e.stopPropagation(); };

  function StepVerbs() {
    const editor = useEditor();
    const [palette, setPalette] = React.useState(() => deps.palette());
    const [busy, setBusy] = React.useState('');
    // the palette follows the Project panel's readings (every few seconds): read again at each paint of the bars
    React.useEffect(() => { const t = setInterval(() => { const p = deps.palette(); if (p !== palette) setPalette(p); }, 1000); return () => clearInterval(t); }, [palette]);
    const bars = useValue('timmy: starter step verbs', () => {
      if (deps.blocked()) return [];
      const shapes = editor.getCurrentPageShapes();
      return stepsOn(shapes).map((step) => {
        const b = editor.getShapePageBounds(step.id);
        if (!b) return null;
        const a = editor.pageToViewport({ x: b.minX, y: b.maxY });
        const z = editor.pageToViewport({ x: b.maxX, y: b.maxY });
        return { step, x: Math.round(a.x), y: Math.round(a.y) + 6, w: Math.round(z.x - a.x) };
      }).filter((x) => x && x.w >= BAR_MIN_WIDTH);
    }, [editor, palette]);
    const act = (step, plan) => {
      const { action } = plan;
      setBusy(step.id);
      const done = () => setBusy('');
      if (action.kind === 'select') {
        try {
          editor.select(action.shape);
          if (typeof editor.zoomToSelectionIfOffscreen === 'function') editor.zoomToSelectionIfOffscreen(64, { animation: { duration: 160 } });
        } catch { /* the card may be gone: the next paint redraws the verb */ }
        done();
        return;
      }
      if (action.kind === 'copy') {
        void deps.copy(action.command).then((ok) => deps.say(ok ? action.words : `Not copied (the clipboard refused): the command is ${action.command}. ${step.n === '03' ? HOUDINI_LINE : 'Nothing ran on this board.'}`, !ok), () => deps.say(`Not copied: the command is ${action.command}.`, true)).finally(done);
        return;
      }
      void deps.add(action.nodeKind, action.id).then((r) => {
        deps.say(r.words);
        try { if (r && r.shape && step.n === '02') editor.select(r.shape); } catch { /* selection is a courtesy */ }
        if (typeof deps.onPlaced === 'function') deps.onPlaced();
      }, (e) => deps.say(e instanceof Error ? e.message : String(e), true)).finally(done);
    };
    return h(React.Fragment, null, ...bars.map(({ step, x, y, w }) => {
      const plan = stepPlan(step, palette);
      return h('div', { key: step.id, className: 'timmy-step-verbs', 'data-step': step.n, 'data-step-frame': step.id, 'data-step-action': plan.action.kind, style: { left: `${x}px`, top: `${y}px`, width: `${w}px` }, onPointerDown: stop, onPointerUp: stop, onPointerMove: stop, onClick: stop, onContextMenu: stop },
        h('button', { type: 'button', className: 'timmy-step-do', disabled: busy === step.id, title: step.n === '03' ? HOUDINI_LINE : `Step ${step.n} · ${step.verb}: ${plan.verb}`, onClick: () => act(step, plan) }, plan.verb),
        h('span', { className: 'timmy-step-state', title: plan.state }, plan.state));
    }));
  }
  return { StepVerbs };
}
