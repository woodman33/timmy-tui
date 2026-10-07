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
