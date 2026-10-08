/**
 * Ctrl+G (C-10): the input opens in your editor, $VISUAL, then $EDITOR, then vi (Neovim included),
 * and what you save comes back as the input. The command may carry its own arguments ("code --wait");
 * the file is handed to it as an argument and never parsed by a shell. The file is 0600 in a private
 * folder and removed afterwards. An editor that fails or is missing leaves the input as it was (null).
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function editExternally(text: string, env: Record<string, string | undefined> = process.env, opts: SpawnSyncOptions = { stdio: 'inherit' }): string | null {
  const command = (env.VISUAL || env.EDITOR || 'vi').trim();
  const dir = mkdtempSync(join(tmpdir(), 'timmy-input-'));
  const file = join(dir, 'input.md');
  try {
    writeFileSync(file, text, { mode: 0o600 });
    // The command is the operator's own setting; the file reaches it as "$1", never as shell text.
    const r = spawnSync('sh', ['-c', `${command} "$1"`, 'timmy-editor', file], { ...opts, env: { ...process.env, ...env } as NodeJS.ProcessEnv });
    if (r.error || r.status !== 0) return null;
    return readFileSync(file, 'utf8').replace(/\n+$/, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
