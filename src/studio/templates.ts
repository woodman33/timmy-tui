/**
 * Public board templates for Timmy Canvas (fourth order, step 5: public templates start blank). The
 * seeds shipped in the public tree (`templates/boards`, listed by its INDEX.json) are read as their
 * id, title, domain and capability names, and nothing else (other fields are never read); a seed whose
 * fields are not each in their own shape is skipped. The canvas opens one as a blank board: its title
 * and an empty slot per capability.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BoardTemplate {
  id: string;
  title: string;
  domain: string;
  caps: string[];
}

const ID = /^[A-Z]{1,3}\d{1,4}$/;
const CAP = /^[a-z]+(\.[a-z]+)+$/;
const TEXT = /^[\w &+.,/:'()-]{1,60}$/;

/** templates/boards, from the source (src/studio) or the build (dist/src/studio). */
export function templatesDir(): string {
  const candidates = ['../../templates/boards', '../../../templates/boards'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  return candidates.find(existsSync) ?? candidates[0];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** One seed as a template, or null when it is not one: four fields, each in its own shape. */
function asTemplate(seed: unknown, expectedId: string): BoardTemplate | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const { id, title, domain, caps } = seed as Record<string, unknown>;
  if (id !== expectedId || typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof title !== 'string' || !TEXT.test(title) || typeof domain !== 'string' || !TEXT.test(domain)) return null;
  if (!Array.isArray(caps) || caps.length === 0 || caps.length > 12 || !caps.every((c) => typeof c === 'string' && CAP.test(c))) return null;
  return { id, title, domain, caps: [...caps] };
}

/** The public board templates, in their index's order. */
export function publicTemplates(dir = templatesDir()): BoardTemplate[] {
  const index = readJson(join(dir, 'INDEX.json')) as { boards?: unknown } | null;
  const ids = Array.isArray(index?.boards) ? index.boards.filter((b): b is string => typeof b === 'string' && ID.test(b)) : [];
  return ids.map((id) => asTemplate(readJson(join(dir, `${id}.json`)), id)).filter((t): t is BoardTemplate => t !== null);
}

/**
 * R5 (H133): a guided blank board (the operator's order of 2026-10-15: "Templates shipped publicly start blank and guided,
 * without private creative assets"): its title, what it is for, and one empty frame per part, each with a line that says what
 * goes in it. Text only: a seed is read as these fields and nothing else (an image, an asset, a sample or a path is never read),
 * and a text that names an address or a home folder is refused with the whole seed.
 */
export interface GuidedTemplate {
  id: string;
  title: string;
  domain: string;
  intro: string;
  /** Frames joined left to right by arrows, in order. */
  flow: boolean;
  /** How many frames to a row (1-6). */
  columns: number;
  frames: Array<{ name: string; guide: string }>;
}

const GUIDED_ID = /^G\d{1,3}$/;
/** Words, numbers, spaces and plain punctuation, the arrow and the middle dot; no markup, braces, backslash or @. */
const PLAIN = /^[\p{L}\p{N} .,;:'"()?!/&+·→–—-]+$/u;
const NOT_PLAIN = /:\/\/|www\.|\/Users\/|\/home\/|\/root\/|~\//i;
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && PLAIN.test(v) && !NOT_PLAIN.test(v);

function asGuided(seed: unknown, expectedId: string): GuidedTemplate | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const { id, kind, title, domain, intro, flow, columns, frames } = seed as Record<string, unknown>;
  if (id !== expectedId || typeof id !== 'string' || !GUIDED_ID.test(id) || kind !== 'guided') return null;
  if (!plain(title, 80) || !plain(domain, 40) || !plain(intro, 400)) return null;
  if (flow !== undefined && typeof flow !== 'boolean') return null;
  if (columns !== undefined && !(Number.isInteger(columns) && (columns as number) >= 1 && (columns as number) <= 6)) return null;
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 12) return null;
  const parts: GuidedTemplate['frames'] = [];
  for (const f of frames) {
    if (typeof f !== 'object' || f === null) return null;
    const { name, guide } = f as Record<string, unknown>;
    if (!plain(name, 40) || !plain(guide, 280)) return null;
    parts.push({ name, guide });
  }
  return { id, title, domain, intro, flow: flow === true, columns: (columns as number | undefined) ?? Math.min(3, parts.length), frames: parts };
}

/** R5 (H133): the guided blank boards, in their index's order (INDEX.json `guided`). */
export function guidedTemplates(dir = templatesDir()): GuidedTemplate[] {
  const index = readJson(join(dir, 'INDEX.json')) as { guided?: unknown } | null;
  const ids = Array.isArray(index?.guided) ? index.guided.filter((b): b is string => typeof b === 'string' && GUIDED_ID.test(b)) : [];
  return ids.map((id) => asGuided(readJson(join(dir, `${id}.json`)), id)).filter((t): t is GuidedTemplate => t !== null);
}
