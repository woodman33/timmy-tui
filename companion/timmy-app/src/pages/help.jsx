// R12 (the finish brief): Help & find — what each page of the rail is for (the rail's own words, ../nav.js), how to start, the
// keys, and where Timmy keeps what it does; a find box filters all of it and goes to the page an entry names. Nothing here is
// read from the companion: these are the app's own words about itself.
import { useMemo, useState } from 'react';
import { GROUPS, PAGES } from '../nav.js';
import { Page, Panel } from '../shell.jsx';
import { goTo } from '../store.js';
import { Button, Empty } from '../ui.jsx';
import './help.css';

/** How to start: one path through the app, each step on the page that does it. */
const START = [
  { n: '1', title: 'Choose a model', words: 'On Models & accounts: let Timmy look for the models on this computer (it asks you first), or connect a cloud account. Use one.', page: 'models' },
  { n: '2', title: 'Work in Chat', words: 'Say what you want to work on. Its tools ask you first (NEEDS YOU); Stop ends a turn at any time; each answer is sealed with a receipt.', page: 'chat' },
  { n: '3', title: 'Lay it out on the Canvas', words: 'A bounded desk for this project: the agent’s console, the chosen model, the last receipt, and your own notes and arrows.', page: 'canvas' },
  { n: '4', title: 'Check the proof', words: 'Runs & receipts: what ran, the model or tool that did it, and whether its receipt verified.', page: 'runs' },
];

/** The keys: the composer's and the desk's (tldraw's own shortcuts). */
const KEYS = [
  { keys: ['Enter'], words: 'Send the message (on a keyboard; on a phone Enter is a new line)', where: 'Chat · the composer', page: 'chat' },
  { keys: ['Shift', 'Enter'], words: 'A new line in the message', where: 'Chat · the composer', page: 'chat' },
  { keys: ['⌘ / Ctrl', 'Enter'], words: 'Send the message, always', where: 'Chat · the composer', page: 'chat' },
  { keys: ['V'], words: 'Arrange: select and move what is on the desk', where: 'Canvas', page: 'canvas' },
  { keys: ['H'], words: 'Hand: move around the desk', where: 'Canvas', page: 'canvas' },
  { keys: ['D'], words: 'Draw', where: 'Canvas', page: 'canvas' },
  { keys: ['A'], words: 'Connect: an arrow, bound to the cards it joins', where: 'Canvas', page: 'canvas' },
  { keys: ['T'], words: 'Text', where: 'Canvas', page: 'canvas' },
  { keys: ['⌘ / Ctrl', 'Z'], words: 'Undo', where: 'Canvas', page: 'canvas' },
  { keys: ['⌘ / Ctrl', 'Shift', 'Z'], words: 'Redo', where: 'Canvas', page: 'canvas' },
  { keys: ['Delete'], words: 'Delete what is selected on the desk', where: 'Canvas', page: 'canvas' },
];

/** Where Timmy keeps what it does (as this build keeps it; nothing here is a promise of more). */
const KEPT = [
  { title: 'Receipts', words: 'Each sealed answer and MCP call gets a receipt in the project’s receipt chain (.timmy/receipts in the project). The app shows whether each one verified.', page: 'runs' },
  { title: 'The conversation', words: 'One conversation per project, shared by every surface of Timmy (the terminal, this app, the Workbench); New conversation starts another and keeps the last one.', page: 'chat' },
  { title: 'The desk', words: 'Kept in this browser, one desk per project (tldraw’s own store). Export canvas in the footer saves it as a file; Import opens one again.', page: 'canvas' },
  { title: 'MCP calls', words: 'Each call made from Tools & integrations is kept with its request, answer and wire trace under .timmy/mcp in the project.', page: 'tools' },
  { title: 'This app’s choices', words: 'The theme, the page you were on and whether Timmy may ask this computer’s Ollama are kept in this browser only. The launch token is kept in this page’s memory, never stored.', page: 'settings' },
];

const norm = (t) => String(t || '').toLowerCase();

export default function HelpPage() {
  const [find, setFind] = useState('');
  const f = norm(find).trim();
  const has = (...parts) => !f || parts.some((p) => norm(p).includes(f));
  const pages = useMemo(() => PAGES.filter((p) => has(p.title, p.lead, p.kicker)), [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = START.filter((s) => has(s.title, s.words));
  const keys = KEYS.filter((k) => has(k.keys.join(' '), k.words, k.where));
  const kept = KEPT.filter((k) => has(k.title, k.words));
  const none = f && !pages.length && !start.length && !keys.length && !kept.length;
  return (
    <Page id="help"
      actions={<Button kind="primary" onClick={() => goTo('models')}>Start: choose a model</Button>}
      context={(
        <div className="tx-help-keys">
          {KEYS.slice(0, 3).map((k) => <p key={k.words}><span className="tx-help-k">{k.keys.map((x) => <kbd key={x}>{x}</kbd>)}</span> {k.words}</p>)}
          <p className="ta-muted">On the desk, tldraw’s own keys: V, H, D, A, T; ⌘/Ctrl + Z undoes.</p>
        </div>
      )}>
      <div className="tx-help-find">
        <input className="ta-search" type="search" placeholder="Find a page, a key, or where something is kept" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find in help" />
        {none ? <Empty>Nothing in help matches “{find}”.</Empty> : null}
      </div>
      {start.length ? (
        <Panel id="start" kicker="HOW TO START" title="Model → Chat → Canvas → proof">
          <ol className="tx-help-steps">
            {start.map((s) => (
              <li key={s.n}>
                <span className="tx-help-n" aria-hidden="true">{s.n}</span>
                <div><p className="tx-help-title">{s.title}</p><p className="ta-muted">{s.words}</p></div>
                <Button onClick={() => goTo(s.page)}>Open</Button>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}
      {pages.length ? (
        <Panel id="pages" kicker="THE PAGES" title="What each page is for">
          {GROUPS.map((g) => {
            const ps = pages.filter((p) => p.group === g.id);
            if (!ps.length) return null;
            return (
              <div key={g.id} className="tx-help-group">
                {g.label ? <p className="ta-context-k">{g.label}</p> : null}
                <ul className="tx-help-pages">
                  {ps.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="tx-help-page" onClick={() => goTo(p.id)} data-goto={p.id}>
                        <span className="tx-help-glyph" aria-hidden="true">{p.glyph}</span>
                        <span><span className="tx-help-title">{p.title}</span><span className="ta-muted tx-help-lead">{p.lead}</span></span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </Panel>
      ) : null}
      {keys.length ? (
        <Panel id="keys" kicker="THE KEYS" title="In the composer and on the desk">
          <table className="ta-table">
            <thead><tr><th>Keys</th><th>What it does</th><th>Where</th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.words}>
                  <td className="tx-help-k">{k.keys.map((x) => <kbd key={x}>{x}</kbd>)}</td>
                  <td>{k.words}</td>
                  <td><button type="button" className="ta-link" onClick={() => goTo(k.page)}>{k.where}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
      {kept.length ? (
        <Panel id="kept" kicker="WHERE THINGS ARE KEPT" title="What Timmy keeps, and where">
          <ul className="tx-help-kept">
            {kept.map((k) => (
              <li key={k.title}><p className="tx-help-title">{k.title}</p><p className="ta-muted">{k.words}</p><button type="button" className="ta-link" onClick={() => goTo(k.page)}>Open {PAGES.find((p) => p.id === k.page).title} →</button></li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </Page>
  );
}
