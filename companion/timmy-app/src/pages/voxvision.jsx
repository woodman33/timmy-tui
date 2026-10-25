// R12 (the finish brief): VoxVision — the spatial records Timmy keeps for this project (results/vox/<id>.json, timmy.vox/1), read
// through the companion's VoxVision routes (src/companion/panels/vox.ts; made by src/vox/preview.ts): the list, newest first, each
// with its action, status, check and receipt; the open record in the context column with its images (fetched with the token in a
// header and shown from a blob), its values and each one's provenance (measured / reconstructed / generated / not recorded) and
// evidence state (constructed / checked / declared / inferred / stale / unverified / unknown) as the record says them — never
// upgraded here. Nothing on this page runs a tool: the record's own next commands are copied for Timmy's terminal.
import { useEffect, useState } from 'react';
import { call, getJson } from '../api.js';
import { Page, Panel, Tool } from '../shell.jsx';
import { projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, day } from '../ui.jsx';
import './voxvision.css';

const R = { records: '/api/panel/voxvision/records', record: '/api/panel/voxvision/record', file: '/api/panel/voxvision/file' };
const FIRST = '/detect <image>';

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** A provenance or evidence word, with its meaning from the record's own legend (the page never chooses the word). */
function Tag({ kind, word, legend }) {
  if (!word) return null;
  const means = legend && legend[kind] ? legend[kind][word] : '';
  return <span className={`tx-vox-tag tx-vox-${kind} is-${String(word).replace(/\s+/g, '-')}`} title={means || word}>{word}</span>;
}

function Receipt({ r }) {
  if (!r) return <span className="ta-muted">—</span>;
  return r.verified ? <span className="ta-verified" title={r.words}>✓ {r.short || 'verified'}</span> : <span className="ta-unverified" title={r.words}>✕ {r.short ? `${r.short} · ` : ''}not verified</span>;
}

