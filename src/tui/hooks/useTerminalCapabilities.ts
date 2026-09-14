import { useState, useEffect } from 'react';
import { detectCapabilities } from '../../graphics/capabilities.js';
import type { GraphicsCapabilities } from '../../types/index.js';

export interface TerminalCapState {
  capabilities: GraphicsCapabilities;
  detected: boolean;
}

export function useTerminalCapabilities(enabled = true): TerminalCapState {
  const [state, setState] = useState<TerminalCapState>({
    capabilities: {
      kittyGraphics: false,
      iterm2Images: false,
      sixel: false,
      trueColor: false,
      mouseEvents: false,
      cellSize: { width: 8, height: 16 },
      program: 'unknown',
    },
    detected: false,
  });

  useEffect(() => {
    if (!enabled) return; // BOOT: probe after first frame
    detectCapabilities().then(caps => {
      setState({ capabilities: caps, detected: true });
    });
  }, []);

  return state;
}
