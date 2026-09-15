import { theme } from '../tui/theme.js';
import type { TemplateBeat } from './templates.js';

export interface StudioComposition {
  id: string;
  title: string;
  duration: number;
  beats: TemplateBeat[];
  width?: number;
  height?: number;
  appearance?: {
    background?: string;
    text?: string;
    label?: string;
    fontFamilies?: string[];
    headlinePx?: number;
    labelPx?: number;
  };
}

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Pure /studio source projection. It neither starts a renderer nor seals a receipt. */
export function renderStudioComposition(input: StudioComposition): string {
  const { id, title, duration, beats } = input;
  const width = input.width ?? 1920;
  const height = input.height ?? 1080;
  const appearance = input.appearance ?? {};
  const color = (value: string | undefined, fallback: string): string => {
    if (value === undefined) return fallback;
    if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) {
      throw new Error('Studio appearance colors must be hex colors');
    }
    return value;
  };
  const pixels = (value: number | undefined, fallback: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 8 || value > max) {
      throw new Error(`Studio appearance font size must be between 8 and ${max}px`);
    }
    return value;
  };
  let fontFamilies = 'ui-monospace,Menlo,Consolas,monospace';
  if (appearance.fontFamilies !== undefined) {
    if (!Array.isArray(appearance.fontFamilies) || !appearance.fontFamilies.length
      || appearance.fontFamilies.length > 8
      || appearance.fontFamilies.some(name => !/^[a-z\d _-]{1,80}$/i.test(name))) {
      throw new Error('Studio appearance requires 1–8 plain font family names');
    }
    const generic = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'cursive', 'fantasy']);
    fontFamilies = appearance.fontFamilies.map(name => generic.has(name) ? name : JSON.stringify(name)).join(',');
  }
  const background = color(appearance.background, theme.ground);
  const bodyText = color(appearance.text, theme.textPrimary);
  const headlineText = color(appearance.text, theme.accent);
  const labelColor = color(appearance.label, theme.accent);
  const headlinePx = pixels(appearance.headlinePx, 28, 240);
  const labelPx = pixels(appearance.labelPx, 12, 96);
  if (!id || !Number.isFinite(duration) || duration <= 0
    || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Studio composition requires an id, positive duration, and positive integer dimensions');
  }
  for (const beat of beats) {
    if (!Number.isFinite(beat.at) || beat.at < 0 || !Number.isFinite(beat.dur) || beat.dur <= 0
      || beat.at + beat.dur > duration + 1e-9) {
      throw new Error('Studio beat must have positive duration and remain inside the composition');
    }
  }
  const clips = beats.map((beat, i) =>
    `  <div id="beat-${i}" class="clip" data-start="${beat.at}" data-duration="${beat.dur}" data-track-index="${i}">`
    + `<div class="motion" style="--at:${beat.at}s;--dur:${beat.dur}s"><span class="label">${escapeHtml(beat.label)}</span><h1>${escapeHtml(beat.text)}</h1></div></div>`
  ).join('\n');
  // JSON is embedded as script source, so HTML escaping alone is insufficient.
  const scriptId = JSON.stringify(id).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>TIMMY Studios — ${escapeHtml(title)}</title>
<style>
html,body,*{text-rendering:geometricPrecision}
body{margin:0;background:${background};color:${bodyText};font:14px/1.5 ${fontFamilies};overflow:hidden}
#stage{position:relative;width:100vw;height:100vh}
.clip{position:absolute;inset:0}
.motion{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;opacity:0;animation:beat var(--dur) linear var(--at) forwards}
.label{color:${labelColor};letter-spacing:.3em;font-size:${labelPx}px}
h1{margin:0;color:${headlineText};font-size:${headlinePx}px;text-align:center;max-width:80%}
@keyframes beat{0%{opacity:0}12%{opacity:1}88%{opacity:1}100%{opacity:0}}
@media(prefers-reduced-motion:reduce){.clip{opacity:0}.clip[data-start="0"]{opacity:1}.motion{animation:none;opacity:1}}
</style>
</head>
<body>
<div id="stage" data-composition-id="${escapeHtml(id)}" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
${clips}
</div>
<script>
(function () {
  var stage = document.getElementById('stage');
  var clips = Array.from(stage.querySelectorAll('.clip'));
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var currentSeconds = 0;
  function animations() { return stage.getAnimations({subtree:true}); }
  function pause() { animations().forEach(function (a) { a.pause(); }); return timeline; }
  function seek(seconds) {
    if (seconds === undefined) return currentSeconds;
    if (!Number.isFinite(seconds)) throw new TypeError('Studio seek requires finite seconds');
    currentSeconds = Math.max(0, Math.min(${duration}, seconds));
    // The animated child has no data-start: HyperFrames's CSS adapter therefore
    // also seeks it in composition time. Putting both data-start and CSS delay
    // on one element would apply the start offset twice and blank later beats.
    animations().forEach(function (a) { a.pause(); a.currentTime = currentSeconds * 1000; });
    // Reduced motion preserves the requested beat as a static cut, including gaps.
    clips.forEach(function (clip) {
      if (reducedMotion.matches) {
        var start = Number(clip.dataset.start);
        var end = start + Number(clip.dataset.duration);
        clip.style.opacity = currentSeconds >= start && currentSeconds < end ? '1' : '0';
      } else { clip.style.removeProperty('opacity'); }
    });
    return timeline;
  }
  // HyperFrames 0.8.30 consumes the timeline registry (duration/seek), not __hf.
  // The same explicit clock can drive local screenshots or motion-anything capture.
  var timeline = {
    duration: function () { return ${duration}; },
    totalDuration: function () { return ${duration}; },
    seek: seek,
    time: seek,
    totalTime: seek,
    pause: pause,
    play: function () { animations().forEach(function (a) { a.play(); }); return timeline; }
  };
  window.__timelines = window.__timelines || {};
  window.__timelines[${scriptId}] = timeline;
  window.__maTimeline = timeline;
  if (reducedMotion.matches) seek(0);
})();
</script>
</body>
</html>
`;
}
