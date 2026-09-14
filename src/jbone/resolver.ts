import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createPlan, armPlan, type DispatchPlan } from '../utils/dispatch.js';
import { issueApproval } from '../utils/approvals.js';

// CONTROL PLANE (ORDER control-plane-k3e7) — jbone RESOLVER v0.
// `timmy do "<phrase>"` -> fuzzy match against plan templates (CUE) -> confirm
// line -> Code Mode script -> lane.
export interface JboneTemplate { file: string; keywords: string[]; harness: string; objective: string; code: string }

const here = dirname(fileURLToPath(import.meta.url));
export const templatesDir = (): string => join(here, 'templates');

export function loadTemplates(): JboneTemplate[] {
  const d = templatesDir();
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.cue')).map(f => {
    const txt = readFileSync(join(d, f), 'utf8');
    const kw = (txt.match(/keywords:\s*\[([^\]]*)\]/)?.[1] ?? '').split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean);
    const harness = txt.match(/harness:\s*"([^"]+)"/)?.[1] ?? 'opencode';
    const objective = txt.match(/objective:\s*"([^"]+)"/)?.[1] ?? '%(phrase)s';
    const code = txt.match(/code:\s*"""([\s\S]*?)"""/)?.[1] ?? '';
    return { file: f, keywords: kw, harness, objective, code };
  });
}

const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function fuzzyMatch(phrase: string): { template: JboneTemplate | null; score: number } {
  const pt = new Set(tokens(phrase));
  let best: JboneTemplate | null = null; let bestScore = 0;
  for (const t of loadTemplates()) {
    let score = 0;
    for (const k of t.keywords) { if (pt.has(k)) score += 2; else if ([...pt].some(p => p.includes(k) || k.includes(p))) score += 1; }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return { template: best, score: bestScore };
}

export const confirmLine = (phrase: string, t: JboneTemplate): string =>
  `jbone: "${phrase}" -> [${t.file}] harness=${t.harness} :: ${t.objective.replace('%(phrase)s', phrase)}`;

export interface JboneRun { status: string; confirm?: string; template?: string; lane?: string; plan?: string; code?: string }

export function runJbone(phrase: string, opts: { yes?: boolean; dir?: string } = {}): JboneRun {
  const { template, score } = fuzzyMatch(phrase);
  if (!template || score === 0) return { status: 'no-match' };
  const confirm = confirmLine(phrase, template);
  if (!opts.yes) return { status: 'pending-confirm', confirm, template: template.file };
  const plan = {
    schema_version: 'dispatch/0.1',
    objective: template.objective.replace('%(phrase)s', phrase),
    deliverables: [phrase],
    acceptance_tests: ['true'],
    harnesses: [template.harness],
    workspace: { kind: 'host-ephemeral' },
  } as unknown as DispatchPlan;
  const cp = createPlan(plan, opts.dir);
  let planId: string | undefined;
  if (cp.ok && cp.id && cp.plan_hash) {
    const ap = issueApproval(cp.plan_hash);
    const ar = armPlan(cp.id, ap.token, opts.dir);
    if (ar.ok) planId = cp.id;
  }
  return { status: planId ? 'dispatched' : 'plan-stored', confirm, template: template.file, lane: template.harness, plan: planId ?? cp.id, code: template.code };
}
