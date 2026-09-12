// lanes/factory/verifiers/jsoup.mjs — structure counts by jsoup (Java, via JBang), compared to the forecast.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
export const name = 'jsoup';
export function verify(file, prediction) {
  const r = spawnSync('jbang', ['--quiet', join(HERE, 'JsoupCount.java'), file], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) return { name, ok: false, ran: false, detail: (r.stderr || '').trim().slice(-200) };
  const c = JSON.parse(r.stdout.trim().split('\n').pop());
  const checks = { pages: c.pages === prediction.pages, elements: c.elements === prediction.elements, named_text: prediction.named_text.every((t) => c.named_text.includes(t)) };
  return { name, ran: true, ok: Object.values(checks).every(Boolean), checks, counted: c };
}
