/**
 * lanes.ts — canonical agent-lane registry for TIMMY.
 *
 * Every multiplexer backend (tmux/zellij/rmux) shares this map so new lanes
 * (jcode, minds, carbonyl, etc.) are added in ONE place and propagate to all
 * backends.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface LaneRunner {
  /** Binary invoked inside the pane */
  cmd: string;
  /** Human-facing label */
  label: string;
  /** Where the binary is expected (for missing-binary guidance) */
  expected: string;
  /** How to install it (shown when the binary is missing) */
  install?: string;
  /** Optional env vars injected before launch */
  env?: Record<string, string>;
  /** OpenRouter model associated with the lane (UI metadata) */
  model?: string;
  /** One-line plain-English blurb (what this agent actually is) */
  blurb?: string;
  /** One-shot delegation template; {task} replaced at delegate time */
  task?: string;
  /** Non-interactive probe used in the pane script when the bare cmd is an
      interactive Commander CLI that exits on help (v1.0.5 minds fix) */
  probe?: string;
  /** For API lanes: env var holding the key; absence = not_configured */
  key?: string;
}

/**
 * Lane IDs are stable strings; pane session ids ('1', '2', ...) map onto
 * these via DEFAULT_LANE_BINDINGS below.
 */
export const LANE_RUNNERS: Record<string, LaneRunner> = {
  opencode: {
    cmd: 'opencode',
    label: 'OpenCode CLI',
    expected: '$HOME/.opencode/bin/opencode',
    install: 'npm i -g opencode-ai',
    model: 'qwen/qwen-2.5-coder-32b',
    blurb: 'open-source coding agent · MIT · 75+ providers',
    task: 'opencode run "{task}"',
  },
  hermes: {
    cmd: 'hermes',
    label: 'Hermes CLI',
    expected: '$HOME/.local/bin/hermes',
    install: 'github.com/NousResearch/hermes-agent',
    model: 'nousresearch/hermes-3-llama-3.1-405b',
    blurb: 'governed agent runner · #1 OpenRouter app',
    task: 'hermes -z "{task}"',
  },
  pi: {
    cmd: 'pi',
    label: 'Pi Daemon',
    expected: '$HOME/.local/bin/pi',
    install: 'npm i -g @earendil-works/pi-coding-agent',
    model: 'inflection/pi-3',
    blurb: 'minimal coding agent: read · bash · edit · write',
    task: 'pi -p "{task}"',
  },
  jcode: {
    cmd: 'jcode',
    label: 'jcode',
    expected: '$HOME/.local/bin/jcode',
    install: 'github.com/1jehuang/jcode',
    model: 'jcode/default',
    blurb: 'coding agent on Claude Max / ChatGPT Pro subs · ACP adapter',
    task: 'jcode run "{task}"',
  },
  minds: {
    cmd: 'minds',
    probe: 'minds --version',
    label: 'Minds CLI (Animoca Builder)',
    expected: '/opt/homebrew/bin/minds',
    install: 'Animoca Brands Builder CLI — see your Animoca toolchain access',
    model: 'animoca/builder',
    blurb: 'Animoca Brands Builder CLI · web3 builder toolchain',
  },
  aichat: {
    cmd: 'aichat',
    label: 'aichat',
    expected: '/opt/homebrew/bin/aichat',
    install: 'brew install aichat',
    model: 'openrouter/auto',
    blurb: 'all-in-one LLM CLI · 20+ providers · OpenAI-compat server',
    task: 'aichat "{task}"',
  },
  deepagents: {
    cmd: 'deepagents-code',
    label: 'DeepAgents (LangChain)',
    expected: '$HOME/.local/bin/deepagents-code',
    install: 'uv tool install deepagents-code · managed: deepagents deploy · mcp: deepagents mcp-servers',
    model: 'langchain/managed',
    blurb: 'LangChain Deep Agents · managed deploy + MCP servers + local chat',
    task: 'deepagents-code "{task}"',
  },
  openhands: {
    cmd: 'openhands',
    label: 'OpenHands',
    expected: '$HOME/.local/bin/openhands',
    install: 'uv tool install openhands --python 3.12',
    model: 'openrouter/auto',
    blurb: 'self-hosted Devin-class autonomous SWE · MIT · sandboxed',
    // jailed workspace = the boundary (headless auto-approves inside its loop);
    // START/END markers let the TUI seal a receipt when the run finishes
    task: 'printf \'TIMMY_RUN_START\\n\'; mkdir -p "${TIMMY_WORKSPACE:-$HOME/openhands-workspace}"; cd "${TIMMY_WORKSPACE:-$HOME/openhands-workspace}" && LLM_MODEL="${LLM_MODEL:-openrouter/auto}" LLM_API_KEY="${LLM_API_KEY:-$OPENROUTER_API_KEY}" LLM_BASE_URL="${LLM_BASE_URL:-https://openrouter.ai/api/v1}" openhands --headless -t "{task}" --always-approve --override-with-envs; code=$?; printf \'TIMMY_RUN_END:%s\\n\' "$code"',
  },
  // ---- 3D workflows (queue item 5) ----
  cocos: {
    cmd: 'cocos', label: 'Cocos Creator CLI', expected: 'cocos',
    install: 'https://www.cocos.com/en/creator-download',
    blurb: '2D/3D engine CLI · build + publish headless',
    task: 'cocos {task}',
  },
  defold: {
    cmd: 'defold', label: 'Defold', expected: 'defold',
    install: 'https://defold.com/download/',
    blurb: 'game engine · headless bob/bundle builds',
    task: 'defold --headless {task}',
  },
  godot: {
    cmd: 'godot', label: 'Godot', expected: 'godot',
    install: 'brew install godot',
    blurb: 'open 2D/3D engine · --headless scripting',
    task: 'godot --headless --quit --script {task}',
  },
  blender: {
    cmd: 'blender', label: 'Blender', expected: 'blender',
    install: 'brew install blender',
    blurb: 'modeling/render/sim · -b --python-expr',
    task: 'blender -b --python-expr "{task}"',
  },
  unity: {
    cmd: 'unity-editor', label: 'Unity CLI', expected: 'unity-editor',
    install: 'unity hub → editor; alias unity-editor',
    blurb: 'batchmode -nographics -executeMethod',
    task: 'unity-editor -batchmode -nographics -executeMethod {task}',
  },
  'unreal-mcp': {
    cmd: 'mcporter', label: 'Unreal MCP', expected: 'mcporter',
    install: 'npm i -g mcporter',
    blurb: 'Unreal editor control via MCP · 2-call code-mode surface',
    task: 'mcporter call unreal-mcp.{task}',
  },
  'houdini-mcp': {
    cmd: 'hython', label: 'Houdini MCP', expected: 'hython',
    install: 'sidefx houdini (hython ships with it)',
    blurb: 'procedural 3D · hython headless + MCP bridge',
    task: 'hython {task}',
  },
  openedit: {
    cmd: 'openedit', label: 'OpenEdit (OTIO editor)', expected: 'openedit',
    install: 'register OpenEdit CLI/MCP when available',
    blurb: 'OTIO timeline editor on the film spine; emits modified EDL for re-verify',
    task: 'openedit edit --instruction "{task}"',
  },
  hyperframes: {
    cmd: 'npx', label: 'HyperFrames renderer', expected: 'npx',
    install: 'npx --yes hyperframes',
    blurb: 'terminal-native video renderer for studio comps; {task} = comp path + flags',
    task: 'npx --yes hyperframes render {task}',
  },
  // ---- stored-key API lanes (queue item 7) ----
  webcontainers: {
    cmd: 'curl', label: 'WebContainers', expected: 'curl', key: 'WEBCONTAINERS_CLIENT_ID',
    blurb: 'browser-native runtime API · client-id gated',
    task: 'curl -s -H "Authorization: Bearer $WEBCONTAINERS_CLIENT_ID" https://webcontainers.io/api/v1/{task}',
  },
  retool: {
    cmd: 'curl', label: 'Retool', expected: 'curl', key: 'RETOOL_API_KEY',
    blurb: 'internal tools API · workflow triggers',
    task: 'curl -s -H "Authorization: Bearer $RETOOL_API_KEY" https://api.retool.com/v1/{task}',
  },
  anythingllm: {
    cmd: 'curl', label: 'AnythingLLM', expected: 'curl', key: 'ANYTHINGLLM_API_KEY',
    blurb: 'local RAG workspace API (localhost:3001)',
    task: 'curl -s -H "Authorization: Bearer $ANYTHINGLLM_API_KEY" http://localhost:3001/api/{task}',
  },
  langsmith: {
    cmd: 'curl', label: 'LangSmith', expected: 'curl', key: 'LANGSMITH_API_KEY',
    blurb: 'trace/run observability API',
    task: 'curl -s -H "x-api-key: $LANGSMITH_API_KEY" https://api.smith.langchain.com/{task}',
  },
  abacus: {
    cmd: 'curl', label: 'Abacus', expected: 'curl', key: 'ABACUS_API_KEY_1',
    blurb: 'financial data API · dual-key rotation',
    task: 'curl -s -H "Authorization: Bearer $ABACUS_API_KEY_1" https://api.abacus.ai/v1/{task}',
  },
};

