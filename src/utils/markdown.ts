import chalk from 'chalk';
import { truncateVisible, wrapVisible } from '../tui/utils/text.js';
import { theme } from '../tui/theme.js';

function wrapLine(line: string, wrapWidth: number): string[] {
  if (wrapVisible(line, wrapWidth).length === 1) {
    return [line];
  }

  // Detect list item prefixes (e.g. "- ", "* ", "• ", "1. ")
  const listMatch = line.match(/^(\s*(?:-|\*|•|\d+\.)\s+)/);
  let prefix = '';
  let content = line;

  if (listMatch) {
    prefix = listMatch[1];
    content = line.slice(prefix.length);
  } else if (line.startsWith('> ')) {
    prefix = '> ';
    content = line.slice(2);
  }

  const wrapped: string[] = [];
  const limit = Math.max(10, wrapWidth - prefix.length);
  wrapped.push(...wrapVisible(content, limit));

  if (wrapped.length === 0) {
    return [line];
  }

  const result: string[] = [];
  result.push(prefix + wrapped[0]);
  const indent = ' '.repeat(prefix.length);
  for (let i = 1; i < wrapped.length; i++) {
    result.push(indent + wrapped[i]);
  }

  return result;
}

export function renderMarkdown(text: string, width: number = 80): string {
  const lines = text.split('\n');
  const rendered: string[] = [];
  let inCode = false;

  const boxWidth = Math.max(25, width - 3);
  const wrapWidth = Math.max(25, width - 3);

  // We wrap prose lines before parsing markdown syntax to prevent ANSI length calculations issues
  const processedLines: { text: string; rawInCode: boolean }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      processedLines.push({ text: line, rawInCode: false });
      continue;
    }

    if (inCode) {
      processedLines.push({ text: line, rawInCode: true });
    } else {
      const wrapped = wrapLine(line, wrapWidth);
      for (const w of wrapped) {
        processedLines.push({ text: w, rawInCode: false });
      }
    }
  }

  // Reset inCode tracker for styling pass
  inCode = false;

  for (const item of processedLines) {
    const { text: line, rawInCode } = item;
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      rendered.push(chalk.dim(inCode ? '┌─ code ' + '─'.repeat(boxWidth - 9) + '┐' : '└' + '─'.repeat(boxWidth - 2) + '┘'));
      continue;
    }

    if (rawInCode || inCode) {
      const contentWidth = boxWidth - 4;
      const padded = truncateVisible(line, contentWidth).padEnd(contentWidth, ' ');
      rendered.push(chalk.dim('│ ') + chalk.hex(theme.textSecondary)(padded) + chalk.dim(' │'));
      continue;
    }

    if (trimmed === '---') {
      if (rendered.length > 0 && rendered[rendered.length - 1] !== '') {
        rendered.push('');
      }
      rendered.push(chalk.hex(theme.line)('─'.repeat(boxWidth)));
      rendered.push('');
      continue;
    }

    // Prepend vertical spacing before sections/headers/emoji badges to maintain a clean layout
    const isSectionStart = 
      trimmed.startsWith('#') || 
      trimmed.startsWith('•') || 
      trimmed.startsWith('|') ||
      trimmed.startsWith('🎯') || 
      trimmed.startsWith('🔋') || 
      trimmed.startsWith('🎛️') || 
      trimmed.startsWith('🚀');

    if (isSectionStart) {
      if (rendered.length > 0 && rendered[rendered.length - 1] !== '') {
        rendered.push('');
      }
    }

    let processed = line;
    processed = processed.replace(/\*\*(.*?)\*\*/g, chalk.bold('$1'));
    processed = processed.replace(/\*(.*?)\*/g, chalk.italic('$1'));
    processed = processed.replace(/`(.*?)`/g, chalk.bold('`$1`'));
    processed = processed.replace(/^- (.*)$/m, chalk.hex(theme.textMuted)('• ') + '$1');
    processed = processed.replace(/^#{1,6}\s+(.*)$/, chalk.bold.underline('$1'));
    processed = processed.replace(/\[(.*?)\]\((.*?)\)/g, `\x1b]8;;$2\x1b\\${chalk.underline('$1')}\x1b]8;;\x1b\\`);

    rendered.push(processed);
  }

  return rendered.join('\n');
}
