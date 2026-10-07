/**
 * Timmy Canvas (plan F-4): Timmy's own tldraw canvas, served on 127.0.0.1.
 * One pinned tldraw version; the page loads exactly this version, and a test keeps them together.
 */
export const TLDRAW_VERSION = '5.5.2';

/** Where Timmy Canvas listens by default (the Mission Map's vision server has 4336). */
export const STUDIO_PORT = 4337;

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
