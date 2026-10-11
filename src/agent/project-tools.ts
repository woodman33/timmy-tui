/**
 * The agent's project file tools (R1 workspace direction, 2026-10-08): list, read and write files in the
 * REPL's active project through src/project's guards (inside the project, no links out, never keys, .env
 * files or .timmy/private). Writing asks first (NEEDS YOU, src/repl/approvals.ts). Each write is kept for
 * the turn's receipt: the file and its hashes before and after.
 */
import { basename } from 'node:path';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { z } from 'zod/v4';
import { listProjectFiles, readProjectFile, writeProjectFile, type FileRole } from '../project/index.js';
// Round R4 (H50): Timmy Memory's recall over the project's retained records, read only (src/memory/tool.ts).
import { recallForAgent } from '../memory/tool.js';
import type { Receipt } from '../utils/receipts.js';

export interface TouchedFile { path: string; sha256: string; previous_sha256?: string; created: boolean; bytes: number }

/** The files a turn wrote, for its receipt: the first hash before the turn and the last after it. */
export class ProjectTurnFiles {
  private files = new Map<string, TouchedFile>();

  saw(f: TouchedFile): void {
    const first = this.files.get(f.path);
    const merged: TouchedFile = { path: f.path, sha256: f.sha256, bytes: f.bytes, created: first ? first.created : f.created };
    const previous = first ? first.previous_sha256 : f.previous_sha256;
    if (previous) merged.previous_sha256 = previous;
    this.files.set(f.path, merged);
  }

  close(): TouchedFile[] {
    const out = [...this.files.values()];
    this.files = new Map();
    return out;
  }
}

export interface ProjectToolOptions {
  root: () => string;
  touched?: ProjectTurnFiles;
  /** R4 (H50): the runs chain recall_project_work checks seals against; absent: this store's runs chain (readChain). */
  chain?: () => readonly Receipt[];
}

const ROLES = ['source', 'reference', 'script', 'workflow', 'output', 'history', 'other'] as const;
const answer = z.record(z.string(), z.unknown());

export function createProjectTools(o: ProjectToolOptions) {
  const list = tool({
    name: 'list_project_files',
    description: "List the files in the operator's active project, by role: source, reference, script, workflow (upmd Markdown), output, history or other. Paths are relative to the project folder; dependencies, git, dotfiles and private files are never listed.",
    inputSchema: z.object({
      role: z.enum(ROLES).optional().describe('Only files of this role'),
      under: z.string().optional().describe('Only files under this folder, relative to the project'),
    }),
    outputSchema: answer,
    execute: async ({ role, under }: { role?: FileRole; under?: string }) => {
      const { files, truncated } = listProjectFiles(o.root());
      const prefix = under ? `${under.replace(/^\.?\/+/, '').replace(/\/+$/, '')}/` : '';
      const picked = files.filter((f) => (!role || f.role === role) && (!prefix || f.rel.startsWith(prefix)));
      const shown = picked.slice(0, 300);
      return { ok: true, project: basename(o.root()), files: shown.map((f) => ({ path: f.rel, role: f.role, bytes: f.bytes })), total: picked.length, truncated: truncated || picked.length > shown.length };
    },
  });
  const read = tool({
    name: 'read_project_file',
    description: "Read a text file in the operator's active project (up to 64 KB; a longer file is cut and says so). Binary files are named, not read. Keys, .env files and .timmy/private are refused.",
    inputSchema: z.object({ path: z.string().describe('Path relative to the project folder') }),
    outputSchema: answer,
    execute: async ({ path }: { path: string }) => {
      let r: ReturnType<typeof readProjectFile>;
      try { r = readProjectFile(o.root(), path); } catch (err) { return { ok: false, error: `${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` }; }
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, path: r.rel, bytes: r.bytes, ...(r.binary ? { binary: true } : { text: r.text ?? '' }), ...(r.truncated ? { truncated: true } : {}) };
    },
  });
  const write = tool({
    name: 'write_project_file',
    description: "Create or replace a text file in the operator's active project with its complete new content. The operator is asked first. Read an existing file before changing it, and write the whole file.",
    inputSchema: z.object({
      path: z.string().describe('Path relative to the project folder'),
      content: z.string().describe('The complete new content of the file'),
    }),
    outputSchema: answer,
    execute: async ({ path, content }: { path: string; content: string }) => {
      let r: ReturnType<typeof writeProjectFile>;
      try { r = writeProjectFile(o.root(), path, content); } catch (err) { return { ok: false, error: `${path} could not be written (${(err as NodeJS.ErrnoException).code ?? 'error'})` }; }
      if (!r.ok) return { ok: false, error: r.error };
      o.touched?.saw({ path: r.rel, sha256: r.sha256, bytes: r.bytes, created: r.created, ...(r.previousSha256 ? { previous_sha256: r.previousSha256 } : {}) });
      return { ok: true, path: r.rel, bytes: r.bytes, created: r.created };
    },
  });
  // R4 (H50): the same hits as /recall (by words, not meaning), as data; read only, so it asks nothing.
  const recallWork = tool({
    name: 'recall_project_work',
    description: "Search what the operator's active project retained for words (by words, not meaning): flow records, VoxVision records, observations, code-agent runs, MCP calls (server, tool and arguments, never their output), native runs, recipe jobs, workflow runs and lessons. Each hit gives when, the kind of record, its state in words, one line, the file to open (read it with read_project_file) and the receipt that seals it, or why none does; a record that could not be read is named. Lessons are text with evidence; no model is trained.",
    inputSchema: z.object({
      words: z.string().describe('The words to look for, each two characters or more'),
      more: z.boolean().optional().describe('Up to 40 hits instead of 10'),
    }),
    outputSchema: answer,
    execute: async ({ words, more }: { words: string; more?: boolean }) => {
      try { return recallForAgent(o.root(), words, { ...(more ? { more } : {}), ...(o.chain ? { chain: o.chain } : {}) }); } catch (err) {
        return { ok: false, error: `the project's records could not be searched (${err instanceof Error ? err.message : String(err)})` };
      }
    },
  });
  return [list, read, write, recallWork];
}
