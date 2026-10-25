// R12 (the finish brief): Settings — how this app looks and what it may ask this computer: the theme, the permission to ask this
// computer's Ollama for its models, the project the page shows, the companion's two start-up settings (the Workbench's own
// file, written through POST /api/workspace/prefs with the revision this page read: a change made elsewhere is never
// overwritten, 409 stale), and About (the canvas SDK's version and licence as it read them).
import { useEffect, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { Page, Panel, ThemeSwitch } from '../shell.jsx';
import { answerLocalPermission, goTo, projectQuery, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord, day } from '../ui.jsx';
import './settings.css';

const PERMISSION_WORDS = {
  granted: 'Timmy may ask the Ollama on this computer for its list of models (its /api/tags, then /api/show for each). No model runs and nothing is downloaded by asking.',
  declined: 'Timmy asks this computer’s Ollama nothing: you said not now. The Chat can still use a cloud model.',
  unasked: 'Not asked yet: Timmy asks this computer’s Ollama nothing until you say yes.',
};

function StartUp() {
  const config = useApp((s) => s.config);
  const [frame, setFrame] = useState(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const read = async () => setFrame(await getJson(`/api/workspace${projectQuery()}`));
  useEffect(() => { read(); }, [config && config.project ? config.project.root : '']); // eslint-disable-line react-hooks/exhaustive-deps
  if (!frame) return <Empty>Reading the companion’s settings…</Empty>;
  if (frame.ok === false || !frame.surfaces) return <Empty>{frame.error || 'The companion did not answer its settings.'}</Empty>;
  const s = frame.surfaces;
  const save = async (key, value) => {
    setBusy(true); setSaid('');
    const r = await postJson(`/api/workspace/prefs${projectQuery()}`, { [key]: value, if_revision: frame.revision });
    setBusy(false);
    if (r.status === 200 && r.frame) { setFrame(r.frame); setSaid(`Saved${r.saved_at ? ` at ${day(r.saved_at)}` : ''}.`); }
    else if (r.status === 409 && r.frame) { setFrame(r.frame); setSaid('Not saved: the settings changed elsewhere since this page read them. They are shown as they are now; change them again if you still want to.'); }
    else setSaid(`Not saved: ${r.error || `the companion answered ${r.status}`}. Nothing was written.`);
  };
  const row = (key, label, on, words) => (
    <label className="tx-set-check">
      <input type="checkbox" checked={!!on} disabled={busy} onChange={(e) => save(key, e.target.checked)} />
      <span><span className="tx-set-label">{label}</span><span className="ta-muted">{words}</span></span>
    </label>
  );
  return (
    <>
      {row('openCompanionAtStart', 'Open the browser companion when Timmy starts', s.companion && s.companion.openAtStart, 'Kept in the Workbench’s settings file, the same one the terminal Workbench uses.')}
      {row('openStudioAtStart', 'Open Timmy Studio when Timmy starts', s.studio && s.studio.openAtStart, 'The same file; Timmy Studio is the Studio’s own canvas page, which Timmy serves apart from this app.')}
      {said ? <p className="ta-muted" role="status">{said}</p> : null}
    </>
  );
}

export default function SettingsPage() {
  const permission = useApp((s) => s.localPermission);
  const config = useApp((s) => s.config);
  const license = useApp((s) => s.license);
  const theme = useApp((s) => s.theme);
  const project = config && config.project;
  return (
    <Page id="settings"
      band={[
        ['THEME', theme === 'glacier' ? 'Glacier' : 'Amber'],
        ['THIS COMPUTER', permission === 'granted' ? 'may be asked for its models' : permission === 'declined' ? 'not asked (you said not now)' : 'not asked yet'],
        ['PROJECT', project ? project.name : <span className="ta-muted">none named</span>],
      ]}
      context={(
        <>
          <Facts rows={[
            ['canvas', config && config.tldrawVersion ? `tldraw ${config.tldrawVersion}` : null],
            ['licence', license ? <span key="l"><StateWord word={license.state} live={license.state === 'licensed'} /> <span className="ta-muted">{license.words}</span></span> : <span key="l" className="ta-muted">read when the Canvas opens</span>],
            ['served by', 'the browser companion on this computer, at /app'],
            ['token', 'kept in this page’s memory only, sent in a header'],
          ]} />
          {!license ? <Button onClick={() => goTo('canvas')}>Open the Canvas</Button> : null}
        </>
      )}>
      <div className="ta-grid-2">
        <Panel id="theme" kicker="LOOK" title="Theme">
          <ThemeSwitch />
          <p className="ta-muted">Amber or Glacier changes the accent only; a state’s meaning never changes with it (green is for a live connection, a passed check or a verified receipt). Kept in this browser.</p>
        </Panel>
        <Panel id="local" kicker="THIS COMPUTER" title="Models on this computer">
          <p className="ta-line"><StateWord word={permission === 'granted' ? 'allowed' : permission === 'declined' ? 'not now' : 'not asked'} /></p>
          <p className="ta-muted">{PERMISSION_WORDS[permission] || PERMISSION_WORDS.unasked}</p>
          <div className="ta-row">
            {permission !== 'granted' ? <Button kind="primary" onClick={() => answerLocalPermission(true)}>Allow Timmy to look</Button> : null}
            {permission === 'granted' ? <Button onClick={() => answerLocalPermission(false)}>Stop asking this computer</Button> : null}
            <Button onClick={() => goTo('models')}>Models &amp; accounts →</Button>
          </div>
          <p className="ta-muted">Kept in this browser only.</p>
        </Panel>
        <Panel id="project" kicker="PROJECT" title="The project this page shows">
          {project ? <Facts rows={[['name', project.name], ['folder', <code key="r" className="tx-set-path">{project.root}</code>]]} /> : <Empty>The companion named no project for this page.</Empty>}
          <p className="ta-muted">Switch with the project button at the top of the rail. Without accounts, this companion follows the folder Timmy was started in.</p>
        </Panel>
        <Panel id="startup" kicker="WHEN TIMMY STARTS" title="Start-up">
          <StartUp />
        </Panel>
      </div>
    </Page>
  );
}