/** One image the record names, read through the file route (the token in a header) and shown from a blob. */
function RecordImage({ id, img }) {
  const [src, setSrc] = useState(null);
  const [why, setWhy] = useState('');
  useEffect(() => {
    if (!img.servable) return undefined;
    let url = null;
    let gone = false;
    (async () => {
      try {
        const r = await call(`${R.file}?id=${encodeURIComponent(id)}&path=${encodeURIComponent(img.path)}${projectQuery('&')}`);
        if (!r.ok) { let w = `the companion answered ${r.status}`; try { const j = await r.json(); w = j.error || w; } catch { /* no JSON */ } if (!gone) setWhy(w); return; }
        url = URL.createObjectURL(await r.blob());
        if (!gone) setSrc(url);
      } catch (e) { if (!gone) setWhy(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [id, img.path, img.servable]);
  return (
    <figure className="tx-vox-img" data-vox-image={img.key}>
      {src ? <img src={src} alt={img.title} /> : <div className="tx-vox-img-none">{img.servable ? (why ? `Not shown: ${why}` : 'Reading…') : `Not shown: ${img.why || 'the file route does not serve it'}`}</div>}
      <figcaption><span>{img.title}</span> <span className="ta-muted">{img.role}{img.matches === false ? ' · changed since the record' : img.matches === null ? ' · bytes not checked' : ''}</span></figcaption>
    </figure>
  );
}

function OpenRecord({ id }) {
  const [rec, setRec] = useState(null);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    let gone = false;
    setRec(null);
    getJson(`${R.record}?id=${encodeURIComponent(id)}${projectQuery('&')}`).then((r) => { if (!gone) setRec(r); });
    return () => { gone = true; };
  }, [id]);
  if (!rec) return <p className="ta-muted">Reading {id}…</p>;
  if (!rec.ok) return <p className="ta-result" role="status">{rec.error || 'The companion did not answer this record.'}</p>;
  const p = rec.preview;
  const legend = p.legend || {};
  const images = (p.images || []).slice(0, 4);
  return (
    <div className="tx-vox-open" data-vox-open={p.id}>
      <p className="tx-vox-open-title"><code>{p.id}</code> · {p.action} <StateWord word={p.status} /></p>
      {p.fake && p.fake.is ? <p className="tx-vox-fake" role="note">{p.fake.words && /^FAKE/.test(p.fake.words) ? p.fake.words : `FAKE: ${p.fake.words || 'made by a labelled test double, not a real tool'}`}</p> : null}
      <Facts rows={[
        ['made', p.madeAt ? day(p.madeAt) : null],
        ['check', <span key="c"><StateWord word={p.check.status} live={p.check.status === 'verified'} /> {(p.check.reasons || []).join(' · ')}</span>],
        ['receipt', <span key="r"><Receipt r={p.receipt} /> <span className="ta-muted">{p.receipt ? p.receipt.words : ''}</span></span>],
        ['file', <code key="f">{p.file}</code>],
      ]} />
      {images.length ? <div className="tx-vox-imgs">{images.map((img) => <RecordImage key={img.key} id={p.id} img={img} />)}</div> : null}
      {(p.values || []).length ? (
        <div className="tx-vox-values">
          <p className="ta-context-k">VALUES</p>
          <ul>
            {p.values.map((v) => (
              <li key={v.name}>
                <span className="tx-vox-v-title">{v.title}</span>
                <span className="tx-vox-v-text">{v.text}</span>
                <span className="tx-vox-v-tags"><Tag kind="provenance" word={v.provenance} legend={legend} /><Tag kind="evidence" word={v.evidence} legend={legend} />{v.measured_by ? <span className="ta-muted">by {v.measured_by}</span> : null}</span>
                {v.note ? <span className="ta-muted">{v.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : <Empty>This record keeps no values.</Empty>}
      {(p.spatial || []).length ? (
        <div className="tx-vox-values">
          <p className="ta-context-k">GEOMETRY</p>
          <ul>{p.spatial.map((s) => <li key={s.key}><span className="tx-vox-v-title">{s.what}</span><span className="tx-vox-v-text">{s.words}</span><span className="tx-vox-v-tags"><Tag kind="provenance" word={s.provenance} legend={legend} /><Tag kind="evidence" word={s.evidence} legend={legend} /></span></li>)}</ul>
        </div>
      ) : null}
      {(p.pipeline && p.pipeline.steps || []).length ? (
        <div className="tx-vox-values">
          <p className="ta-context-k">PIPELINE</p>
          <ul>{p.pipeline.steps.map((st) => <li key={st.name}><span className="tx-vox-v-title">{st.name}</span><span className="tx-vox-v-text">{st.words}</span></li>)}</ul>
        </div>
      ) : null}
      {p.doctrine ? <p className="tx-vox-doctrine">{p.doctrine}</p> : null}
      <p className="ta-muted">{p.verdict}</p>
      {(p.actions || []).length ? (
        <div className="tx-vox-actions">
          <p className="ta-context-k">NEXT IN TIMMY’S TERMINAL</p>
          {p.actions.map((a) => (
            <div key={a.command} className="tx-vox-action">
              <code>{a.command}</code>
              <span className="ta-muted">{a.enabled ? a.effect : a.why || 'not available for this record'}</span>
              <Button disabled={!a.enabled} onClick={async () => setCopied((await copy(a.command)) ? a.command : '')}>{copied === a.command ? 'Copied' : 'Copy'}</Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function VoxVisionPage() {
  const config = useApp((s) => s.config);
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [copied, setCopied] = useState(false);
  const read = async () => { setList(null); const r = await getJson(`${R.records}${projectQuery()}`); setList(r); if (r.ok && r.records && r.records.length && !open) setOpen(r.records[0].id); };
  useEffect(() => { read(); }, [config && config.project && config.project.root]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = list && list.ok && Array.isArray(list.records) ? list.records : [];
  const verified = rows.filter((r) => r.receipt && r.receipt.verified).length;
  const notChecked = rows.filter((r) => r.check && r.check.status !== 'verified').length;
  const fakes = rows.filter((r) => r.fake).length;
  const copyFirst = async () => { setCopied(await copy(FIRST)); };
  return (
    <Page id="voxvision"
      actions={rows.length ? <Button onClick={read}>Read again</Button> : <Button kind="primary" onClick={copyFirst} title="Copies the command for Timmy's terminal; nothing runs from this page">{copied ? 'Copied: /detect <image>' : 'Copy the detect command'}</Button>}
      band={[
        ['RECORDS', !list ? <span className="ta-muted">reading…</span> : list.ok ? `${rows.length}${list.more ? ` (+${list.more} not listed)` : ''}` : <span className="ta-muted">not read</span>],
        ['SEALED', list && list.ok ? <span>{verified ? <span className="ta-verified">✓ {verified} verified</span> : <span className="ta-muted">none verified</span>}</span> : <span className="ta-muted">—</span>],
        ['STALE OR UNVERIFIED', list && list.ok ? (notChecked ? <span className="ta-unverified">{notChecked} record{notChecked === 1 ? '' : 's'}</span> : <span className="ta-muted">none</span>) : <span className="ta-muted">—</span>],
        ...(fakes ? [['FAKE', <span key="f" className="ta-unverified">{fakes} made by a test double</span>]] : []),
      ]}
      context={open ? <OpenRecord id={open} /> : (
        <div className="tx-vox-legend">
          <p className="ta-muted">Select a record to open it here: its images, its values and where each came from.</p>
          <p className="ta-context-k">PROVENANCE</p>
          <ul>
            <li><b>measured</b> computed by a deterministic tool on the recorded bytes, in the file’s own frame; never of a physical object</li>
            <li><b>reconstructed</b> a mesh made from a STEP’s surfaces within a stated tolerance</li>
            <li><b>generated</b> a model’s prediction, or generated CAD a source report vouches for</li>
          </ul>
          <p className="ta-muted">Unknown space is never empty space: a value the record does not have stays unknown.</p>
        </div>
      )}
      contextTitle={open ? 'The open record' : 'How to read a record'}
      tools={<>
        <span className="ta-toolsrow-k">VOXVISION</span>
        <Tool glyph="⟳" label="Read again" onClick={read} />
        <Tool glyph="◇" label="Inspect" why="/inspect in the terminal" />
        <Tool glyph="◈" label="Detect" why="/detect in the terminal" />
        <Tool glyph="⟷" label="Measure" why="/measure in the terminal" />
        <Tool glyph="⇄" label="Compare" why="/compare in the terminal" />
      </>}>
      <Panel id="records" kicker="THIS PROJECT" title="Spatial records">
        {!list ? <p className="ta-muted">Reading the project’s records…</p>
          : !list.ok ? <p className="ta-result" role="status">The records could not be read: {list.error || `the companion answered ${list.status || 'nothing'}`}.</p>
            : !rows.length ? (
              <div className="tx-vox-empty">
                <Empty>No VoxVision record in this project yet ({config && config.project ? config.project.name : 'the project shown'}: results/vox/ holds none).</Empty>
                <p className="ta-muted">A record is made in Timmy’s terminal: <code>/inspect &lt;file&gt;</code> says what a file is, <code>/measure &lt;file&gt;</code> measures it with the tool that reads it, <code>/detect &lt;image|video&gt;</code> finds what is in an image; each record is sealed with a receipt. This page reads records; it runs nothing.</p>
              </div>
            ) : (
              <div className="tx-vox-scroll"><table className="ta-table" aria-label="VoxVision records">
                <thead><tr><th>Record</th><th>Action</th><th>Status</th><th>Check</th><th>Receipt</th><th>Made</th><th>Values · images</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} aria-selected={open === r.id} onClick={() => setOpen(r.id)} data-vox-row={r.id}>
                      <td><button type="button" className="ta-link" onClick={() => setOpen(r.id)}><code>{r.id}</code></button>{r.fake ? <span className="tx-vox-tag is-fake">FAKE</span> : null}</td>
                      <td>{r.action}</td>
                      <td>{r.status}</td>
                      <td><StateWord word={r.check.status} live={r.check.status === 'verified'} /></td>
                      <td><Receipt r={r.receipt} /></td>
                      <td>{r.madeAt ? day(r.madeAt) : <span className="ta-muted">not recorded</span>}</td>
                      <td>{r.counts.values} · {r.counts.images}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
        {list && list.ok && (list.unreadable || []).length ? <p className="ta-muted">Not read: {list.unreadable.map((u) => `${u.file} (${u.why})`).join('; ')}</p> : null}
      </Panel>
    </Page>
  );
}
