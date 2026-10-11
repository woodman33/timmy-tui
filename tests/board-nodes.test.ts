// Round R4 (H22): workflow documents as node graphs on the board, and the Markdown rewrite behind the live
// board's node editor. Pure functions on real Markdown text, read back with the real parser (parseWorkflow);
// tests/board-edits.test.ts drives the same edits over HTTP to the live board on 127.0.0.1.
import { describe, expect, it } from 'vitest';
import { kit } from '../src/repl/board-kit.js';
import {
  checkEdits, findLoop, graphSvg, layoutGraph, MAX_BLOCKS, MAX_COMMAND, renderWorkflowCard, rewriteWorkflow, segmentWorkflow, workflowForBoard, type EditBlock,
} from '../src/repl/board-nodes.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const F = '```';
const DOC = [
  '# Build the site', '',
  'Set up first; this paragraph is prose and must survive every edit.', '',
  `${F}bash [name:setup, timeout:30]`, 'mkdir -p dist', F, '',
  'An example, not a task:', '',
  `${F}text`, 'not a task', F, '',
  '## Build', '',
  `${F}bash [name:build, deps:setup]`, 'npm ci', 'npm run build', F, '',
  `${F}sh [name:verify, deps:"setup | build"]`, 'test -f dist/index.html', F, '',
  'The end.', '',
].join('\n');

/** The document's named blocks as the editor would send them unchanged. */
const asIs = (text: string): EditBlock[] => parseWorkflow(text).filter((b) => b.name).map((b) => ({ from: b.index, name: b.name!, lang: b.lang, needs: b.deps, command: b.code }));
function rewrite(text: string, edit: (blocks: EditBlock[]) => EditBlock[]): string {
  const seg = segmentWorkflow(text);
  if (!seg.ok) throw new Error(seg.why);
  const checked = checkEdits(edit(asIs(text)), seg.slots);
  if (!checked.ok) throw new Error(checked.error);
  const out = rewriteWorkflow(text, seg, checked.value);
  if (!out.ok) throw new Error(out.why);
  return out.text;
}
const named = (text: string) => parseWorkflow(text).filter((b) => b.name).map((b) => ({ name: b.name, lang: b.lang, deps: b.deps, code: b.code }));
/** Every line that is not inside a fenced block: what "prose" means here. */
const prose = (text: string): string[] => {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null; continue; }
    if (m) { fence = m[1]; continue; }
    if (line.trim()) out.push(line);
  }
  return out;
};
const unescapeAttr = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('rewriting a workflow document block by block', () => {
  it('an edit that changes nothing writes back the same bytes', () => {
    expect(rewrite(DOC, (b) => b)).toBe(DOC);
  });

  it('renaming a block renames it where others need it, keeps its other attributes, and leaves every prose line as it was', () => {
    const out = rewrite(DOC, (b) => b.map((x) => (x.name === 'setup' ? { ...x, name: 'init' } : { ...x, needs: x.needs.map((n) => (n === 'setup' ? 'init' : n)) })));
    expect(out).toContain(`${F}bash [name:init, timeout:30]`);
    expect(out).toContain(`${F}bash [name:build, deps:init]`);
    // The quoted expression keeps its form, with the name replaced.
    expect(out).toContain(`${F}sh [name:verify, deps:"init | build"]`);
    expect(named(out).map((b) => [b.name, b.deps])).toEqual([['init', []], ['build', ['init']], ['verify', ['init', 'build']]]);
    expect(prose(out)).toEqual(prose(DOC));
    // The unnamed example block is untouched.
    expect(out).toContain(`${F}text\nnot a task\n${F}`);
  });

  it("editing one command changes only that block's lines", () => {
    const out = rewrite(DOC, (b) => b.map((x) => (x.name === 'build' ? { ...x, command: 'npm ci\nnpm test\nnpm run build' } : x)));
    const before = DOC.split('\n');
    const after = out.split('\n');
    expect(after.length).toBe(before.length + 1);
    const at = before.indexOf('npm run build');
    expect(after.slice(0, at)).toEqual(before.slice(0, at));
    expect(after.slice(at + 1)).toEqual(before.slice(at));
    expect(named(out)[1].code).toBe('npm ci\nnpm test\nnpm run build');
  });

  it('a new block goes right after the block before it in the list, with a blank line; a new first block goes before the first', () => {
    const out = rewrite(DOC, (b) => [...b.slice(0, 2), { name: 'lint', lang: 'bash', needs: ['build'], command: 'npm run lint' }, b[2]]);
    expect(out).toContain(`npm run build\n${F}\n\n${F}bash [name:lint, deps:build]\nnpm run lint\n${F}\n\n${F}sh [name:verify`);
    expect(named(out).map((b) => b.name)).toEqual(['setup', 'build', 'lint', 'verify']);
    expect(prose(out)).toEqual(prose(DOC));
    const first = rewrite(DOC, (b) => [{ name: 'clean', lang: 'bash', needs: [], command: 'rm -rf dist' }, ...b]);
    expect(first).toContain(`must survive every edit.\n\n${F}bash [name:clean]\nrm -rf dist\n${F}\n\n${F}bash [name:setup, timeout:30]`);
    expect(prose(first)).toEqual(prose(DOC));
  });

  it('a removed block takes one blank line with it; the prose around it stays', () => {
    const out = rewrite(DOC, (b) => b.filter((x) => x.name !== 'verify'));
    expect(out).not.toContain('name:verify');
    expect(out).not.toMatch(/\n\n\n/);
    expect(out.endsWith('npm run build\n```\n\nThe end.\n')).toBe(true);
    expect(prose(out)).toEqual(prose(DOC));
  });

  it('reordering moves the blocks between their places; the headings and prose stay where they are', () => {
    const out = rewrite(DOC, (b) => [b[0], b[2], b[1]]);
    expect(named(out).map((b) => b.name)).toEqual(['setup', 'verify', 'build']);
    expect(prose(out)).toEqual(prose(DOC));
    expect(out.indexOf('## Build')).toBeLessThan(out.indexOf('name:verify'));
  });

  it('keeps CRLF line endings and a missing final newline', () => {
    const doc = ['# T', '', `${F}bash [name:a]`, 'echo a', F, '', `${F}bash [name:b, deps:a]`, 'echo b', F].join('\r\n');
    const out = rewrite(doc, (b) => b.map((x) => (x.name === 'b' ? { ...x, command: 'echo b\necho bb' } : x)));
    expect(out).toBe(['# T', '', `${F}bash [name:a]`, 'echo a', F, '', `${F}bash [name:b, deps:a]`, 'echo b', 'echo bb', F].join('\r\n'));
  });

  it('a command that holds a fence gets a longer fence, and reads back exactly', () => {
    const command = `cat <<'EOF'\n${F}\nnot the end\n${F}\nEOF`;
    const out = rewrite(DOC, (b) => b.map((x) => (x.name === 'setup' ? { ...x, command } : x)));
    expect(out).toContain('````bash [name:setup, timeout:30]');
    expect(named(out)[0].code).toBe(command);
  });

  it('a block inside a list, or a named block with no closing fence, is not rewritten: the document is shown read-only', () => {
    const listed = ['# L', '', '- step one', '- ```bash [name:a]', '  echo a', '  ```', ''].join('\n');
    expect(segmentWorkflow(listed)).toMatchObject({ ok: false });
    const open = ['# O', '', `${F}bash [name:a]`, 'echo a', ''].join('\n');
    expect(segmentWorkflow(open)).toMatchObject({ ok: false, why: expect.stringContaining('no closing fence') });
    const view = workflowForBoard('O.md', { text: open, sha256: 'ab'.repeat(32) });
    expect(view.readOnly).toContain('no closing fence');
    expect(view.blocks.map((b) => b.name)).toEqual(['a']);
  });
});

