import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { VisualToolsPanel, type VisualToolRunState } from '../src/tui/components/VisualToolsPanel.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 30));
async function input(view: ReturnType<typeof render>, value: string) { view.stdin.write(value); await tick(); }
afterEach(cleanup);

describe('Visual tools action panel', () => {
  it('requires detail and explicit Run after path entry, and blocks duplicate starts', async () => {
    let finish!: () => void;
    const onRun = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = render(<VisualToolsPanel active onRun={onRun} />);
    await tick();
    expect(view.lastFrame()).toContain('Camera alignment');
    await input(view, '\r');
    expect(view.lastFrame()).toContain('Request JSON path');
    expect(onRun).not.toHaveBeenCalled();
    await input(view, '\r');
    expect(view.lastFrame()).toContain('Enter one local file path first');
    await input(view, '/tmp/camera request.json');
    await input(view, '\r');
    expect(onRun).toHaveBeenCalledExactlyOnceWith('camera-fit', '/tmp/camera request.json');
    expect(view.lastFrame()).toContain('RUNNING');
    await input(view, '\r');
    expect(onRun).toHaveBeenCalledTimes(1);
    finish(); await tick();
  });

  it('selects Gaussian inspection and permits pasted paths and backspace', async () => {
    const onRun = vi.fn(async () => {});
    const view = render(<VisualToolsPanel active onRun={onRun} />);
    await tick(); await input(view, '\x1b[B'); await input(view, '\r');
    await input(view, '/tmp/cloud.plyx'); await input(view, '\x7f'); await input(view, '\r');
    expect(onRun).toHaveBeenCalledExactlyOnceWith('opensplat-inspect', '/tmp/cloud.ply');
  });

  it('exposes Motion HTML and Telemetry as distinct fixed actions', async () => {
    const onRun = vi.fn(async () => {});
    const view = render(<VisualToolsPanel active onRun={onRun} />);
    await tick(); await input(view, '\x1b[B'); await input(view, '\x1b[B'); await input(view, '\r');
    expect(view.lastFrame()).toContain('Create preview');
    await input(view, '/tmp/story.json'); await input(view, '\r');
    expect(onRun).toHaveBeenLastCalledWith('motion-html', '/tmp/story.json');
    await input(view, '\x1b'); await input(view, '\x1b[B'); await input(view, '\r');
    expect(view.lastFrame()).toContain('Export OTLP');
    await input(view, '\r');
    expect(onRun).toHaveBeenLastCalledWith('otlp-export', undefined);
  });

  it('leaves dmux catalog-only even when available', async () => {
    const onRun = vi.fn(async () => {});
    const view = render(<VisualToolsPanel active onRun={onRun} availability={{ dmux: 'available' }} />);
    await tick(); await input(view, '\x1b[A'); await input(view, '\r');
    expect(view.lastFrame()).toContain('CATALOG ONLY');
    expect(view.lastFrame()).toContain('available');
    await input(view, '\r');
    expect(onRun).not.toHaveBeenCalled();
  });

  it('distinguishes completion from verification and opens only the host-provided artifact', async () => {
    const state: VisualToolRunState = { toolId: 'camera-fit', status: 'completed', summary: 'Pose reconstructed.',
      artifactPath: '/tmp/pose.json', receiptId: 'rc_test_pose' };
    const open = vi.fn();
    const view = render(<VisualToolsPanel active onRun={async () => {}} runState={state} onOpenArtifact={open} />);
    await tick(); await input(view, '\r');
    expect(view.lastFrame()).toContain('COMPLETED');
    expect(view.lastFrame()).toContain('Completion is not geometry verification');
    expect(view.lastFrame()).toContain('rc_test_pose');
    await input(view, '\x0f');
    expect(open).toHaveBeenCalledExactlyOnceWith('/tmp/pose.json');
    view.rerender(<VisualToolsPanel active onRun={async () => {}} runState={{ ...state, status: 'refused', summary: 'Stale revision.' }} />);
    await tick();
    expect(view.lastFrame()).toContain('REFUSED');
    expect(view.lastFrame()).not.toContain('Completion is not geometry verification');
  });

  it('does not consume inactive keys, and Esc returns to the host only from the list', async () => {
    const onRun = vi.fn(async () => {}); const onBack = vi.fn();
    const view = render(<VisualToolsPanel active={false} onRun={onRun} onBack={onBack} />);
    await tick(); await input(view, '\r'); await input(view, '\x1b');
    expect(onRun).not.toHaveBeenCalled(); expect(onBack).not.toHaveBeenCalled();
    view.rerender(<VisualToolsPanel active onRun={onRun} onBack={onBack} />);
    await tick(); await input(view, '\r'); await input(view, '\x1b');
    expect(onBack).not.toHaveBeenCalled();
    await input(view, '\x1b'); expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('refuses missing runtimes and multiline input without running', async () => {
    const onRun = vi.fn(async () => {});
    const view = render(<VisualToolsPanel active onRun={onRun} availability={{ 'camera-fit': 'not-installed' }} />);
    await tick(); await input(view, '\r'); await input(view, '/tmp/input.json'); await input(view, '\r');
    expect(view.lastFrame()).toContain('Unavailable');
    expect(onRun).not.toHaveBeenCalled();
    view.rerender(<VisualToolsPanel active onRun={onRun} />);
    await tick(); await input(view, '/bad\npath');
    expect(view.lastFrame()).toContain('multiline or control input was refused');
    expect(onRun).not.toHaveBeenCalled();
  });
});
