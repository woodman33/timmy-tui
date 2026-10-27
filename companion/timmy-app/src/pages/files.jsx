// R12 (the finish brief): Files — the project's files, read through the companion (GET /api/files, GET /api/files/file:
// src/companion/workspace.ts). The folder in the work area (its breadcrumb, its entries), the open file in the context column:
// a text file as text (Markdown drawn as React elements), an image as itself, anything else described, never guessed at.
// Nothing here writes a file: the companion has no route for it, and the page says so.
import { useEffect, useRef, useState } from 'react';
import { call, getJson, postJson } from '../api.js';
import { Markdown } from '../md.jsx';
import { Page, Panel, Tool } from '../shell.jsx';
import { aimAgent, goTo, openApp, projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, day } from '../ui.jsx';
import './files.css';

const q = (path) => `path=${encodeURIComponent(path || '')}${projectQuery('&')}`;
const sizeWords = (n) => (typeof n !== 'number' ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const isMarkdown = (name) => /\.(md|markdown|mdx)$/i.test(String(name || ''));
/**
 * A fence's info string beyond its language (a workflow block's ```bash [name:build]) as only its language: ../md.jsx reads
 * ```lang alone, and a longer info string stopped its paragraph reader without moving on (the page hung).
 */
const fencesOf = (text) => String(text || '').replace(/^([ \t]*```)[ \t]*([\w+-]*)[^`\n]*$/gm, '$1$2');
const GLYPH = { dir: '▸', file: '·', other: '◇' };

/** The open file: { path, state: 'reading' | 'text' | 'image' | 'refused', … } */
async function readFile(path) {
  // an image answers its bytes (the token rides in the header, so it is fetched, then shown from a blob address)
  if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
    try {
      const r = await call(`/api/files/file?${q(path)}`);
      if (r.ok && /^image\//.test(r.headers.get('Content-Type') || '')) {
        const blob = await r.blob();
        return { path, state: 'image', url: URL.createObjectURL(blob), size: blob.size };
      }
      const body = await r.json().catch(() => null);
      return { path, state: 'refused', words: (body && body.error) || `The companion answered ${r.status}.` };
    } catch (e) { return { path, state: 'refused', words: e instanceof Error ? e.message : String(e) }; }
  }
  const f = await getJson(`/api/files/file?${q(path)}`);
  if (f.ok && f.kind === 'text') return { path, state: 'text', ...f };
  return { path, state: 'refused', words: f.error || `The companion answered ${f.status}.` };
}

function Crumbs({ path, onGo, project }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav className="tx-files-crumbs" aria-label="Where in the project">
      <button type="button" className="tx-files-crumb" onClick={() => onGo('')}>{project || 'project'}</button>
      {parts.map((p, i) => (
        <span key={i}><span className="tx-files-sep" aria-hidden="true">/</span>
          <button type="button" className="tx-files-crumb" aria-current={i === parts.length - 1 ? 'location' : undefined} onClick={() => onGo(parts.slice(0, i + 1).join('/'))}>{p}</button>
        </span>
      ))}
    </nav>
  );
}

const APP_WORDS = { 'card-lab': 'Card Lab', 'film-room': 'Film Room', 'model-studio': 'Model Studio', animate: 'Animate', 'stream-studio': 'Stream Studio' };
const appWord = (id, title) => title || APP_WORDS[id] || id;
/** Card Lab's own address for one run (its page reads `?run=`). */
const inspectionAt = (run) => `/?run=${encodeURIComponent(run)}`;

/**
 * The checklist's A6 and A11, and the 05:03 order's G3: who made this file (the receipt naming these exact bytes) and, for an
 * image, the one supported handoff — a new Card Lab run made from it. After it: "Sent to Card Lab" with Open inspection first;
 * the hashes, the receipts and the run's id under Details.
 */
