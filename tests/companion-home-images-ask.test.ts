/**
 * R8 lead (R7's open item D; the CI of PR #102 at 1dd6ec9 and of R7's b40fad3, where tests/companion-r7-page-browser.test.ts
 * waited 20 s for Home's run image to say that one newer run holds none): when Home asks again for the newest run image.
 *
 * The page's own code (src/companion/client/companion.js, from `const homeImages =` to `function drawHome(`, and its
 * newestRunOf line) runs here with the companion's answers held by the test and given when the test says, so each order of
 * events below is the test's, not a race's. Stubbed, labelled: the token, the project id, the element builder and the one
 * element Home's images are drawn in. The answers are FAKE (a run image's fields as GET /api/newest-run-image gives them).
 *
 *  - an answer that comes back after the frame's newest run changed (it was asked for the run before) is followed by one
 *    more ask, for the newest: before R8 the page kept it until another run began;
 *  - the newest run's later entry (its end) asks again: an answer read while it ran may be another once it has ended;
 *  - a frame that did not change asks nothing, and frames that change while an ask is out make one ask after it, not one each.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../src/companion/client/companion.js', import.meta.url), 'utf8');
const from = script.indexOf('const homeImages = ');
const to = script.indexOf('function drawHome(');
const newestRunOf = script.match(/^const newestRunOf = .*$/m)?.[0] ?? '';

interface Node { tag: string; attrs: Record<string, string>; children: Array<Node | string> }
interface Asked { url: string; answer: (body: unknown) => void }
interface Entry { at: string; tag: string; words: string; tone: string; operation?: string; source: string }

const OLD = 'o0aa00001';
const NEW = 'o0aa00002';
const entry = (operation: string, tag: string, at: string): Entry => ({ at, tag, words: `${operation} ${tag}`, tone: 'info', operation, source: `${operation}-${tag}` });
const frame = (...log: Entry[]) => ({ log });
/** FAKE: the companion's answer, the run image of OLD with `newer` newer runs that hold none */
const answer = (newer: number) => ({ ok: true, looked: newer + 1, image: { op: OLD, path: 'out/shot.png', width: 640, height: 360, src: 'data:image/png;base64,AA==', newer } });
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function home() {
  const asked: Asked[] = [];
  let drawn: Node | null = null;
  const h = (tag: string, attrs: Record<string, string> | null, ...children: Array<Node | string | null | undefined | false>): Node =>
    ({ tag, attrs: attrs ?? {}, children: children.flat().filter((c): c is Node | string => c !== null && c !== undefined && c !== false) });
  const context: Record<string, unknown> = {
    companion: {
      token: 'c0'.repeat(32), refused: false,
      // the run image waits for the test; the VoxVision records list answers at once, with none (Home's run image is what is tested)
      fetch: (url: string) => new Promise((resolve) => {
        const reply = (body: unknown) => resolve({ ok: true, status: 200, json: async () => body });
        if (url.startsWith('/api/panel/voxvision/records')) reply({ ok: true, records: [] });
        else asked.push({ url, answer: reply });
      }),
    },
    shownProjectId: () => 'p-home',
    h,
    document: { querySelector: (sel: string) => (sel === '#home-preview [data-preview="images"]' ? { replaceWith: (n: Node) => { drawn = n; } } : null) },
  };
  runInNewContext(`${newestRunOf}\n${script.slice(from, to)}\nthis.refresh = (f) => homeImagesRefresh(f, true); this.state = () => homeImages.run;`, context);
  const refresh = context.refresh as (f: { log: Entry[] }) => void;
  const state = context.state as () => { key: unknown; want: unknown; item: { newer?: number; op?: string } | null; asking: boolean };
  const runAsks = () => asked.filter((a) => a.url.startsWith('/api/newest-run-image'));
  /** the run's figure as Home draws it last: its data-newer, or null when none is drawn */
  const shownNewer = (): string | null => {
    const find = (n: Node | string): Node | null => (typeof n === 'string' ? null : n.tag === 'figure' && n.attrs['data-home-image'] === 'run' ? n : n.children.map(find).find(Boolean) ?? null);
    const fig = drawn ? find(drawn) : null;
    return fig ? fig.attrs['data-newer'] : null;
  };
  return { refresh, state, runAsks, shownNewer };
}

