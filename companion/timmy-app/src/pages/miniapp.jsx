// R13 (the 2026-10-26 integration order): the four launch mini-apps and Timmy Animate on the permanent rail. Each page reads
// /api/apps (src/companion/miniapps/routes.ts): an app Timmy can host here opens inside this page's frame, through the gateway
// address the companion gives for this principal and project (the launch address is one-time and short-lived); an app whose
// reviewed source is not in hand says so with the integration register's record (owner, revision, date, the missing step).
// Nothing here stands in for an app: no mock canvas, no sample data.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, postJson } from '../api.js';
import { Page, Panel } from '../shell.jsx';
import { PAGES, aimAgent, aimCanvasOperation, goBack, goTo, projectQuery, takeAppTarget, useApp } from '../store.js';
import { MenuButton, MenuGroup, MenuItem } from '../menu.jsx';
import { operations } from './op-node.jsx';
import { Button, Facts, StateWord } from '../ui.jsx';
import './miniapp.css';

const WAITING = {
  'awaiting-owner-checkpoint': 'Waiting for the owner’s checkpoint',
  'no-owner': 'Not built: no owner assigned',
};

/**
 * The launch path for an app with the theme contract: its own path (Open inspection's `/?run=<id>`, or its root) with
 * `theme=` and, when the app reads it there, the exact origin of this page (Card Lab's themeHostOrigin); null for another app.
 */
export function themedPath(app, to, theme) {
  if (!app || !app.theme) return to;
  const u = new URL(to || '/', 'http://app.invalid');
  u.searchParams.set('theme', theme === 'glacier' ? 'glacier' : 'amber');
  if (app.theme.hostOriginParam && typeof location !== 'undefined') u.searchParams.set(app.theme.hostOriginParam, location.origin);
  return `${u.pathname}${u.search}`;
}

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
  return <Facts rows={[['owner', o.owner], ['source', o.revision], ['recorded', o.observedAt], ...(a.installed ? [['installed here', /^[0-9a-f]{40}$/.test(a.installed) ? a.installed.slice(0, 8) : a.installed]] : []), ['next step', o.next]]} />;
}

/**
 * The spatial tools order (2026-10-28): 3D Model Studio's Gaussian-splat operations (Timmy's own jobs: KIRI in Blender, Brush;
 * gsplat awaiting an NVIDIA worker), each opening on the shared Workspace canvas as an operation node. One that cannot run here
 * is listed with its precise reason, never as a working item. Model Studio's own page is its owner's; this menu is the host's.
 */
function SplatMenu() {
  const [specs, setSpecs] = useState(null);
  useEffect(() => { operations().then((all) => setSpecs(all.filter((o) => o.app === 'spatial'))); }, []);
  return (
    <MenuButton label="Gaussian splats" glyph="✷" title="Gaussian-splat operations on the Workspace" menuLabel="Gaussian-splat operations" buttonClass="ta-btn ta-splat-menu" data={{ 'data-menu': 'splats' }}>
      {(close) => (
        <>
          <MenuGroup label="On the Workspace canvas">
            {!specs ? <p className="ta-menu-note">Reading the operations…</p> : specs.map((o) => {
              const why = o.available && o.available.ok === false ? o.available.why : null;
              return <MenuItem key={o.id} close={close} disabled={Boolean(why)} hint={why || (o.heavy ? `${o.lead} It ${o.heavy}.` : o.lead)} data={{ 'data-splat-op': o.id, 'data-op-available': why ? 'no' : 'yes' }} onSelect={() => aimCanvasOperation(o.id)}>{o.label}</MenuItem>;
            })}
          </MenuGroup>
          <MenuGroup label="Also">
            <MenuItem close={close} onSelect={() => goTo('canvas')} data={{ 'data-act': 'import-splat' }} hint="Import from apps → From this computer: a splat (PLY) or a posed dataset (zip)">Bring a splat onto the Workspace…</MenuItem>
          </MenuGroup>
          <p className="ta-menu-note">A splat is an appearance reconstruction: not measured geometry, a watertight mesh or verified CAD.</p>
        </>
      )}
    </MenuButton>
  );
}

