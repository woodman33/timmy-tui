import React from 'react';
import { render } from 'ink';
import { WizardScreen } from './wizard.js';

/** Explicit settings UI; importing this module never renders, writes or changes cwd. */
export async function runWizard(args: string[] = []): Promise<number> {
  if (args.some(arg => !['--tui', '--dry-run'].includes(arg))) {
    console.error('Settings wizard accepts --tui and --dry-run; use plain timmy init for identity setup.');
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('The settings wizard requires a terminal. Use timmy init without --tui for non-interactive setup.');
    return 1;
  }
  const app = render(<WizardScreen cwd={process.cwd()} dry={args.includes('--dry-run')} />);
  await app.waitUntilExit();
  return 0;
}
