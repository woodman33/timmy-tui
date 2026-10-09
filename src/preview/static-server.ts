/**
 * Timmy's preview server for a static folder (R1 workspace direction, 2026-10-08): serves one folder on
 * 127.0.0.1 only, with plain content types, nothing outside the folder (links included) and one log line
 * per request. It runs as `node -e STATIC_SERVER_JS <folder> <port>`, so it needs no file of its own in a
 * checkout or a package, and it stops on SIGTERM like any job.
 */
export const STATIC_SERVER_JS = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const [dirArg, portArg] = process.argv.slice(1);
const root = fs.realpathSync(path.resolve(dirArg || '.'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };
const server = http.createServer((req, res) => {
  let rel = '/';
  try { rel = decodeURIComponent(String(req.url || '/').split('?')[0]); } catch (e) { rel = '/'; }
  let file = path.resolve(root, '.' + rel);
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const real = fs.realpathSync(file);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('outside');
    // Review at c7475458: a read that fails (an unreadable file, or one a rebuild removed after the check)
    // answers 500 or ends that one response; it never takes the whole server down. The 200 goes out only
    // once the file is open, so a failed open is a 500, not a short 200.
    const stream = fs.createReadStream(real);
    stream.on('open', () => {
      res.writeHead(200, { 'content-type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      stream.pipe(res);
      console.log(req.method + ' ' + rel + ' 200');
    });
    stream.on('error', (err) => {
      console.log(req.method + ' ' + rel + ' 500 ' + ((err && err.code) || 'read error'));
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('could not read this file\n'); }
      else res.destroy();
    });
    res.on('close', () => stream.destroy());
    res.on('error', () => stream.destroy());
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    console.log(req.method + ' ' + rel + ' 404');
  }
});
server.listen(Number(portArg || 0), '127.0.0.1', () => console.log('serving at http://127.0.0.1:' + server.address().port + '/'));
const stop = () => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`;

/** The command that serves `dir` on `port`: this Node with the inline server above. */
export const staticServerCommand = (dir: string, port: number): { command: string; args: string[] } => ({
  command: process.execPath,
  args: ['-e', STATIC_SERVER_JS, dir, String(port)],
});
