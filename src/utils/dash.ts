import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync, spawnSync } from 'child_process';
import { BRAND } from './brand.js';
import { GENERATION_PROVIDERS } from './providers.js';
import { theme } from '../tui/theme.js';
import { DASH_PORT, dashHealth, dashRootId, startDashServer, type DashServer } from './dash-server.js';

// TIMMY Studios dashboard — the whole fabric (ledger, fleet, frames, events)
// rendered in carbonyl browser panes. R4 (H97): served by Timmy's own dashboard
// server (src/utils/dash-server.ts), on 127.0.0.1 only and for the pages' own
// files only; it was `python3 -m http.server` over the whole working folder,
// which listens on every network address and served .env and .timmy/ too.

export { DASH_PORT } from './dash-server.js';

export function dashUrl(): string {
  return `http://127.0.0.1:${DASH_PORT}/studio/dashboard.html`;
}

/** How the dashboard's server came up: serving this folder's pages (`up`), or why not, in words; `older`: an older Timmy's
 *  Python server that still runs for this folder (its words are in `words` too). */
export interface DashReady { up: boolean; words: string; older?: string }
/** What ensureDashServer can say at once (`up`, or `starting` while it listens), and `ready`, which settles how it went. */
export interface DashStart { state: 'up' | 'starting'; words: string; ready: Promise<DashReady> }

interface Served { root: string; port: number; ready: Promise<DashReady>; server?: DashServer; done?: DashReady }
let served: Served | null = null;

const starting = (port: number): string => `starting on 127.0.0.1:${port}, this computer only`;
const upWords = (port: number): string => `up on 127.0.0.1:${port}, this computer only: it serves this folder's studio/ and the dashboard's records, nothing else of it`;

/**
 * R4 (H97): a `python3 -m http.server` an older Timmy started for this folder (its pid in .timmy/dash.pid) that still
 * runs, in words with how to stop it; null when there is none (no file, no such process, or a process that is not it).
 * It is not stopped here: it is named.
 */
export function olderPythonServer(root: string): string | null {
  let pid = 0;
  try { pid = Number.parseInt(readFileSync(join(root, '.timmy', 'dash.pid'), 'utf8').trim(), 10); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return null; }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
  if (ps.status !== 0 || !/\bhttp\.server\b/.test(ps.stdout ?? '')) return null;
  return `an older Timmy's dashboard server still runs: Python's http.server (pid ${pid}, named in .timmy/dash.pid), which serves this whole folder, .env and .timmy/ included, to every network address of this computer; stop it with: kill ${pid}`;
}

/** Why the server did not start, in words: the port taken (by another Timmy's dashboard server, or by what else), or the error's code. */
async function whyNot(e: unknown, root: string, port: number): Promise<DashReady> {
  const code = (e as NodeJS.ErrnoException)?.code ?? 'an error';
  if (code !== 'EADDRINUSE') return { up: false, words: `not started: it could not listen on 127.0.0.1:${port} (${code})` };
  const h = await dashHealth(port);
  if (h.state === 'timmy' && h.root === dashRootId(root)) return { up: true, words: `served by another Timmy on this computer, on 127.0.0.1:${port}, for this same folder (its pages work while that Timmy runs)` };
  if (h.state === 'timmy') return { up: false, words: `not started: 127.0.0.1:${port} is taken by Timmy's dashboard server of another folder (another Timmy on this computer), so this folder's pages are not served; quit that Timmy, then try again` };
  return { up: false, words: `not started: 127.0.0.1:${port} is taken by ${h.state === 'other' ? 'another program (not Timmy\'s dashboard server)' : 'something that did not answer'}, so this folder's pages are not served` };
}

/**
 * Serves this folder's dashboard and Slate pages (src/utils/dash-server.ts), in this Timmy, on 127.0.0.1:4273 (`port` for a
 * test). Says at once whether this Timmy already serves it, else `starting`; `ready` settles how it went. A server already
 * running here for this folder is used; one for another folder is closed first. It ends with this Timmy.
 */
export function ensureDashServer(cwd: string = process.cwd(), o: { port?: number } = {}): DashStart {
  const root = resolve(cwd);
  const port = o.port ?? DASH_PORT;
  const now = served;
  if (now && now.root === root && now.port === port && (now.server || !now.done)) {
    return now.done ? { state: 'up', words: now.done.words, ready: now.ready } : { state: 'starting', words: starting(port), ready: now.ready };
  }
  const entry: Served = { root, port, ready: Promise.resolve({ up: false, words: '' }) };
  entry.ready = (async (): Promise<DashReady> => {
    if (now?.server) await now.server.close();
    let r: DashReady;
    try {
      entry.server = await startDashServer({ root, port });
      r = { up: true, words: upWords(entry.server.port) };
    } catch (e) { r = await whyNot(e, root, port); }
    const older = olderPythonServer(root);
    if (older) r = { ...r, words: `${r.words}; ${older}`, older };
    entry.done = r;
    return r;
  })();
  served = entry;
  return { state: 'starting', words: starting(port), ready: entry.ready };
}

/** Closes the dashboard server this Timmy runs, if any (tests; Timmy's own exit ends it too). */
export async function stopDashServer(): Promise<void> {
  const s = served;
  served = null;
  if (!s) return;
  await s.ready;
  await s.server?.close();
}

