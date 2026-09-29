import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BRAND } from '../src/utils/brand.js';
import { defaultStoryboard, loadTemplate, saveTemplate, listTemplates, templatesDir } from '../src/utils/templates.js';
import { renderDashboardHtml } from '../src/utils/dash.js';
import { recordGeneration, parseCostFromLog, aggregateGenerations } from '../src/utils/generations.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-studios-'));
});

describe('brand system', () => {
  it('centralizes product names so a rename is one file', () => {
    expect(BRAND.umbrella).toBe('TIMMY');
    expect(BRAND.studios).toBe('TIMMY Studios');
    expect(BRAND.slate).toBe('TIMMY Slate');
    expect(BRAND.tagline).toMatch(/Receipts/);
  });
});

describe('TIMMY Slate templates', () => {
  it('seeds the default storyboard and interpolates {brief}', () => {
    const t = loadTemplate('storyboard', 'launch sting', dir);
    expect(t.beats).toHaveLength(5);
    expect(t.beats[1].text).toBe('launch sting');
    expect(existsSync(join(templatesDir(dir), 'storyboard.json'))).toBe(true);
  });

  it('round-trips agent-authored templates and lists them', () => {
    saveTemplate({ name: 'confessional', total: 8, source: 'agent:test', beats: [{ at: 0, dur: 8, label: 'TALK', text: '{brief}' }] }, dir);
    expect(listTemplates(dir)).toContain('confessional');
    const t = loadTemplate('confessional', 'hi', dir);
    expect(t.source).toBe('agent:test');
    expect(t.total).toBe(8);
    expect(t.beats[0].text).toBe('hi');
  });

  it('falls back to the default on missing templates', () => {
    expect(loadTemplate('nope', 'x', dir).beats).toHaveLength(defaultStoryboard().beats.length);
  });
});

describe('Studios dashboard', () => {
  it('renders branded self-contained html wired to ledger + events + fleet', () => {
    const html = renderDashboardHtml(dir);
    expect(html).toContain('TIMMY Studios');
    expect(html).toContain('TIMMY Slate');
    expect(html).toContain('/.timmy/generations.json');
    expect(html).toContain('/.timmy/runs/events.jsonl');
    expect(html).toContain('nano-banana-2');
    expect(html).toContain('setInterval(refresh,5000)');
  });
});

describe('prompt & result DB', () => {
  it('parses costs and aggregates per provider/model with timestamps', () => {
    expect(parseCostFromLog('done — $0.22 total')).toBe(0.22);
    expect(parseCostFromLog('no money here')).toBeUndefined();
    recordGeneration({ prompt: 'a', provider: 'seedance-2-0', model: 'bytedance/seedance-2.0', kind: 'video', transport: 'openrouter', status: 'done', cost_usd: 0.22 }, dir);
    recordGeneration({ prompt: 'b', provider: 'seedance-2-0', model: 'bytedance/seedance-2.0', kind: 'video', transport: 'openrouter', status: 'failed' }, dir);
    recordGeneration({ prompt: 'c', provider: 'nano-banana-2', kind: 'image', transport: 'openrouter', status: 'done', cost_usd: 0.07 }, dir);
    const stats = aggregateGenerations(undefined, dir);
    expect(stats).toHaveLength(2);
    const sd = stats.find(s => s.provider === 'seedance-2-0')!;
    expect(sd.total).toBe(2);
    expect(sd.done).toBe(1);
    expect(sd.failed).toBe(1);
    expect(sd.cost).toBeCloseTo(0.22);
    expect(sd.models['bytedance/seedance-2.0']).toBe(2);
    expect(sd.last_at).toMatch(/^\d{4}-/);
    expect(aggregateGenerations('nano', dir)).toHaveLength(1);
  });

  it('counts declared-unknown costs separately instead of summing them', () => {
    recordGeneration({ prompt: 'live', provider: 'higgsfield', kind: 'image', transport: 'higgsfield', status: 'done', cost_usd: 0, cost_measured: false }, dir);
    recordGeneration({ prompt: 'stub', provider: 'higgsfield', kind: 'image', transport: 'higgsfield', status: 'done', cost_usd: 0, cost_measured: true }, dir);
    const stats = aggregateGenerations('higgsfield', dir);
    expect(stats).toHaveLength(1);
    expect(stats[0].cost).toBe(0);                    // placeholder never summed
    expect(stats[0].declared_unknown).toBe(1);        // counted separately
  });

  it('writes a timestamped jsonl event trail', () => {
    const rec = recordGeneration({ prompt: 'x', provider: 'wan-2-7', kind: 'video', transport: 'openrouter', status: 'queued' }, dir);
    const events = readFileSync(join(dir, '.timmy', 'runs', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(events.some((e: any) => e.genId === rec.id && e.event === 'recorded')).toBe(true);
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