describe('checking the edited blocks', () => {
  const seg = segmentWorkflow(DOC);
  if (!seg.ok) throw new Error(seg.why);
  const slots = seg.slots;
  const base = asIs(DOC);
  const refused = (blocks: unknown): { status: number; error: string } => {
    const r = checkEdits(blocks, slots);
    if (r.ok) throw new Error('accepted');
    return r;
  };

  it('refuses duplicate names, ill-formed names, unknown needs, a block that needs itself, and a loop, in plain words', () => {
    expect(refused([...base, { name: 'build', lang: 'bash', needs: [], command: '' }])).toMatchObject({ status: 422, error: 'Two blocks are named build: each name is used once.' });
    for (const name of ['my block', '-x', 'a/b', 'x:y', '', 'a'.repeat(65), 'ünï']) expect(refused([{ ...base[0], name }]).error).toContain('is not a block name');
    expect(refused([{ ...base[0], needs: ['deploy'] }]).error).toBe('setup needs deploy, but no block is named deploy.');
    expect(refused([{ ...base[0], needs: ['setup'] }]).error).toBe('setup needs itself.');
    const loop = refused([{ ...base[0], needs: ['verify'] }, base[1], base[2]]);
    expect(loop).toEqual({ ok: false, status: 422, error: 'These blocks need each other in a loop: setup → verify → setup. A workflow runs in order, so a loop cannot run.' });
  });

  it('refuses sizes over the bounds, control characters, an empty list, and blocks that do not belong to the document', () => {
    expect(refused([])).toMatchObject({ status: 422 });
    expect(refused(Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({ name: `s${i}`, lang: 'bash', needs: [], command: '' })))).toMatchObject({ status: 422 });
    expect(refused([{ ...base[0], command: 'x'.repeat(MAX_COMMAND + 1) }]).error).toContain('longer than');
    expect(refused([{ ...base[0], command: 'echo a\r\necho b' }]).error).toContain('control character');
    expect(refused([{ ...base[0], lang: 'ba sh' }]).error).toContain('language');
    expect(refused([{ ...base[0], from: 99 }])).toMatchObject({ status: 400 });
    expect(refused([base[0], { ...base[1], from: base[0].from }])).toMatchObject({ status: 400, error: expect.stringContaining('sent twice') });
    expect(refused([{ ...base[0], extra: 1 }])).toMatchObject({ status: 400 });
    expect(refused([{ ...base[0], needs: 'setup' }])).toMatchObject({ status: 400 });
  });

  it('finds a loop among more blocks than one graph draws', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `s${i}`, deps: i ? [`s${i - 1}`] : ['s59'] }));
    expect(findLoop(many)?.length).toBe(61);
    expect(findLoop(many.map((b, i) => (i ? b : { ...b, deps: [] })))).toBeUndefined();
  });
});

