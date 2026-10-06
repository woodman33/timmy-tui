// Where Timmy keeps operator state on this machine: TIMMY_HOME, else ~/timmy.
// Kept apart from the first-run wizard (init.ts) so features such as Timmy Pro
// can find it without depending on the wizard.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** TIMMY_HOME from the given environment only, else ~/timmy. */
export const resolveTimmyHome = (env: Readonly<Record<string, string | undefined>>): string => env.TIMMY_HOME?.trim() || join(homedir(), 'timmy');

/** TIMMY_HOME for this process. */
export const timmyHome = (): string => resolveTimmyHome(process.env);