function Provenance({ path, image, onSent }) {
  const [p, setP] = useState(null);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let gone = false; setP(null); setSent(null); getJson(`/api/apps/provenance?${q(path)}`).then((r) => { if (!gone) setP(r); }); return () => { gone = true; }; }, [path]);
  const send = async () => { setBusy(true); const r = await postJson(`/api/apps/card-lab/handoff${projectQuery()}`, { path }); setBusy(false); setSent(r); if (r.ok && onSent) onSent(); };
  if (!p) return null;
  const rc = p.ok ? p.receipt : null;
  // sent now, or earlier (the newest handoff receipt naming these bytes)
  const before = p.ok && Array.isArray(p.sent) && p.sent.length ? p.sent[p.sent.length - 1] : null;
  const done = sent && sent.ok ? { run: sent.run, receipt: sent.receipt } : before;
  return (
    <div className="tx-files-prov">
      {rc ? <p className="tx-files-made">Made by {rc.app ? appWord(rc.app) : rc.kind}{rc.at ? `, ${day(rc.at)}` : ''}</p>
        : p.ok ? <p className="ta-muted">Not made by an app job of this project.</p> : null}
      {image ? (done ? (
        <div className="tx-files-sent" role="status" data-sent="card-lab">
          <p className="tx-files-sent-title">✓ Sent to Card Lab</p>
          <div className="ta-row">
            <Button kind="primary" onClick={() => openApp('card-lab', inspectionAt(done.run))} data-action="open-inspection">Open inspection</Button>
          </div>
        </div>
      ) : (
        <div className="ta-row">
          <Button onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send to Card Lab'}</Button>
          {sent && !sent.ok ? <span className="ta-result" role="status">{sent.error || `The companion answered ${sent.status}.`}</span> : null}
        </div>
      )) : null}
      {rc && rc.app && /^from-apps\/[a-z-]+\//.test(path) ? (
        <div className="ta-row"><Button onClick={() => aimAgent({ kind: 'app', app: rc.app, path })} data-action="send-file-to-agent">Send to an agent</Button><span className="ta-muted">A run in the Control Room on a copy of this file.</span></div>
      ) : null}
      <details className="ta-details">
        <summary>Details: path, hash and receipts</summary>
        <Facts rows={[
          ['path', <code key="p">{path}</code>],
          ['sha256', p.ok && p.sha256 ? <code key="h">{p.sha256}</code> : null],
          ['made by', rc ? `${rc.app ? `${appWord(rc.app)}’s job ${rc.job}` : rc.kind}; receipt ${rc.id}` : null],
          ['Card Lab run', done ? <code key="r">{done.run}</code> : null],
          ['handoff receipt', done ? <code key="hr">{done.receipt}</code> : null],
        ]} />
        {rc ? <Button onClick={() => goTo('runs')}>Open Runs &amp; receipts</Button> : null}
      </details>
    </div>
  );
}

/** One app result's first image, drawn from its bytes (the token rides in the header, so it is fetched, then shown). */
function Thumb({ path, name }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let gone = false; let made = null;
    call(`/api/files/file?${q(path)}`).then(async (r) => { if (!r.ok || gone) return; const b = await r.blob(); if (gone) return; made = URL.createObjectURL(b); setUrl(made); }).catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  return url ? <img className="tx-files-thumb" src={url} alt={name} /> : <span className="tx-files-thumb is-empty" aria-hidden="true" />;
}

