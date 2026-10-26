// R12 (the finish brief): Motion & 3D — the project's meshes and recordings, its parameter files and workflow documents, the three
// Houdini starters, and the routes that can make or change them with which of those are available HERE. Read through the
// companion's 3D & Motion routes (src/companion/panels/create.ts: /meshes, /mesh, /sources) and the Studio panel's (studio.ts:
// /board, and POST /open, the one-time grant that opens Timmy Studio on this project's board). Every number is the list's (Timmy's
// own STL / OBJ / PLY reader, from the whole file); the view is Timmy's own flat drawing of the file's triangles and measures
// nothing. Nothing on this page runs a tool or calls Houdini: editing, Save, Rebuild and Run are Studio's and the terminal's.
import { useEffect, useRef, useState } from 'react';
import { call, getJson, postJson } from '../api.js';
import { Page, Panel, Tool } from '../shell.jsx';
import { projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, day } from '../ui.jsx';
import './motion.css';

const R = { meshes: '/api/panel/create/meshes', mesh: '/api/panel/create/mesh', sources: '/api/panel/create/sources', board: '/api/panel/studio/board', open: '/api/panel/studio/open' };
/** DOCTRINE §15, verbatim (shown wherever measured 3D work is offered; the list's own `doctrine` is shown when it answers). */
export const DOCTRINE_15 = 'Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.';
/** The Houdini lane as probed (src/forge/stubs.ts): available is not exercised. */
const LANE_WORD = { flag_off: 'off', not_configured: 'armed, not on PATH', ready: 'on PATH, not exercised' };
const VIEWS = { front: [0, 0], top: [0, 90], side: [90, 0], iso: [45, 35.26] };
const n3 = (v) => (typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/\.?0+$/, '')) : '?');
const sizeWords = (rb) => (rb && rb.bbox ? rb.bbox.size.map(n3).join(' × ') : null);
const bytesWords = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} kB` : `${b} B`);

/** Timmy's own view of a mesh's triangles: orthographic, flat shading by each face's normal, painter's order, neutral greys. */
function MeshView({ mesh, view }) {
  const canvas = useRef(null);
  const [tris, setTris] = useState(null);
  const [state, setState] = useState('');
  useEffect(() => {
    let gone = false;
    setTris(null);
    setState('Reading the triangles…');
    const sha = mesh.readback && mesh.readback.sha256 ? `&sha=${mesh.readback.sha256}` : '';
    (async () => {
      try {
        const r = await call(`${R.mesh}?path=${encodeURIComponent(mesh.path)}${sha}${projectQuery('&')}`);
        if (!r.ok) { let w = `the companion answered ${r.status}`; try { const j = await r.json(); w = j.error || w; } catch { /* no JSON */ } if (!gone) setState(`Not drawn: ${w}`); return; }
        const shown = r.headers.get('X-Timmy-Triangles') || '';
        const buf = new Float32Array(await r.arrayBuffer());
        if (!gone) { setTris(buf); setState(shown ? `showing ${shown.replace('/', ' of ')} triangles` : ''); }
      } catch (e) { if (!gone) setState(`Not drawn: ${e instanceof Error ? e.message : String(e)}`); }
    })();
    return () => { gone = true; };
  }, [mesh.path, mesh.readback && mesh.readback.sha256]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !tris || !tris.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const [yawD, pitchD] = VIEWS[view] || VIEWS.iso;
    const yaw = (yawD * Math.PI) / 180;
    const pitch = (pitchD * Math.PI) / 180;
    const cy = Math.cos(yaw); const sy = Math.sin(yaw); const cp = Math.cos(pitch); const sp = Math.sin(pitch);
    // the file's own x right, z up, seen from −y; turned by yaw about z, then pitch about the screen's x
    const proj = (x, y, z) => { const x1 = x * cy + y * sy; const y1 = -x * sy + y * cy; return [x1, z * cp - y1 * sp, z * sp + y1 * cp]; };
    const n = tris.length / 9;
    const pts = new Float32Array(n * 9);
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let i = 0; i < n * 3; i += 1) {
      const p = proj(tris[i * 3], tris[i * 3 + 1], tris[i * 3 + 2]);
      pts[i * 3] = p[0]; pts[i * 3 + 1] = p[1]; pts[i * 3 + 2] = p[2];
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    const s = 0.86 * Math.min(W / Math.max(1e-9, maxX - minX), H / Math.max(1e-9, maxY - minY));
    const ox = W / 2 - ((minX + maxX) / 2) * s;
    const oy = H / 2 + ((minY + maxY) / 2) * s;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (pts[a * 9 + 2] + pts[a * 9 + 5] + pts[a * 9 + 8]) - (pts[b * 9 + 2] + pts[b * 9 + 5] + pts[b * 9 + 8]));
    for (const i of order) {
      const k = i * 9;
      const ax = pts[k + 3] - pts[k]; const ay = pts[k + 4] - pts[k + 1]; const az = pts[k + 5] - pts[k + 2];
      const bx = pts[k + 6] - pts[k]; const by = pts[k + 7] - pts[k + 1]; const bz = pts[k + 8] - pts[k + 2];
      const nx = ay * bz - az * by; const ny = az * bx - ax * bz; const nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const light = Math.abs((nx * 0.35 + ny * 0.55 - nz * 0.76) / len);
      const v = Math.round(46 + light * 186);
      g.fillStyle = `rgb(${v}, ${v}, ${v})`;
      g.beginPath();
      g.moveTo(ox + pts[k] * s, oy - pts[k + 1] * s);
      g.lineTo(ox + pts[k + 3] * s, oy - pts[k + 4] * s);
      g.lineTo(ox + pts[k + 6] * s, oy - pts[k + 7] * s);
      g.closePath();
      g.fill();
    }
  }, [tris, view]);
  return (
    <div className="tx-mo-view">
      <canvas ref={canvas} aria-label={`Timmy's own drawing of ${mesh.path}, ${view} view`} role="img" />
      <p className="ta-muted">{state}</p>
    </div>
  );
}

