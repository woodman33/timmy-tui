// lanes/factory/verifiers/ocr.mjs — tesseract over the Playwright screenshot: is every named text visible?
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
export const name = 'ocr';
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function verify(screenshot, prediction) {
  if (!screenshot || !existsSync(screenshot)) return { name, ran: false, ok: false, detail: 'no screenshot (playwright did not run)' };
  const r = spawnSync('tesseract', [screenshot, 'stdout', '--psm', '6'], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) return { name, ran: false, ok: false, detail: (r.stderr || '').trim().slice(-160) };
  const text = norm(r.stdout);
  const found = prediction.named_text.filter((t) => text.includes(norm(t)));
  const missing = prediction.named_text.filter((t) => !text.includes(norm(t)));
  return { name, ran: true, ok: missing.length === 0, found, missing, chars: r.stdout.length };
}
