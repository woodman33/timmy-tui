// lanes/privacy/overlay.mjs is Claude Code's private-overlay reader
// (privacy-d5n9): plain ESM JavaScript; edge-host.ts imports it so the
// overlay → env → placeholder resolution has one implementation.
declare module '*privacy/overlay.mjs' {
  export const ROOT: string;
  export const PRIVATE_DIR: string;
  export function privatePath(rel: string): { path: string; source: 'private' | 'template' | 'public' | 'missing' };
  export function readPrivateJson(rel: string): { data: unknown; source: string; path: string };
  export function writePrivateJson(rel: string, data: unknown): string;
  export function relPath(p: string): string;
  export function publicNodeRef(node: unknown): string;
  export function isPlaceholder(v: unknown): boolean;
}
