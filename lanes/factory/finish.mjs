// lanes/factory/finish.mjs — hana.frame: the winner goes into a Hana frame through the Spline bridge's documented
// tools (2d_reserve_frames + 2d_write_html for a site; 3d_set_html_content for a scene overlay). Without --hana the
// request is prepared and hashed only; the bridge is driven only when the editor is running and --hana is given.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = { command: '/Applications/Spline.app/Contents/MacOS/Spline', args: ['/Applications/Spline.app/Contents/Resources/spline-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

export async function prepareFinish({ out, take, prediction, hana = false }) {
  const html = readFileSync(join(ROOT, take.file), 'utf8');
  const request = prediction.target === 'site'
    ? { tool: '2d_write_html', frame: { name: `omma take ${take.take}`, width: 1440, height: 900 }, html }
    : { tool: '3d_set_html_content', html: `<!doctype html><html><body><pre id="scene">${html.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre></body></html>` };
  const file = join(out, 'hana.frame.request.json');
  const sha256 = 'sha256_' + createHash('sha256').update(JSON.stringify(request)).digest('hex');
  writeFileSync(file, JSON.stringify({ schema: 'timmy.hana-frame-request/1', take: take.take, take_sha256: take.sha256, request, sha256 }, null, 1) + '\n');
  if (!hana) return { status: 'prepared', file, sha256, note: 'run with --hana while the Hana editor is open to write the frame' };
  return { status: 'attempted', file, sha256, ...(await driveBridge(request)) };
}

/** Minimal stdio JSON-RPC client for the bridge: initialize → tools/list → the write tool. */
async function driveBridge(request) {
  return new Promise((resolveP) => {
    const child = spawn(BRIDGE.command, BRIDGE.args, { env: { ...process.env, ...BRIDGE.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; const results = {}; let id = 0;
    const send = (method, params) => { const m = { jsonrpc: '2.0', id: ++id, method, params }; child.stdin.write(JSON.stringify(m) + '\n'); return id; };
    const done = (r) => { try { child.kill(); } catch { /* gone */ } resolveP(r); };
    const timer = setTimeout(() => done({ bridge: 'timeout', results }), 60000);
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); send('tools/list', {}); }
        else if (msg.id === 2) { const names = (msg.result?.tools ?? []).map((t) => t.name); results.tools = names.length; if (!names.includes(request.tool)) { clearTimeout(timer); return done({ bridge: 'tool-missing', tool: request.tool, results }); } if (request.tool === '2d_write_html') send('tools/call', { name: '2d_reserve_frames', arguments: { frames: [{ name: request.frame.name, width: request.frame.width, height: request.frame.height }] } }); else send('tools/call', { name: request.tool, arguments: { html: request.html } }); }
        else if (msg.id === 3 && request.tool === '2d_write_html') { if (msg.error) { results.reserve = `error: ${JSON.stringify(msg.error).slice(0, 160)}`; clearTimeout(timer); return done({ bridge: 'error', results }); } const text = JSON.stringify(msg.result); const fid = (text.match(/"(?:frame_id|id)"\s*:\s*"([0-9a-f-]{20,})"/) || [])[1]; results.reserve = fid ? 'ok' : 'no-frame-id'; if (!fid) { clearTimeout(timer); return done({ bridge: 'error', results }); } send('tools/call', { name: '2d_write_html', arguments: { html: request.html, frame_id: fid } }); }
        else if (msg.id >= 3) { results.write = msg.error ? `error: ${JSON.stringify(msg.error).slice(0, 160)}` : 'ok'; clearTimeout(timer); return done({ bridge: msg.error ? 'error' : 'ok', results }); }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); done({ bridge: 'spawn-failed', detail: e.message }); });
    send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'timmy-factory', version: '0.1.0' } });
  });
}
