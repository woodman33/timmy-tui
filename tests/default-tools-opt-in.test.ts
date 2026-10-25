/**
 * R11 (H169, Phase 0 item 4): cloudflare_send_durable_pulse is offered to no turn by default. It posts to a remote Worker
 * (TIMMY_EDGE_HOST) that nothing in Timmy reads back, so it is out of the default tool list (src/agent/tools.ts defaultTools),
 * out of the chat mode's list (src/modes/index.ts), and comes in only when TIMMY_TOOLS_OPT_IN names it for the process: the
 * agent's own tools (createAgent), the REPL's (replTools) and a chat session's offered tools (openChatSession) all follow
 * the one list. An opted-in tool is still gated like every other remote write (src/repl/approvals.ts).
 *
 * No model is asked, nothing leaves this computer: the lists are read, no tool is run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../src/agent/core.js';
import { openChatSession } from '../src/agent/chat-session.js';
import { cloudflareSendDurablePulseTool, defaultTools, OPT_IN_TOOLS, optedInToolNames, optedInTools, TOOLS_OPT_IN_VAR } from '../src/agent/tools.js';
import { BUILT_IN_MODES, resolveToolsForMode } from '../src/modes/index.js';
import { replTools } from '../src/repl/main.js';
import { approvalNeeded } from '../src/repl/approvals.js';

const PULSE = 'cloudflare_send_durable_pulse';
const names = (tools: readonly unknown[]): string[] => tools.map((t) => (t as { function?: { name?: string }; name?: string }).function?.name ?? (t as { name?: string }).name ?? '?');
const agentNames = (): string[] => {
  const agent = createAgent({ apiKey: '', model: '', instructions: '', maxSteps: 1, maxCost: 1 }, { multiplexer: 'none' });
  return names((agent as unknown as { tools: unknown[] }).tools);
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('cloudflare_send_durable_pulse is opt-in, not a default tool (R11 H169, Phase 0 item 4)', () => {
  it('the default list, the chat mode\'s list, the agent\'s own tools and the REPL\'s lack it', () => {
    vi.stubEnv(TOOLS_OPT_IN_VAR, '');
    expect(names(defaultTools)).not.toContain(PULSE);
    expect(names(defaultTools)).toContain('cloudflare_get_feature_flag');
    expect(BUILT_IN_MODES.chat.tools).not.toContain(PULSE);
    expect(names(resolveToolsForMode('chat'))).not.toContain(PULSE);
    expect(agentNames()).not.toContain(PULSE);
    expect(names(replTools())).not.toContain(PULSE);
    expect(optedInToolNames()).toEqual([]);
    expect(optedInTools()).toEqual([]);
    // the tool itself still exists, for whoever opts in
    expect(Object.keys(OPT_IN_TOOLS)).toEqual([PULSE]);
    expect(names([cloudflareSendDurablePulseTool])).toEqual([PULSE]);
    expect(TOOLS_OPT_IN_VAR).toBe('TIMMY_TOOLS_OPT_IN');
  });

  it('TIMMY_TOOLS_OPT_IN names it: the agent, the REPL and a chat session offer it (once); unknown names are ignored', async () => {
    vi.stubEnv(TOOLS_OPT_IN_VAR, ` ${PULSE}, not_a_tool ,${PULSE}`);
    expect(optedInToolNames()).toEqual([PULSE]);
    expect(names(optedInTools())).toEqual([PULSE]);
    expect(agentNames().filter((n) => n === PULSE)).toHaveLength(1);
    expect(names(replTools()).filter((n) => n === PULSE)).toHaveLength(1);
    // the default list itself is unchanged by the opt-in
    expect(names(defaultTools)).not.toContain(PULSE);
    // a chat session's offered tools (gated: src/agent/chat-session.ts gateAgent), from the defaults plus the opt-in
    const box = mkdtempSync(join(tmpdir(), 'h169-opt-in-'));
    try {
      mkdirSync(join(box, 'project', '.timmy'), { recursive: true });
      writeFileSync(join(box, 'project', '.timmy', 'store-pin'), join(box, 'project', '.timmy', 'receipts'));
      const agent = createAgent({ apiKey: '', model: '', instructions: '', maxSteps: 1, maxCost: 1 }, { multiplexer: 'none' });
      agent.useSessions(join(box, 'sessions'));
      await openChatSession({ project: { name: 'demo', root: join(box, 'project') }, surface: 'workbench' }, { agent });
      const offered = names((agent as unknown as { tools: unknown[] }).tools);
      expect(offered.filter((n) => n === PULSE)).toHaveLength(1);
      // still gated: it writes to a remote service, so a turn's call needs the person
      expect(approvalNeeded(PULSE, { metricName: 'cpu', metricValue: 1 })).toMatchObject({ reason: 'writes to a remote service' });
    } finally { rmSync(box, { recursive: true, force: true }); }
  });

  it('with the variable naming only unknown tools, nothing is opted in', () => {
    vi.stubEnv(TOOLS_OPT_IN_VAR, 'not_a_tool,another');
    expect(optedInToolNames()).toEqual([]);
    expect(agentNames()).not.toContain(PULSE);
  });
});
