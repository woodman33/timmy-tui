import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useFocus, panelMayAct } from '../hooks/useKeyDispatcher.js';
import { DispatchRail } from '../panels/DispatchRail.js';
import chalk from 'chalk';
import { useAgent } from '../hooks/useAgent.js';
import type { Agent } from '../../agent/core.js';
import { renderMarkdown } from '../../utils/markdown.js';
import { theme } from '../theme.js';
import { SLASH_COMMANDS, handleSlashCommand, getAutocompleteEnabled } from '../../utils/slash-commands.js';
import { truncateVisible, scrollVisibleLeft, truncateMiddleOrEnd, splitModelNameAndBlurb, getModelColors, wrapVisible } from '../utils/text.js';
import { Spinner } from './Motion.js';
import { useEdgeHealth } from '../hooks/useEdgeHealth.js';
import { PrimaryButton, SecondaryButton } from './DesignSystem.js';
import { fetchModels } from '../../agent/openrouter-client.js';
import { LogRain } from '../panels/LogRain.js';

interface ChatPanelProps {
  agent: Agent;
  setInspector: (data: any) => void;
  zone?: number;
  setZone?: (z: number) => void;
  /** v1.0.1: the COMMAND view kills the ambient reverse rain (ticker owns live). */
  ambientRain?: boolean;
}

const FALLBACK_MODELS = [
  { id: 'anthropic/claude-opus-4.7', name: 'Claude 4.7 Opus', description: 'high reasoning / coding' },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5', description: 'general reasoning' },
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: 'fast multimodal' },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', description: 'long-context coding/reasoning' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'intelligence & speed leader' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'high-performance general reasoning' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', description: 'reasoning & coding cost disruptor' },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', description: 'highly-capable open weights logic' },
  { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', description: 'top coding open weights assistant' }
];

