/** Whether `program` is an executable file in a PATH folder: no shell, nothing run. */
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export function onPath(program: string, env: Record<string, string | undefined> = process.env): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, program), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}
