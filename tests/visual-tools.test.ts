import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runVisualTool, visualToolExamples } from '../src/utils/visual-tools.js';
import { shellOnKey, initialShell } from '../src/tui/shell-mode.js';
import { footerHintsShellShort } from '../src/tui/keymap.js';
import * as video from '../src/utils/visual-video.js';
import * as integrations from '../src/vision/integrations/runner.js';

const fixture = (name: string) => resolve('examples/visual-tools', name);
afterEach(() => vi.restoreAllMocks());
describe('real visual operation service', () => {
  it('resolves bundled examples outside the caller workspace', () => {
    const examples = visualToolExamples();
    expect(readFileSync(examples['motion-html']!, 'utf8')).toContain('timmy-visual-tools');
    expect(readFileSync(examples['mcap-roundtrip']!, 'utf8')).toContain('synthetic-interchange-example');
  });
  it('renders the supplied storyboard locally with a matching hash and no invented receipt', async () => {
    const result = await runVisualTool('motion-html', fixture('storyboard.json'));
    expect(result.status).toBe('completed');
    const body = readFileSync(result.artifactPath!, 'utf8');
    expect(body).toContain('window.__maTimeline');
    expect(body).toContain('Keep the unknowns visible.');
    expect(result.artifactHash).toBe(createHash('sha256').update(body).digest('hex'));
    expect(result.receiptId).toBeUndefined();
    expect(result.summary).toContain('No video rendered');
  });
  it('inspects the supplied parameter file and preserves unknown interior and units', async () => {
    const result = await runVisualTool('opensplat-inspect', fixture('parameters.ply'));
    expect(result.status).toBe('completed');
    const context = JSON.parse(readFileSync(result.artifactPath!, 'utf8'));
    expect(context.facts.find((f: any) => f.key === 'vertexCount').value).toBe(2);
    for (const key of ['interiorGeometry', 'physicalUnits', 'solidFill']) {
      expect(context.facts.find((f: any) => f.key === key)).toMatchObject({ value: null, epistemic: 'unknown' });
    }
    expect(result.receiptId).toBeUndefined();
  });
  it('exports OTLP as data without claiming transmission or a seal', async () => {
    const result = await runVisualTool('otlp-export');
    expect(result.status).toBe('completed');
    expect(JSON.parse(readFileSync(result.artifactPath!, 'utf8'))).toHaveProperty('resourceSpans');
    expect(result.summary).toContain('No telemetry sent');
    expect(result.receiptId).toBeUndefined();
  });
  it('refuses invalid, oversized, linked or out-of-bounds input without an output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-visual-input-'));
    const invalid = join(dir, 'invalid.json'); writeFileSync(invalid, '{"secret":"not a storyboard"}');
    const large = join(dir, 'large.json'); writeFileSync(large, 'x'.repeat(65537));
    const duplicate = join(dir, 'duplicate.json'); writeFileSync(duplicate, '{"id":"first","id":"last"}');
    const link = join(dir, 'link.json'); symlinkSync(invalid, link);
    const long = join(dir, 'long.json'); writeFileSync(long, JSON.stringify({ id: 'x', title: 'x', duration: 301, beats: [{ at: 0, dur: 301, label: 'x', text: 'x' }] }));
    for (const path of [invalid, large, duplicate, link, long, dir]) {
      const r = await runVisualTool('motion-html', path);
      expect(r.status).toBe('refused'); expect(r.artifactPath).toBeUndefined();
      expect(r.summary).not.toContain('secret');
    }
  });
  it('does not turn a camera probe into a fitting result or run an unknown operation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-visual-refuse-'));
    const path = join(dir, 'request.json'); writeFileSync(path, '{"operation":"probe"}');
    expect((await runVisualTool('camera-fit', path)).status).toBe('refused');
    expect((await runVisualTool('shell' as never, path)).status).toBe('refused');
    expect((await runVisualTool('motion-html', '')).status).toBe('refused');
  });
  it.each([
    ['camera-fit', 'camera-fit.json'], ['mcap-roundtrip', 'simulation.json'], ['motion-mp4', 'storyboard.json']
  ] as const)('reports %s persistence exceptions after invocation as failed, not refused', async (operation, name) => {
    const invoked = operation === 'motion-mp4' ? vi.spyOn(video, 'renderVisualVideo') : vi.spyOn(integrations, 'runIntegration');
    invoked.mockRejectedValueOnce(new Error('Could not retain result after execution'));
    const result = await runVisualTool(operation, fixture(name));
    expect(invoked).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('may have run');
    expect(result.receiptId).toBeUndefined();
  });
  it('makes Visual Tools discoverable only in Library normal mode', () => {
    const home = initialShell();
    expect(shellOnKey(home, 'V').actions).not.toContain('open-visual-tools');
    const library = shellOnKey(home, '4').state;
    expect(shellOnKey(library, 'V').actions).toEqual(['open-visual-tools']);
    expect(footerHintsShellShort('NORMAL', 'LIBRARY')).toContain('[V] visual tools');
    expect(shellOnKey({ ...library, mode: 'INSERT' }, 'V').actions).not.toContain('open-visual-tools');
  });
});
