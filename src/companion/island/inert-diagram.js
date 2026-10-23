/**
 * R10 (H164): a diagram's text never brings an HTML attribute into the companion page.
 *
 * Mermaid parses a label's markup as it was written: its sanitizer, DOMPurify, parses `<img src=x onerror=…>` into a document
 * of this page (a DOMParser document) and only then removes the handler. In the page test's hostile answer that parse is the
 * one place a handler meets a parser of the page (measured in Chromium 148: two per drawing, under Mermaid's removeScript).
 * CI's gate on Google Chrome 156 (runner image ubuntu24/20261021.345, at 51d2dbc and at 4e75edf) reported 'script-src-attr
 * inline' beside the expected img-src report, with nothing run; on Chrome 155, and on Chromium here (which reports a handler
 * only as it is about to run), it never did. A browser that checks the page's policy as a handler attribute is set (the HTML
 * standard's attribute-change steps) reports it at that parse.
 *
 * So the chat hands Mermaid each '<' that opens a start tag with an attribute as Mermaid's own entity #lt;, which Mermaid draws
 * as '<': the label reads as it was written, and no parser of this page (DOMPurify's, the drawing's, the chat's) is ever handed
 * an attribute from a diagram. A tag with none (<br/>, <b>bold</b>), an end tag, and every other '<' (arrows, <<annotations>>,
 * comparisons) are left as Mermaid reads them.
 */

/** A start tag's name runs to white space, '/' or '>' (the HTML tokenizer's tag name state); JavaScript's \s covers HTML's. */
const NAME_END = /[\s/>]/;
const BETWEEN = /[\s/]/;

/** `text` with each '<' that opens a start tag carrying an attribute given as Mermaid's entity #lt;. */
export function inertDiagramText(text) {
  const s = String(text ?? '');
  let out = '';
  let from = 0;
  for (let i = s.indexOf('<'); i !== -1; i = s.indexOf('<', i + 1)) {
    if (!/[A-Za-z]/.test(s.charAt(i + 1))) continue; // not a start tag: an end tag, a comment, an arrow, a comparison
    let j = i + 2;
    while (j < s.length && !NAME_END.test(s.charAt(j))) j++;
    while (j < s.length && BETWEEN.test(s.charAt(j))) j++;
    // anything before its '>' (or the end of a text still streaming) begins an attribute
    if (j < s.length && s.charAt(j) !== '>') {
      out += `${s.slice(from, i)}#lt;`;
      from = i + 1;
    }
  }
  return out + s.slice(from);
}

/**
 * The Streamdown Mermaid plugin `plugin` (@streamdown/mermaid's), drawing each diagram from its inert text: the same plugin
 * otherwise (its name, type, language, and the drawer's initialize). Streamdown's drawing and its SVG and PNG downloads both
 * draw through getMermaid().render.
 */
export function inertDiagrams(plugin) {
  return {
    ...plugin,
    getMermaid(config) {
      const drawer = plugin.getMermaid(config);
      return { ...drawer, render: (id, text) => drawer.render(id, inertDiagramText(text)) };
    },
  };
}