export function ChatPanel({ agent, setInspector, zone = 0, setZone, ambientRain = true }: ChatPanelProps) {
  const { rows: height, columns: width } = useWindowSize();
  const terminalHeight = height || 24;
  const terminalWidth = width || 80;
  
  const state = useAgent(agent);
  const edge = useEdgeHealth();

  const [input, setInput] = useState('');
  const [cursorPos, setCursorPos] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [activeSuggestIdx, setActiveSuggestIdx] = useState(0);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [activeCheckpointIdx, setActiveCheckpointIdx] = useState(0);

  // Home buttons interactive selection
  const [activeHomeBtnIdx, setActiveHomeBtnIdx] = useState(-1); // -1 = input focus, 0 = Paste URL, 1 = Open Workspace, 2 = View Receipt

  // Command Post v0.1 Dispatch rail (ctrl+d)
  const [showDispatch, setShowDispatch] = useState(false);

  // OpenRouter Model Rail states
  const [liveModels, setLiveModels] = useState<any[]>([]);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [showModelDetail, setShowModelDetail] = useState(false);
  const [highlightedModelIdx, setHighlightedModelIdx] = useState(0);
  const [focusSection, setFocusSection] = useState<'chat' | 'modelRail' | 'logRain'>('chat');
  const [modelChangedFlash, setModelChangedFlash] = useState(false);

  // ONE GRAMMAR: pane focus lives in the root zone (-1 nav · 0 chat · 1 rail · 2 rain)
  const focusPane = (s: 'chat' | 'modelRail' | 'logRain') => {
    setFocusSection(s);
    setZone?.(s === 'chat' ? 0 : s === 'modelRail' ? 1 : 2);
  };

  useEffect(() => {
    fetchModels().then(models => {
      if (models && models.length > 0) {
        setLiveModels(models);
      }
    }).catch(() => {
      // catalog unavailable fallback
    });
  }, []);

  // Drawable stage width = terminal minus Layout's NAV column (14 when W>=90) and STAGE paddingX=2.
  // Sizing from the true width is what keeps the chat from ever sliding under the right rail.
  const navWidth = terminalWidth >= 90 ? 14 : 0;
  const stageWidth = Math.max(60, terminalWidth - navWidth - 4);
  const railWidth = Math.max(30, Math.min(44, Math.floor(stageWidth * 0.28)));
  const rainWidth = Math.max(34, Math.min(60, Math.floor(stageWidth * 0.24)));
  // Three full-height columns (chat | rail | rain) only when chat keeps >=44 cols.
  const threeCol = ambientRain && stageWidth >= 128 && stageWidth - railWidth - rainWidth - 8 >= 44;
  const chatWidth = Math.max(30, stageWidth - railWidth - (threeCol ? rainWidth : 0) - 4);

  // Chat viewport = measured fill, not a hard cap.
  // Fixed chrome (Layout): top bar 2 (1 text + 1 border-bottom), bottom bar 1, stage paddingTop 1  → 4
  // Panel chrome: header 2 + marginBottom 1, border box 2 (round borders), input marginTop 1 + 3 (1 text + 2 borders) → 9
  // Autocomplete row (when visible): minHeight 1 + marginBottom 1 → +2
  const isCompact = terminalHeight < 36;
  const railListHeight = Math.max(6, Math.floor((terminalHeight - 20) * 0.55));
  const rainHeight = Math.max(6, terminalHeight - 20 - railListHeight);
  const chromeOverhead = 4;
  const headerOverhead = isCompact ? 2 : 3;
  const autocompleteOverhead = 0; // refined below once autocomplete is known
  const visibleHeight = Math.max(6, terminalHeight - chromeOverhead - headerOverhead - 2 - 4 - 2);
  // = terminalHeight - 12 (compact) / - 13 (normal); the trailing -2 is headroom for autocomplete so the input never gets pushed off-screen.

  const updateInspectorData = () => {
    setInspector({
      title: 'TIMMY ACTIVE PASSPORT',
      subtitle: 'VERIFIABLE OPERATIONS LEDGER',
      type: 'AgentPass Session',
      status: 'VERIFIED',
      risk: 'LOW',
      scope: 'brief.session.auth',
      details: [
        'Passport ID: jti_auth_91a783',
        'Authority: Enforced locally & CF Edge',
        'Telemetry Target: Cloudflare Durable Object',
        'Wedge: Code Swarm Pack active',
        'Edge Status: Connected D1 Database'
      ]
    });
  };

  useEffect(() => {
    updateInspectorData();
  }, []);

  const { allLines, checkpoints } = React.useMemo(() => {
    const lines: string[] = [];
    const checkpointsList: { checkpointIndex: number; lineIndex: number }[] = [];
    const messages = state.messages;
    const textWidth = Math.max(16, chatWidth - 6);
    
    let checkpointCount = 0;
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user') {
        const lineIndex = lines.length;
        checkpointsList.push({
          checkpointIndex: checkpointCount,
          lineIndex
        });
        checkpointCount++;

        lines.push(chalk.bold.hex(theme.accent)(`▶ You [Checkpoint ${checkpointCount}]`));
        lines.push(...msg.content.split('\n'));
        lines.push('');
      } else if (msg.role === 'assistant') {
        lines.push(chalk.bold.hex(theme.accent)('◀ TIMMY Agent'));
        const parsedMarkdown = renderMarkdown(msg.content, textWidth);
        lines.push(...parsedMarkdown.split('\n'));
        lines.push('');
        lines.push(chalk.hex(theme.accent)('☁️  [Saved to Cloudflare Durable Object SQLite Session]'));
        lines.push('');
      }
    }

    if (state.isStreaming) {
      if (state.currentTools.length > 0) {
        lines.push(chalk.hex(theme.accent)(state.currentTools.map(t => `⚙ ${t}`).join('  ')));
        lines.push('');
      }
      if (state.streamingText) {
        lines.push(chalk.bold.hex(theme.accent)('◀ TIMMY Agent'));
        const parsedStream = renderMarkdown(state.streamingText, textWidth);
        lines.push(...parsedStream.split('\n'));
        lines.push(chalk.hex(theme.textSecondary)('▌'));
      } else {
        lines.push(chalk.hex(theme.accent)('◌ Thinking...'));
      }
    }

    if (state.error) {
      lines.push(chalk.bold.hex(theme.danger)(`✕ Error: ${state.error.message}`));
    }

    return { allLines: lines, checkpoints: checkpointsList };
  }, [state.messages, state.isStreaming, state.streamingText, state.currentTools, state.error, chatWidth]);

  useEffect(() => {
    if (checkpoints.length > 0) {
      setActiveCheckpointIdx(checkpoints.length - 1);
      setUserScrolledUp(false);
      setActiveHomeBtnIdx(-1);
    }
  }, [checkpoints.length]);

  useEffect(() => {
    if (state.isStreaming || state.isThinking) {
      setUserScrolledUp(false);
    }
  }, [state.isStreaming, state.isThinking]);

  const showAutocomplete = getAutocompleteEnabled() && input.startsWith('/') && !input.includes(' ');
  const matches = showAutocomplete
    ? SLASH_COMMANDS.filter(c => c.command.startsWith(input.split(' ')[0])).slice(0, 5)
    : [];
  const closestMatch = matches[activeSuggestIdx] || matches[0];

  const inputTextWidth = Math.max(1, chatWidth - 18);

  (agent as any).autocompleteActive = showAutocomplete && matches.length > 0;

  useEffect(() => {
    return () => {
      (agent as any).autocompleteActive = false;
    };
  }, [agent]);

  const visibleLines = allLines.slice(scrollOffset, scrollOffset + visibleHeight);

  useEffect(() => {
    const totalLines = allLines.length;
    if (totalLines > visibleHeight) {
      if (!userScrolledUp) {
        setScrollOffset(totalLines - visibleHeight);
      }
    } else {
      setScrollOffset(0);
    }
  }, [allLines.length, visibleHeight, userScrolledUp]);

  // Derive scrollable list of models
  const rawModels = liveModels.length > 0
    ? liveModels.map(m => {
        const fb = FALLBACK_MODELS.find(f => f.id === m.id);
        return {
          id: m.id,
          name: m.name || m.id,
          description: fb ? fb.description : (m.description || 'description unavailable'),
          pricing: (m as any).pricing
        };
      })
    : FALLBACK_MODELS;

  const filteredModels = rawModels.filter(m => 
    m.id.toLowerCase().includes(modelSearchQuery.toLowerCase()) ||
    m.name.toLowerCase().includes(modelSearchQuery.toLowerCase())
  );

  const visibleModelCount = 10;
  const startIdx = Math.max(0, Math.min(highlightedModelIdx - 4, filteredModels.length - visibleModelCount));
  const visibleModels = filteredModels.slice(startIdx, startIdx + visibleModelCount);

  const __focus = useFocus();
  useInput((char, key) => {
    if (!panelMayAct(__focus, 'input:chat')) return;
    if (zone < 0) return; // nav owns the keyboard
    if (focusSection === 'chat') {
      if (key.escape) {
        if (showAutocomplete) {
          setInput('');
          return;
        }
      }

      if (key.rightArrow) {
        focusPane('modelRail');
        setHighlightedModelIdx(0);
        return;
      }
      // ← from chat walks back to the left nav, like every other tab
      if (key.leftArrow && checkpoints.length > 0) {
        setZone?.(-1);
        return;
      }

      if (key.ctrl && char === 'm') {
        focusPane('modelRail');
        setHighlightedModelIdx(0);
        return;
      }

      // Command Post v0.1: compact Dispatch rail (J-BANG), ctrl+d
      if (key.ctrl && char === 'd') {
        setShowDispatch(s => !s);
        return;
      }

      // Scroll chat history — step scroll: default 3 lines (smooth), shift+↑↓ = 1 line (fine)
      const scrollStep = key.shift ? 1 : 3;
      if ((key.upArrow || (key.ctrl && char === 'k')) && checkpoints.length > 0) {
        setScrollOffset(prev => {
          const next = Math.max(0, prev - scrollStep);
          setUserScrolledUp(true);
          return next;
        });
        return;
      }
      if ((key.downArrow || (key.ctrl && char === 'j')) && checkpoints.length > 0) {
        const totalLines = allLines.length;
        const maxScroll = Math.max(0, totalLines - visibleHeight);
        setScrollOffset(prev => {
          const next = Math.min(maxScroll, prev + scrollStep);
          setUserScrolledUp(next < maxScroll);
          return next;
        });
        return;
      }
      // Page scroll — full viewport jumps
      if (key.pageUp && checkpoints.length > 0) {
        setScrollOffset(prev => {
          const next = Math.max(0, prev - visibleHeight);
          setUserScrolledUp(true);
          return next;
        });
        return;
      }
      if (key.pageDown && checkpoints.length > 0) {
        const totalLines = allLines.length;
        const maxScroll = Math.max(0, totalLines - visibleHeight);
        setScrollOffset(prev => {
          const next = Math.min(maxScroll, prev + visibleHeight);
          setUserScrolledUp(next < maxScroll);
          return next;
        });
        return;
      }
      // Home/End
      if (key.home && checkpoints.length > 0) {
        setScrollOffset(0);
        setUserScrolledUp(true);
        return;
      }
      if (key.end && checkpoints.length > 0) {
        setScrollOffset(Math.max(0, allLines.length - visibleHeight));
        setUserScrolledUp(false);
        return;
      }

      // Starting view: 1-3 pick a home button (positional rhyme with LOGS 1-5),
      // ←→ still walk panes
      if (checkpoints.length === 0) {
        if (char === '1') { setActiveHomeBtnIdx(0); return; }
        if (char === '2') { setActiveHomeBtnIdx(1); return; }
        if (char === '3') { setActiveHomeBtnIdx(2); return; }
        if (key.leftArrow) {
          setActiveHomeBtnIdx(prev => prev <= 0 ? 2 : prev - 1);
          return;
        }
        if (key.rightArrow) {
          setActiveHomeBtnIdx(prev => prev >= 2 ? 0 : prev + 1);
          return;
        }
      }

      if (showAutocomplete && matches.length > 0) {
        if (key.tab && closestMatch) {
          setInput(closestMatch.command + ' ');
          setCursorPos(closestMatch.command.length + 1);
          setActiveSuggestIdx(0);
          return;
        }
      }

      if (key.return || char === '\r' || char === '\n') {
        if (checkpoints.length === 0 && activeHomeBtnIdx !== -1) {
          // Trigger select button action
          if (activeHomeBtnIdx === 0) {
            // Run Proof
            const newRunId = `run_proof_${Date.now()}`;
            agent.emit('run.created' as any, {
              runId: newRunId,
              receiptUrl: `https://timmy-ai-proxy.wmeldman33.workers.dev/runs/${newRunId}/receipt`,
              source: 'timmy-tui-chat-shortcut',
              timestamp: Date.now()
            });
            agent.emit('message:user' as any, {
              role: 'assistant',
              content: `⚙️ **[SYSTEM]** Mock proof run generated. Receipt committed locally under Run ID: ${newRunId}. Check [Proof] tab for complete details.`,
              timestamp: Date.now()
            });
          } else if (activeHomeBtnIdx === 1) {
            // Open Lanes (live agent panes)
            agent.emit('mode:change' as any, 'lanes');
          } else if (activeHomeBtnIdx === 2) {
            // Open Files
            agent.emit('mode:change' as any, 'files');
          }
          return;
        }

        if (input.trim()) {
          const text = input.trim();
          setInput('');
          setCursorPos(0);
          setActiveSuggestIdx(0);
          setActiveHomeBtnIdx(-1);
          
          if (text.startsWith('/')) {
            const res = handleSlashCommand(text, agent, state);
            if (res) {
              agent.emit('message:user', {
                role: 'assistant',
                content: `⚙️ **[SYSTEM]** ${res}`,
                timestamp: Date.now()
              });
            }
          } else {
            state.send(text);
          }
        }
      } else if (key.backspace || key.delete) {
        setInput(input.slice(0, -1));
        setCursorPos(Math.max(0, cursorPos - 1));
        setActiveSuggestIdx(0);
        setActiveHomeBtnIdx(-1);
      } else if (char && char !== '\t' && char !== '\r' && char !== '\n' && !key.ctrl && !key.meta) {
        setInput(input + char);
        setCursorPos(cursorPos + 1);
        setActiveSuggestIdx(0);
        setActiveHomeBtnIdx(-1);
      }
    } else if (focusSection === 'logRain') {
      // LogRain owns ↑↓ while focused; ←/Esc return to chat
      if (key.leftArrow || key.escape) {
        focusPane('chat');
      }
      return;
    } else {
      // focusSection === 'modelRail'
      if (key.rightArrow && ambientRain) {
        focusPane('logRain');
        return;
      }
      if (key.leftArrow || key.escape) {
        focusPane('chat');
        return;
      }
      if (key.upArrow) {
        setHighlightedModelIdx(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setHighlightedModelIdx(prev => Math.min(filteredModels.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const selectedModel = filteredModels[highlightedModelIdx];
        if (selectedModel) {
          state.switchModel(selectedModel.id);
          focusPane('chat');
          setModelChangedFlash(true);
          setTimeout(() => setModelChangedFlash(false), 1500);
          agent.emit('message:user', {
            role: 'assistant',
            content: `⚙️ **[SYSTEM]** Switched active model to: \`${selectedModel.id}\``,
            timestamp: Date.now()
          });
        }
        return;
      }
      if (char === 'd') { setShowModelDetail(v => !v); return; }
      if (char === 'o') {
        const m = filteredModels[highlightedModelIdx];
        if (m && (agent as any).addBrowserPane) (agent as any).addBrowserPane(`https://openrouter.ai/${m.id}`);
        return;
      }
      if (char && char !== '\t' && char !== '\r' && char !== '\n' && !key.ctrl && !key.meta) {
        setModelSearchQuery(prev => prev + char);
        setHighlightedModelIdx(0);
      } else if (key.backspace || key.delete) {
        setModelSearchQuery(prev => prev.slice(0, -1));
        setHighlightedModelIdx(0);
      }
    }
  });

  const totalLines = allLines.length;
  const maxScroll = Math.max(0, totalLines - visibleHeight);
  
  const renderScrollbar = () => {
    if (totalLines <= visibleHeight) {
      return (
        <Box flexDirection="column" width={2} alignItems="center" paddingLeft={1}>
          <Text color={theme.line}>▲</Text>
          {Array.from({ length: visibleHeight - 2 }).map((_, idx) => (
            <Text key={idx} color={theme.surfaceRaised}>│</Text>
          ))}
          <Text color={theme.line}>▼</Text>
        </Box>
      );
    }

    const trackHeight = visibleHeight;
    const scrollPct = scrollOffset / maxScroll;
    const handlePos = Math.round(scrollPct * (trackHeight - 3)) + 1;

    const track = [];
    for (let i = 0; i < trackHeight; i++) {
      if (i === 0) track.push('▲');
      else if (i === trackHeight - 1) track.push('▼');
      else if (i === handlePos) track.push('█');
      else track.push('░');
    }

    return (
      <Box flexDirection="column" width={2} alignItems="center" paddingLeft={1}>
        {track.map((char, idx) => (
          <Text key={idx} color={char === '█' ? theme.accent : theme.surfaceRaised}>{char}</Text>
        ))}
      </Box>
    );
  };

  return (
    <Box flexDirection="row" width={stageWidth} flexGrow={1} flexShrink={1}>
      {showDispatch && <DispatchRail width={36} />}
      {/* 1. Left Box: Chat Panel */}
      <Box flexDirection="column" flexGrow={1} width={chatWidth} paddingX={1}>
        
        {/* Short 1-line top guide header */}
        <Box paddingX={1} flexDirection="column" marginBottom={isCompact ? 0 : 1} width={chatWidth - 2}>
          <Box justifyContent="space-between" width="100%">
            <Text bold color={theme.accent}>💬 Main Chat</Text>
            {state.isThinking || state.isStreaming ? <Spinner color={theme.accent} label="thinking" /> : <Text color={theme.textSecondary}>Ready</Text>}
          </Box>
          <Box marginTop={0}>
            <Text bold color={theme.textPrimary}>OpenRouter Agent</Text>
            <Text color={theme.textSecondary}>  - "Ask TIMMY anything. Choose a model on the right."</Text>
          </Box>
        </Box>

        {/* Messages Viewport — flex-fills all remaining stage height */}
        <Box borderStyle="round" borderColor={theme.line} width={chatWidth - 2} flexDirection="row" paddingX={1} flexShrink={1} flexGrow={1}>
          
          {/* Scrollable text region */}
          <Box flexDirection="column" flexGrow={1} height={visibleHeight} justifyContent={totalLines <= visibleHeight ? 'flex-end' : 'flex-start'} overflowY="hidden">
            {checkpoints.length === 0 ? (
              <Box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1} justifyContent="space-around">
                
                <Box justifyContent="center" marginBottom={1}>
                  <Text bold color={theme.textPrimary}>Start here. Ask the OpenRouter agent what to do.</Text>
                </Box>
                
                {/* Available Tools Summary */}
                <Box flexDirection="column" borderStyle="single" borderColor={theme.line} paddingX={2} paddingY={isCompact ? 0 : 1} marginBottom={1}>
                  <Text bold color={theme.accent}>⚙️ Core trust chain:</Text>
                  <Text color={theme.textPrimary}> • <Text bold color={theme.accent}>OpenRouter Agent</Text>: model routing and agent reasoning</Text>
                  <Text color={theme.textPrimary}> • <Text bold color={theme.danger}>TIMMY Porter</Text>: MCP server ➔ CLI onboarding</Text>
                  <Text color={theme.textPrimary}> • <Text bold color={theme.accent}>carbonyl</Text>: headless Chromium browser lanes in terminal panes</Text>
                  <Text color={theme.textPrimary}> • <Text bold color={theme.warn}>OpenHands</Text>: autonomous headless runner for delegated fixes (lane 4)</Text>
                </Box>

                {/* Three Buttons - Position Stable Fixed Width */}
                <Box flexDirection="row" justifyContent="center" width="100%">
                  {activeHomeBtnIdx === 0 
                    ? <PrimaryButton label="Run Proof" selected={true} width={20} /> 
                    : <SecondaryButton label="Run Proof" selected={false} width={20} />
                  }
                  {activeHomeBtnIdx === 1 
                    ? <PrimaryButton label="Lanes" selected={true} width={20} /> 
                    : <SecondaryButton label="Lanes" selected={false} width={20} /> 
                  }
                  {activeHomeBtnIdx === 2
                    ? <PrimaryButton label="Files" selected={true} width={20} />
                    : <SecondaryButton label="Files" selected={false} width={20} />
                  }
                </Box>
                <Box justifyContent="center" width="100%">
                  <Text color={theme.textSecondary}>[1-3] pick · ↵ runs · → model rail</Text>
                </Box>

              </Box>
            ) : (
              visibleLines.map((line, i) => (
                <Text key={i} wrap="wrap">{line}</Text>
              ))
            )}
          </Box>

          {/* Dynamic visual scrollbar track */}
          {renderScrollbar()}
        </Box>

        {/* Autocomplete Suggestions */}
        {showAutocomplete && matches.length > 0 && (
          <Box paddingX={1} minHeight={1} width={chatWidth - 2} flexDirection="row" flexWrap="wrap" marginBottom={1} flexShrink={0}>
            <Box marginRight={2}>
              <Text color={theme.textSecondary}>Suggestions: </Text>
            </Box>
            {matches.map((m, idx) => {
              const isCurrent = idx === activeSuggestIdx;
              return (
                <Box key={m.command} marginRight={4}>
                  <Text color={isCurrent ? theme.accent : theme.textSecondary} bold={isCurrent}>
                    {isCurrent ? `▶ ${m.command}` : m.command}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {/* Input prompt box - Never disappears */}
        <Box borderStyle="single" borderColor={focusSection === 'chat' && zone >= 0 ? theme.accent : theme.line} paddingX={1} width={chatWidth - 2} flexShrink={0} marginTop={1}>
          <Text color={theme.textSecondary}>[ main-chat ] </Text>
          <Text color={theme.accent}>{state.isThinking ? '◌ ' : '▶ '} </Text>
          <Text color={theme.textPrimary} wrap="truncate">{scrollVisibleLeft(input, inputTextWidth)}</Text>
          <Text color={theme.accent}>{state.isStreaming || state.isThinking ? ' ···' : '█'}</Text>
        </Box>
      </Box>

      {/* 2. Right Box: OpenRouter Model Rail */}
      <Box width={railWidth} flexDirection="column" borderStyle="single" borderColor={modelChangedFlash ? theme.accent : (focusSection === 'modelRail' ? theme.accent : theme.line)} borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} paddingX={1} flexShrink={0}>
        <Box marginBottom={1} height={1} justifyContent="space-between" flexDirection="row">
          <Text bold color={focusSection === 'modelRail' ? theme.accent : theme.danger}>🤖 OPENROUTER MODELS</Text>
          {modelChangedFlash && <Text bold color={theme.accent}> [ 🤖 OK ]</Text>}
        </Box>

        {/* Active Model & Session Cost */}
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.textSecondary}>Active Model:</Text>
          <Text bold color={theme.textPrimary} wrap="truncate">{state.model}</Text>
          <Text color={theme.textSecondary}>Cost/Session: <Text bold color={theme.accent}>${state.totalCost.toFixed(4)}</Text></Text>
          <Text color={theme.textSecondary}>Model Health: <Text bold color={
            state.modelHealthStatus === 'READY' ? theme.accent :
            state.modelHealthStatus === 'FALLBACK READY' ? theme.warn :
            state.modelHealthStatus === 'ERROR' ? theme.danger : theme.textSecondary
          }>{state.modelHealthStatus || 'UNTESTED'}</Text></Text>
          <Text color={theme.textSecondary}>Provider Status: <Text bold color={
            state.modelHealthStatus === 'READY' ? theme.accent :
            state.modelHealthStatus === 'FALLBACK READY' ? theme.warn :
            state.modelHealthStatus === 'ERROR' ? theme.danger : theme.warn
          }>{
            state.modelHealthStatus === 'READY' ? 'ONLINE 🟢' :
            state.modelHealthStatus === 'FALLBACK READY' ? 'FALLBACK 🟡 ollama' :
            state.modelHealthStatus === 'ERROR' ? 'ERROR 🔴' : 'CHECKING ⏳'
          }</Text></Text>
          {state.modelHealthStatus === 'ERROR' && (agent as any).lastHealthError ? (
            <Text color={theme.textSecondary}>  └ {String((agent as any).lastHealthError).slice(0, 70)}</Text>
          ) : null}
        </Box>

        {/* Model Search Box */}
        <Box borderStyle="single" borderColor={focusSection === 'modelRail' ? theme.accent : theme.line} paddingX={1} marginBottom={1} flexShrink={0}>
          <Text color={theme.textSecondary}>[ search ] </Text>
          <Text color={theme.textPrimary} wrap="truncate">{scrollVisibleLeft(modelSearchQuery, 14)}</Text>
          {focusSection === 'modelRail' && <Text color={theme.accent}>█</Text>}
        </Box>

        {/* Scrollable Model List */}
        <Box flexDirection="column" height={railListHeight} overflowY="hidden">
          {filteredModels.length === 0 ? (
            <Text color={theme.textSecondary} italic>No matching models.</Text>
          ) : (
            visibleModels.map((m, idx) => {
              const actualIdx = startIdx + idx;
              const isSelected = actualIdx === highlightedModelIdx && focusSection === 'modelRail';
              const isActive = m.id === state.model;
              
              let marker = '  ';
              if (isSelected) marker = '▶ ';
              else if (isActive) marker = '● ';

              const { cleanName, cleanDesc } = splitModelNameAndBlurb(m.name || m.id, m.description);
              const { nameColor, descColor } = getModelColors(isSelected, isActive);
              
              const usableWidth = railWidth - 4;
              const nameText = truncateMiddleOrEnd(cleanName, usableWidth - 2);
              const descText = cleanDesc ? truncateMiddleOrEnd(cleanDesc, usableWidth - 2, true) : '';

              const priceText = (() => {
                try {
                  const p = (m as any).pricing;
                  if (!p) return '';
                  const inn = parseFloat(p.prompt);
                  const out = parseFloat(p.completion);
                  if (!isFinite(inn) && !isFinite(out)) return '';
                  if (inn === 0 && out === 0) return 'free';
                  const fmt = (v: number) => (v === 0 ? '$0' : `$${(v * 1e6).toFixed(2)}`);
                  return `${fmt(inn)}→${fmt(out)} /M tokens`;
                } catch {
                  return '';
                }
              })();

              // Descriptions only for the highlighted/active model — a rail of
              // mid-truncated blurbs was noise, not information.
              const showDescription = isSelected || isActive;

              return (
                <Box key={m.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text bold={isSelected || isActive} color={nameColor}>
                      {marker}{m.id.startsWith('ollama') || m.id.includes('local') ? '🏠 ' : '$ '}{nameText}
                    </Text>
                  </Box>
                  {showDescription && descText && (
                    <Box paddingLeft={2}>
                      <Text color={descColor}>{descText}</Text>
                    </Box>
                  )}
                  {showDescription && priceText && (
                    <Box paddingLeft={2}>
                      <Text color={theme.textSecondary}>{priceText}</Text>
                    </Box>
                  )}
                </Box>
              );
            })
          )}
        </Box>

        {/* Model detail card — ghost-bordered, bottom-docked; the list above stays fully visible */}
        {showModelDetail && (filteredModels[highlightedModelIdx] as any) && (() => {
          const dm = filteredModels[highlightedModelIdx] as any;
          const priceOf = (m: any): string => {
            try {
              const p = m?.pricing;
              if (!p) return '';
              const i = parseFloat(p.prompt), o = parseFloat(p.completion);
              if (!isFinite(i) && !isFinite(o)) return '';
              const f = (v: number) => (v === 0 ? '$0' : `$${(v * 1e6).toFixed(2)}`);
              return `${f(i)}→${f(o)}/M`;
            } catch { return ''; }
          };
          const activeModel = (rawModels as any[]).find(r => r.id === state.model);
          return (
            <Box flexDirection="column" borderStyle="single" borderColor={theme.line} paddingX={1} marginTop={1} flexShrink={0}>
              <Text bold color={theme.accent} wrap="truncate">{dm.name || dm.id}</Text>
              {wrapVisible(String(dm.description || 'no description'), Math.max(20, railWidth - 6)).slice(0, 7).map((l, i) => (
                <Text key={i} color={theme.textSecondary}>{l}</Text>
              ))}
              <Text color={theme.textSecondary}>
                {dm.context_length ? `${Math.round(dm.context_length / 1000)}k ctx · ` : ''}{priceOf(dm)}
              </Text>
              {activeModel && activeModel.id !== dm.id && (
                <Text color={theme.textSecondary} wrap="truncate">vs active {String(state.model).split('/').pop()}: {priceOf(activeModel)}</Text>
              )}
              <Text color={theme.textSecondary}>[d] close · [o] full page in carbonyl</Text>
            </Box>
          );
        })()}

        {/* Live log rain — newest at top, rains downward (stacked mode).
            v1.0.1: hidden in the COMMAND view; the header ticker owns live. */}
        {!threeCol && ambientRain && <LogRain height={rainHeight} focused={focusSection === 'logRain' && zone >= 0} />}

        <Box flexDirection="column" borderStyle="single" borderColor={theme.line} paddingX={1} borderBottom={false} borderLeft={false} borderRight={false} flexShrink={0}>
          <Text color={theme.textSecondary}>Tab·menu ←→·panes ↑↓·move</Text>
          <Text color={theme.textSecondary}>Enter·select Esc·back ?·keys</Text>
          <Text color={theme.textSecondary}>d·model detail o·open page</Text>
          <Text color={theme.textSecondary}>^K·palette · 1-3 home buttons</Text>
        </Box>
      </Box>

      {threeCol && (
        <Box width={rainWidth} flexDirection="column" flexShrink={0}>
          <LogRain height={terminalHeight - 12} focused={focusSection === 'logRain' && zone >= 0} />
        </Box>
      )}
    </Box>
  );
}
