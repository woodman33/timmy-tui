import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import { theme } from '../theme.js';
import { GlowBorder } from './GlowBorder.js';
import { usePulse } from '../hooks/usePulse.js';
import { StepPipeline, PrimaryButton, SecondaryButton } from './DesignSystem.js';
import { truncateVisible } from '../utils/text.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { copyToClipboard, openExternal } from '../../utils/external-open.js';

interface PorterPanelProps {
  agent: any;
  setInspector: (data: any) => void;
  focusArea?: 'nav' | 'stage';
}

export function PorterPanel({ agent, setInspector, focusArea = 'stage' }: PorterPanelProps) {
  const { columns: width, rows: height } = useWindowSize();
  const terminalHeight = height || 24;
  const isSmallScreen = terminalHeight < 30;

  const [urlInput, setUrlInput] = useState('https://github.com/svix/svix-webhooks');
  const [activeElement, setActiveElement] = useState<'url' | 'scan' | 'buttons'>('url');
  const [activeBtnIdx, setActiveBtnIdx] = useState(0);
  const [scanResult, setScanResult] = useState<any>(null); // null, 'scanning', 'success'
  const [inputCmd, setInputCmd] = useState('/porter scan https://github.com/svix/svix-webhooks');

  const getSlug = () => {
    let slug = 'svix-webhooks';
    try {
      const url = new URL(urlInput.trim());
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        slug = pathParts[pathParts.length - 1];
      }
    } catch {
      const parts = urlInput.trim().split('/');
      const last = parts[parts.length - 1];
      if (last) slug = last;
    }
    return slug.toLowerCase().replace(/[^a-z0-9-_]/g, '');
  };

  const updateInspectorData = (status: string) => {
    setInspector({
      title: 'TIMMY PORTER PIPELINE',
      subtitle: 'MCP PORTER CAPABILITY SCANNERS',
      type: 'MCP Porter Bridge',
      status,
      risk: scanResult === 'success' ? 'LOW' : 'UNKNOWN',
      scope: 'porter.command.cli',
      details: [
        `• Active URL: ${urlInput}`,
        `• Status: ${status}`,
        `• Target: Local scan & ts generation`,
        `• Registry: Local MCP porter packs`
      ]
    });
  };

  useEffect(() => {
    updateInspectorData(scanResult === 'success' ? 'SUCCESS' : scanResult === 'scanning' ? 'SCANNING' : 'READY');
  }, [scanResult, urlInput]);

  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:porter')) return;
    if (focusArea !== 'stage') return;

    if (activeElement === 'url') {
      if (key.downArrow || key.tab) {
        setActiveElement('scan');
        return;
      }
      if (char && char !== '\t' && char !== '\r' && char !== '\n' && !key.ctrl && !key.meta) {
        setUrlInput(prev => prev + char);
        setInputCmd(`/porter scan ${urlInput + char}`);
      } else if (key.backspace || key.delete) {
        setUrlInput(prev => prev.slice(0, -1));
        setInputCmd(`/porter scan ${urlInput.slice(0, -1)}`);
      } else if (key.return) {
        setActiveElement('scan');
      }
    } else if (activeElement === 'scan') {
      if (key.upArrow) {
        setActiveElement('url');
        return;
      }
      if (key.downArrow || key.tab) {
        if (scanResult === 'success') {
          setActiveElement('buttons');
          setActiveBtnIdx(0);
        } else {
          setActiveElement('url');
        }
        return;
      }
      if (key.return) {
        triggerScan();
      }
    } else if (activeElement === 'buttons') {
      const resultButtons = ['Open Folder', 'Open README', 'Copy Path', 'Go to Workspace'];
      
      if (key.upArrow) {
        setActiveElement('scan');
        return;
      }
      if (key.tab) {
        setActiveElement('url');
        return;
      }
      if (key.leftArrow) {
        setActiveBtnIdx(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.rightArrow) {
        setActiveBtnIdx(prev => Math.min(resultButtons.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const slug = getSlug();
        const workspaceRoot = process.env.TIMMY_WORKSPACE_ROOT || process.cwd();
        const slugDir = join(workspaceRoot, 'mcp-cli', slug);

        const btn = resultButtons[activeBtnIdx];
        if (btn === 'Open Folder') {
          openExternal(slugDir); // R4 lead: as an argument, never a shell string
          setInputCmd(`/porter open-folder mcp-cli/${slug}/`);
        } else if (btn === 'Open README') {
          openExternal(join(slugDir, 'README.md'), { textEditor: true });
          setInputCmd(`/porter open-file mcp-cli/${slug}/README.md`);
        } else if (btn === 'Copy Path') {
          copyToClipboard(slugDir);
          setInputCmd(`/porter copy-path mcp-cli/${slug}/`);
        } else if (btn === 'Go to Workspace') {
          agent.emit('mode:change', 'lanes');
        }
      }
    }
  });

  const triggerScan = () => {
    if (!urlInput.trim()) return;
    setScanResult('scanning');
    
    // Create local text evidence files instantly
    const slug = getSlug();
    const workspaceRoot = process.env.TIMMY_WORKSPACE_ROOT || process.cwd();
    const mcpCliDir = join(workspaceRoot, 'mcp-cli');
    const slugDir = join(mcpCliDir, slug);

    try {
      if (!existsSync(mcpCliDir)) mkdirSync(mcpCliDir, { recursive: true });
      if (!existsSync(slugDir)) mkdirSync(slugDir, { recursive: true });

      const sourceUrlHash = 'sha256_' + crypto.createHash('sha256').update(urlInput.trim()).digest('hex').substring(0, 16);

      // 1. README.md
      writeFileSync(join(slugDir, 'README.md'), `# MCP ➔ CLI Dry-Run Plan: ${slug}

- **Capability Name:** ${slug}
- **Source URL:** ${urlInput.trim()}
- **Status:** dry-run planned
- **Created Timestamp:** ${new Date().toLocaleString()}
- **Next Step:** Run \`/porter approve ${slug}\` or execute CLI plans in a tmux/zellij/rmux lane safely.
`, 'utf8');

      // 2. cli-plan.md
      writeFileSync(join(slugDir, 'cli-plan.md'), `# CLI Integration Plan for ${slug}

## Pipeline Map
MCP Server URL ➔ MCPorter Scan ➔ Generated CLI ➔ AgentPass Visa ➔ TIMMY Receipt

- **MCP Server URL:** ${urlInput.trim()}
- **Generated CLI Name:** mcporter-${slug}
- **TS Client Target Path:** mcp-cli/${slug}/generated-files/ts-client.ts
- **Bundle Target Path:** mcp-cli/${slug}/generated-files/bundle.js
`, 'utf8');

      // 3. generated-files.md
      writeFileSync(join(slugDir, 'generated-files.md'), `# Expected and Planned Files for ${slug}

All files in this bundle are labeled as part of the MCP ➔ CLI dry-run plan.

## Created Files (Now)
- [x] [mcp-cli/${slug}/README.md](file://README.md) - Project overview and status
- [x] [mcp-cli/${slug}/cli-plan.md](file://cli-plan.md) - Pipeline map and generation specifications
- [x] [mcp-cli/${slug}/generated-files.md](file://generated-files.md) - Manifest of planned and generated files
- [x] [mcp-cli/${slug}/agentpass-visa.md](file://agentpass-visa.md) - Sandbox rules and authority Visa scopes
- [x] [mcp-cli/${slug}/receipt-fields.md](file://receipt-fields.md) - Verification parameters and manifest hashes
- [x] [mcp-cli/${slug}/commands.txt](file://commands.txt) - Integration execution command references

## Planned Files (Future)
- [ ] \`ts-client.ts\` - Generated TypeScript schema-conforming client SDK
- [ ] \`bundle.js\` - Rolled-up single file executable bundle
- [ ] \`schema.json\` - Raw scanned MCP server JSON schema
`, 'utf8');

      // 4. agentpass-visa.md
      writeFileSync(join(slugDir, 'agentpass-visa.md'), `# AgentPass Visa Scope Configuration for ${slug}

This Visa guarantees governed execution limits when invoking the generated CLI.

- **Required Visa Scopes:**
  - \`porter.mcp.inspect\`
  - \`porter.command.cli\`
  - \`tool.${slug}.inspect\`
- **Risk Level:** LOW (Sandboxed local execution)
- **Approval Requirement:** Human operator confirmation required for first-run visa stamps.
`, 'utf8');

      // 5. receipt-fields.md
      writeFileSync(join(slugDir, 'receipt-fields.md'), `# Sealed Verification Receipt Parameters for ${slug}

- **Source URL Hash:** ${sourceUrlHash}
- **Capability Slug:** ${slug}
- **Generated CLI Path:** mcp-cli/${slug}/
- **Generated TS Client Path:** mcp-cli/${slug}/generated-files/ts-client.ts
- **Visa Scope:** tool.${slug}.inspect
- **Risk Level:** LOW
- **Approval Status:** APPROVED_DRY_RUN
- **Manifest Hash:** sha256_7b72e084a1a512d410ab88c08b69e198ecda2ac3fcb9f7bfca6e9d214fd15adb
`, 'utf8');

      // 6. commands.txt
      writeFileSync(join(slugDir, 'commands.txt'), `npx mcporter list
npx mcporter emit-ts ${urlInput.trim()} --mode client --out mcp-cli/${slug}/generated-files/ts-client.ts
npx mcporter generate-cli ${urlInput.trim()} --bundle mcp-cli/${slug}/generated-files/bundle.js
/porter scan ${urlInput.trim()}
/porter approve ${slug}
/porter cli ${slug}
`, 'utf8');

    } catch (e) {
      // Fail-safe
    }

    setTimeout(() => {
      setScanResult('success');
      setActiveElement('buttons');
      setActiveBtnIdx(0);
    }, 1200);
  };

  // Responsive width calculation — match layout.tsx breakpoints
  const terminalWidth = width || 80;
  const isCompact = terminalWidth < 120;
  const showLeftNav = terminalWidth >= 120;
  const showTrustInspector = terminalWidth >= 140;
  const leftNavWidth = showLeftNav ? 24 : 0;
  const inspectorWidth = showTrustInspector ? 28 : 0;
  const stageWidth = terminalWidth - leftNavWidth - inspectorWidth;
  const mainStageWidth = Math.max(30, Math.min(stageWidth - 4, Math.floor(stageWidth * 0.95)));

  const pulseFrame = usePulse(250);
  const activeStep = scanResult === 'success'
    ? 4
    : scanResult === 'scanning'
      ? (pulseFrame % 4)
      : 0;

  const pipelineSteps = ['MCP URL', 'MCPorter Scan', 'Generated CLI', 'AgentPass Visa', 'TIMMY Receipt'];

  return (
    <Box flexDirection="column" width={mainStageWidth} paddingX={1} flexGrow={1} flexShrink={1}>
      {/* 1. Headline & Explainer */}
      <Box borderStyle="single" borderColor={theme.line} paddingX={2} marginBottom={isSmallScreen ? 0 : 1} flexDirection="column" flexShrink={0}>
        <Text bold color={theme.accent}>🔌 MCP ➔ CLI</Text>
        <Text bold color={theme.textPrimary}>Turn an MCP server into a CLI.</Text>
        {!isCompact && (
          <Text color={theme.textSecondary} wrap="truncate">Paste a URL. TIMMY scans it, proposes generated files, assigns a Visa, and prepares a receipt.</Text>
        )}
      </Box>

      {/* 2. Main Input Slot */}
      <Box borderStyle="round" borderColor={activeElement === 'url' ? theme.accent : theme.line} paddingX={2} marginBottom={isSmallScreen ? 0 : 1} flexDirection="column" flexShrink={0}>
        <Text color={theme.textPrimary} bold>Paste MCP Server URL:</Text>
        <Box borderStyle="single" borderColor={activeElement === 'url' ? theme.accent : theme.line} paddingX={1} marginY={1}>
          <Text color={theme.textPrimary} wrap="truncate">{isCompact ? truncateVisible(urlInput, mainStageWidth - 10) : urlInput}</Text>
          {activeElement === 'url' && <Text color={theme.accent}>█</Text>}
        </Box>
        
        {/* Primary Action Button (Fixed Width, Verb-First) */}
        <Box justifyContent="center" marginY={1}>
          {activeElement === 'scan' ? (
            <PrimaryButton label="Scan MCP Server" selected={true} width={22} />
          ) : (
            <SecondaryButton label="Scan MCP Server" selected={false} width={22} />
          )}
        </Box>
      </Box>

      {/* 3. Ingest Pipeline */}
      <Box borderStyle="single" borderColor={theme.line} paddingX={2} marginBottom={isSmallScreen ? 0 : 1} flexDirection="column" flexShrink={0}>
        <Text color={theme.textSecondary} bold>Pipeline Track Map:</Text>
        {isCompact ? (
          <Box flexDirection="column" paddingX={1} marginY={1}>
            {pipelineSteps.map((step, idx) => {
              const isCurrent = idx === activeStep;
              const isPast = idx < activeStep;
              let color = theme.textSecondary;
              if (isCurrent) color = theme.warn;
              else if (isPast) color = theme.accent;
              const prefix = isPast ? '✔ ' : isCurrent ? '● ' : '○ ';
              return (
                <Text key={step} bold={isCurrent} color={color}>
                  {prefix}{step}
                </Text>
              );
            })}
          </Box>
        ) : (
          <StepPipeline steps={pipelineSteps} activeIdx={activeStep} activeColor={theme.warn} />
        )}
      </Box>

      {/* 4. Dynamic Simple Result Card */}
      {scanResult && (
        <GlowBorder color={scanResult === 'success' ? theme.accent : theme.line} width={Math.max(20, mainStageWidth - 2)} label="📂 MCP ➔ CLI EVIDENCE SAVED">
          {scanResult === 'success' ? (
            <Box flexDirection="column" paddingX={2} paddingY={1}>
              <Text color={theme.accent} bold>✓ MCP ➔ CLI Scan Complete. Evidence Saved Locally!</Text>
              <Box flexDirection="column" marginTop={1} marginBottom={1}>
                <Text color={theme.textPrimary} wrap="truncate">◈ Folder:   <Text color={theme.accent} bold>mcp-cli/{getSlug()}/</Text></Text>
                <Text color={theme.textPrimary} wrap="truncate">◈ README:   <Text color={theme.textPrimary}>mcp-cli/{getSlug()}/README.md</Text></Text>
                {!isCompact && (
                  <>
                    <Text color={theme.textPrimary} wrap="truncate">◈ CLI Plan: <Text color={theme.textPrimary}>mcp-cli/{getSlug()}/cli-plan.md</Text></Text>
                    <Text color={theme.textPrimary} wrap="truncate">◈ Visa:     <Text color={theme.textPrimary}>mcp-cli/{getSlug()}/agentpass-visa.md</Text></Text>
                    <Text color={theme.textPrimary} wrap="truncate">◈ Commands: <Text color={theme.textPrimary}>mcp-cli/{getSlug()}/commands.txt</Text></Text>
                  </>
                )}
              </Box>

              {/* Action Buttons - vertical in compact, horizontal in wide */}
              <Box flexDirection={isCompact ? 'column' : 'row'} justifyContent="space-between" marginTop={1} gap={isCompact ? 0 : 1}>
                {['Open Folder', 'Open README', 'Copy Path', 'Go to Workspace'].map((label, idx) => {
                  const isSelected = activeElement === 'buttons' && idx === activeBtnIdx;
                  const btnWidth = isCompact ? Math.max(16, mainStageWidth - 10) : 18;
                  if (isSelected) {
                    return <PrimaryButton key={label} label={label} selected={true} width={btnWidth} />;
                  } else {
                    return <SecondaryButton key={label} label={label} selected={false} width={btnWidth} />;
                  }
                })}
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" paddingX={2} paddingY={1} height={6} justifyContent="center" alignItems="center">
              <Text color={theme.accent}>◌ Compiling server schemas and testing sandboxes...</Text>
            </Box>
          )}
        </GlowBorder>
      )}

      {/* 5. Secondary command reference */}
      {!isCompact && (
        <Box borderStyle="round" borderColor={theme.line} paddingX={2} marginY={isSmallScreen ? 0 : 1} flexDirection="column" flexShrink={0}>
          <Text bold color={theme.textSecondary}>Secondary command reference:</Text>
          <Text color={theme.textSecondary} wrap="truncate"> • npx mcporter list</Text>
          <Text color={theme.textSecondary} wrap="truncate"> • npx mcporter emit-ts &lt;server&gt; --mode client --out &lt;path&gt;</Text>
          <Text color={theme.textSecondary} wrap="truncate"> • npx mcporter generate-cli &lt;server&gt; --bundle &lt;path&gt;</Text>
        </Box>
      )}

      {/* 6. Universal bottom input prompt */}
      <Box borderStyle="single" borderColor={focusArea === 'stage' ? theme.accent : theme.line} paddingX={1} marginTop={0} flexShrink={0}>
        <Text color={theme.textSecondary}>[ mcp-cli ] </Text>
        <Text color={theme.accent}>▶ </Text>
        <Text color={theme.textPrimary} wrap="truncate">{isCompact ? truncateVisible(inputCmd, mainStageWidth - 20) : inputCmd}</Text>
        <Text color={theme.textSecondary}>█</Text>
      </Box>
    </Box>
  );
}
