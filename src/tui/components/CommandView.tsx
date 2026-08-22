// v1.0.2 radical de-clutter — View [1] is ONLY the conversation plus one
// clean bordered prompt box. No model rail, no action cards, no rain, no
// scroll thumb, no nested boxes. Internal system chatter is filtered out
// of the scrollback entirely.
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAgent } from '../hooks/useAgent.js';
import { theme } from '../theme.js';
import { handleSlashCommand } from '../../utils/slash-commands.js';
import type { Agent } from '../../agent/core.js';
import { ViewportContext } from '../layout.js';

const NOISE: RegExp[] = [
  /Saved to Cloudflare/i,
  /state[- ]?sync/i,
  /internal checkpoint/i,
  /run\.created/i,
  /telemetry:run/i,
  /\[SYSTEM\] Mock proof/i,
  /\[SYSTEM\] Switched active model/i
];

export const isNoise = (text: string): boolean => NOISE.some(r => r.test(text));

const wrap = (text: string, width: number): string[] => {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw;
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width);
      if (cut < width / 2) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
};

interface Line { text: string; kind: 'user' | 'agent' | 'err' }

export function CommandView({ agent }: { agent: Agent }) {
  const { w: width, h: height } = React.useContext(ViewportContext);
  const state = useAgent(agent);
  const [input, setInput] = useState('');
  const [scroll, setScroll] = useState(0); // lines up from the tail

  const lines = React.useMemo(() => {
    const out: Line[] = [];
    for (const m of state.messages) {
      const content = String(m.content ?? '');
      if (!content || isNoise(content)) continue;
      if (m.role === 'user') {
        wrap(`▶ ${content}`, Math.max(24, width - 4)).forEach((l, i) => out.push({ text: i === 0 ? l : `  ${l}`, kind: 'user' }));
      } else {
        wrap(content, Math.max(24, width - 6)).forEach(l => out.push({ text: `  ${l}`, kind: 'agent' }));
      }
    }
    if (state.isStreaming && state.streamingText) {
      wrap(state.streamingText, Math.max(24, width - 6)).forEach(l => out.push({ text: `  ${l}`, kind: 'agent' }));
      out.push({ text: '  ▌', kind: 'agent' });
    } else if (state.isThinking) {
      out.push({ text: '  ◌ thinking…', kind: 'agent' });
    }
    if (state.error) out.push({ text: `✕ ${state.error.message}`, kind: 'err' });
    return out;
  }, [state.messages, state.isStreaming, state.streamingText, state.isThinking, state.error, width]);

  const INPUT_H = 3;
  const viewH = Math.max(4, height - INPUT_H);
  const maxScroll = Math.max(0, lines.length - viewH);
  const clamped = Math.min(scroll, maxScroll);
  const end = lines.length - clamped;
  const visible = lines.slice(Math.max(0, end - viewH), end);

  useInput((char, key) => {
    if (key.upArrow) { setScroll(s => Math.min(maxScroll, s + 1)); return; }
    if (key.downArrow) { setScroll(s => Math.max(0, s - 1)); return; }
    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInput('');
      if (text.startsWith('/')) {
        const res = handleSlashCommand(text, agent, state);
        if (res) agent.emit('message:user', { role: 'assistant', content: `⚙️ ${res}`, timestamp: Date.now() });
      } else {
        state.send(text);
      }
      setScroll(0);
      return;
    }
    if (key.backspace || key.delete) { setInput(v => v.slice(0, -1)); return; }
    if (char && !key.ctrl && !key.meta && char !== '\t' && char !== '\r' && char !== '\n') setInput(v => v + char);
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((l, i) => (
          <Text
            key={i}
            color={l.kind === 'user' ? theme.info : l.kind === 'err' ? theme.error : theme.textPrimary}
            bold={l.kind === 'user'}
            wrap="truncate"
          >
            {l.text}
          </Text>
        ))}
      </Box>
      {/* input bar lives inside the round card — no nested borders (v1.0.4) */}
      <Box flexShrink={0} marginTop={1}>
        <Text color={theme.focus}>▶ </Text>
        <Text color={input ? theme.textPrimary : theme.textTertiary}>{input ? `${input}▌` : `${width < 70 ? '[Type a command...]' : '[Type a command or mission prompt...]'}▌`}</Text>
      </Box>
    </Box>
  );
}
