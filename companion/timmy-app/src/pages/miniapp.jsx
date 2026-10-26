// R13 (the 2026-10-26 integration order): the four launch mini-apps and Timmy Animate on the permanent rail. Each page reads
// /api/apps (src/companion/miniapps/routes.ts): an app Timmy can host here opens inside this page's frame, through the gateway
// address the companion gives for this principal and project (the launch address is one-time and short-lived); an app whose
// reviewed source is not in hand says so with the integration register's record (owner, revision, date, the missing step).
// Nothing here stands in for an app: no mock canvas, no sample data.
import { useCallback, useEffect, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { Page, Panel } from '../shell.jsx';
import { projectQuery, useApp } from '../store.js';
import { Button, Facts, StateWord } from '../ui.jsx';
import './miniapp.css';

const WAITING = {
  'awaiting-owner-checkpoint': 'Waiting for the owner’s checkpoint',
  'no-owner': 'Not built: no owner assigned',
};

function useApps() {
  const generation = useApp((s) => s.projectId);
  const [apps, setApps] = useState(null);
  const read = useCallback(() => getJson(`/api/apps${projectQuery()}`).then(setApps), []);
  useEffect(() => { read(); }, [read, generation]);
  return [apps, read];
}

function Record({ a }) {
  const o = a.observed;
  if (!o) return null;
  return <Facts rows={[['owner', o.owner], ['source', o.revision], ['recorded', o.observedAt], ...(a.installed ? [['installed here', a.installed.slice(0, 8)]] : []), ['next step', o.next]]} />;
}

export function MiniAppPage({ appId }) {
  const [apps, read] = useApps();
  const [open, setOpen] = useState(null); // { url } while framed
  const [busy, setBusy] = useState('');
  const [words, setWords] = useState('');
  const a = apps && apps.ok ? apps.apps.find((x) => x.id === appId) : null;

  const start = async () => {
    setBusy('open'); setWords('');
    const r = await postJson(`/api/apps/${appId}/open${projectQuery()}`, {});
    setBusy('');
    if (r.ok && r.url) setOpen({ url: r.url, startedAt: r.startedAt });
    else setWords(r.error || 'The companion did not open the app.');
    read();
  };
  const stop = async () => {
    setBusy('stop');
    const r = await postJson(`/api/apps/${appId}/stop${projectQuery()}`, {});
    setBusy(''); setOpen(null);
    setWords(r.ok ? (r.stopped ? 'Stopped. Its work is kept in this project.' : 'It was not running.') : (r.error || 'The companion did not stop it.'));
    read();
  };

  if (!apps) return <Page id={appId}><p className="ta-muted">Reading the mini-apps…</p></Page>;
  if (!apps.ok || !a) return <Page id={appId}><p className="ta-result" role="status">{apps.error || 'The companion did not list this app.'}</p></Page>;

  if (open) {
    return (
      <Page id={appId} fill head={false}>
        <div className="ta-miniapp" data-miniapp={appId} data-miniapp-state="open">
          <div className="ta-miniapp-bar" role="toolbar" aria-label={`${a.title} controls`}>
            <span className="ta-miniapp-name">{a.title}</span>
            <StateWord word="running" live />
            <span className="ta-muted">{apps.project ? `in ${apps.project}` : ''}</span>
            <span className="ta-miniapp-gap" />
            <Button onClick={stop} disabled={busy === 'stop'} title={`Stop ${a.title} for this project`}>Stop</Button>
          </div>
          <iframe className="ta-miniapp-frame" title={a.title} src={open.url} data-miniapp-frame={appId} />
        </div>
      </Page>
    );
  }

  const hostable = a.hostable;
  return (
    <Page
      id={appId}
      actions={hostable ? <Button kind="primary" onClick={start} disabled={busy === 'open'}>{busy === 'open' ? 'Opening…' : `Open ${a.title}`}</Button> : null}
      band={[['status', hostable ? (a.running ? 'running' : 'ready to open') : (a.problem ? 'not available here' : WAITING[a.availability] || a.availability)], ['project', apps.project || 'none open']]}
      note={words || null}
    >
      <Panel title={hostable ? `${a.title} runs here as its owner built it` : (a.problem ? `${a.title} cannot start here` : WAITING[a.availability])} kicker={a.kind.toUpperCase()} id={`miniapp-${appId}`}>
        <p className="ta-miniapp-lead">{a.lead}</p>
        {a.problem ? <p className="ta-result" role="status">{a.problem}</p> : null}
        {hostable ? <p className="ta-muted">It keeps its work in this project’s own folder, separate for each person signed in. Paid model calls stay held.</p> : null}
        <Record a={a} />
      </Panel>
    </Page>
  );
}

export const CardLabPage = () => <MiniAppPage appId="card-lab" />;
export const FilmRoomPage = () => <MiniAppPage appId="film-room" />;
export const ModelStudioPage = () => <MiniAppPage appId="model-studio" />;
export const StreamStudioPage = () => <MiniAppPage appId="stream-studio" />;
export const AnimatePage = () => <MiniAppPage appId="animate" />;
