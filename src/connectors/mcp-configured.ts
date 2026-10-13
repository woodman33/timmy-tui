/**
 * Round R4 (helper H107; r25, the scripted rehearsal on the operator's Mac at 5e5cbb3, finding D13): whether an MCP server
 * is configured for Timmy, by name, read from MCPorter's own configuration files only: nothing is run, no server is
 * started or contacted. /lanes said "unreal-mcp Unreal MCP · found (not checked)" only because mcporter, the program that
 * lane runs, was on PATH (as a package dependency); a lane that runs `mcporter call <server>.…` is found only when its
 * server is configured here (src/utils/dispatch.ts listLanes).
 *
 * Which files, as MCPorter 0.12.4 itself finds its layers (node_modules/mcporter/dist/config/path-discovery.js) when Timmy's
 * route runs it (src/connectors/mcp-cli.ts: the route gives MCPorter TIMMY_MCP_HOME as its home when that is set):
 *   - with $MCPORTER_CONFIG set: that file alone (a leading ~ is the home);
 *   - else the home config, the first of $XDG_CONFIG_HOME/mcporter/mcporter.json[c] (when XDG_CONFIG_HOME is set and
 *     absolute) and <home>/.mcporter/mcporter.json[c] that exists, where <home> is TIMMY_MCP_HOME when set and absolute,
 *     else HOME; and the route's own config, ./config/mcporter.json in the folder the route runs in.
 * A server is configured when a layer's `mcpServers` names it. The editors' configs MCPorter can import (Cursor, Claude
 * Code and the rest) are not Timmy's: a server there does not count. A file that cannot be read as JSON (comments and
 * trailing commas allowed, as MCPorter reads them) is named as unreadable, never taken for a server.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

type Env = Record<string, string | undefined>;

export interface McpServerConfigured {
  configured: boolean;
  /** the file that names it (~ for the home, relative to the folder it was asked from when under it) */
  where?: string;
  /** every file read, in order, written as `where` is */
  checked: string[];
  /** files that were there and could not be read as JSON */
  unreadable?: string[];
}

/** The most of a config file this reads. */
const MAX_BYTES = 1024 * 1024;

/** JSON with comments (line and block) and trailing commas, as MCPorter reads its configs; undefined when it is not. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[++i] ?? ''; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; out += ' '; continue; }
    out += ch;
  }
  // a trailing comma (before } or ], outside strings) is dropped
  let cleaned = '';
  inString = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      cleaned += ch;
      if (ch === '\\') { cleaned += out[++i] ?? ''; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',') {
      let k = i + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    cleaned += ch;
  }
  try { return JSON.parse(cleaned); } catch { return undefined; }
}

/** The files MCPorter would read, in its order (see the module comment). */
export function mcporterConfigFiles(o: { env?: Env; cwd?: string } = {}): { files: string[]; home: string; homeName: string; cwd: string } {
  const env = o.env ?? process.env;
  const cwd = resolve(o.cwd ?? process.cwd());
  const mcpHome = env.TIMMY_MCP_HOME?.trim();
  const home = mcpHome && isAbsolute(mcpHome) ? mcpHome : env.HOME?.trim() || homedir();
  // how the home is written in what is said: never as its path
  const homeName = mcpHome && isAbsolute(mcpHome) ? 'TIMMY_MCP_HOME' : '~';
  const expand = (p: string): string => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
  const explicit = env.MCPORTER_CONFIG?.trim();
  if (explicit) return { files: [resolve(cwd, expand(explicit))], home, homeName, cwd };
  const candidates: string[] = [];
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const legacy = join(home, '.mcporter');
  const xdgDir = xdg ? expand(xdg) : undefined;
  const base = xdgDir && isAbsolute(xdgDir) ? join(xdgDir, 'mcporter') : legacy;
  candidates.push(join(base, 'mcporter.json'), join(base, 'mcporter.jsonc'));
  if (base !== legacy) candidates.push(join(legacy, 'mcporter.json'), join(legacy, 'mcporter.jsonc'));
  const exists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };
  const files: string[] = [];
  const first = candidates.find(exists);
  if (first) files.push(first);
  const project = join(cwd, 'config', 'mcporter.json');
  if (exists(project)) files.push(project);
  return { files, home, homeName, cwd };
}

/** Whether MCPorter's configuration names `name` (see the module comment). Reads files only. */
export function mcporterServerConfigured(name: string, o: { env?: Env; cwd?: string } = {}): McpServerConfigured {
  const { files, home, homeName, cwd } = mcporterConfigFiles(o);
  /** `p` relative to `base`, with / between its parts, when it lies inside it; else undefined */
  const inside = (base: string, p: string): string | undefined => { const r = relative(base, p); return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : undefined; };
  // a file is named relative to the folder asked from (the project) unless that folder holds a home (a REPL started in / or
  // /home would name a home's file by its path), else from the home (~, or TIMMY_MCP_HOME), never by an absolute path
  const holdsHome = inside(cwd, home) !== undefined || inside(cwd, homedir()) !== undefined;
  const shown = (p: string): string => {
    const r = holdsHome ? undefined : inside(cwd, p);
    if (r) return r;
    const h = inside(home, p);
    if (h) return `${homeName}/${h}`;
    const own = inside(homedir(), p);
    return own ? `~/${own}` : `a file outside the project and the home (${basename(p)})`;
  };
  const checked: string[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      if (lstatSync(file).size > MAX_BYTES) { unreadable.push(shown(file)); checked.push(shown(file)); continue; }
      text = readFileSync(file, 'utf8');
    } catch { continue; } // not there (an explicit $MCPORTER_CONFIG that is missing names no server)
    checked.push(shown(file));
    const value = parseJsonc(text);
    const servers = value && typeof value === 'object' && !Array.isArray(value) ? (value as { mcpServers?: unknown }).mcpServers : undefined;
    if (value === undefined || (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers)))) { unreadable.push(shown(file)); continue; }
    if (servers && Object.prototype.hasOwnProperty.call(servers, name)) return { configured: true, where: shown(file), checked, ...(unreadable.length ? { unreadable } : {}) };
  }
  return { configured: false, checked, ...(unreadable.length ? { unreadable } : {}) };
}

/** The server an MCP-backed lane reaches (its task runs `mcporter call <server>.{task}`), or undefined for any other lane. */
export function mcporterLaneServer(runner: { cmd: string; task?: string }): string | undefined {
  if (runner.cmd !== 'mcporter') return undefined;
  return /^mcporter call ([A-Za-z0-9_-][A-Za-z0-9_.-]*?)\.\{task\}/.exec(runner.task ?? '')?.[1];
}
