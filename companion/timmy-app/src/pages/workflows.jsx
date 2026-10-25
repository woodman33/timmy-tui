// R12 (the finish brief): Workflows — the project's workflow documents as the terminal Workbench reads them
// (GET /api/panel/workflows/docs, timmy.workflows/1: src/companion/panels.ts). Each document's named blocks with their state in
// the board's words, whether the runner (upmd) is on this computer, the runs under way, and the ONE next action with its
// terminal command. A run starts in the terminal (the Workbench's R or the REPL's /run): this page starts none and says so; it
// copies the command. The selected document is read whole through GET /api/files/file and drawn as Markdown.
import { useEffect, useState } from 'react';
import { getJson } from '../api.js';
import { Markdown } from '../md.jsx';
import { Page, Panel, Tool } from '../shell.jsx';
import { goTo, projectQuery, useApp } from '../store.js';
import { Button, Empty, StateWord, clock } from '../ui.jsx';
import './workflows.css';

/**
 * A fence's info string beyond its language (a workflow block's ```bash [name:build]) as only its language: ../md.jsx reads
 * ```lang alone, and a longer info string stopped its paragraph reader without moving on (the page hung).
 */
const fencesOf = (text) => String(text || '').replace(/^([ \t]*```)[ \t]*([\w+-]*)[^`\n]*$/gm, '$1$2');
const live = (w) => /^(ran|completed|passed|no change)$/i.test(String(w || ''));

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function Blocks({ doc }) {
  if (doc.error) return <p className="ta-result" role="status">{doc.rel} could not be read whole: {doc.error}</p>;
  if (!doc.blocks.length) return <Empty>No named block in this document (a block is a fenced code block with a name: ```bash [name:build]).</Empty>;
  return (
    <ul className="tx-wf-blocks">
      {doc.blocks.map((b) => (
        <li key={b.key} className="tx-wf-block">
          <span className="tx-wf-glyph" aria-hidden="true">{b.glyph || '·'}</span>
          <div className="tx-wf-block-main">
            <p className="tx-wf-block-name"><code>{b.name}</code> <span className="ta-muted">{b.lang}</span> <StateWord word={b.word} live={live(b.word)} /></p>
            {b.detail ? <p className="ta-muted">{b.detail}</p> : null}
            {b.needs && b.needs.length ? <p className="ta-muted">needs {b.needs.join(', ')}{b.missing && b.missing.length ? ` · missing ${b.missing.join(', ')}` : ''}</p> : null}
            {b.run ? <p className="ta-muted">last run <code>{b.run}</code></p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Doc({ doc }) {
  const projectId = useApp((s) => s.projectId);
  const [file, setFile] = useState(null);
  useEffect(() => {
    if (!doc) return undefined;
    let gone = false;
    setFile(null);
    getJson(`/api/files/file?path=${encodeURIComponent(doc.rel)}${projectQuery('&')}`).then((f) => { if (!gone) setFile(f); });
    return () => { gone = true; };
  }, [doc && doc.rel, projectId]);
  if (!doc) return <Empty>Select a workflow document to read it here.</Empty>;
  return (
    <div className="tx-wf-doc">
      <p className="tx-wf-doc-title">{doc.title || doc.rel}</p>
      <p className="ta-muted"><code>{doc.rel}</code> · {doc.blocks.length} block{doc.blocks.length === 1 ? '' : 's'}{doc.repeated && doc.repeated.length ? ` · names used twice: ${doc.repeated.join(', ')}` : ''}</p>
      {!file ? <p className="ta-muted">Reading the document…</p>
        : file.ok && file.kind === 'text' ? <div className="tx-wf-md"><Markdown text={fencesOf(file.text)} />{file.truncated ? <p className="ta-muted">Only its first 256 KB are shown.</p> : null}</div>
          : <p className="ta-result" role="status">{file.error || `The companion answered ${file.status}.`}</p>}
    </div>
  );
}

export default function WorkflowsPage() {
  const projectId = useApp((s) => s.projectId);
  const config = useApp((s) => s.config);
  const [a, setA] = useState(null);
  const [selected, setSelected] = useState(null);
  const [said, setSaid] = useState('');
  const read = () => { setA(null); getJson(`/api/panel/workflows/docs${projectQuery()}`).then((r) => { setA(r); if (r.ok && r.docs && r.docs.length) setSelected((s) => (s && r.docs.some((d) => d.rel === s) ? s : r.docs[0].rel)); }); };
  useEffect(read, [projectId, config && config.project && config.project.root]); // eslint-disable-line react-hooks/exhaustive-deps
  const docs = a && a.ok && Array.isArray(a.docs) ? a.docs : [];
  const running = a && a.ok && Array.isArray(a.running) ? a.running : [];
  const next = a && a.ok ? a.next : null;
  const blocks = docs.reduce((n, d) => n + d.blocks.length, 0);
  const notRun = docs.reduce((n, d) => n + d.blocks.filter((b) => b.word === 'not run yet').length, 0);
  const doc = docs.find((d) => d.rel === selected) || null;
  const copyCommand = async (cmd) => { const ok = await copy(cmd); setSaid(ok ? `Copied: ${cmd} — paste it in Timmy's terminal (the Workbench or the REPL).` : `Not copied (this browser refused the clipboard). The command: ${cmd}`); };
  const primary = !next ? null
    : next.kind === 'open' ? <Button kind="primary" onClick={() => goTo('runs')}>Open Runs &amp; receipts</Button>
      : next.command ? <Button kind="primary" onClick={() => copyCommand(next.command)}>Copy: {next.command}</Button> : null;
  return (
    <Page id="workflows" actions={primary} note={said || null}
      band={[
        ['DOCUMENTS', a ? (a.ok ? String(docs.length) : <span className="ta-muted">not read</span>) : <span className="ta-muted">reading…</span>],
        ['BLOCKS', a && a.ok ? <>{blocks} <span className="ta-muted">· {notRun} not run yet</span></> : <span className="ta-muted">—</span>],
        ['RUNNER', a && a.ok ? (a.upmd ? <StateWord word="upmd on this computer" live /> : <StateWord word="upmd not found" />) : <span className="ta-muted">—</span>],
        ['RUNNING', a && a.ok ? (running.length ? <StateWord word={`${running.length} under way`} /> : <span className="ta-muted">none</span>) : <span className="ta-muted">—</span>],
      ]}
      context={<Doc doc={doc} />} contextTitle="The selected workflow"
      tools={<>
        <span className="ta-toolsrow-k">WORKFLOWS</span>
        <Tool glyph="⟳" label="Read again" onClick={read} />
        <Tool glyph="▶" label="Run a block" why="runs start in Timmy's terminal (the Workbench's R or /run in the REPL)" />
        <Tool glyph="☰" label="Runs & receipts" onClick={() => goTo('runs')} />
      </>}>
      {next ? (
        <Panel id="wf-next" kicker="NEXT" title={next.words}>
          {next.command ? <p className="ta-muted">In Timmy’s terminal: <code>{next.command}</code></p> : null}
          {a.notes && a.notes.length ? a.notes.map((n) => <p key={n} className="ta-muted">{n}</p>) : null}
        </Panel>
      ) : null}
      {running.length ? (
        <Panel id="wf-running" kicker="UNDER WAY" title="Runs of this project now">
          <ul className="tx-wf-running">{running.map((r) => <li key={r.id}><span aria-hidden="true">▶</span> {r.label} <StateWord word={r.word} /> <span className="ta-muted">{r.elapsed}</span></li>)}</ul>
        </Panel>
      ) : null}
      <Panel id="wf-docs" kicker="THE PROJECT'S WORKFLOWS" title="Documents and their blocks">
        {!a ? <p className="ta-muted">Reading the project’s workflow documents…</p>
          : !a.ok ? <p className="ta-result" role="status">{a.error || `The companion answered ${a.status}.`}</p>
            : !docs.length ? <Empty>{next ? next.words : 'No workflow document in this project yet.'}</Empty> : (
              <div className="tx-wf-list">
                {docs.map((d) => (
                  <article key={d.rel} className={`tx-wf-card${d.rel === selected ? ' is-selected' : ''}`}>
                    <button type="button" className="tx-wf-card-head" aria-pressed={d.rel === selected} onClick={() => setSelected(d.rel)}>
                      <span className="tx-wf-card-title">{d.title || d.rel}</span>
                      <code className="ta-muted">{d.rel}</code>
                    </button>
                    <Blocks doc={d} />
                  </article>
                ))}
                <p className="ta-muted">Read {clock(a.at)} from the project’s documents, its job store and its receipts; nothing ran.</p>
              </div>
            )}
      </Panel>
    </Page>
  );
}
