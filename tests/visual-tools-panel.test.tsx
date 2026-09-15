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

  it('loads a bundled example without executing and exposes MCAP and MP4 actions', async () => {
    const onRun = vi.fn(async () => {});
    const view = render(<VisualToolsPanel active onRun={onRun} examplePaths={{ 'mcap-roundtrip': '/bundle/simulation.json' }} />);
    await tick();
    for (let n = 0; n < 4; n++) await input(view, '\x1b[B');
    await input(view, '\r');
    expect(view.lastFrame()).toContain('Record and replay');
    await input(view, '\x05');
    expect(view.lastFrame()).toContain('/bundle/simulation.json');
    expect(onRun).not.toHaveBeenCalled();
    await input(view, '\r');
    expect(onRun).toHaveBeenLastCalledWith('mcap-roundtrip', '/bundle/simulation.json');
    await input(view, '\x1b'); await input(view, '\x1b[B'); await input(view, '\r');
    expect(view.lastFrame()).toContain('Render MP4');
    await input(view, '/tmp/story.json'); await input(view, '\r');
    expect(onRun).toHaveBeenLastCalledWith('motion-mp4', '/tmp/story.json');
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
  it('shows Chafa output inline with explicit display-only status and a details toggle', async () => {
    const onRun = vi.fn(async () => {});
    const result: VisualToolRunState = { toolId: 'chafa-preview', status: 'completed', ansiPreview: '██  ░░', summary: 'Rendered PNG', artifactPath: '/tmp/preview.json' };
    const view = render(<VisualToolsPanel active onRun={onRun} runState={result} />);
    await tick(); await input(view, '\x1b[A'); await input(view, '\x1b[A'); await input(view, '\r');
    expect(view.lastFrame()).toContain('DISPLAY ONLY'); expect(view.lastFrame()).toContain('██  ░░');
    await input(view, '\x10'); expect(view.lastFrame()).toContain('PNG path'); expect(view.lastFrame()).toContain('Rendered PNG');
    expect(onRun).not.toHaveBeenCalled();
  });
  it('names cropped image rows in a short terminal', async () => {
    const result: VisualToolRunState = { toolId: 'chafa-preview', status: 'completed', ansiPreview: Array(10).fill('██').join('\n') };
    const view = render(<VisualToolsPanel active height={14} onRun={async () => {}} runState={result} />);
    await tick(); await input(view, '\x1b[A'); await input(view, '\x1b[A'); await input(view, '\r');
    expect(view.lastFrame()).toContain('CROPPED 4 ROWS');
    expect(view.lastFrame()).toContain('ENLARGE TERMINAL');
    expect(view.lastFrame()).toContain('Ctrl+P details');
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

  it('hides the previous completion and its open action when the input changes', async () => {
    const open = vi.fn();
    const state: VisualToolRunState = { toolId: 'camera-fit', status: 'completed', artifactPath: '/tmp/old.json', summary: 'Previous source' };
    const view = render(<VisualToolsPanel active onRun={async () => {}} runState={state} onOpenArtifact={open} />);
    await tick(); await input(view, '\r');
    expect(view.lastFrame()).toContain('Previous source');
    await input(view, '/tmp/new.json');
    expect(view.lastFrame()).not.toContain('Previous source');
    await input(view, '\x0f'); expect(open).not.toHaveBeenCalled();
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

  it('shows the host running state after remount instead of opening a cached completion', async () => {
    const open = vi.fn();
    const old: VisualToolRunState = { toolId: 'camera-fit', status: 'completed', artifactPath: '/tmp/old.json', summary: 'Previous source' };
    const onRun = vi.fn(async () => {});
    const view = render(<VisualToolsPanel active onRun={onRun} runStates={{ 'camera-fit': old }}
      runState={{ toolId: 'camera-fit', status: 'running' }} onOpenArtifact={open} />);
    await tick(); await input(view, '\r');
    expect(view.lastFrame()).toContain('RUNNING');
    expect(view.lastFrame()).not.toContain('Previous source');
    expect(view.lastFrame()).not.toContain('COMPLETED');
    await input(view, '\x0f'); await input(view, '\r');
    expect(open).not.toHaveBeenCalled(); expect(onRun).not.toHaveBeenCalled();
    view.rerender(<VisualToolsPanel active onRun={onRun} runStates={{ 'camera-fit': old }}
      runState={{ toolId: 'camera-fit', status: 'failed', summary: 'New failure' }} onOpenArtifact={open} />);
    await tick();
    expect(view.lastFrame()).toContain('New failure');
    expect(view.lastFrame()).not.toContain('Previous source');
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
