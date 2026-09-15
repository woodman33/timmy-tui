import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { renderStudioComposition, type StudioComposition } from '../src/utils/studio-composition.js';

const source: StudioComposition = {
  id: 'timmy-clock', title: 'Clock', duration: 3,
  beats: [
    { at: 0, dur: 1, label: 'PREDICTION', text: 'A claim' },
    { at: 2, dur: 1, label: 'EVIDENCE', text: 'An observation' }
  ]
};

function loadTimeline(reduced = false, composition = source) {
  const animations = composition.beats.map(() => ({ currentTime: 0, paused: false,
    pause() { this.paused = true; }, play() { this.paused = false; } }));
  const clips = composition.beats.map(beat => ({
    dataset: { start: String(beat.at), duration: String(beat.dur) },
    style: { opacity: '', removeProperty() { this.opacity = ''; } }
  }));
  const otherTimeline = { retained: true };
  const window: any = { __timelines: { other: otherTimeline }, matchMedia: () => ({ matches: reduced }) };
  const stage = { querySelectorAll: () => clips, getAnimations: () => animations };
  const document = { getElementById: () => stage };
  const html = renderStudioComposition(composition);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, { window, document });
  return { window, timeline: window.__timelines[composition.id], animations, clips, otherTimeline };
}

describe('studio composition projection', () => {
  it('produces byte-identical source without mutating the storyboard', () => {
    const before = JSON.stringify(source);
    expect(renderStudioComposition(source)).toBe(renderStudioComposition(source));
    expect(JSON.stringify(source)).toBe(before);
    const html = renderStudioComposition(source);
    expect(html).toContain('data-start="2" data-duration="1"');
    expect(html).toContain('data-width="1920" data-height="1080"');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
  });

  it('escapes authored labels, text, title and composition IDs in their respective contexts', () => {
    const injection = '</script><img src=x onerror="attack()">';
    const html = renderStudioComposition({ ...source, id: injection, title: injection,
      beats: [{ ...source.beats[0], label: injection, text: injection }] });
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=&quot;attack()&quot;&gt;');
    expect(html).toContain('window.__timelines["\\u003c/script>');
  });

  it('rejects invalid time spans instead of silently changing source timing', () => {
    expect(() => renderStudioComposition({ ...source, duration: NaN })).toThrow();
    expect(() => renderStudioComposition({ ...source, width: 1.5 })).toThrow();
    for (const beat of [{ ...source.beats[0], dur: 0 }, { ...source.beats[0], at: -1 },
      { ...source.beats[0], at: 3, dur: 1 }]) {
      expect(() => renderStudioComposition({ ...source, beats: [beat] })).toThrow();
    }
  });

  it('accepts bounded visual tokens without changing the storyboard', () => {
    const html = renderStudioComposition({ ...source, appearance: {
      background: '#000000', text: '#FFFFFF', label: '#8A8A8A',
      fontFamilies: ['Avenir', 'Avenir Next', 'system-ui'], headlinePx: 72, labelPx: 24
    } });
    expect(html).toContain('background:#000000;color:#FFFFFF;font:14px/1.5 "Avenir","Avenir Next",system-ui');
    expect(html).toContain('.label{color:#8A8A8A;letter-spacing:.3em;font-size:24px}');
    expect(html).toContain('h1{margin:0;color:#FFFFFF;font-size:72px');
    expect(html).toContain('data-start="2" data-duration="1"');
  });

  it('refuses CSS injection and out-of-bounds appearance values', () => {
    for (const appearance of [
      { background: '#000; background:url(https://example.invalid)' },
      { text: '</style><script>attack()</script>' },
      { fontFamilies: ['Avenir"; color:red'] },
      { fontFamilies: [] },
      { headlinePx: 241 },
      { labelPx: NaN }
    ]) expect(() => renderStudioComposition({ ...source, appearance })).toThrow();
  });
});

describe('explicit studio clock', () => {
  it('uses the installed HyperFrames registry contract and preserves other timelines', () => {
    const { timeline, window, otherTimeline, animations } = loadTimeline();
    expect(timeline.duration()).toBe(3);
    expect(timeline.totalDuration()).toBe(3);
    expect(window.__maTimeline).toBe(timeline);
    expect(window.__timelines.other).toBe(otherTimeline);
    expect(window.__hf).toBeUndefined();
    expect(animations.every(a => !a.paused)).toBe(true); // Existing standalone CSS preview still plays.
  });

  it('seeks absolutely, pauses, and returns to the same time after out-of-order requests', () => {
    const { timeline, animations } = loadTimeline();
    for (const second of [0.5, 2.5, 0.5]) {
      timeline.seek(second, false);
      expect(animations.map(a => a.currentTime)).toEqual([second * 1000, second * 1000]);
      expect(animations.every(a => a.paused)).toBe(true);
      expect(timeline.totalTime()).toBe(second);
    }
    timeline.play();
    expect(animations.every(a => !a.paused)).toBe(true);
    timeline.pause();
    expect(animations.every(a => a.paused)).toBe(true);
  });

  it('clamps finite seeks and rejects invalid times before changing the clock', () => {
    const { timeline, animations } = loadTimeline();
    timeline.seek(-1);
    expect(timeline.time()).toBe(0);
    timeline.totalTime(100);
    expect(timeline.time()).toBe(3);
    expect(() => timeline.seek(NaN)).toThrow('finite seconds');
    expect(animations.map(a => a.currentTime)).toEqual([3000, 3000]);
  });

  it('reduces motion to static cuts without filling storyboard gaps or merging beats', () => {
    const { timeline, clips } = loadTimeline(true);
    const opacity = () => clips.map(c => c.style.opacity);
    timeline.seek(0.5);
    expect(opacity()).toEqual(['1', '0']);
    timeline.seek(1.5);
    expect(opacity()).toEqual(['0', '0']);
    timeline.seek(2.5);
    expect(opacity()).toEqual(['0', '1']);
    timeline.seek(3);
    expect(opacity()).toEqual(['0', '0']);
  });

  it('does not display a delayed first beat prematurely in reduced-motion mode', () => {
    const delayed = { ...source, beats: [{ at: 1, dur: 1, label: 'LATER', text: 'Wait for the beat' }] };
    const { timeline, clips } = loadTimeline(true, delayed);
    expect(clips[0].style.opacity).toBe('0');
    timeline.seek(1);
    expect(clips[0].style.opacity).toBe('1');
    expect(renderStudioComposition(delayed)).not.toContain('.clip:first-child');
  });
});

