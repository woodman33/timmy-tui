// R12 (the finish brief): one shell for every page of the Timmy app — Timmy's permanent left rail (the mark, the project, the
// grouped pages), the top bar (where you are and the theme), the page frame (the head: its kicker, title, lead and one primary
// action; a summary band; the work area with the contextual column on its right; the page's tools row), the quiet records dock
// (this page's own requests to the companion) and the status footer (the workspace, the canvas licence as the SDK read it, and
// Export / Import of the canvas). The Card Lab's composition with Timmy's hierarchy: Timmy → project → current task → primary
// next action → work area → contextual tools and details → progress and evidence.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { onRequest, requestLog } from './api.js';
import { GROUPS, PAGES, pageOf } from './nav.js';
import { goTo, loadProjects, setDock, setDrawer, setRailSlim, setTheme, switchProject, useApp } from './store.js';
import { Button, clock } from './ui.jsx';

// ── the rail ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function ProjectSwitcher() {
  const config = useApp((s) => s.config);
  const projects = useApp((s) => s.projects);
  const turn = useApp((s) => s.turn);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const project = config && config.project ? config.project : null;
  useEffect(() => {
    if (!open) return undefined;
    if (!projects) loadProjects();
    const off = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', esc); };
  }, [open, projects]);
  const list = projects && projects.ok !== false && Array.isArray(projects.projects) ? projects.projects : [];
  const running = turn && ['running', 'stopping'].includes(turn.phase);
  return (
    <div className="ta-project-switch" ref={box}>
      <button type="button" className="ta-project-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}
        title={project ? project.display || project.name : 'The companion named no project'}>
        <span className="ta-project-k">PROJECT</span>
        <span className="ta-project-name">{project ? project.name : config ? 'none named' : 'reading…'}</span>
        <span className="ta-project-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="ta-project-menu" role="listbox" aria-label="Projects">
          {list.length ? list.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={!!project && project.root === p.root} disabled={running}
              className="ta-project-opt" onClick={() => { setOpen(false); switchProject(p.id); }}>
              <span>{p.name}</span>
            </button>
          )) : (
            <p className="ta-project-none">
              {!projects ? 'Asking the companion for your projects…'
                : projects.status === 401 || projects.status === 403 || projects.status === 404 || projects.ok === false
                  ? 'This companion follows one project (the folder Timmy was started in). Start Timmy in another folder to show another.'
                  : 'No other project.'}
            </p>
          )}
          {running ? <p className="ta-project-none">A turn is running: stop it before switching.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

const NARROW = '(max-width: 760px)';
const subscribeNarrow = (fn) => { const m = matchMedia(NARROW); m.addEventListener('change', fn); return () => m.removeEventListener('change', fn); };
/** Whether the window is a phone's width (the rail is then a drawer). */
export const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW).matches);

/** Whether the rail is folded to its icons: on the Canvas by default (the canvas is that page's work), anywhere the person folds it. */
export function useRailSlim() {
  const page = useApp((s) => s.page);
  const fold = useApp((s) => s.railFold);
  return fold === null || fold === undefined ? page === 'canvas' : Boolean(fold[page] ?? fold.all);
}

export function Rail() {
  const page = useApp((s) => s.page);
  const drawer = useApp((s) => s.drawer);
  const narrow = useNarrow();
  const nav = useRef(null);
  // the drawer on a phone: out of the tab order and the reading order while closed; open, it takes the focus, Escape closes it
  // and the focus goes back to the menu button
  useEffect(() => {
    if (!narrow || !drawer) return undefined;
    const close = nav.current && nav.current.querySelector('.ta-rail-close');
    if (close) close.focus();
    const esc = (e) => { if (e.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); const m = document.querySelector('.ta-menu'); if (m) m.focus(); };
  }, [narrow, drawer]);
  const hidden = narrow && !drawer;
  const slim = useRailSlim();
  return (
    <nav ref={nav} className={`ta-rail${drawer ? ' is-open' : ''}`} aria-label="Timmy" inert={hidden} aria-hidden={hidden ? 'true' : undefined}
      {...(narrow && drawer ? { role: 'dialog', 'aria-modal': 'true' } : {})}>
      <div className="ta-rail-brand">
        <span className="ta-mark" aria-hidden="true">T</span>
        <span className="ta-rail-name">TIMMY</span>
        <button type="button" className="ta-rail-close" aria-label="Close the menu" onClick={() => setDrawer(false)}>✕</button>
        <button type="button" className="ta-rail-fold" aria-label={slim ? 'Show the menu’s words' : 'Fold the menu to its icons'} aria-pressed={slim} onClick={() => setRailSlim(!slim)} title={slim ? 'Show the words' : 'Fold to icons'}><span aria-hidden="true">{slim ? '»' : '«'}</span></button>
      </div>
      <ProjectSwitcher />
      {GROUPS.map((g) => {
        const pages = PAGES.filter((p) => p.group === g.id);
        if (!pages.length) return null;
        const items = pages.map((p) => (
          <button key={p.id} type="button" className="ta-rail-item" aria-current={page === p.id ? 'page' : undefined} onClick={() => goTo(p.id)} data-nav={p.id} title={p.title}>
            <span className="ta-rail-glyph" aria-hidden="true">{p.glyph}</span>
            <span className="ta-rail-title">{p.title}</span>
          </button>
        ));
        // the WORKSPACES pages behind one disclosure: open while one of them is the page shown
        if (g.disclosure) {
          return (
            <details key={g.id} className={`ta-rail-group ta-rail-${g.id} ta-rail-more`} open={pages.some((p) => p.id === page) || undefined}>
              <summary className="ta-rail-label ta-rail-summary">{g.label}</summary>
              <div role="group" aria-label={g.label}>{items}</div>
            </details>
          );
        }
        return (
          <div key={g.id} className={`ta-rail-group ta-rail-${g.id}`} role="group" aria-label={g.label || (g.id === 'start' ? 'Start' : 'More')}>
            {g.label ? <p className="ta-rail-label">{g.label}</p> : null}
            {items}
          </div>
        );
      })}
    </nav>
  );
}

