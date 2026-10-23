import {
  currentTimeTool,
  calculatorTool,
  systemInfoTool,
  envTool,
  stressTestTool,
  browserOpenTool,
  browserSnapshotTool,
  browserClickTool,
  browserScreenshotTool,
  daytonaWorkspaceTool,
  triggerJobTool,
  composioIntegrationTool,
  cloudflareGetFeatureFlagTool
} from '../agent/tools.js';
import { summarizeTool } from './chat/tools.js';
import {
  diffTool,
  lintTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  grepTool,
  globTool,
  shellTool
} from './code-review/tools.js';

export interface Mode {
  id: string;
  name: string;
  icon: string;
  description: string;
  tools: string[];
  riveStates: {
    idle: string;
    thinking: string;
    streaming: string;
    tool_call: string;
    error: string;
    success: string;
  };
}

export const BUILT_IN_MODES: Record<string, Mode> = {
  chat: {
    id: 'chat',
    name: 'Chat',
    icon: '💬',
    description: 'Conversational agent with streaming and tool use',
    tools: [
      'get_current_time', 'calculate', 'get_system_info', 'get_env', 'summarize',
      'run_in_daytona_workspace', 'trigger_background_workflow', 'manage_composio_integrations',
      'cloudflare_get_feature_flag'
    ],
    riveStates: {
      idle: 'idle', thinking: 'thinking', streaming: 'talking',
      tool_call: 'wrench', error: 'error', success: 'success',
    },
  },
  'code-review': {
    id: 'code-review',
    name: 'Code Review',
    icon: '🔍',
    description: 'Analyze diffs, suggest fixes, run tests',
    tools: ['get_current_time', 'get_git_diff', 'run_linter', 'file_read', 'file_write', 'file_edit', 'grep', 'glob', 'shell'],
    riveStates: {
      idle: 'idle', thinking: 'analyzing', streaming: 'reviewing',
      tool_call: 'wrench', error: 'error', success: 'done',
    },
  },
  dashboard: {
    id: 'dashboard',
    name: 'Dashboard',
    icon: '📊',
    description: 'Multi-panel overview: agents, models, resources',
    tools: [],
    riveStates: {
      idle: 'idle', thinking: 'calculating', streaming: 'displaying',
      tool_call: 'wrench', error: 'error', success: 'done',
    },
  },
  'model-explorer': {
    id: 'model-explorer',
    name: 'Model Explorer',
    icon: '🧠',
    description: 'Browse OpenRouter models, compare, select',
    tools: ['get_current_time', 'calculate'],
    riveStates: {
      idle: 'idle', thinking: 'searching', streaming: 'listing',
      tool_call: 'wrench', error: 'error', success: 'done',
    },
  },
  workspace: {
    id: 'workspace',
    name: 'Workspace',
    icon: '🖥️',
    description: 'Multi-panel hyper-grid coordinates background tmux session clusters',
    tools: ['get_current_time', 'calculate'],
    riveStates: {
      idle: 'idle', thinking: 'searching', streaming: 'listing',
      tool_call: 'wrench', error: 'error', success: 'done',
    },
  },
};

export function getMode(id: string): Mode | undefined {
  return BUILT_IN_MODES[id];
}

export function listModes(): Mode[] {
  return Object.values(BUILT_IN_MODES);
}

export function resolveToolsForMode(modeId: string): any[] {
  switch (modeId) {
    case 'chat':
      return [
        currentTimeTool,
        calculatorTool,
        systemInfoTool,
        envTool,
        summarizeTool,
        stressTestTool,
        browserOpenTool,
        browserSnapshotTool,
        browserClickTool,
        browserScreenshotTool,
        daytonaWorkspaceTool,
        triggerJobTool,
        composioIntegrationTool,
        cloudflareGetFeatureFlagTool
        // R11 (H169, Phase 0 item 4): cloudflare_send_durable_pulse is opt-in (TIMMY_TOOLS_OPT_IN), in no mode's default list
      ];
    case 'code-review':
      return [
        currentTimeTool,
        diffTool,
        lintTool,
        readFileTool,
        writeFileTool,
        editFileTool,
        grepTool,
        globTool,
        shellTool,
        stressTestTool,
        browserOpenTool,
        browserSnapshotTool,
        browserClickTool,
        browserScreenshotTool
      ];
    case 'dashboard':
      return [];
    case 'model-explorer':
      return [currentTimeTool, calculatorTool];
    case 'workspace':
      return [currentTimeTool, calculatorTool];
    default:
      return [currentTimeTool, calculatorTool];
  }
}
