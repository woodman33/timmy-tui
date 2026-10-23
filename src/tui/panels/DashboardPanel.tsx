import React, { useState, useEffect } from 'react';
import { Box, Text, useWindowSize, useInput } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import type { Agent } from '../../agent/core.js';
import { PaneFocusContext } from '../components/PanelFrame.js';
import { Card, SectionRule, BudgetList, Pill, type PillKind } from '../ui/index.js';
import { theme } from '../theme.js';
import { truncateVisible } from '../utils/text.js';

interface DashboardPanelProps {
  agent: Agent;
  setInspector: (data: any) => void;
}

interface CapabilityItem {
  key: string;
  name: string;
  category: 'CORE' | 'EDGE' | 'SANDBOX' | 'FUTURE';
  status: 'ACTIVE' | 'AVAILABLE' | 'LOCKED';
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  scope: string;
  tier: string;
  description: string;
  details: string[];
}

export function DashboardPanel({ agent: _agent, setInspector }: DashboardPanelProps) {
  const { columns: width } = useWindowSize();
  const terminalWidth = width || 80;

  // REVIEW view: this panel owns the right half of a two-pane row
  const panelWidth = Math.max(20, Math.floor((terminalWidth - 4) / 2) - 2);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const focused = React.useContext(PaneFocusContext);

  const capabilities: CapabilityItem[] = [
    {
      key: 'mcp-tools',
      name: 'MCP Tools Engine',
      category: 'CORE',
      status: 'ACTIVE',
      risk: 'LOW',
      scope: 'mcp.tools.*',
      tier: 'Enterprise',
      description: 'Dynamic server connection and raw capability schema parser.',
      details: [
        '• Scans raw tools schemas cleanly',
        '• Maps custom dynamic CLI APIs',
        '• Validated runtime sandbox boundaries',
        '• Automated parameter schema checks'
      ]
    },
    {
      key: 'timmy-porter',
      name: 'TIMMY Porter Scanner',
      category: 'CORE',
      status: 'ACTIVE',
      risk: 'MEDIUM',
      scope: 'porter.import.*',
      tier: 'Standard',
      description: 'Ingests external capability URLs step-by-step.',
      details: [
        '• Enrolls URL descriptors safely',
        '• Restricts direct system executions',
        '• Proposes strict AgentPass visas',
        '• Dry-run scanning capability'
      ]
    },
    {
      key: 'acp-bridge',
      name: 'ACP Agent Bridge',
      category: 'EDGE',
      status: 'ACTIVE',
      risk: 'LOW',
      scope: 'acp.bridge.*',
      tier: 'Pro',
      description: 'Cross-swarm integration WebSocket bridge.',
      details: [
        '• Handles live websocket sync triggers',
        '• Maps parallel execution payloads',
        '• Binds external swarms securely',
        '• Secure telemetry push tunnels'
      ]
    },
    {
      key: 'agentpass',
      name: 'AgentPass Passport',
      category: 'CORE',
      status: 'ACTIVE',
      risk: 'LOW',
      scope: 'agentpass.auth',
      tier: 'Enterprise',
      description: 'Verifies credentials claims and excludes key leakage.',
      details: [
        '• Strict JTI claim token validations',
        '• Excludes credentials pathing details',
        '• Local sandbox policy gates',
        '• Restricts credential environment prints'
      ]
    },
    {
      key: 'rmux-recorder',
      name: 'RMUX Flight Recorder',
      category: 'SANDBOX',
      status: 'AVAILABLE',
      risk: 'MEDIUM',
      scope: 'rmux.recording',
      tier: 'Pro',
      description: 'Spatial terminal workspace video/command flight recorder.',
      details: [
        '• Records terminal flight data securely',
        '• Synced to edge evidence DO',
        '• Encrypted local session storage',
        '• Playback schema tracking'
      ]
    },
    {
      key: 'cf-edge',
      name: 'Cloudflare DO Embassy',
      category: 'EDGE',
      status: 'ACTIVE',
      risk: 'LOW',
      scope: 'cf.durable.objects',
      tier: 'Enterprise',
      description: 'Edge network serverless Embassy database storage.',
      details: [
        '• persistent edge database bound',
        '• SQLite transaction D1 datalake sync',
        '• Encrypted session state archives',
        '• High performance (low latency edge)'
      ]
    },
    {
      key: 'context-packs',
      name: 'TIMMY Context Packs',
      category: 'CORE',
      status: 'ACTIVE',
      risk: 'LOW',
      scope: 'context.registry',
      tier: 'Standard',
      description: 'Dynamic team blueprint configuration pack registry.',
      details: [
        '• Gathers workspace blueprint rules',
        '• Packages swarm security bounds',
        '• Tamper-evident context hashes',
        '• Enrollable via Porter URLs'
      ]
    },
    {
      key: 'receipts',
      name: 'Receipts Ledger',
      category: 'EDGE',
      status: 'ACTIVE',
      risk: 'LOW',
      scope: 'agentrun.receipts',
      tier: 'Standard',
      description: 'Tamper-evident operational receipt manifest system.',
      details: [
        '• Verifiable manifest stamp',
        '• Synced to edge Embassy ledger',
        '• Secure exportable receipt logs',
        '• Verified visa trace indices'
      ]
    }
  ];

  const updateInspectorData = (item: CapabilityItem) => {
    setInspector({
      title: `Capability: ${item.name.toUpperCase()}`,
      subtitle: 'TIMMY SYSTEMS WEB NODE DETAILS',
      type: 'Systems Web Node',
      status: item.status,
      risk: item.risk,
      scope: item.scope,
      details: [
        `Category: ${item.category}`,
        `Service Tier: ${item.tier}`,
        `Description: ${item.description}`,
        ...item.details
      ]
    });
  };

  useEffect(() => {
    updateInspectorData(capabilities[selectedIndex]);
  }, [selectedIndex]);

  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:dashboard')) return;
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(capabilities.length - 1, prev + 1));
      return;
    }
  });

  const selectedItem = capabilities[selectedIndex];
  const activeCount = capabilities.filter(c => c.status === 'ACTIVE').length;

  const pillKindFor = (status: CapabilityItem['status']): PillKind =>
    status === 'ACTIVE' ? 'accent' : status === 'AVAILABLE' ? 'warn' : 'muted';

  return (
    <Card
      title="Systems web capability map"
      focused={focused}
      purpose="navigate system capabilities — specs, safety scopes, and risk tiers pipe to the trust inspector"
      pill={{ kind: 'accent', label: `${activeCount} ACTIVE` }}
      width={panelWidth}
      flexGrow={1}
    >
      {/* Systems status ticker — one muted line */}
      <Text color={theme.textMuted} wrap="wrap">
        "Quartermaster here: Navigate Systems Web capabilities below. Detailed specs, safety scopes, and risk tiers are piped straight to your Trust Inspector on the right in real-time."
      </Text>

      <Box marginTop={1}>
        <SectionRule label="installed system capabilities" />
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <BudgetList
          items={capabilities}
          max={7}
          offset={Math.max(0, selectedIndex - 6)}
          render={(item, idx) => {
            const isSelected = selectedIndex === idx;
            return (
              <Box key={item.key} marginBottom={1} justifyContent="space-between" width={panelWidth - 6}>
                <Text color={isSelected ? theme.accent : theme.textPrimary} bold={isSelected}>
                  {isSelected ? '▸ ' : '  '}
                  {truncateVisible(item.name, panelWidth - 24)}
                </Text>
                <Box>
                  <Pill kind={pillKindFor(item.status)} label={item.status} />
                  <Text color={theme.textMuted}> ({item.category})</Text>
                </Box>
              </Box>
            );
          }}
        />
      </Box>

      {/* Quick specs overview */}
      <Box marginTop={1}>
        <SectionRule label="highlighted specs preview" />
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        <Text color={theme.textSecondary} wrap="truncate">
          Description: {selectedItem.description}
        </Text>
      </Box>
    </Card>
  );
}
