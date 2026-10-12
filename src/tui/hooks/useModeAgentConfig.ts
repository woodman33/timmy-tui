import React, { useEffect } from 'react';
import type { Agent } from '../../agent/core.js';
import type { AgentConfig } from '../../types/index.js';
import { BUILT_IN_MODES, resolveToolsForMode } from '../../modes/index.js';
import { gateTools } from '../../repl/approvals.js';

interface UseModeAgentConfigProps {
  agent: Agent;
  mode: string;
  config: AgentConfig;
}

export function useModeAgentConfig({
  agent,
  mode,
  config,
  enabled = true
}: UseModeAgentConfigProps & { enabled?: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    try {
      const modeConfig = (BUILT_IN_MODES as any)[mode];
      if (modeConfig) {
        const baseInstructions = config.instructions || '';
        const modeInstructions = `${baseInstructions}\n\n[MODE CONTEXT] You are running in ${modeConfig.name} mode. ${modeConfig.description}. Only use tools registered for your mode.`;
        agent.setInstructions(modeInstructions);

        const activeTools = resolveToolsForMode(mode as any);
        // R4 lead (H103's finding): this legacy shell (TIMMY_SHELL=v1) cannot show the NEEDS YOU box, so a tool that needs a
        // person is refused here, as the board refuses a risky Run; before, these tools ran unasked (one runs shell commands)
        agent.setTools(gateTools(activeTools, async () => 'deny'));
      }
    } catch {
      // Guard silently to never crash the TUI on configuration changes
    }
  }, [mode, agent, config, enabled]);
}
