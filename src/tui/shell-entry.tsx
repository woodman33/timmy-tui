import React from 'react';
import { render } from 'ink';
import { ShellV2 } from './components/ShellV2.js';

// BOOT (opentui-u4e9): HOME assembles from the light shell entry (ShellV2 +
// keymap/modes/bus only). The full App (agent graph, telemetry, onboarding)
// lazy-loads: onboarding when not completed, agent on first chat send.
export function startShellV2(config: unknown, graphics: string): void {
  const cfg = config as { onboarded?: boolean } | null;
  if (!cfg || cfg.onboarded !== true) {
    void import('./app.js').then(m => m.startTUI(config as never, 'brief', graphics));
    return;
  }
  render(React.createElement(ShellV2, { width: process.stdout.columns ?? 120, config }));
}
