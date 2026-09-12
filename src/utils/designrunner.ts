import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { OPEN_DESIGN_MCP, openDesignInstalled, mcpSession, pickArgs } from './mcpstdio.js';
import { listGenerations, updateGeneration } from './generations.js';
import { publish as appendEvent } from '../bus/index.js';
import { appendReceipt } from './receipts.js';

// Lesson from gen_msukpsfq_f4ru: create_artifact ran but its tool content had
// no parseable path. Don't trust the tool result text alone — scan the data
// dir by mtime for what the daemon actually wrote.
const ARTIFACT_EXT = /\.(png|jpe?g|webp|svg|html|pdf)$/i;

function newestSince(root: string, sinceMs: number, depth = 0): string | undefined {
  if (depth > 4 || !existsSync(root)) return undefined;
  let best: { p: string; t: number } | undefined;
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, e.name);
      try {
        if (e.isDirectory()) {
          const hit = newestSince(p, sinceMs, depth + 1);
          if (hit) {
            const t = statSync(hit).mtimeMs;
            if (!best || t > best.t) best = { p: hit, t };
          }
        } else if (ARTIFACT_EXT.test(e.name)) {
          const t = statSync(p).mtimeMs;
          if (t >= sinceMs && (!best || t > best.t)) best = { p, t };
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable dir */ }
  return best?.p;
}

// Open Design runner: GENS queues an open-design gen; this executes it over
// the Open Design daemon MCP and seals what happened. The MCP server designs;
// timmy notarizes.

export interface DesignRunResult { ok: boolean; note?: string; artifact?: string }

export async function runOpenDesignGen(genId: string): Promise<DesignRunResult> {
  if (!openDesignInstalled()) return { ok: false, note: 'Open Design app not found (/Applications/Open Design.app)' };
  const rec = listGenerations({}).find(g => g.id === genId);
  if (!rec) return { ok: false, note: `no generation ${genId}` };

  let session;
  try {
    session = await mcpSession(OPEN_DESIGN_MCP);
  } catch (e) {
    return { ok: false, note: `open-design MCP handshake failed: ${(e as Error).message}` };
  }
  try {
    const tool = session.tools.find(t => /design|generate|create|image|render/i.test(t.name)) ?? session.tools[0];
    if (!tool) {
      updateGeneration(genId, { status: 'failed' });
      return { ok: false, note: 'Open Design MCP exposed no tools' };
    }
    const startedAt = Date.now();
    const result = await session.call(tool.name, pickArgs(tool, rec.prompt));
    const text = ((result?.content ?? []) as { text?: string }[]).map(c => c.text ?? '').join(' ').trim();
    const urlMatch = text.match(/(\/[^\s"']+\.(png|jpg|jpeg|webp|svg|html))|(https?:\/\/[^\s"']+)/i);
    const artifact = urlMatch?.[0]
      ?? newestSince(OPEN_DESIGN_MCP.env?.OD_DATA_DIR ?? '', startedAt - 2000);
    updateGeneration(genId, { status: 'done', ...(artifact ? { artifact } : {}) });
    appendEvent('gen.status', { genId, event: 'done', tool: tool.name });
    appendReceipt('runs', {
      kind: 'run',
      subject: `open-design · ${genId}`,
      policy: 'human-gated',
      spans: [{ name: `mcp ${tool.name}`, kind: 'execute_tool' }],
      cost_usd: 0
    });
    return { ok: true, artifact, note: artifact ? `artifact: ${artifact}` : `tool ${tool.name} ran; no artifact path in its output` };
  } catch (e) {
    updateGeneration(genId, { status: 'failed' });
    appendEvent('gen.status', { genId, event: 'failed' });
    return { ok: false, note: (e as Error).message };
  } finally {
    session.close();
  }
}
