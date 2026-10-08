import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { themeFiles } from '../src/term/theme-files.js';

// The terminal palettes in assets/themes are generated from src/term/palettes.ts; this test fails
// when a file drifts from the source (regenerate with: npx tsx scripts/ui/themes.ts).
describe('assets/themes', () => {
  const files = themeFiles();
  it('ships Timmy Homebrew, Night and Day for Ghostty, iTerm2, WezTerm, kitty and Alacritty; Homebrew for macOS Terminal; zellij', () => {
    expect(Object.keys(files).sort()).toEqual([
      'alacritty/timmy-day.toml', 'alacritty/timmy-homebrew.toml', 'alacritty/timmy-night.toml',
      'ghostty/timmy-day', 'ghostty/timmy-homebrew', 'ghostty/timmy-night',
      'iterm2/Timmy Day.itermcolors', 'iterm2/Timmy Homebrew.itermcolors', 'iterm2/Timmy Night.itermcolors',
      'kitty/timmy-day.conf', 'kitty/timmy-homebrew.conf', 'kitty/timmy-night.conf',
      'terminal/Timmy Homebrew.terminal',
      'wezterm/Timmy Day.toml', 'wezterm/Timmy Homebrew.toml', 'wezterm/Timmy Night.toml',
      'zellij/timmy.kdl',
    ]);
    expect(files['ghostty/timmy-homebrew']).toContain('palette = 2=#28fe14');
    expect(files['ghostty/timmy-night']).toContain('background = #000000');
    expect(files['ghostty/timmy-night']).toContain('palette = 2=#33ff66');
    expect(files['kitty/timmy-day.conf']).toContain('color8 #595959');
  });
  it('matches the files on disk byte for byte', () => {
    for (const [path, content] of Object.entries(files)) {
      expect(readFileSync(join('assets/themes', path), 'utf8'), path).toBe(content);
    }
  });
});
