import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { execFileSync } from 'child_process';
import { projectDir } from './projects.js';

// Roboflow connector — #2 in the Porter fleet. The loop: TIMMY generates
// labeled, receipted artifacts → Roboflow trains on REAL logs/frames →
// better models for TIMMY's own tools. Degrades honestly without a key.

export interface RoboflowStatus {
  cli: boolean;
  key: boolean;
  via: string;
}

export function detectRoboflow(): RoboflowStatus {
  let cli = false;
  try { execFileSync('sh', ['-c', 'command -v roboflow'], { stdio: 'ignore' }); cli = true; } catch { cli = false; }
  const key = Boolean(process.env.ROBOFLOW_API_KEY);
  return { cli, key, via: key ? 'ROBOFLOW_API_KEY' : cli ? 'roboflow CLI' : 'not configured' };
}

export async function roboflowUpload(project: string, dir?: string): Promise<{ ok: boolean; uploaded: number; reason?: string }> {
  const st = detectRoboflow();
  if (!st.key) {
    return { ok: false, uploaded: 0, reason: 'set ROBOFLOW_API_KEY (app.roboflow.com → settings) — then /roboflow upload <project> trains on your real gens/frames' };
  }
  const p = projectDir(project, dir);
  const files: string[] = [];
  for (const sub of ['gens', 'frames']) {
    const d = join(p, sub);
    if (existsSync(d)) for (const f of readdirSync(d)) if (/\.(png|jpe?g)$/i.test(f)) files.push(join(d, f));
  }
  if (!files.length) return { ok: false, uploaded: 0, reason: 'no png/jpg artifacts in the project yet — generate first' };
  let uploaded = 0;
  // R11 (H170; Phase 0 item 3): the key goes in the Authorization header (Bearer, as src/vision/platform.ts sends it to
  // api.roboflow.com), never in the URL: a URL lands in logs, histories and error text; a header does not
  const key = process.env.ROBOFLOW_API_KEY!;
  for (const f of files.slice(0, 20)) {
    try {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(f)], { type: /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png' }), basename(f));
      const res = await fetch(
        `https://api.roboflow.com/dataset/timmy-${encodeURIComponent(project)}/upload`,
        { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }
      );
      if (res.ok) uploaded++;
    } catch { /* per-file best effort; the count is the truth */ }
  }
  return { ok: uploaded > 0, uploaded, reason: uploaded ? undefined : 'all uploads failed — check key/workspace' };
}
