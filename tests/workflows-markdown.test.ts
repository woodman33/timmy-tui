// Round R4 (H47): the small, safe Markdown subset a workflow document's prose is drawn with on the board
// (src/workflows/markdown.ts). Pure functions on real Markdown text; the named blocks come from upmd.ts parseWorkflow.
import { describe, expect, it } from 'vitest';
import { escapeHtml, linkTarget, markdownLinks, renderMarkdown, type MarkdownDraw } from '../src/workflows/markdown.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const F = '```';
/** A drawing that marks each named block and each project file plainly, so the tests can find them. */
const draw = (doc = 'BUILD.md', extra: Partial<MarkdownDraw> = {}): MarkdownDraw => ({
  doc,
  chip: (b) => `<button class="chip" data-block="${b.index}">${escapeHtml(b.name)}</button>`,
  file: (rel, html) => `<a class="file" href="../../${escapeHtml(rel)}">${html}</a>`,
  ...extra,
});
const md = (text: string, d: MarkdownDraw = draw()): string => renderMarkdown(text, d);
/** Every tag the renderer may write, the caller's chip and file link aside. */
const ALLOWED = new Set(['div', 'p', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre', 'code', 'span', 'strong', 'em', 'a', 'br', 'button']);
const tags = (html: string): string[] => [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());

describe('the Markdown subset', () => {
  it('draws headings, paragraphs, lists, quotes, rules and code in document order', () => {
    const html = md([
      '# Build the site', '', 'First line', 'second line of the same paragraph.', '',
      'Setext title', '============', '',
      '## Steps', '',
      '- one', '- two', '  - nested', '- three', '',
      '3. third', '4. fourth', '',
      '> a quote', '> that goes on', '',
      '---', '',
      '    indented code', '    more', '',
      'Hard break  ', 'after it. And a backslash\\', 'break.', '',
      '###### Six #####', '',
    ].join('\n'));
    expect(html.startsWith('<div class="md">')).toBe(true);
    expect(html).toContain('<h4 class="md-h md-h1">Build the site</h4>');
    expect(html).toContain('<p class="md-p">First line\nsecond line of the same paragraph.</p>');
    expect(html).toContain('<h4 class="md-h md-h1">Setext title</h4>');
    expect(html).toContain('<h5 class="md-h md-h2">Steps</h5>');
    expect(html).toContain('<ul class="md-list"><li>one</li><li>two<ul class="md-list"><li>nested</li></ul></li><li>three</li></ul>');
    expect(html).toContain('<ol class="md-list" start="3"><li>third</li><li>fourth</li></ol>');
    expect(html).toContain('<blockquote class="md-quote"><p class="md-p">a quote\nthat goes on</p></blockquote>');
    expect(html).toContain('<hr class="md-hr">');
    expect(html).toContain('<pre class="md-code"><code>indented code\nmore</code></pre>');
    expect(html).toContain('Hard break<br>\nafter it. And a backslash<br>\nbreak.');
    expect(html).toContain('<h6 class="md-h md-h6">Six</h6>');
    // document order
    const at = (s: string): number => html.indexOf(s);
    expect(at('Build the site')).toBeLessThan(at('Setext title'));
    expect(at('Setext title')).toBeLessThan(at('<ul'));
    expect(at('<ul')).toBeLessThan(at('<ol'));
    expect(at('<ol')).toBeLessThan(at('<blockquote'));
    expect(tags(html).every((t) => ALLOWED.has(t))).toBe(true);
  });

  it('draws inline code, strong and emphasis; underscores inside words and escaped marks stay as they are', () => {
    const html = md('Run `npm run build` with **care** and *some* __more__ _style_, not snake_case_names or 2*3*4; keep \\*this\\* and `` a ` tick ``.');
    expect(html).toContain('<code class="md-c">npm run build</code>');
    expect(html).toContain('<strong>care</strong>');
    expect(html).toContain('<em>some</em>');
    expect(html).toContain('<strong>more</strong>');
    expect(html).toContain('<em>style</em>');
    expect(html).toContain('snake_case_names');
    expect(html).toContain('2*3*4');
    expect(html).toContain('keep *this*');
    expect(html).toContain('<code class="md-c">a ` tick</code>');
  });
});

