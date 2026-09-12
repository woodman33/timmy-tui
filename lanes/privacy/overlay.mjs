// The private overlay (ORDER privacy-d5n9 step 2): site-specific data lives at
// <repo>/.timmy/private/… (gitignored with the rest of .timmy/), the public tree
// keeps templates with placeholders. A lane asks `privatePath('fleet/nodes.json')`
// and gets the overlay file when it exists, else the committed template
// (`fleet/nodes.example.json`), else the public path — and it can tell which.
//
// Receipts committed publicly must use `publicNodeRef(node)` (the node id) and
// `relPath(p)` (repo-relative, never a home path).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
export const PRIVATE_DIR = join(ROOT, '.timmy', 'private');

/** Where a site-specific file is read from: the private overlay, the .example template, or the public path. */
export function privatePath(rel) {
  const priv = join(PRIVATE_DIR, rel);
  if (existsSync(priv)) return { path: priv, source: 'private' };
  const example = rel.replace(/(\.[a-z]+)$/i, '.example$1');
  if (existsSync(join(ROOT, example))) return { path: join(ROOT, example), source: 'template' };
  return { path: join(ROOT, rel), source: existsSync(join(ROOT, rel)) ? 'public' : 'missing' };
}

export function readPrivateJson(rel) {
  const { path, source } = privatePath(rel);
  if (source === 'missing') return { data: null, source, path };
  return { data: JSON.parse(readFileSync(path, 'utf8')), source, path };
}

export function writePrivateJson(rel, data) {
  const p = join(PRIVATE_DIR, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 1) + '\n', { mode: 0o600 });
  return p;
}

/** A path as a receipt may carry it: repo-relative, and never a home directory. */
export function relPath(p) {
  if (!p) return '';
  const abs = isAbsolute(p) ? p : resolve(ROOT, p);
  const r = relative(ROOT, abs);
  if (!r.startsWith('..')) return r.split('\\').join('/');
  const home = homedir();
  if (abs.startsWith(home)) return '~/' + relative(home, abs).split('\\').join('/');
  return abs.replace(/\/Users\/[^/]+/, '/Users/<user>').replace(/\/home\/[^/]+/, '/home/<user>');
}

/** The only node identity a public receipt carries. */
export const publicNodeRef = (node) => (typeof node === 'string' ? node : node?.id ?? 'node');

/** A placeholder check: true when a template value is still a <placeholder>. */
export const isPlaceholder = (v) => typeof v === 'string' && /^<[a-z-]+>$/.test(v);

// ---- blank-slate-v1k9: the edge host is READ, never literalized (same contract as src/utils/edge-host.ts
// in ORDER hosts-j4t1): private overlay config.json `edge_host` → TIMMY_EDGE_HOST → inert placeholder.
export const EDGE_HOST_PLACEHOLDER = '<hostname>';
export function edgeHost() {
  try {
    const { data } = readPrivateJson('config.json');
    const v = data?.edge_host;
    if (typeof v === 'string' && v.trim() && !isPlaceholder(v)) return v.trim();
  } catch { /* overlay unreadable → fall through */ }
  const e = process.env.TIMMY_EDGE_HOST;
  return e && e.trim() && !isPlaceholder(e) ? e.trim() : null;
}
/** `https://<host><path>`, or the inert `https://<hostname><path>` when nothing resolves (callers must treat it as not live). */
export const edgeUrlOrInert = (path = '') => `https://${edgeHost() ?? EDGE_HOST_PLACEHOLDER}${path}`;
/** The operator's label for headers/payloads: overlay `operator_label` → TIMMY_OPERATOR_LABEL → 'operator'. */
export function operatorLabel() {
  try {
    const { data } = readPrivateJson('config.json');
    const v = data?.operator_label;
    if (typeof v === 'string' && v.trim() && !isPlaceholder(v)) return v.trim();
  } catch { /* fall through */ }
  return process.env.TIMMY_OPERATOR_LABEL?.trim() || 'operator';
}