const browserPath = existsSync(chromium.executablePath()) ? chromium.executablePath()
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

it.skipIf(!existsSync(browserPath))('matches static frame oracles after the HyperFrames CSS adapter applies its clock', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  try {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, offline: true });
    await context.route('**/*', route => route.abort());
    const animated = await context.newPage();
    const oracle = await context.newPage();
    const html = renderStudioComposition(source);
    await animated.setContent(html);
    await oracle.setContent(html);
    await Promise.all([animated, oracle].map(page => page.evaluate(() => document.fonts.ready)));
    for (const [seconds, visibleIndex, doubleOffset] of [[0.5, 0, false], [2.5, 1, false], [0.5, 0, false], [1.5, -1, false], [2.5, 1, true]] as const) {
      if (doubleOffset) {
        // Reproduce the original source's dual ownership as a negative control.
        await animated.evaluate(() => document.querySelectorAll<HTMLElement>('.motion').forEach(motion => {
          motion.dataset.start = (motion.parentElement as HTMLElement).dataset.start;
        }));
      }
      await animated.evaluate(time => {
        (window as any).__maTimeline.seek(time);
        // Installed HyperFrames 0.8.30 adapters/css: animation currentTime is
        // global seconds minus the animated element's own resolved data-start.
        // These root-composition fixtures have no referenced or nested starts.
        document.querySelectorAll<HTMLElement>('*').forEach(element => {
          if (getComputedStyle(element).animationName === 'none') return;
          const localMs = Math.max(0, time - Number(element.dataset.start || 0)) * 1000;
          element.getAnimations().forEach(animation => {
            animation.currentTime = localMs;
            animation.pause();
          });
        });
      }, seconds);
      await oracle.evaluate(index => {
        // Static oracle: choose the fixture's expected beat directly. It never
        // reads a timeline, start, duration, animation delay, or seek result.
        document.querySelectorAll<HTMLElement>('.clip').forEach((clip, i) => {
          clip.style.animation = 'none';
          clip.style.opacity = i === index ? '1' : '0';
          clip.querySelectorAll<HTMLElement>('.motion').forEach(motion => {
            motion.style.animation = 'none';
            motion.style.opacity = '1';
          });
        });
      }, visibleIndex);
      const diagnostics = await animated.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.clip')).map(clip => ({
        opacity: getComputedStyle(clip).opacity,
        motion: clip.querySelector('.motion') ? getComputedStyle(clip.querySelector('.motion')!).opacity : null,
        animations: clip.getAnimations({subtree:true}).map(a => ({ time: a.currentTime, timing: a.effect?.getComputedTiming() }))
      })));
      const frames = [await animated.screenshot(), await oracle.screenshot()].map(buffer => buffer.toString('base64'));
      const comparison = await oracle.evaluate(async encoded => {
        const decoded = await Promise.all(encoded.map(base64 => new Promise<ImageData>(resolve => {
          const image = new Image();
          image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            resolve(context.getImageData(0, 0, image.width, image.height));
          };
          image.src = 'data:image/png;base64,' + base64;
        })));
        const [a, b] = decoded.map(image => image.data);
        let delta = 0; let foreground = 0;
        for (let i = 0; i < a.length; i += 4) {
          if ([0, 1, 2].some(channel => a[i + channel] !== b[channel] || b[i + channel] !== b[channel])) {
            foreground++;
            for (let channel = 0; channel < 3; channel++) delta += Math.abs(a[i + channel] - b[i + channel]);
          }
        }
        return { foreground, meanChannelError: foreground ? delta / (foreground * 3) : 0 };
      }, frames);
      // CSS opacity animation may use different text antialiasing from static
      // text; compare foreground pixels rather than treating PNG bytes as truth.
      const assertion = expect(comparison.meanChannelError, `static oracle at ${seconds}s ${JSON.stringify({ doubleOffset, diagnostics, comparison })}`);
      if (doubleOffset) assertion.toBeGreaterThan(20);
      else assertion.toBeLessThan(3);
    }
  } finally { await browser.close(); }
}, 20000);
