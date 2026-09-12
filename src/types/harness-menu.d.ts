// fleet/harness-menu.mjs is Claude Code's project-folder reader (mindship-v5c2
// step 5). It is plain ESM JavaScript; warroom2 imports it so the war room and
// the harness menus agree by construction instead of by copy.
declare module '*harness-menu.mjs' {
  export const PROJECTS_ROOT: string;
  export const STANDARD: string;
  export const LAYOUT: string[];
  export function readProject(name: string, root?: string): {
    ok: boolean; name: string; dir: string;
    profile?: { budget?: { max_spend_usd?: number }; harnesses?: { allowed?: string[] }; models?: string[] };
    skills: { name?: string; path?: string }[];
    plans: { name?: string; path?: string }[];
    boards: { name?: string; path?: string }[];
    drop: { name?: string; path?: string }[];
    out: { name?: string; path?: string }[];
  };
  export function harnessMenu(project: unknown, harness: string | null, runners?: Record<string, unknown>): Record<string, unknown>;
}