function MeshDetail({ mesh, view, doctrine, viewWords }) {
  const rb = mesh.readback;
  return (
    <div className="tx-mo-detail">
      <p className="tx-mo-detail-title"><code>{mesh.path}</code></p>
      {rb || mesh.kind === 'tessellation' ? <MeshView mesh={mesh} view={view} /> : null}
      {viewWords ? <p className="ta-muted tx-mo-small">{viewWords}</p> : null}
      {rb ? (
        <Facts rows={[
          ['triangles', String(rb.triangles)],
          ['corners', String(rb.corners)],
          ['box', rb.bbox ? `${sizeWords(rb)}${rb.units ? ` (${rb.units})` : ''}` : 'no triangles'],
          ['area', n3(rb.area)],
          ['volume', mesh.volume || n3(rb.volume)],
          ['topology', mesh.topology || null],
          ['measured by', mesh.reader ? mesh.reader.words : null],
          ['provenance', rb.provenance ? `${rb.provenance} · ${rb.evidence}` : null],
          ['origin', mesh.origin ? mesh.origin.words : null],
          ['declared', mesh.declared ? `${mesh.declared.words} (${mesh.declared.what}, not checked)` : null],
        ]} />
      ) : <p className="ta-muted">{mesh.pending ? 'Not measured yet: the next read of the list measures it.' : `Not measured: ${mesh.why || 'the reader gave no reason'}`}</p>}
      <p className="tx-mo-doctrine">{doctrine || DOCTRINE_15}</p>
    </div>
  );
}