describe('links: only http(s) addresses and files of the project', () => {
  it('an http(s) address opens in a new tab with no referrer; a relative path is a project file, resolved from the document', () => {
    const html = md('See [upmd](https://github.com/rezigned/upmd), <https://example.com/a?b=1>, https://example.org/x. and [the model](../cad/box.scad#top) or [notes](notes%20one.md).', draw('docs/BUILD.md'));
    expect(html).toContain('<a class="md-a md-web" href="https://github.com/rezigned/upmd" rel="noopener noreferrer" target="_blank">upmd</a>');
    expect(html).toContain('href="https://example.com/a?b=1"');
    // a bare address without the full stop that ends the sentence
    expect(html).toContain('<a class="md-a md-web" href="https://example.org/x" rel="noopener noreferrer" target="_blank">https://example.org/x</a>.');
    expect(html).toContain('<a class="file" href="../../cad/box.scad">the model</a>');
    expect(html).toContain('<a class="file" href="../../docs/notes one.md">notes</a>');
    expect(markdownLinks('[a](a.md) [b](../b.md) [c](https://x.example) [d](../../out.md)', 'docs/BUILD.md')).toEqual(['docs/a.md', 'b.md']);
  });

  it('javascript:, data:, vbscript:, file:, mailto:, protocol-relative, absolute, anchors and paths out of the project are text, never links', () => {
    const targets = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'mailto:a@example.com',
      '//evil.example/x', '/etc/passwd', '~/x', '#top', '../../outside.md', 'C:\\x', 'a\\b'];
    for (const t of targets) {
      const html = md(`[click](${t.includes(' ') ? `<${t}>` : t}) and <${t.trim()}>`);
      expect(html, t).not.toMatch(/<a\s/);
      expect(html, t).not.toMatch(/href=/);
      expect(html, t).toContain('click');
    }
    // a target that is not followed keeps its text and says why, in a title
    expect(md('[click](javascript:alert(1))')).toContain('<span class="md-a md-nolink" title="not a link here: a javascript: link is not followed here: only http(s) addresses and project files are links">click</span>');
    expect(linkTarget('javascript:alert(1)', 'BUILD.md')).toMatchObject({ kind: 'none' });
    expect(linkTarget('https://example.com', 'BUILD.md')).toEqual({ kind: 'web', href: 'https://example.com/' });
    expect(linkTarget('docs/../src/a.ts', 'BUILD.md')).toEqual({ kind: 'file', rel: 'src/a.ts' });
    expect(linkTarget('../a.ts', 'BUILD.md')).toMatchObject({ kind: 'none', why: 'a path outside the project' });
    // an entity is not decoded into a scheme: the target stays a (harmless) relative name, cut at its '#'
    expect(linkTarget('java&#x73;cript:alert(1)', 'BUILD.md')).toEqual({ kind: 'file', rel: 'java&' });
  });

  it('reference links resolve their definitions, which are not drawn; an undefined label stays text', () => {
    const html = md(['Read [the guide][g] and [Upmd] and [missing][nope].', '', '[g]: https://example.com/guide "Guide"', '[upmd]: <https://github.com/rezigned/upmd>'].join('\n'));
    expect(html).toContain('<a class="md-a md-web" href="https://example.com/guide" rel="noopener noreferrer" target="_blank">the guide</a>');
    expect(html).toContain('href="https://github.com/rezigned/upmd"');
    expect(html).toContain('[missing][nope]');
    expect(html).not.toContain('[g]:');
  });

  it('an image is a link to its file with its alt text, never an <img>', () => {
    const html = md('![the tray](renders/tray.png) ![remote](https://example.com/x.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('<a class="file" href="../../renders/tray.png">image: the tray</a>');
    expect(html).toContain('image: remote</a>');
  });
});

describe('escaping: the document is text, its HTML is shown as text', () => {
  it('script tags, raw HTML, event handlers, entities and an HTML comment are shown as the text they are', () => {
    const doc = [
      '# <script>alert(1)</script>', '',
      'Text <img src=x onerror=alert(1)> and <b>bold</b> &amp; "quotes" \'single\'.', '',
      '<div onclick="alert(1)">a block of HTML</div>', '',
      '<!-- a comment', `${F}bash [name:hidden]`, 'rm -rf /', F, '-->', '',
      '[x" onmouseover="alert(1)](https://example.com/"onmouseover="alert(2))', '',
      '- <script>in a list</script>', '',
    ].join('\n');
    const html = md(doc);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<div onclick/i);
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Text &lt;img src=x onerror=alert(1)&gt; and &lt;b&gt;bold&lt;/b&gt; &amp;amp; &quot;quotes&quot; &#39;single&#39;.');
    expect(html).toContain('&lt;div onclick=&quot;alert(1)&quot;&gt;a block of HTML&lt;/div&gt;');
    // The comment is text; the fence inside it is not a block (parseWorkflow does not count it either).
    expect(parseWorkflow(doc).map((b) => b.name)).toEqual([]);
    expect(html).toContain('<p class="md-raw">&lt;!-- a comment\n```bash [name:hidden]\nrm -rf /\n```\n--&gt;</p>');
    expect(html).not.toContain('class="chip"');
    // an attribute cannot be broken out of: the address is percent-encoded and escaped
    expect(html).toContain('href="https://example.com/%22onmouseover=%22alert(2)"');
    expect(tags(html).every((t) => ALLOWED.has(t))).toBe(true);
  });

  it('characters the renderer uses inside are taken out of the document first', () => {
    const html = md('a \uE0000\uE001 b \uE002 c');
    expect(html).not.toMatch(/[\uE000-\uE002]/);
    expect(html).toContain('a \uFFFD0\uFFFD b \uFFFD c');
  });
});