describe('Home asks again for its newest run image (R8 lead, R7\'s open item D)', () => {
  it('the page\'s code is here: the part from homeImages to drawHome, and newestRunOf', () => {
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(newestRunOf).toContain('(f.log || []).find((e) => e.operation)');
  });

  it('an answer that comes back after the frame\'s newest run changed is followed by one more ask, for the newest run', async () => {
    const p = home();
    const before = frame(entry(OLD, 'job.ended', '2026-10-18T10:00:00.000Z'));
    p.refresh(before);
    expect(p.runAsks()).toHaveLength(1);
    // a newer run (one that writes no image) begins and ends while that ask is out: the page asks nothing more yet (one at a time)
    p.refresh(frame(entry(NEW, 'job.started', '2026-10-18T10:00:05.000Z'), ...before.log));
    p.refresh(frame(entry(NEW, 'job.ended', '2026-10-18T10:00:06.000Z'), entry(NEW, 'job.started', '2026-10-18T10:00:05.000Z'), ...before.log));
    expect(p.runAsks()).toHaveLength(1);
    // the answer comes back, read before the newer run was: it says no newer run
    p.runAsks()[0].answer(answer(0));
    await settle();
    expect(p.shownNewer()).toBe('0');
    // ... and the page asks again at once, for the frame it shows now (before R8: never, until another run began)
    expect(p.runAsks()).toHaveLength(2);
    p.runAsks()[1].answer(answer(1));
    await settle();
    expect(p.shownNewer()).toBe('1');
    expect(p.state()).toMatchObject({ asking: false, item: { op: OLD, newer: 1 } });
    expect(p.state().key).toBe(p.state().want);
    // nothing changed since: nothing more is asked
    await settle();
    expect(p.runAsks()).toHaveLength(2);
  });

  it('the newest run\'s later entry (its end) asks again: an answer read while it ran may be another once it has ended', async () => {
    const p = home();
    const old = entry(OLD, 'job.ended', '2026-10-18T10:00:00.000Z');
    const running = frame(entry(NEW, 'job.started', '2026-10-18T10:00:05.000Z'), old);
    p.refresh(running);
    expect(p.runAsks()).toHaveLength(1);
    // FAKE: what was read while the run ran (here the image of the run before, with no newer run counted yet)
    p.runAsks()[0].answer(answer(0));
    await settle();
    expect(p.shownNewer()).toBe('0');
    // the same frame drawn again asks nothing
    p.refresh(running);
    await settle();
    expect(p.runAsks()).toHaveLength(1);
    // the run ends: its end is the frame's newest entry now, and the page asks again (before R8: not while the run was the same)
    p.refresh(frame(entry(NEW, 'job.ended', '2026-10-18T10:00:06.000Z'), ...running.log));
    expect(p.runAsks()).toHaveLength(2);
    p.runAsks()[1].answer(answer(1));
    await settle();
    expect(p.shownNewer()).toBe('1');
  });

  it('frames that change while an ask is out make one ask after it, for the newest of them, not one each', async () => {
    const p = home();
    p.refresh(frame(entry(OLD, 'job.ended', '2026-10-18T10:00:00.000Z')));
    for (let i = 1; i <= 5; i++) p.refresh(frame(entry(NEW, `receipt.sealed`, `2026-10-18T10:00:0${i}.000Z`)));
    expect(p.runAsks()).toHaveLength(1);
    p.runAsks()[0].answer(answer(0));
    await settle();
    expect(p.runAsks()).toHaveLength(2);
    expect(p.state().want).toBe(`${NEW} receipt.sealed ${NEW}-receipt.sealed 2026-10-18T10:00:05.000Z`);
    p.runAsks()[1].answer(answer(1));
    await settle();
    expect(p.runAsks()).toHaveLength(2);
    expect(p.state().key).toBe(p.state().want);
  });
});
