/**
 * R10 (H164): a diagram's text never brings an HTML attribute into the companion page.
 *
 * CI's gate on runner image ubuntu24/20261021.345 (Google Chrome 156; at 51d2dbc and at 4e75edf) reported 'script-src-attr
 * inline' in the page test's hostile answer, beside the expected img-src report; on Chrome 155 it never did. Measured in
 * Chromium 148 here: the only place that answer's handlers meet a parser of the page is Mermaid's own sanitizer. DOMPurify
 * parses each label as written (<img src=x onerror=…>, <b onclick=…>) into a document of the page, then removes the
 * handlers; a browser that checks the page's policy as a handler attribute is set (the HTML standard's attribute-change
 * steps) reports it there. The chat's Mermaid plugin (src/companion/island/inert-diagram.js) now hands Mermaid each '<' that
 * opens a start tag with an attribute as Mermaid's own entity #lt; (drawn as '<'): the label reads as it was written, and no
 * parser of the page is handed one.
 */
import { describe, expect, it } from 'vitest';
import { inertDiagramText, inertDiagrams } from '../src/companion/island/inert-diagram.js';

describe('a diagram\'s text as the chat hands it to Mermaid (R10 H164)', () => {
  it('gives each tag with an attribute as Mermaid\'s entity #lt;, the hostile answer\'s labels included', () => {
    const hostile = 'graph LR\n  A["<img src=x onerror=window.__pwned=1>"] --> B["<b onclick=window.__pwned=2>bold</b>"]';
    expect(inertDiagramText(hostile)).toBe('graph LR\n  A["#lt;img src=x onerror=window.__pwned=1>"] --> B["#lt;b onclick=window.__pwned=2>bold</b>"]');
    for (const [given, handed] of [
      ['<img/onerror=1>', '#lt;img/onerror=1>'], // a slash before an attribute, as the HTML tokenizer reads it
      ['<IMG SRC=x ONERROR=1>', '#lt;IMG SRC=x ONERROR=1>'],
      ['<svg\nonload=1>', '#lt;svg\nonload=1>'],
      ['<a href="https://x.example">x</a>', '#lt;a href="https://x.example">x</a>'],
      ['A["<img src', 'A["#lt;img src'], // cut by a stream: a tag with an attribute already
      ['<b><img src=x onerror=1></b>', '<b>#lt;img src=x onerror=1></b>'],
    ]) expect(inertDiagramText(given), given).toBe(handed);
  });

  it('leaves what carries no attribute as Mermaid reads it: line breaks, bare tags, arrows, annotations, comparisons', () => {
    for (const same of [
      'A[one<br/>two]', 'A[one<br />two]', 'A[<b>bold</b> and <i>it</i>]', 'A <--> B', 'Animal <|-- Duck',
      'class Shape{\n  <<interface>>\n}', 'A[a < b]', 'A[x<y]', 'A["5 <= 6"]', '</b onclick=1>', '<!-- a note -->', '<img ', '',
    ]) expect(inertDiagramText(same), same).toBe(same);
  });

  it('the chat\'s Mermaid plugin hands Mermaid the inert text, and is otherwise the plugin it wraps', async () => {
    const asked: unknown[] = [];
    const drawn: Array<[string, string]> = [];
    const drawer = {
      initialize: (config: unknown) => config,
      render: async (id: string, text: string) => { drawn.push([id, text]); return { svg: '<svg></svg>' }; },
    };
    const plugin = { name: 'mermaid', type: 'diagram', language: 'mermaid', getMermaid: (config?: unknown) => { asked.push(config); return drawer; } };
    const wrapped = inertDiagrams(plugin);
    expect([wrapped.name, wrapped.type, wrapped.language]).toEqual(['mermaid', 'diagram', 'mermaid']);
    const m = wrapped.getMermaid({ theme: 'dark' });
    expect(asked).toEqual([{ theme: 'dark' }]);
    expect(m.initialize).toBe(drawer.initialize);
    expect(await m.render('d1', 'A["<img src=x onerror=1>"]')).toEqual({ svg: '<svg></svg>' });
    expect(drawn).toEqual([['d1', 'A["#lt;img src=x onerror=1>"]']]);
  });
});