describe('the named blocks, in place', () => {
  const DOC = [
    '# Build', '', 'Set up first.', '',
    `${F}bash [name:setup]`, 'mkdir -p dist', F, '',
    'An example, not a task:', '',
    `${F}text`, 'not a task <b>', F, '',
    '1. Then build:', '',
    `   ${F}bash [name:build, deps:setup]`, '   npm run build', `   ${F}`, '',
    '2. And check it.', '',
    `~~~sh [name:verify, deps:build]`, 'test -f dist/index.html', '~~~', '',
    'The end.', '',
  ].join('\n');

  it('each named block parseWorkflow finds is drawn where it is, once, by the caller; an unnamed block is code', () => {
    const seen: string[] = [];
    const html = md(DOC, draw('BUILD.md', { chip: (b) => { seen.push(`${b.index}:${b.name}`); return `<button class="chip">${escapeHtml(b.name)}</button>`; } }));
    expect(seen).toEqual(['1:setup', '3:build', '4:verify']);
    const order = ['Set up first.', '>setup<', 'An example', 'not a task &lt;b&gt;', 'Then build:', '>build<', 'And check it.', '>verify<', 'The end.'].map((s) => html.indexOf(s));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the block in the list item is drawn inside it, and the list goes on after it
    expect(html).toMatch(/<ol class="md-list"><li><p class="md-p">Then build:<\/p><button class="chip">build<\/button><\/li><li><p class="md-p">And check it\.<\/p><\/li><\/ol>/);
    expect(html).toContain('<pre class="md-code"><span class="md-lang">text</span><code>not a task &lt;b&gt;</code></pre>');
    // no block's lines leak into the prose
    expect(html).not.toContain('mkdir -p dist');
    expect(html).not.toContain('npm run build');
    expect(html).not.toContain('~~~');
  });

  it('blocks that hold fences, are empty, are not closed or follow a list item are each drawn once, with nothing of theirs left over', () => {
    const doc = [
      `\`\`\`\`bash [name:outer]`, `cat <<'EOF'`, F, 'not the end', F, 'EOF', '````', '',
      `${F}bash [name:empty]`, F, '',
      `${F}bash [name:blank]`, '', F, '',
      '- item', `  ${F}bash [name:listed]`, '  echo listed', `  ${F}`, '',
      '- ```bash [name:marker]', '  echo on the marker line', '  ```', '',
      `${F}bash [name:open]`, 'echo never closed', '',
    ].join('\n');
    const names = parseWorkflow(doc).map((b) => b.name ?? '(unnamed)');
    const seen: string[] = [];
    const html = md(doc, draw('BUILD.md', { chip: (b) => { seen.push(b.name); return `<button class="chip">${escapeHtml(b.name)}</button>`; } }));
    expect(seen).toEqual(names.filter((n) => n !== '(unnamed)'));
    for (const leak of ['not the end', 'EOF', 'echo listed', 'echo on the marker line', 'echo never closed']) expect(html).not.toContain(leak);
    expect(seen).toEqual(['outer', 'empty', 'blank', 'listed', 'marker', 'open']);
  });

  it('follows parseWorkflow where a fence is not closed in its list item: the line after it opens another block, drawn as parseWorkflow reads it', () => {
    const doc = ['- item', `  ${F}bash [name:listed]`, '  echo listed', F, 'echo inside the next block', ''].join('\n');
    expect(parseWorkflow(doc).map((b) => b.name ?? '(unnamed)')).toEqual(['listed', '(unnamed)']);
    const html = md(doc);
    expect(html).toContain('<button class="chip" data-block="1">listed</button>');
    expect(html).toContain('<pre class="md-code"><code>echo inside the next block\n</code></pre>');
  });

  it('draws at most maxLines lines, and says how many more there are', () => {
    const html = md(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n\n'), draw('BUILD.md', { maxLines: 10 }));
    expect(html).toContain('line 4');
    expect(html).not.toContain('line 5<');
    expect(html).toContain('49 more lines of BUILD.md are not drawn here: open it to read them.');
  });
});

describe('long and hostile text: drawn in time linear in its length, never too deep', () => {
  it('link targets with titles, parentheses, angle brackets and escapes; reference labels hold no bracket', () => {
    const html = md([
      '[t](a.md "a title") [u](b.md "no end [v](<c d.md>) [w](e(f)g.md) [x](h.md)i) [y](j\\)k.md)',
      '',
      '[[r]] [r][] [s][r] [z][a [r]]',
      '',
      '[r]: https://example.com/r',
    ].join('\n'));
    expect(html).toContain('<a class="file" href="../../a.md">t</a>');
    expect(html).toContain('[u](b.md &quot;no end');
    expect(html).toContain('<a class="file" href="../../c d.md">v</a>');
    expect(html).toContain('<a class="file" href="../../e(f)g.md">w</a>');
    expect(html).toContain('<a class="file" href="../../h.md">x</a>i)');
    expect(html).toContain('<a class="file" href="../../j)k.md">y</a>');
    const r = (text: string): string => `<a class="md-a md-web" href="https://example.com/r" rel="noopener noreferrer" target="_blank">${text}</a>`;
    // [[r]]: the outer brackets hold a bracket, so only the inner [r] is a reference
    expect(html).toContain(`[${r('r')}] ${r('r')} ${r('s')} [z][a ${r('r')}]`);
  });

  it('a hard break after a long run of spaces, and closing #s of a heading, are read from the line\'s end', () => {
    expect(md(`a${' '.repeat(10)}b  \nc`)).toContain(`a${' '.repeat(10)}b<br>\nc`);
    expect(md('# Title ##')).toContain('<h4 class="md-h md-h1">Title</h4>');
    expect(md('## C# #')).toContain('<h5 class="md-h md-h2">C#</h5>');
    expect(md('# ##')).toContain('<h4 class="md-h md-h1"></h4>');
    expect(md('#hashtag')).toContain('<p class="md-p">#hashtag</p>');
    expect(md(`# a${' '.repeat(10)}b #`)).toContain(`<h4 class="md-h md-h1">a${' '.repeat(10)}b</h4>`);
  });

  it('lists and quotes nest 16 deep at most; deeper markers are drawn as the text they are', () => {
    const quotes = md(`${'> '.repeat(5000)}x`);
    expect(quotes.split('<blockquote').length - 1).toBe(16);
    expect(quotes).toContain('&gt; &gt; &gt; x');
    const lists = md(`${'- '.repeat(200)}x`);
    expect(lists.split('<ul').length - 1).toBe(16);
    expect(lists).toContain('- - - x');
  });

  it('hostile text of 128 KB is drawn in well under 3 s each (a quadratic path takes tens of seconds at this size)', () => {
    const n = 128 * 1024;
    const fill = (s: string, len = n): string => s.repeat(Math.ceil(len / s.length)).slice(0, len);
    const cases: Record<string, string> = {
      'unclosed link targets': fill('[a]('),
      'targets that never close, then spaces': `${fill('[a]((', n / 2)}${' '.repeat(n / 2)}x`,
      'a title that never closes': `${fill('[a]((', n / 2)} "${'x'.repeat(n / 2)}`,
      'nested brackets': `${'['.repeat(n / 2)}${']'.repeat(n / 2)}`,
      'nested brackets with a definition': `[a]: https://example.com\n${'['.repeat(n / 2)}${']'.repeat(n / 2)}`,
      'unclosed brackets': fill('['),
      'emphasis marks': fill('**a'),
      'underscores': fill('_a'),
      'backtick runs': fill('`'),
      'bare-address starts': fill('h '),
      'an address of dots': `http://x${'.'.repeat(n)}`,
      'angle brackets': fill('<http:'),
      'spaces mid-line': `a${' '.repeat(n)}b\nc`,
      'a heading of spaces': `# a${' '.repeat(n)}b`,
      'a heading of #s': `# a${' #'.repeat(n / 2)}b`,
      'quote markers': `${fill('> ')}x`,
      'backslashes': `a${'\\'.repeat(n)}b\nc`,
      'raw HTML': fill('&amp;<b>'),
      'a dense paragraph': fill('word *em* [l](https://example.com) `c` '),
    };
    for (const [name, text] of Object.entries(cases)) {
      const t0 = performance.now();
      const html = md(text);
      const ms = performance.now() - t0;
      expect(html.startsWith('<div class="md">'), name).toBe(true);
      expect(ms, `${name}: ${ms.toFixed(0)} ms`).toBeLessThan(3000);
    }
  });
});