describe('the graph', () => {
  const view = workflowForBoard('BUILD.md', { text: DOC, sha256: 'cd'.repeat(32) });

  it('lays blocks out by their needs: each edge runs forward, a loop and a missing need are marked', () => {
    const g = layoutGraph(view.blocks);
    expect(g.nodes.map((n) => [n.name, n.layer])).toEqual([['setup', 0], ['build', 1], ['verify', 2]]);
    expect(g.edges.map((e) => [g.nodes[e.from].name, g.nodes[e.to].name])).toEqual([['setup', 'build'], ['setup', 'verify'], ['build', 'verify']]);
    expect(g.edges.every((e) => !e.loop)).toBe(true);
    const bad = layoutGraph([{ name: 'a', deps: ['b'] }, { name: 'b', deps: ['a', 'ghost'] }]);
    expect(bad.cycle).toEqual(['a', 'b', 'a']);
    expect(bad.edges.some((e) => e.loop)).toBe(true);
    expect(bad.missing).toEqual([{ block: 'b', need: 'ghost' }]);
  });

  it('draws names, languages and first command lines as escaped SVG text, with no script, style attribute or url()', () => {
    const svg = graphSvg('x.md', [{ name: 'evil', lang: 'bash', deps: [], code: 'echo "<script>alert(1)</script>" & more' }, { name: 'next', lang: 'sh', deps: ['evil'], code: 'a\nb\nc\nd\ne' }]);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toMatch(/<script|\sstyle=|url\(|\son[a-z]+=/i);
    expect(svg).toContain('>evil</text>');
    expect(svg).toContain('+ 3 more lines');
    expect(svg).toMatch(/<svg class="wf-svg" role="img" aria-label="x\.md: evil; next \(needs evil\)"/);
  });

  it('the snapshot card: graph, needs, /run commands, read-only; the live card adds Run, Edit and its blocks as escaped JSON', () => {
    const still = renderWorkflowCard(view, kit({ live: false, base: '../../' }));
    expect(still).toContain('<svg');
    expect(still).toContain('needs setup');
    expect(still).toContain('data-cmd="/run BUILD.md build"');
    expect(still).toContain('href="../../BUILD.md"');
    expect(still).not.toContain('data-act=');
    expect(still).not.toContain('data-wf=');
    expect(still).toContain('Read-only here: /board live edits its blocks');
    const live = renderWorkflowCard(view, kit({ live: true, base: '../../' }));
    expect(live).toContain('data-act="run" data-doc="BUILD.md" data-block="build"');
    expect(live).toContain('data-wf-edit="BUILD.md"');
    expect(live).toContain(`data-wf-sha="${'cd'.repeat(32)}"`);
    const data = JSON.parse(unescapeAttr(/ data-wf="([^"]*)"/.exec(live)![1]));
    expect(data).toEqual([
      { index: 1, name: 'setup', lang: 'bash', deps: [], code: 'mkdir -p dist' },
      { index: 3, name: 'build', lang: 'bash', deps: ['setup'], code: 'npm ci\nnpm run build' },
      { index: 4, name: 'verify', lang: 'sh', deps: ['setup', 'build'], code: 'test -f dist/index.html' },
    ]);
    expect(live).not.toContain('href=');
    // A document the board cannot rewrite is drawn, says why, and carries nothing for an editor.
    const ro = renderWorkflowCard({ ...view, readOnly: 'it has no closing fence' }, kit({ live: true, base: '../../' }));
    expect(ro).not.toContain('data-wf=');
    expect(ro).toContain('The board does not edit this document: it has no closing fence.');
  });
});
