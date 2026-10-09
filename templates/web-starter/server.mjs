// The web starter's development server: no dependencies, this folder's files on 127.0.0.1 at $PORT.
// Timmy's /preview runs it (npm run dev) until the project has a built dist/; edit and reload.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

const base = root.endsWith(sep) ? root : root + sep;

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
    // Only this folder's own files, never a hidden one (.git, .timmy, .env).
    const inside = file.startsWith(base);
    const hidden = file.slice(base.length).split(sep).some((part) => part.startsWith('.'));
    if (!inside || hidden || !(await stat(file)).isFile()) throw new Error('not served');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  }
}).listen(port, '127.0.0.1', () => console.log(`web starter on http://127.0.0.1:${port}/`));