export function MiniAppPage({ appId }) {
  const [apps, read] = useApps();
  const [open, setOpen] = useState(null); // { url } while framed
  const [busy, setBusy] = useState('');
  const [words, setWords] = useState('');
  const a = apps && apps.ok ? apps.apps.find((x) => x.id === appId) : null;
  const projectNow = useApp((s) => s.projectId);
  const from = useApp((s) => s.from);
  const fromTitle = (PAGES.find((x) => x.id === from && x.id !== appId) || { title: 'Chat' }).title;
  // another project: the frame of the one left is closed (its grant there was ended by the companion when this one opens)
  useEffect(() => { setOpen(null); }, [projectNow]);
  // while framed, the grant is renewed with this page's own session; a page whose session ended cannot renew, so the app
  // refuses its frame within the grant's time (src/companion/miniapps/host.ts GRANT_MS)
  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(async () => {
      const r = await postJson(`/api/apps/${appId}/renew${projectQuery()}`, {});
      if (!r.ok) { setOpen(null); setWords(r.error || 'The app was closed: open it again.'); }
    }, 5 * 60_000);
    return () => clearInterval(t);
  }, [open, appId]);

  const theme = useApp((s) => s.theme);
  const frame = useRef(null);
  const start = async (to) => {
    setBusy('open'); setWords('');
    const at = themedPath(a, typeof to === 'string' ? to : null, theme);
    const r = await postJson(`/api/apps/${appId}/open${projectQuery()}`, at ? { to: at } : {});
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

  // the theme contract v1 (an app that declares it): the frame's exact origin gets the theme on load, on its ready, on change
  const frameOrigin = open ? (() => { try { return new URL(open.url).origin; } catch { return null; } })() : null;
  const sendTheme = useCallback(() => {
    const w = frame.current && frame.current.contentWindow;
    if (!w || !frameOrigin || !a || !a.theme) return;
    try { w.postMessage({ type: 'timmy:theme', version: 1, theme }, frameOrigin); } catch { /* the frame went away */ }
  }, [frameOrigin, a, theme]);
  useEffect(() => { sendTheme(); }, [sendTheme]);
  useEffect(() => {
    if (!open || !a || !a.theme || !a.theme.ready) return undefined;
    const ready = (e) => {
      const w = frame.current && frame.current.contentWindow;
      if (!w || e.source !== w || e.origin !== frameOrigin) return;
      const d = e.data;
      if (d && typeof d === 'object' && d.type === 'timmy:theme-ready' && d.version === 1) sendTheme();
    };
    window.addEventListener('message', ready);
    return () => window.removeEventListener('message', ready);
  }, [open, a, frameOrigin, sendTheme]);
  const hostableNow = !!(a && a.hostable);
  useEffect(() => { if (hostableNow) { const to = takeAppTarget(appId); if (to !== null && to !== undefined) start(to); } }, [hostableNow, appId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!apps) return <Page id={appId}><p className="ta-muted">Reading the mini-apps…</p></Page>;
  if (!apps.ok || !a) return <Page id={appId}><p className="ta-result" role="status">{apps.error || 'The companion did not list this app.'}</p></Page>;

  if (open) {
    return (
      <Page id={appId} fill head={false}>
        <div className="ta-miniapp" data-miniapp={appId} data-miniapp-state="open">
          <div className="ta-miniapp-bar" role="toolbar" aria-label={`${a.title} controls`}>
            {/* the checklist's A1 and C8: the same way out of every app — back to the page the person came from (the app keeps
                running for this project), its results in Files, or Stop */}
            <Button onClick={goBack} className="ta-miniapp-back" title={`Back to ${fromTitle}; ${a.title} keeps running for this project`}>← {fromTitle}</Button>
            <span className="ta-miniapp-name">{a.title}</span>
            <StateWord word="app open" />
            <span className="ta-muted ta-miniapp-where" title="The Timmy project this app keeps its work in (the app's own document titles are its own)">{apps.project ? `Timmy project: ${apps.project}` : ''}</span>
            <span className="ta-miniapp-gap" />
            {appId === 'model-studio' ? <SplatMenu /> : null}
            <Button onClick={() => goTo('files')} title={`What ${a.title}'s jobs made, in this project's Files`}>Results in Files</Button>
            <Button onClick={() => aimAgent({ kind: 'app', app: appId })} data-action="send-to-agent" title={`Start an agent run in the Control Room on ${a.title}'s outputs in this project`}>Send to an agent</Button>
            <Button onClick={stop} disabled={busy === 'stop'} title={`Stop ${a.title} for this project`}>Stop</Button>
          </div>
          <iframe ref={frame} className="ta-miniapp-frame" title={a.title} src={open.url} data-miniapp-frame={appId} onLoad={sendTheme} />
        </div>
      </Page>
    );
  }

  const hostable = a.hostable;
  return (
    <Page
      id={appId}
      actions={hostable ? <><Button kind="primary" onClick={() => start()} disabled={busy === 'open'}>{busy === 'open' ? 'Opening…' : a.running ? `Return to ${a.title}` : `Open ${a.title}`}</Button>{appId === 'model-studio' ? <SplatMenu /> : null}<Button onClick={() => goTo('files')}>Results in Files</Button></> : <>{appId === 'model-studio' ? <SplatMenu /> : null}<Button onClick={goBack}>← {fromTitle}</Button></>}
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