/** Calls `say` once the server has settled, when it is not up or something needs saying beyond that it is (an older server). */
export function whenDashNotFine(start: DashStart, say: (words: string) => void): void {
  void start.ready.then((r) => { if (!r.up || r.older) say(r.words); });
}

export function probeUrl(url: string): boolean {
  try {
    execSync(`curl -s -o /dev/null --max-time 1 ${JSON.stringify(url)}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function writeDashboard(cwd: string = process.cwd()): string {
  mkdirSync(join(cwd, 'studio'), { recursive: true });
  const path = join(cwd, 'studio', 'dashboard.html');
  writeFileSync(path, renderDashboardHtml(cwd), 'utf8');
  return path;
}

export function renderDashboardHtml(_cwd: string = process.cwd()): string {
  const fleet = GENERATION_PROVIDERS.map(p => ({
    id: p.id, kind: p.kind, transport: p.transport, model: p.modelId || '', notes: p.notes || ''
  }));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${BRAND.studios} — dashboard</title>
<style>
body{margin:0;background:${theme.ground};color:${theme.textPrimary};font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}
header{padding:14px 18px;border-bottom:1px solid ${theme.surfaceRaised};display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
header h1{margin:0;font-size:16px;color:${theme.accent}}
header .tag{color:${theme.accent}}
header .slate{color:${theme.textSecondary}}
main{padding:14px 18px;display:grid;gap:18px}
section h2{font-size:12px;letter-spacing:.25em;color:${theme.accent};margin:0 0 8px}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid ${theme.surfaceRaised};padding:4px 8px;text-align:left;vertical-align:top;font-size:12px}
th{color:${theme.textSecondary}}
.done{color:${theme.seal}}.failed{color:${theme.danger}}.running{color:${theme.warn}}.queued{color:${theme.textSecondary}}
.fleet{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid ${theme.surfaceRaised};border-radius:10px;padding:2px 8px;font-size:11px;color:${theme.textPrimary}}
.chip b{color:${theme.accent}}
.frames{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.frames img{height:72px;border:1px solid ${theme.surfaceRaised}}
pre{margin:0;font-size:11px;color:${theme.textSecondary};white-space:pre-wrap}
</style>
</head>
<body>
<header>
  <h1>● ${BRAND.studios}</h1>
  <span class="tag">${BRAND.studiosTagline}</span>
  <span class="slate">${BRAND.slate}: ${BRAND.slateTagline}</span>
</header>
<main>
  <section><h2>GENERATION LEDGER</h2><table id="gens"><tr><th>id</th><th>timestamp</th><th>provider</th><th>model</th><th>status</th><th>cost</th><th>frames</th><th>prompt</th><th>artifact</th></tr></table><div id="frames"></div></section>
  <section><h2>PROVIDER FLEET</h2><div class="fleet" id="fleet"></div></section>
  <section><h2>TIMESTAMPED EVENTS (.timmy/runs/events.jsonl)</h2><pre id="events">loading…</pre></section>
</main>
<script>
var FLEET = ${JSON.stringify(fleet)};
function el(t){return document.createElement(t)}
function draw(gens){
  var t=document.getElementById('gens');
  while(t.rows.length>1)t.deleteRow(1);
  var fr=document.getElementById('frames');fr.innerHTML='';
  gens.slice().reverse().forEach(function(g){
    var r=t.insertRow();
    r.insertCell().textContent=g.id;
    r.insertCell().textContent=(g.created_at||'').replace('T',' ').slice(0,19);
    r.insertCell().textContent=g.provider;
    r.insertCell().textContent=g.model||'';
    var c=r.insertCell();c.textContent=g.status;c.className=g.status;
    r.insertCell().textContent=g.cost===null?'unknown':typeof g.cost==='number'?'$'+g.cost.toFixed(3):'';
    r.insertCell().textContent=g.frameCount||'';
    r.insertCell().textContent=g.prompt.length>70?g.prompt.slice(0,70)+'…':g.prompt;
    r.insertCell().textContent=g.artifact||'';
    var d=g.frames;
    if(d&&g.frameCount){
      var wrap=el('div');wrap.className='frames';
      var n=Math.min(g.frameCount,8);
      for(var i=1;i<=n;i++){
        var img=el('img');
        img.src=d+'/frame_'+String(i).padStart(4,'0')+'.png';
        img.title=g.id+' frame '+i;
        wrap.appendChild(img);
      }
      fr.appendChild(wrap);
    }
  });
}
function refresh(){
  fetch('/data/generations.json').then(function(r){return r.ok?r.json():{generations:[]}}).then(function(d){draw(d.generations||[])}).catch(function(){});
  fetch('/data/events.jsonl').then(function(r){return r.ok?r.text():''}).then(function(t){
    var lines=t.split('\\n').filter(Boolean).slice(-25);
    document.getElementById('events').textContent=lines.join('\\n')||'(no events yet)';
  }).catch(function(){});
}
var f=document.getElementById('fleet');
FLEET.forEach(function(p){
  var s=el('span');s.className='chip';
  s.innerHTML='<b>'+p.id+'</b> '+p.kind+' · '+p.transport+(p.model?' · '+p.model:'');
  f.appendChild(s);
});
refresh();setInterval(refresh,5000);
</script>
</body>
</html>
`;
}
