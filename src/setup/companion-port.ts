/**
 * The browser companion's port as `timmy watch` asks for it (round R4, H98). r24 found TIMMY_COMPANION_PORT ignored: the
 * monitor (cli.tsx) read only --companion-port (3001 by default), so the companion took 3001. `timmy watch` now passes the
 * variable on as that flag (a flag given wins), and refuses a value that is not a port; the monitor says which port the
 * companion took whenever it is not the one asked for (src/tui/components/ShellV2.tsx, from askedCompanionPort).
 */
export type Env = Record<string, string | undefined>;

export const COMPANION_PORT_DEFAULT = 3001;

const FLAG = '--companion-port';
const isPort = (v: string): boolean => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

/** The monitor's arguments with TIMMY_COMPANION_PORT passed on as --companion-port, or why the variable cannot be one. */
export function companionPortArgs(pass: readonly string[], env: Env): { args: string[] } | { error: string } {
  const raw = env.TIMMY_COMPANION_PORT?.trim();
  if (!raw || pass.some((a) => a === FLAG || a.startsWith(`${FLAG}=`))) return { args: [...pass] };
  if (!isPort(raw)) return { error: `TIMMY_COMPANION_PORT is "${raw}", which is not a port (1 to 65535): unset it, or set a port, then start timmy watch again.` };
  return { args: [...pass, FLAG, String(Number(raw))] };
}

/** The port the companion was asked for: --companion-port among the monitor's arguments, else TIMMY_COMPANION_PORT, else 3001. */
export function askedCompanionPort(argv: readonly string[], env: Env): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = a === FLAG ? argv[i + 1] : a.startsWith(`${FLAG}=`) ? a.slice(FLAG.length + 1) : undefined;
    if (v !== undefined) return isPort(v.trim()) ? Number(v.trim()) : COMPANION_PORT_DEFAULT;
  }
  const raw = env.TIMMY_COMPANION_PORT?.trim();
  return raw && isPort(raw) ? Number(raw) : COMPANION_PORT_DEFAULT;
}

/** What to say when the companion took another port than the one asked for; null when it took that one (or none runs). */
export function companionPortNote(asked: number, took: number | undefined): string | null {
  if (took === undefined || took === asked) return null;
  return `Browser companion on port ${took}: ${asked}, the port asked for, was taken.`;
}

/** The same, short enough for the monitor's STATUS card (its full sentence is on the pairing card, q on HOME). */
export function companionPortShort(asked: number, took: number | undefined): string | null {
  if (took === undefined || took === asked) return null;
  return `companion on port ${took} (${asked} was taken)`;
}