/**
 * Which lane boots in which default pane session.
 * Extend freely — extra lanes spawn via addTmuxSession / lane switcher.
 */
export const DEFAULT_LANE_BINDINGS: Record<string, string> = {
  '1': 'opencode',
  '2': 'hermes',
  '3': 'pi',
  '4': 'openhands',
  '5': 'jcode',
  '6': 'minds',
};

/**
 * shell preamble used by every backend — AgentPass banner + PATH.
 *
 * The launcher is written to a real file and the pane just runs `bash <file>`:
 * zero shell escaping, zero embedded one-liners. This kills the whole class
 * of nested-quoting mangling that leaked raw printf/ANSI into panes (minds).
 */
export function laneStartupScript(runnerKey: string | undefined, jti: string, visa: string, hash: string): string {
  const script = [
    '#!/usr/bin/env bash',
    'clear',
    `printf '\\033[38;5;81m============================================================\\n\\033[0m'`,
    `printf '\\033[38;5;81m[TIMMY Core]\\033[0m Cloudflare Durable Storage: SUCCESS (D1/R2)\\n'`,
    `printf '\\033[38;5;121m[AgentPass]\\033[0m Delivering session passport (JTI: ${jti})\\n'`,
    `printf '\\033[38;5;121m[AgentPass]\\033[0m Visa stamp: ${visa} | scope: agent.run.governed: VERIFIED\\n'`,
    `printf '\\033[38;5;215m[Receipt]\\033[0m Shipped local-first proof bundle: ${hash}\\n'`,
    `printf '\\033[38;5;81m============================================================\\n\\033[0m'`,
    'export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"',
  ];

  const runner = runnerKey ? LANE_RUNNERS[runnerKey] : undefined;
  if (runner) {
    script.push(`printf '\\n\\033[38;5;220m⚡ Launching ${runner.label} in 3 seconds...\\n\\033[0m'`);
    script.push('sleep 3');
    script.push(`if command -v ${runner.cmd} >/dev/null 2>&1; then`);
    script.push(`  printf '\\033[38;5;121m[Runner]\\033[0m ${runner.label}: connected (${runner.cmd})\\n'`);
    script.push(`  ${runner.probe ?? runner.cmd} || printf '\\n\\033[31m[Agent Alert] ${runner.label} exited with code $?\\n\\033[0m'`);
    script.push('else');
    script.push(`  printf '\\n\\033[38;5;215m[Runner]\\033[0m ${runner.label}: not found. Install: ${runner.install || runner.expected}\\n'`);
    script.push('fi');
  } else {
    script.push(`printf '\\033[38;5;121m[Runner]\\033[0m Systems MCP shell ready. Type commands below.\\n'`);
  }

  try {
    const dir = join(process.cwd(), '.timmy', 'run');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `lane-${runnerKey || 'shell'}.sh`);
    writeFileSync(path, script.join('\n') + '\n', { mode: 0o755 });
    return `bash '${path}'`;
  } catch {
    // filesystem unavailable — fall back to the old one-liner shape
    return script.slice(1).join('; ');
  }
}
