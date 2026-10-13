// The web starter's development server: no dependencies, this folder's files on 127.0.0.1 at $PORT.
// Timmy's /preview runs it (npm run dev) until the project has a built dist/; edit and reload.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

// The folder as it really is (a link resolved), so a request is judged by where it truly leads.
const real = await realpath(root);
const base = real.endsWith(sep) ? real : real + sep;
const hiddenUnder = (p, from) => p.slice(from.length).split(sep).some((part) => part.startsWith('.'));

createServer(async (req, res) => {
  let status = 404, type = 'text/plain; charset=utf-8', body = 'not found\n';
  try {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const asked = normalize(join(real, path.endsWith('/') ? `${path}index.html` : path));
    // Only this folder's own files, never a hidden one (.git, .timmy, .env), checked on the path asked for
    // and on where it leads: a link out of the folder, or to a hidden file, is not served.
    const file = await realpath(asked);
    if (!asked.startsWith(base) || hiddenUnder(asked, base) || !file.startsWith(base) || hiddenUnder(file, base)) throw new Error('not served');
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    // Read first, answer after: a file that cannot be read (too big, no permission, removed) is a 404,
    // never a second answer after the first, which would stop this server.
    body = await readFile(file);
    status = 200; type = types[extname(file)] ?? 'application/octet-stream';
  } catch { /* not served: 404 */ }
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}).listen(port, '127.0.0.1', () => console.log(`web starter on http://127.0.0.1:${port}/`));
