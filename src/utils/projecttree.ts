import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { execFileSync } from 'child_process';
import { readProject, projectDir } from './projects.js';
import { laneTmux } from '../agent/lane-server.js';

// TIMMY project tree — the ICEBERG applied per project. Tiny index on top
// (PROJECT.md, always loaded first), deep organized vault below. Everything
// cross-links by gen-id: prompt ↔ outcome ↔ logs ↔ receipts always match.

export const TREE_FOLDERS = [
  'templates', // tldraw/slate templates scoped to this project
  'prompts',   // one md per gen: prompt + options + provider/model + outcome link
  'gens',      // generated material, named <gen-id>.<ext>
  'training',  // roboflow export: labeled copies + labels.json
  'logs',      // chat threads + lane captures + events
  'research',  // notes, refs, breakdowns
  'houdini',   // levels/scene files + sceneforge receipts
  'mcp',       // porter/mcp→cli call log
  'comfy',     // workflows
  'site',      // published site + tldraw canvas
  'receipts'   // project-scoped receipt excerpts
];

export function ensureProjectTree(name: string, dir?: string): string {
  const p = projectDir(name, dir);
  for (const f of TREE_FOLDERS) mkdirSync(join(p, f), { recursive: true });
  mkdirSync(join(p, 'logs', 'lanes'), { recursive: true });
  renderProjectIndex(name, dir);
  return p;
}

export interface TreeFile { rel: string; size: number; }

export function projectTree(name: string, dir?: string): TreeFile[] {
  const p = projectDir(name, dir);
  const out: TreeFile[] = [];
  for (const f of ['.', ...TREE_FOLDERS, join('logs', 'lanes')]) {
    const d = join(p, f);
    if (!existsSync(d)) continue;
    try {
      for (const file of readdirSync(d)) {
        const fp = join(d, file);
        try {
          const st = statSync(fp);
          if (st.isFile()) out.push({ rel: f === '.' ? file : join(f, file), size: st.size });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function writePromptRecord(
  name: string,
  gen: { id: string; prompt: string; provider: string; model?: string; cost_usd?: number; status?: string; artifact?: string; options?: string },
  dir?: string
): string {
  const p = ensureProjectTree(name, dir);
  const path = join(p, 'prompts', `${gen.id}.md`);
  writeFileSync(path, [
    `# prompt · ${gen.id}`,
    `provider: ${gen.provider}${gen.model ? ` · ${gen.model}` : ''}`,
    `options: ${gen.options || '—'} · cost: ${gen.cost_usd !== undefined ? `$${gen.cost_usd.toFixed(4)}` : '—'} · status: ${gen.status || '—'}`,
    `outcome: ../gens/${gen.id}${gen.artifact ? extname(gen.artifact) : '.png'}  (prompt ↔ outcome, matched)`,
    '',
    gen.prompt
  ].join('\n') + '\n', 'utf8');
  return path;
}

export function appendChatThread(name: string, msgs: { role: string; content: string }[], dir?: string): string {
  const p = ensureProjectTree(name, dir);
  const path = join(p, 'logs', 'chat.md');
  writeFileSync(path, `# chat threads · ${name}\n\n` + msgs.map(m => `## ${m.role}\n\n${m.content}\n`).join('\n'), 'utf8');
  return path;
}

export function syncLaneLogs(name: string, lanes: { id: string; name: string }[], dir?: string): number {
  const p = ensureProjectTree(name, dir);
  let n = 0;
  for (const l of lanes) {
    try {
      // R4 (H87): the lanes live on Timmy's own tmux server (src/agent/lane-server.ts), never the default one
      const out = execFileSync('tmux', laneTmux('capture-pane', '-pt', `ortui-${l.id}`, '-S', '-200'), { encoding: 'utf8', stdio: 'pipe' });
      writeFileSync(join(p, 'logs', 'lanes', `${l.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.log`), out, 'utf8');
      n++;
    } catch { /* lane not alive */ }
  }
  return n;
}

export function exportTraining(name: string, dir?: string): { files: number; labelsPath: string | null } {
  const p = ensureProjectTree(name, dir);
  const proj = readProject(name, dir);
  const src = join(p, 'gens');
  const dst = join(p, 'training');
  const labels: { file: string; label: string }[] = [];
  let files = 0;
  if (existsSync(src)) {
    for (const f of readdirSync(src)) {
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      copyFileSync(join(src, f), join(dst, f));
      const genId = basename(f, extname(f));
      const gen = proj?.gens.find(g => g.id === genId);
      labels.push({ file: f, label: gen?.label || gen?.provider || name });
      files++;
    }
  }
  let labelsPath: string | null = null;
  if (labels.length) {
    labelsPath = join(dst, 'labels.json');
    writeFileSync(labelsPath, JSON.stringify({ project: name, exported_at: new Date().toISOString(), labels }, null, 2), 'utf8');
  }
  return { files, labelsPath };
}

export function renderProjectIndex(name: string, dir?: string): string {
  const p = projectDir(name, dir);
  mkdirSync(p, { recursive: true });
  const proj = readProject(name, dir);
  const count = (f: string) => { try { return readdirSync(join(p, f)).filter(x => { try { return statSync(join(p, f, x)).isFile(); } catch { return false; } }).length; } catch { return 0; } };
  const idx = [
    `# PROJECT · ${name}`,
    `kind: ${proj?.kind || 'storyboard'} · beats: ${(proj?.beats || []).length} · cast: ${(proj?.cast || []).length}`,
    '',
    '## tree (context-optimized: load this first, descend only when relevant)',
    ...TREE_FOLDERS.map(f => `- ${f}/ (${count(f)} files)`),
    `- logs/lanes/ (${count(join('logs', 'lanes'))} lane captures)`,
    '',
    '## cross-links',
    '- prompts/<gen-id>.md ↔ gens/<gen-id>.* — prompt matched to outcome',
    '- training/labels.json — roboflow export of gens with labels',
    '- receipts/ — project-scoped excerpts of the sealed chain'
  ].join('\n');
  const path = join(p, 'PROJECT.md');
  writeFileSync(path, idx + '\n', 'utf8');
  return path;
}

// In-terminal previews: chafa/catimg for images, head for docs, honest
// fallbacks otherwise. [v] always opens the real thing in carbonyl.
export function previewFile(path: string): string {
  const ext = extname(path).toLowerCase();
  const size = (() => { try { return statSync(path).size; } catch { return 0; } })();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    for (const [cmd, args] of [
      ['chafa', [path, '--size', '70x28', '--format', 'symbols']],
      ['catimg', ['-w', '60', path]]
    ] as [string, string[]][]) {
      try {
        return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' });
      } catch { /* try next */ }
    }
    return `[image · ${basename(path)} · ${size}b — no chafa/catimg installed; [v] opens it in carbonyl]`;
  }
  if (['.mp4', '.webm', '.mov'].includes(ext)) {
    return `[video · ${basename(path)} · ${(size / 1024).toFixed(0)}kb — [v] plays it in carbonyl]`;
  }
  try {
    return readFileSync(path, 'utf8').split('\n').slice(0, 24).join('\n');
  } catch {
    return `[unreadable: ${basename(path)}]`;
  }
}
