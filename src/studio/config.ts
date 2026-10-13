/**
 * Timmy Canvas (plan F-4): Timmy's own tldraw canvas, served on 127.0.0.1.
 * One pinned tldraw version; the page loads exactly this version, and a test keeps them together.
 */
export const TLDRAW_VERSION = '5.5.2';

/** Where Timmy Canvas listens by default (the Mission Map's vision server has 4336). */
export const STUDIO_PORT = 4337;

type Env = Record<string, string | undefined>;

/** The port Timmy Canvas uses here: TIMMY_STUDIO_PORT when it is a port number, else 4337 (round R1). */
export function studioPort(env: Env = process.env): number {
  const n = Number(env.TIMMY_STUDIO_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : STUDIO_PORT;
}

/**
 * Where Timmy Canvas answers, for every caller (the REPL, the agent's canvas tools, the web views and
 * the receipt links): TIMMY_STUDIO_URL without its trailing slash, else 127.0.0.1 on studioPort().
 */
export function studioBaseUrl(env: Env = process.env): string {
  const url = env.TIMMY_STUDIO_URL?.trim();
  return (url ? url : `http://127.0.0.1:${studioPort(env)}`).replace(/\/+$/, '');
}

export interface StudioConfig {
  /** The tldraw license, or null: tldraw then runs in development mode (no key needed on 127.0.0.1). */
  licenseKey: string | null;
  tldrawVersion: string;
}

/**
 * The license comes from TLDRAW_LICENSE_KEY at run time: the same name as the operator's GitHub
 * Actions secret, which a workflow maps into the environment. It is never stored in the repo and
 * never printed. tldraw checks it offline in the page, against the domains it lists.
 */
export function studioConfig(env: Record<string, string | undefined>): StudioConfig {
  const key = env.TLDRAW_LICENSE_KEY?.trim();
  return { licenseKey: key ? key : null, tldrawVersion: TLDRAW_VERSION };
}
