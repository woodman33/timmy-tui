/**
 * R12: the Timmy app's reading of a model's answer (companion/timmy-app/src/md.jsx): its blocks, and that an answer never
 * becomes markup (the renderer makes React elements from text; nothing here is HTML).
 */
import { describe, expect, it } from 'vitest';
import { blocksOf } from '../companion/timmy-app/src/md.jsx';

describe('the app reads an answer as markdown blocks (R12)', () => {
  it('paragraphs, headings, lists, quotes and fenced code', () => {
    const b = blocksOf('# Plan\n\nFirst line\nsecond line\n\n- one\n- two\n\n1. a\n2) b\n\n> quoted\n\n```bash\nnpm i\n<b>x</b>\n```\nafter');
    expect(b.map((x) => x.kind)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'code', 'p']);
    expect(b[1]).toEqual({ kind: 'p', text: 'First line\nsecond line' });
    expect(b[2]).toEqual({ kind: 'ul', items: ['one', 'two'] });
    expect(b[3]).toEqual({ kind: 'ol', items: ['a', 'b'] });
    expect(b[5]).toEqual({ kind: 'code', lang: 'bash', text: 'npm i\n<b>x</b>' });
  });
  it('an unclosed fence while it streams is code to the end', () => {
    expect(blocksOf('Here:\n```js\nconst a = 1;')).toEqual([{ kind: 'p', text: 'Here:' }, { kind: 'code', lang: 'js', text: 'const a = 1;' }]);
  });
  it('empty or absent text has no blocks', () => {
    expect(blocksOf('')).toEqual([]);
    expect(blocksOf(undefined as unknown as string)).toEqual([]);
  });
});