/** G3: the apps' results first, by name and preview; the from-apps/<app>/<job>/ folders stay below, for whoever wants them. */
function AppResults({ onOpen, stamp }) {
  const projectId = useApp((s) => s.projectId);
  const [r, setR] = useState(null);
  // the newest eight first; the rest one press away (the Mac pass of 1c5da0a: with five apps, an older handoff fell off the list)
  const [all, setAll] = useState(false);
  useEffect(() => { let gone = false; getJson(`/api/apps/outputs${projectQuery()}`).then((x) => { if (!gone) setR(x); }); return () => { gone = true; }; }, [projectId, stamp]);
  if (!r || !r.ok || !r.results.length) return null;
  return (
    <section className="tx-files-results" aria-label="Results from the apps">
      <p className="ta-context-k">RESULTS FROM THE APPS</p>
      <ul className="tx-files-results-list">
        {(all ? r.results : r.results.slice(0, 8)).map((x) => {
          const first = x.files.find((f) => f.image);
          return (
            <li key={x.receipt} className="tx-files-result" data-app={x.app}>
              {first ? <button type="button" className="tx-files-result-thumb" onClick={() => onOpen({ kind: 'file', path: first.path, name: first.name })} aria-label={`Open ${first.name}`}><Thumb path={first.path} name={first.name} /></button> : null}
              <div className="tx-files-result-words">
                <p className="tx-files-result-title"><strong>{appWord(x.app, x.title)}</strong> <span className="ta-muted">{x.label || 'job'} · {day(x.at)}</span></p>
                <div className="tx-files-chips">
                  {x.files.filter((f) => !/\.(log|json)$/i.test(f.name) || x.files.length <= 3).slice(0, 6).map((f) => (
                    <button key={f.path} type="button" className="ta-chip" onClick={() => onOpen({ kind: 'file', path: f.path, name: f.name })} title={f.path}>
                      {f.name}{f.sent.length ? ` · sent to ${appWord(f.sent[f.sent.length - 1].app)}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {r.results.length > 8 ? <button type="button" className="ta-link" data-action="all-results" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show the newest 8' : `Show all ${r.results.length} results`}</button> : null}
    </section>
  );
}

function OpenFile({ file, onSent }) {
  if (!file) return <Empty>Open a file from the list to read it here. Text and images are shown; anything else is described.</Empty>;
  const name = file.path.split('/').pop();
  return (
    <div className="tx-files-open">
      <p className="tx-files-open-name" title={file.path}>{name}</p>
      {file.state === 'reading' ? <p className="ta-muted">Reading…</p> : null}
      {file.state === 'refused' ? <p className="ta-result" role="status">{file.words}</p> : null}
      {file.state === 'image' ? <><img className="tx-files-img" src={file.url} alt={name} /><Facts rows={[['size', sizeWords(file.size)]]} /></> : null}
      {file.state === 'image' || file.state === 'text' ? <Provenance path={file.path} image={file.state === 'image' && /\.(png|jpe?g|webp)$/i.test(file.path)} onSent={onSent} /> : null}
      {file.state === 'text' ? (
        <>
          <Facts rows={[['size', sizeWords(file.size)], ['changed', day(file.mtime)], ['shown', file.truncated ? 'the first 256 KB (the file is longer)' : 'all of it']]} />
          {isMarkdown(name) ? <div className="tx-files-md"><Markdown text={fencesOf(file.text)} /></div> : <pre className="tx-files-text">{file.text}</pre>}
        </>
      ) : null}
    </div>
  );
}

export default function FilesPage() {
  const config = useApp((s) => s.config);
  const projectId = useApp((s) => s.projectId);
  const [path, setPath] = useState('');
  const [list, setList] = useState(null);
  const [file, setFile] = useState(null);
  const [filter, setFilter] = useState('');
  const urlRef = useRef(null);
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    let gone = false;
    setList(null);
    getJson(`/api/files?${q(path)}`).then((l) => { if (!gone) setList(l); });
    return () => { gone = true; };
  }, [path, projectId, config && config.project && config.project.root]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  const open = async (entry) => {
    if (entry.kind === 'dir') { setPath(entry.path); setFilter(''); return; }
    if (entry.kind !== 'file') { setFile({ path: entry.path, state: 'refused', words: 'This is neither a file nor a folder of the project (a link or a special file), so it is not opened.' }); return; }
    if (entry.view === 'binary') { setFile({ path: entry.path, state: 'refused', words: `Not opened here: this file is neither text nor an image this page shows${entry.size ? ` (${sizeWords(entry.size)})` : ''}. A tool of a chat turn can still read it.` }); return; }
    setFile({ path: entry.path, state: 'reading' });
    const f = await readFile(entry.path);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = f.url || null;
    setFile(f);
    // a phone shows the open file under the list: bring it into view
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches) requestAnimationFrame(() => { const el = document.querySelector('[data-page="files"] .ta-context'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  };
  const entries = list && list.ok && Array.isArray(list.entries) ? list.entries : [];
  const shown = filter ? entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase())) : entries;
  const folders = entries.filter((e) => e.kind === 'dir').length;
  const project = list && list.ok ? list.project.name : config && config.project ? config.project.name : null;
  return (
    <Page id="files"
      actions={<Button kind="primary" onClick={() => goTo('chat')} title="Ask Timmy about these files in the Chat">Ask Timmy about this project</Button>}
      band={[
        ['PROJECT', project || <span className="ta-muted">reading…</span>],
        ['FOLDER', <code key="f">{list && list.ok ? `/${list.path}` : '/'}</code>],
        ['HERE', list ? (list.ok ? `${entries.length - folders} files · ${folders} folders${list.truncated ? ' (more not listed)' : ''}` : <span className="ta-muted">not read</span>) : <span className="ta-muted">reading…</span>],
        ['WHERE', list && list.ok ? <code key="w" className="tx-files-where" title={list.where.root}>{list.where.root}</code> : <span className="ta-muted">—</span>],
      ]}
      context={<OpenFile file={file} onSent={() => setStamp((n) => n + 1)} />} contextTitle="The open file"
      tools={<>
        <span className="ta-toolsrow-k">FILES</span>
        <Tool glyph="↑" label="Up a folder" onClick={list && list.ok && list.parent !== null ? () => setPath(list.parent) : null} why="at the project's root" />
        <Tool glyph="⟳" label="Read again" onClick={() => { setList(null); getJson(`/api/files?${q(path)}`).then(setList); }} />
        <Tool glyph="✎" label="Edit" why="read-only: the companion has no route that writes a file" />
        <Tool glyph="⎘" label="Attach to chat" why="not in this build" />
      </>}>
      <Panel id="files" kicker="THE PROJECT'S FILES" title="This folder"
        tools={entries.length > 8 ? <input className="ta-search tx-files-filter" type="search" placeholder="Filter this folder" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter this folder" /> : null}>
        {!path ? <AppResults onOpen={open} stamp={stamp} /> : null}
        <Crumbs path={list && list.ok ? list.path : path} onGo={(p) => { setPath(p); setFilter(''); }} project={project} />
        {!list ? <p className="ta-muted">Reading the folder…</p>
          : !list.ok ? <p className="ta-result" role="status">{list.error || `The companion answered ${list.status}.`}</p>
            : !entries.length ? <Empty>{list.words}</Empty> : (
              <>
                <table className="ta-table tx-files-table">
                  <thead><tr><th>Name</th><th>Size</th><th>Changed</th></tr></thead>
                  <tbody>
                    {shown.map((e) => (
                      <tr key={e.path} aria-selected={file && file.path === e.path} className={`tx-files-row is-${e.kind}${e.heavy ? ' is-heavy' : ''}`}>
                        <td>
                          <button type="button" className="tx-files-name" onClick={() => open(e)} title={e.heavy ? 'A heavy folder (dependencies or build output): opened only when you ask' : e.path}>
                            <span className="tx-files-glyph" aria-hidden="true">{GLYPH[e.kind] || '·'}</span>{e.name}{e.kind === 'dir' ? '/' : ''}
                          </button>
                          {e.heavy ? <span className="tx-files-tag">heavy</span> : e.view === 'binary' ? <span className="tx-files-tag">not shown</span> : null}
                        </td>
                        <td className="ta-muted">{e.kind === 'file' ? sizeWords(e.size) : ''}</td>
                        <td className="ta-muted">{day(e.mtime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="ta-muted">{filter ? `${shown.length} of ${entries.length} match “${filter}”. ` : ''}{list.words} Nothing here writes a file.</p>
              </>
            )}
      </Panel>
    </Page>
  );
}
