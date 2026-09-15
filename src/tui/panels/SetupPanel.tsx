import React, { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import type { Agent } from '../../agent/core.js';
import { PaneFocusContext } from '../components/PanelFrame.js';
import { Card, SectionRule } from '../ui/index.js';
import { saveConfig } from '../../utils/config.js';
import { terminalLink } from '../../utils/hyperlink.js';
import { getResponsiveLayout } from '../utils/responsive.js';
import { theme } from '../theme.js';

interface SetupPanelProps {
  agent: Agent;
}

export function SetupPanel({ agent }: SetupPanelProps) {
  const { columns: width } = useWindowSize();
  const [input, setInput] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [success, setSuccess] = useState(false);
  const focused = React.useContext(PaneFocusContext);
  const { mainStageWidth } = getResponsiveLayout(width || 80);

  // Generate OSC 8 hyperlinked buttons
  const oauthLink = terminalLink('Get API Key / OAuth Link', 'https://openrouter.ai/keys');
  const stripeLink = terminalLink('Subscribe to Premium Edge (Stripe)', 'https://checkout.stripe.com/pay/timmy-tui-premium');

  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:setup')) return;
    if (success) return; // Wait for transition

    if (key.return || char === '\r' || char === '\n') {
      const trimmedKey = input.trim();
      if (!trimmedKey) {
        setErrorMsg('API Key cannot be empty.');
        return;
      }
      if (!trimmedKey.startsWith('sk-or-')) {
        setErrorMsg('Warning: Key does not look like a valid OpenRouter API key (should start with sk-or-).');
      } else {
        setErrorMsg('');
      }

      try {
        // Save the key permanently in Conf store
        saveConfig({ apiKey: trimmedKey });

        // Dynamically update the active agent client
        agent.updateApiKey(trimmedKey);

        setSuccess(true);
        setErrorMsg('');

        // Visual flash transition to chat mode
        setTimeout(() => {
          agent.emit('mode:change' as any, 'chat');
        }, 800);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } else if (key.backspace || key.delete) {
      setInput(input.slice(0, -1));
    } else if (key.escape) {
      setInput('');
      setErrorMsg('');
    } else if (char && char !== '\t' && char !== '\r' && char !== '\n' && !key.ctrl && !key.meta) {
      setInput(input + char);
    }
  });

  return (
    // alignSelf: SYSTEM cards fit content height — no giant blank middle
    <Box alignSelf="flex-start">
    <Card
      title="Welcome to OpenRouter terminal TUI"
      focused={focused}
      purpose="link your account, pick a tier, paste your API key — the workspace unlocks"
      pill={success ? { kind: 'accent', label: 'KEY SAVED' } : { kind: 'accent', label: 'NEEDS KEY' }}
      width={mainStageWidth}
    >
      <Text color={theme.textPrimary} wrap="wrap">
        A state-of-the-art developer workspace powered by OpenRouter, featuring a high-fidelity swarm dashboard, real-time code reviewer panels, and persistent edge storage sync.
      </Text>

      {/* Account & Billing Hyperlinks */}
      <Box marginTop={1}>
        <SectionRule label="quick setup & credentials links" />
      </Box>
      <Box flexDirection="column">
        <Text color={theme.textSecondary}>
          Click the interactive terminal links below to link your account or upgrade:
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.accent}>{oauthLink}</Text>
          <Text color={theme.accent}>{stripeLink}</Text>
        </Box>
      </Box>

      {/* Pricing / Capabilities Tier Cards */}
      <Box marginTop={1}>
        <SectionRule label="tiers" />
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        {/* Free Tier */}
        <Box flexDirection="column" width="30%">
          <Text bold color={theme.textSecondary}>Free Tier ($0)</Text>
          <Text color={theme.textMuted}>- Local Session History</Text>
          <Text color={theme.textMuted}>- Standard CLI Sandboxing</Text>
          <Text color={theme.textMuted}>- Local Telemetry Mascot</Text>
        </Box>

        {/* Pro Tier */}
        <Box flexDirection="column" width="33%">
          <Text bold color={theme.warn}>Edge Pro ($5/mo)</Text>
          <Text color={theme.textSecondary}>- Durable Object SQLite Sync</Text>
          <Text color={theme.textSecondary}>- Offloaded Edge Swarm DO</Text>
          <Text color={theme.textSecondary}>- Globally Replicated KV Vault</Text>
          <Text color={theme.textSecondary}>- Edge Crawler proxy scraping</Text>
        </Box>

        {/* Ultra Pro Tier */}
        <Box flexDirection="column" width="33%">
          <Text bold color={theme.accent}>Ultra Pro ($45/mo)</Text>
          <Text color={theme.textPrimary}>- Private Isolated VPS droplet</Text>
          <Text color={theme.textPrimary}>- Asynchronous Email Agent Loop</Text>
          <Text color={theme.textPrimary}>- MCP Serverless Wrangler Deploy</Text>
          <Text color={theme.textPrimary}>- Vectorize RAG Context Memory</Text>
        </Box>
      </Box>

      {/* Interactive API Key Input Console */}
      <Box marginTop={1}>
        <SectionRule label="credentials" />
      </Box>
      {success ? (
        <Box flexDirection="column" paddingY={1} alignItems="center">
          <Text bold color={theme.accent}>✓ API Key Saved Successfully!</Text>
          <Text color={theme.textSecondary}>Dynamically connecting client and launching conversational console...</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold color={theme.textPrimary}>Setup your credentials</Text>
          <Box marginBottom={1}>
            <Text color={theme.textSecondary}>
              Paste your OpenRouter API key below and press [Enter] to unlock the workspace:
            </Text>
          </Box>

          <Box flexDirection="row" alignItems="center">
            <Text bold color={theme.accent}>sk-or- </Text>
            <Text color={input ? theme.textPrimary : theme.textMuted}>
              {input ? '•'.repeat(Math.min(input.length, 36)) : 'Paste your API key here (Ctrl+V / Cmd+V)...'}
            </Text>
          </Box>

          {errorMsg && (
            <Box marginTop={1}>
              <Text color={errorMsg.includes('Warning') ? theme.warn : theme.danger} bold>
                {errorMsg.includes('Warning') ? 'warn: ' : '× '}
                {errorMsg}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Card>
    </Box>
  );
}
