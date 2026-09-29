import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';
import chalk from 'chalk';
import { theme } from '../theme.js';

interface ProgressBarProps {
  value: number; // 0-1
  width?: number;
  label?: string;
  showPercent?: boolean;
  color?: string;
}

export function ProgressBar({ value, width = 30, label, showPercent = true, color = theme.accent }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const safeWidth = Math.max(1, Math.floor(width));
  const filled = Math.round(clamped * safeWidth);
  const empty = safeWidth - filled;

  const bar = chalk.hex(color)('█'.repeat(filled)) + chalk.hex(theme.textMuted)('░'.repeat(empty));
  const pct = showPercent ? ` ${Math.round(clamped * 100)}%` : '';

  return (
    <Box>
      <Text>{bar}{pct}</Text>
      {label && <Text> {label}</Text>}
    </Box>
  );
}

export function IndeterminateBar({ width = 30, label }: { width?: number; label?: string }) {
  const safeWidth = Math.max(1, Math.floor(width));
  const [pos, setPos] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setPos(p => (p + 1) % safeWidth);
    }, 100);
    return () => clearInterval(interval);
  }, [safeWidth]);

  const chars = '░'.repeat(safeWidth).split('');
  const dotWidth = Math.min(4, safeWidth);
  for (let i = 0; i < dotWidth; i++) {
    const idx = (pos + i) % safeWidth;
    chars[idx] = '█';
  }

  return (
    <Box>
      <Text>{chalk.hex(theme.accent)(chars.join(''))}</Text>
      {label && <Text> {label}</Text>}
    </Box>
  );
}