/** One route that can make or change something here, and whether it is available on this computer, in the companion's words. */
function RouteRow({ name, state, words, here }) {
  return (
    <li className="tx-mo-route" data-route={name}>
      <span className="tx-mo-route-name">{name}</span>
      <span><StateWord word={state} live={false} /></span>
      <span className={here ? '' : 'ta-muted'}>{words}</span>
    </li>
  );
}

export default function MotionPage() {
  const config = useApp((s) => s.config);
  const [list, setList] = useState(null);
  const [src, setSrc] = useState(null);
  const [board, setBoard] = useState(null);
  const [pick, setPick] = useState(null);
  const [view, setView] = useState('iso');
  const [opening, setOpening] = useState(null);
  const read = async () => {
    const [m, s, b] = await Promise.all([getJson(`${R.meshes}${projectQuery()}`), getJson(`${R.sources}${projectQuery()}`), getJson(`${R.board}${projectQuery()}`)]);
    setList(m); setSrc(s); setBoard(b);
    if (m.ok && m.meshes && m.meshes.length) setPick((p) => p || m.meshes[0].path);
    return m;
  };
  useEffect(() => {
    let gone = false;
    let timer = 0;
    const again = async () => { const m = await read(); if (!gone && m.ok && (m.pending || m.recordingsPending)) timer = setTimeout(again, 2000); };
    again();
    return () => { gone = true; clearTimeout(timer); };
  }, [config && config.project && config.project.root]); // eslint-disable-line react-hooks/exhaustive-deps
  const openStudio = async () => {
    setOpening({ phase: 'asking' });
    const r = await postJson(`${R.open}${projectQuery()}`, {});
    // the grant is the companion's answer; whether a new tab opened, a page cannot know (a browser may block it): the link is said too
    if (r.ok && r.target && r.target.ok && r.target.url) {
      window.open(r.target.url, '_blank', 'noopener');
      setOpening({ phase: 'granted', words: <>Studio gave a one-time grant for {r.project ? r.project.name : 'this project'}’s board; Timmy asked the browser to open it in a new tab. If no tab opened: <a href={r.target.url} target="_blank" rel="noopener noreferrer">open Timmy Studio ↗</a></> });
    }
    else setOpening({ phase: 'refused', words: r.target ? r.target.why : r.error || 'The companion did not answer.' });
  };
  const meshes = list && list.ok && Array.isArray(list.meshes) ? list.meshes : [];
  const recs = list && list.ok && Array.isArray(list.recordings) ? list.recordings : [];
  const mesh = meshes.find((m) => m.path === pick) || null;
  const lane = src && src.ok ? src.houdini : null;
  const starters = src && src.ok && Array.isArray(src.starters) ? src.starters : board && board.ok && Array.isArray(board.starters) ? board.starters.map((t) => ({ ...t, steps: t.steps.map((w) => ({ n: w.slice(0, 2), verb: w.slice(3), guide: '' })) })) : [];
  const params = src && src.ok ? src.params || [] : [];
  const workflows = src && src.ok ? src.workflows || [] : [];
  const items = board && board.ok && Array.isArray(board.items) ? board.items.length : null;
  return (
    <Page id="motion"
      actions={<Button kind="primary" onClick={openStudio} disabled={opening && opening.phase === 'asking'} title="Asks Timmy Studio for a one-time grant on this project's board (POST /api/panel/studio/open)">{opening && opening.phase === 'asking' ? 'Asking Studio…' : 'Open Timmy Studio'}</Button>}
      note={opening && opening.words ? opening.words : null}
      band={[
        ['MESHES', !list ? <span className="ta-muted">reading…</span> : list.ok ? <>{meshes.length}{list.pending ? <span className="ta-muted"> · {list.pending} being measured</span> : null}</> : <span className="ta-muted">not read</span>],
        ['RECORDINGS', list && list.ok ? `${recs.length}` : <span className="ta-muted">—</span>],
        ['HOUDINI', lane ? <StateWord word={LANE_WORD[lane.status] || lane.status} /> : <span className="ta-muted">—</span>],
        ['STUDIO BOARD', board && board.ok ? <span>{items} item{items === 1 ? '' : 's'}{board.board && board.board.savedAt ? <span className="ta-muted"> · saved {day(board.board.savedAt)}</span> : <span className="ta-muted"> · never saved</span>}</span> : <span className="ta-muted">—</span>],
      ]}
      context={mesh ? <MeshDetail mesh={mesh} view={view} doctrine={list && list.doctrine} viewWords={list && list.view} /> : (
        <div className="tx-mo-detail">
          <p className="ta-muted">{meshes.length ? 'Select a mesh to see it and what Timmy’s own reader measured of the whole file.' : 'No mesh to show: this project has no STL, OBJ or PLY file Timmy can read.'}</p>
          <p className="tx-mo-doctrine">{(list && list.doctrine) || DOCTRINE_15}</p>
        </div>
      )}
      contextTitle={mesh ? 'The open mesh' : 'The open item'}
      tools={<>
        <span className="ta-toolsrow-k">VIEW</span>
        {Object.keys(VIEWS).map((v) => <Tool key={v} glyph={v[0].toUpperCase()} label={v === 'iso' ? 'Isometric' : v[0].toUpperCase() + v.slice(1)} pressed={view === v} onClick={mesh ? () => setView(v) : null} why={mesh ? '' : 'no mesh open'} />)}
        <span className="ta-toolsrow-sep" aria-hidden="true" />
        <Tool glyph="⟳" label="Read again" onClick={read} />
        <Tool glyph="⚙" label="Cook in Houdini" why={lane && lane.status === 'ready' ? 'a REPL’s tool call' : 'not configured'} />
        <Tool glyph="▶" label="Run a workflow" why="/run in the terminal" />
      </>}>
      <Panel id="meshes" kicker="GEOMETRY" title="Meshes and recordings">
        {!list ? <p className="ta-muted">Reading the project’s meshes…</p>
          : !list.ok ? <p className="ta-result" role="status">The meshes could not be read: {list.error || `the companion answered ${list.status || 'nothing'}`}.</p>
            : !meshes.length ? <Empty>No mesh in {config && config.project ? config.project.name : 'this project'} yet: Timmy reads STL, OBJ and PLY files in the project ({list.walk ? `${list.walk.files} file${list.walk.files === 1 ? '' : 's'} looked at` : 'the project walked'}), and a STEP’s tessellations a VoxVision record names.</Empty>
              : (
                <div className="tx-mo-scroll"><table className="ta-table tx-mo-table" aria-label="Meshes">
                  <thead><tr><th>File</th><th>Kind</th><th>Triangles</th><th>Box</th><th>Size</th><th>Origin</th></tr></thead>
                  <tbody>
                    {meshes.map((m) => (
                      <tr key={m.path} aria-selected={pick === m.path} onClick={() => setPick(m.path)} data-mesh={m.path} className="tx-mo-row">
                        <td><button type="button" className="ta-link" onClick={() => setPick(m.path)}><code>{m.path}</code></button></td>
                        <td>{m.kind === 'tessellation' ? 'tessellation' : m.kind.toUpperCase()}</td>
                        <td>{m.readback ? m.readback.triangles : <span className="ta-muted">{m.pending ? 'measuring…' : 'not measured'}</span>}</td>
                        <td>{sizeWords(m.readback) || '—'}</td>
                        <td>{bytesWords(m.bytes)}</td>
                        <td>{m.origin ? m.origin.provenance : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
        {recs.length ? (
          <ul className="tx-mo-list" aria-label="Rerun recordings">
            {recs.map((r) => <li key={r.path}><code>{r.path}</code> <span className="ta-muted">{bytesWords(r.bytes)} · {r.origin ? r.origin.words : ''}</span></li>)}
          </ul>
        ) : list && list.ok ? <p className="ta-muted">No Rerun recording in the project.</p> : null}
      </Panel>

      <Panel id="routes" kicker="WHAT CAN MAKE OR CHANGE THEM" title="Routes, and which are available here">
        {!list || !src ? <p className="ta-muted">Reading…</p> : (
          <ul className="tx-mo-routes">
            <RouteRow name="Measure a mesh" state="here" here words={list.ok ? list.reader : 'not read'} />
            {list.ok && list.viewer ? <RouteRow name={list.viewer.name} state={list.viewer.state} here={list.viewer.state.startsWith('found')} words={list.viewer.words} /> : null}
            {lane ? <RouteRow name="Cook in Houdini" state={LANE_WORD[lane.status] || lane.status} here={false} words={lane.words} /> : <RouteRow name="Cook in Houdini" state="not read" here={false} words={src.error || 'The sources were not read.'} />}
            <RouteRow name="Parameters (Save, Rebuild)" state={params.length ? `${params.length} file${params.length === 1 ? '' : 's'}` : 'none'} here={false}
              words={params.length ? 'Edited, saved and rebuilt in Studio’s parameter node or by its typed command; nothing here runs.' : 'This project has no parameter file (a tray recipe or an OpenSCAD model).'} />
            <RouteRow name="Workflows (Run)" state={workflows.length ? `${workflows.length} document${workflows.length === 1 ? '' : 's'}` : 'none'} here={false}
              words={workflows.length ? 'Run in Timmy’s terminal with /run, or from Studio’s workflow node; nothing here runs.' : 'This project has no workflow document.'} />
          </ul>
        )}
        {params.length ? (
          <div className="tx-mo-sources">
            {params.map((p) => (
              <div key={p.id} className="tx-mo-source"><p><b>{p.title}</b> <span className="ta-muted">{p.engine} · {p.state}</span></p>
                <p className="ta-muted">{p.values.slice(0, 6).map((v) => `${v.name} ${v.value}${v.unit ? ` ${v.unit}` : ''}`).join(' · ')}{p.more ? ` · +${p.more}` : ''}</p>
                <code>{p.command}</code></div>
            ))}
          </div>
        ) : null}
        {workflows.length ? (
          <div className="tx-mo-sources">
            {workflows.map((w) => (
              <div key={w.id} className="tx-mo-source"><p><b>{w.title}</b> <span className="ta-muted">{w.state}{w.houdini ? ' · names Houdini' : ''}</span></p>
                <p className="ta-muted">{w.blocks.map((b) => `${b.glyph} ${b.name}`).join('  ')}</p>
                {w.runnable ? null : <p className="ta-muted">{w.notRunnable}</p>}</div>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel id="starters" kicker="CANVAS & HOUDINI STARTERS" title="Start a board in Timmy Studio">
        {!starters.length ? <Empty>{src ? 'The companion named no starter.' : 'Reading the starters…'}</Empty> : (
          <div className="tx-mo-starters">
            {starters.map((t) => (
              <article key={t.id} className="tx-mo-starter" data-starter={t.id}>
                <p className="tx-mo-starter-title">{t.title} <span className="ta-muted">{t.id}</span></p>
                <p className="ta-muted">{t.intro}</p>
                <ol>{t.steps.map((st) => <li key={st.n}><span className="tx-mo-n">{st.n}</span><b>{st.verb}</b></li>)}</ol>
                {t.steps.some((st) => st.guide) ? (
                  <details className="ta-details"><summary>What each step takes</summary>
                    <ul className="tx-mo-guides">{t.steps.map((st) => <li key={st.n}><b>{st.n}</b> {st.guide}</li>)}</ul>
                  </details>
                ) : null}
              </article>
            ))}
            <p className="ta-muted">A starter opens from Studio’s New board, on this project’s board: Open Timmy Studio asks Studio for a one-time grant. Every card starts blank; the board never calls Houdini.</p>
          </div>
        )}
      </Panel>
    </Page>
  );
}