// ── the top bar ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ThemeSwitch() {
  const theme = useApp((s) => s.theme);
  return (
    <div className="ta-theme" role="group" aria-label="Theme">
      {['amber', 'glacier'].map((t) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>{t === 'amber' ? 'Amber' : 'Glacier'}</button>)}
    </div>
  );
}

export function Topbar() {
  const page = useApp((s) => s.page);
  const config = useApp((s) => s.config);
  const p = pageOf(page);
  return (
    <header className="ta-topbar">
      <button type="button" className="ta-menu" aria-label="Open the menu" aria-expanded={useApp((s) => s.drawer)} onClick={() => setDrawer(true)}><span aria-hidden="true">☰</span></button>
      <p className="ta-crumb"><span className="ta-crumb-root">{config && config.project ? config.project.name : 'Workspace'}</span><span className="ta-crumb-sep" aria-hidden="true">/</span><span className="ta-crumb-page">{p.title}</span></p>
      <div className="ta-topbar-tools">
        <ThemeSwitch />
      </div>
    </header>
  );
}

// ── the page frame ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One page. `actions` (the head's buttons: the primary first), `band` (cells: [label, value]… or null), `context` (the right
 * column; its heading is the page's `context` word), `tools` (the page's tools row, under the work), `fill` (the work area
 * takes the page's height: the Chat, the Canvas), `children` (the work area).
 */
export function Page({ id, actions, band, context, contextTitle, tools, fill = false, compact = fill, head = true, children, note }) {
  const p = pageOf(id);
  return (
    <div className={`ta-page${fill ? ' is-fill' : ''}${compact ? ' is-compact' : ''}${head ? '' : ' is-headless'}`} data-page={p.id}>
      {head ? <header className="ta-head">
        <div className="ta-head-words">
          <p className="ta-kicker">{p.kicker}</p>
          <h1 className="ta-title">{p.title}</h1>
          <p className="ta-lead">{p.lead}</p>
        </div>
        {actions ? <div className="ta-head-actions">{actions}</div> : null}
      </header> : <h1 className="tr-visually-hidden">{p.title}</h1>}
      {band && band.length ? (
        <section className="ta-band" aria-label="Summary">
          {band.map(([k, v], i) => (
            <div key={`${k}-${i}`} className="ta-cell"><p className="ta-cell-k">{k}</p><div className="ta-cell-v">{v}</div></div>
          ))}
        </section>
      ) : null}
      {note ? <p className="ta-page-note" role="status">{note}</p> : null}
      <div className={`ta-body${context ? ' has-context' : ''}`}>
        <section className="ta-work" aria-label={p.title}>{children}</section>
        {context ? (
          <aside className="ta-context" aria-label={contextTitle || p.context}>
            <p className="ta-context-k">{(contextTitle || p.context).toUpperCase()}</p>
            {context}
          </aside>
        ) : null}
      </div>
      {tools ? <div className="ta-toolsrow" role="toolbar" aria-label={`${p.title} tools`}>{tools}</div> : null}
    </div>
  );
}

/** A section of a page's work area (a panel in the Card Lab's dark material). */
export function Panel({ title, kicker, tools, children, className = '', id }) {
  return (
    <section className={`ta-panel ${className}`} data-panel={id} aria-label={title}>
      {title || tools ? (
        <header className="ta-panel-head">
          <div className="ta-panel-titles">{kicker ? <p className="ta-kicker">{kicker}</p> : null}{title ? <h2 className="ta-panel-title">{title}</h2> : null}</div>
          {tools ? <div className="ta-panel-tools">{tools}</div> : null}
        </header>
      ) : null}
      <div className="ta-panel-body">{children}</div>
    </section>
  );
}

/** A tool on a tools row: a real action, or (no `onClick`) a named one that is not available here, said so. */
export function Tool({ glyph, label, onClick, disabled, why, pressed, icon = false }) {
  const off = !onClick || disabled;
  return (
    <button type="button" className={`ta-tool${icon ? ' is-icon' : ''}`} onClick={onClick} disabled={off} aria-pressed={pressed} title={off && why ? `${label}: ${why}` : label} aria-label={label} data-tool={label}>
      {glyph ? <span className="ta-tool-glyph" aria-hidden="true">{glyph}</span> : null}
      <span className="ta-tool-label">{label}</span>
      {off && why ? <span className="ta-tool-why">{why}</span> : null}
    </button>
  );
}

// ── the records dock ────────────────────────────────────────────────────────────────────────────────────────────────────

const subscribeLog = (fn) => onRequest(fn);
let logVersion = 0;
onRequest(() => { logVersion += 1; });
const useLogVersion = () => useSyncExternalStore(subscribeLog, () => logVersion);

export function Dock() {
  const open = useApp((s) => s.dock);
  useLogVersion();
  const [source, setSource] = useState('local');
  const lines = requestLog();
  const last = lines[lines.length - 1];
  const failed = lines.filter((l) => l.status === 0 || l.status >= 400).length;
  return (
    <section className={`ta-dock${open ? ' is-open' : ''}`} aria-label="Records">
      <button type="button" className="ta-dock-bar" aria-expanded={open} onClick={() => setDock(!open)}>
        <span className="ta-dock-k">RECORDS</span>
        {/* G4: diagnostics are secondary: the bar says only what needs a look (a request not ok); the count is in the records */}
        {failed ? <span className="ta-dock-sum ta-dock-bad">{failed} request{failed === 1 ? '' : 's'} not ok</span> : null}
        {/* the checklist's C7: which route answered is a technical detail, read in the opened records, not on the bar */}
        {last ? <span className="ta-dock-last">last {clock(last.at)}{last.status === 0 || last.status >= 400 ? ' · not ok' : ''}</span> : null}
        <span className="ta-dock-caret" aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>
      {open ? (
        <div className="ta-dock-body">
          <div className="ta-dock-head">
            <div className="ta-seg" role="group" aria-label="Which records">
              <button type="button" aria-pressed={source === 'local'} onClick={() => setSource('local')}>Local</button>
              <button type="button" aria-pressed={source === 'cloudflare'} onClick={() => setSource('cloudflare')}>Cloudflare</button>
            </div>
            <p className="ta-muted">{source === 'local' ? `${lines.length} request${lines.length === 1 ? '' : 's'}: this page’s own, to the companion on this computer, newest last. The token rides in a header, never in these paths.` : 'Not connected here: this build reads no Cloudflare logs. Nothing below is from Cloudflare.'}</p>
          </div>
          {source === 'local' ? (
            <ol className="ta-dock-lines">
              {lines.slice(-60).map((l, i) => (
                <li key={`${l.at}-${i}`} className={l.status === 0 || l.status >= 400 ? 'is-bad' : ''}>
                  <span className="ta-when">{clock(l.at)}</span><code>{l.method}</code><code className="ta-dock-path">{l.path}</code><span>{l.status || 'no answer'}</span><span className="ta-muted">{l.ms} ms</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ── the status footer ───────────────────────────────────────────────────────────────────────────────────────────────────

export function Footer() {
  const config = useApp((s) => s.config);
  const license = useApp((s) => s.license);
  const canvasIo = useApp((s) => s.canvasIo);
  const project = config && config.project ? config.project.name : null;
  return (
    <footer className="ta-footer">
      <span>Local workspace{project ? ` · ${project}` : ''}</span>
      <span className="ta-footer-sep" aria-hidden="true">·</span>
      <span title={license ? license.words : ''}>Canvas licence: {license ? license.state : 'read when the Canvas opens'}</span>
      <span className="ta-footer-sep" aria-hidden="true">·</span>
      <button type="button" className="ta-footer-btn" disabled={!canvasIo} onClick={() => canvasIo && canvasIo.export()} title={canvasIo ? 'Save this project’s canvas as a file' : 'Open the Canvas first'}>Export canvas</button>
      <button type="button" className="ta-footer-btn" disabled={!canvasIo} onClick={() => canvasIo && canvasIo.import()} title={canvasIo ? 'Open a canvas file into this project’s canvas' : 'Open the Canvas first'}>Import</button>
      <span className="ta-footer-right">tldraw {config && config.tldrawVersion ? config.tldrawVersion : ''}</span>
    </footer>
  );
}
