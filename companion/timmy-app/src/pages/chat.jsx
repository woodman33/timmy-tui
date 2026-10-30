// R12 (the finish brief): Chat — Timmy's main screen. The conversation and one composer (one Send; Stop reachable while a turn
// runs) in the work area; the model choice (OpenRouter · Ollama · Cloudflare), the agent's AgentConsole face and the route in the
// context column; the chat's tools on the tools row (each goes to the page that does it, or says it is not in this build). Every
// turn is the real agent's (POST /api/chat/turn, contract C3).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../md.jsx';
import { ActionFace, ConsoleFace } from '../rive.jsx';
import { Catalog, ChooseResult, LocalModels, chosenOf, providerOf, whereOf } from '../models-parts.jsx';
import { Page, Tool } from '../shell.jsx';
import { activityOf, answerNeedsYou, goTo, newConversation, send, stop, useApp } from '../store.js';
import { Button, Facts, StateWord, clock } from '../ui.jsx';

const SURFACES = { repl: 'the REPL', workbench: 'the Workbench', monitor: 'the monitor', companion: 'another page', studio: 'the Studio' };
export const surfaceWord = (s) => SURFACES[s] || String(s || 'another surface');

function Turn({ t }) {
  if (t.kind === 'you') return <li className="ta-turn ta-you"><p className="ta-who">You <span className="ta-when">{clock(t.at)}</span></p><p className="ta-text">{t.text}</p></li>;
  if (t.kind === 'tool') return <li className="ta-turn ta-tool"><p className="ta-who">Tool · {t.tool || 'a tool'}</p><p className="ta-text ta-mono">{String(t.text || '').slice(0, 600)}</p></li>;
  const r = t.receipt;
  return (
    <li className={`ta-turn ta-timmy${t.stopped ? ' is-stopped' : ''}`}>
      <p className="ta-who"><span className="ta-who-mark" aria-hidden="true">T</span>Timmy {t.model ? <span className="ta-model-tag">{t.model}</span> : null} <span className="ta-when">{clock(t.at)}</span></p>
      {t.text ? <Markdown text={t.text} /> : <p className="ta-text">{t.stopped ? '(stopped before it answered)' : ''}</p>}
      {t.stopped ? <p className="ta-muted">Stopped{t.stopped.by ? ` by ${t.stopped.by}` : ''}.</p> : null}
      {r ? <p className="ta-receipt"><span className={r.verified ? 'ta-verified' : 'ta-unverified'}>{r.verified ? '✓ receipt' : '✕ receipt'}</span> <code>{r.id}</code> · {r.where}{r.ms ? ` · ${(r.ms / 1000).toFixed(1)} s` : ''}</p> : null}
    </li>
  );
}

function LiveTurn({ turn, theme, saved }) {
  if (!turn) return null;
  return (
    <>
      {saved ? null : <li className="ta-turn ta-you is-live"><p className="ta-who">You</p><p className="ta-text">{turn.message}</p></li>}
      <li className="ta-turn ta-timmy is-live" data-phase={turn.phase}>
        <p className="ta-who"><span className="ta-who-mark" aria-hidden="true">T</span>Timmy {turn.route && turn.route.model ? <span className="ta-model-tag">{turn.route.model}</span> : null} <StateWord word={activityOf(turn) === 'idle' ? turn.phase : activityOf(turn)} /></p>
        {turn.text ? <Markdown text={turn.text} /> : turn.phase === 'running' ? <p className="ta-muted">{turn.route ? `Asking ${turn.route.where}…` : 'Opening the turn…'}</p> : null}
        {turn.tools.length ? <ul className="ta-tools">{turn.tools.map((x) => <li key={x.call}><StateWord word={x.status} /> {x.words}</li>)}</ul> : null}
        {turn.needsYou ? (
          <div className="ta-needs" role="alertdialog" aria-label="NEEDS YOU">
            <p className="ta-needs-head"><strong>NEEDS YOU</strong> · {turn.needsYou.tool}</p>
            <p>{turn.needsYou.words}</p>
            {turn.needsYou.detail ? <pre className="ta-detail">{String(turn.needsYou.detail).slice(0, 1200)}</pre> : null}
            <div className="ta-row ta-answers">
              {(turn.needsYou.options || ['once', 'deny']).map((o) => (
                <ActionFace key={o} theme={theme} name={`needs-you:${o}`} label={o === 'once' ? 'Allow once' : o === 'session' ? 'Allow for this session' : 'Deny'} onPress={() => answerNeedsYou(o)} />
              ))}
            </div>
          </div>
        ) : null}
        {turn.stopWords && ['running', 'stopping'].includes(turn.phase) ? <p className="ta-muted" role="status">{turn.stopWords}</p> : null}
        {turn.error ? <p className="ta-result" role="status">{turn.error}</p> : null}
        {turn.done ? <p className="ta-receipt">{turn.done.receipt ? <>receipt <code>{String(turn.done.receipt).slice(0, 15)}</code> · </> : null}{turn.done.status}{turn.done.model ? ` · ${turn.done.model}` : ''}{typeof turn.done.steps === 'number' ? ` · ${turn.done.steps} step${turn.done.steps === 1 ? '' : 's'}` : ''}{turn.done.costMeasured && typeof turn.done.costUsd === 'number' ? ` · $${turn.done.costUsd.toFixed(4)}` : ''}</p> : null}
      </li>
    </>
  );
}

/** Ways to begin, written into the composer (never sent by themselves). */
const STARTS = ['What can you help me with in this project?', 'Read the project’s files and summarise them.', 'Plan the next step with me.'];

/** Where the Agent & model column is: on the right of the chat, or below it (900 px and under: app.css stacks the page). */
function useStacked() {
  const q = '(max-width: 900px)';
  const [stacked, setStacked] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const m = matchMedia(q);
    const on = () => setStacked(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return stacked;
}

/** The chooser in the Agent & model column, brought into view and its first control focused (the phone's way to it, too). */
export function showChooser() {
  const el = typeof document !== 'undefined' ? document.querySelector('.ta-choose') : null;
  if (!el) { goTo('models'); return; }
  try { el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); } catch { el.scrollIntoView(); }
  const first = el.querySelector('[role="tab"][aria-selected="true"]') || el.querySelector('button, input, select');
  if (first) setTimeout(() => first.focus({ preventScroll: true }), 300);
}

/** The one setup action: on a phone the picker opens as a sheet over the chat; wide, the picker beside the chat takes the focus. */
let openSheet = null;
export function openChooser(stacked) {
  if (stacked && openSheet) { openSheet(); return; }
  showChooser();
}

function ChooserSheet() {
  const view = useApp((s) => s.view);
  const ready = !!(view && view.route && view.route.ready);
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { openSheet = () => setOpen(true); return () => { openSheet = null; }; }, []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => { if (ready) setOpen(false); }, [ready]);
  // the picker is drawn only while the sheet is open: one chooser on the page at a time, its requests made once
  return (
    <dialog ref={ref} className="ta-sheet" aria-label="Choose a model" onClose={() => setOpen(false)} onClick={(e) => { if (e.target === ref.current) setOpen(false); }}>
      {open ? (
        <>
          <div className="ta-sheet-head">
            <p className="ta-sheet-title">Choose a model</p>
            <button type="button" className="ta-sheet-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>
          <ChooseModel />
        </>
      ) : null}
    </dialog>
  );
}

/** The phone's software keyboard: the composer stays above it (the visual viewport's height, as a CSS variable). */
function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const set = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--ta-kb', `${Math.round(inset)}px`);
    };
    set();
    vv.addEventListener('resize', set);
    vv.addEventListener('scroll', set);
    return () => { vv.removeEventListener('resize', set); vv.removeEventListener('scroll', set); document.documentElement.style.removeProperty('--ta-kb'); };
  }, []);
}

function Conversation({ theme }) {
  const view = useApp((s) => s.view);
  const turn = useApp((s) => s.turn);
  const [draft, setDraft] = useState('');
  const stacked = useStacked();
  const list = useRef(null);
  const input = useRef(null);
  useKeyboardInset();
  const running = turn && ['running', 'stopping'].includes(turn.phase);
  const route = view ? view.route : null;
  const ready = route ? route.ready === true : false;
  const saved = view && view.conversation && Array.isArray(view.conversation.turns) ? view.conversation.turns : [];
  const elsewhere = view && view.conversation && Array.isArray(view.conversation.running) ? view.conversation.running : [];
  const shown = useMemo(() => saved.slice(-60), [saved]);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [shown.length, turn && turn.text, turn && turn.tools.length, turn && turn.needsYou]);
  const submit = () => { const t = draft.trim(); if (!t || running || !ready) return; setDraft(''); send(t); };
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const onKey = (e) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // ⌘/Ctrl + Enter always sends; Enter alone sends on a keyboard (Shift + Enter is a new line), and is a new line on a phone
    if (e.metaKey || e.ctrlKey || (!e.shiftKey && !coarse)) { e.preventDefault(); submit(); }
  };
  const savedAt = (kind, text) => turn && saved.some((x) => x.kind === kind && (text === undefined || x.text === text) && Date.parse(x.at) >= Date.parse(turn.startedAt) - 5000);
  const messageSaved = !!(turn && savedAt('you', turn.message));
  const live = turn && !(turn.phase === 'done' && messageSaved && savedAt('timmy'));
  return (
    <div className="ta-chat" data-card="chat">
      <ol className="ta-turns" ref={list} aria-label="The conversation">
        {!shown.length && !turn ? (
          <li className="ta-turn ta-hello">
            <p className="ta-hello-title">{ready ? 'What are we working on?' : 'Pick the model Timmy talks with'}</p>
            <p className="ta-text">{ready ? 'Its tools ask you first; each answer is sealed with a receipt.' : 'A model on this computer (Ollama) or one through your OpenRouter key.'}</p>
            {ready ? <div className="ta-row ta-starts">{STARTS.map((t) => <button key={t} type="button" className="ta-chip" onClick={() => { setDraft(t); input.current && input.current.focus(); }}>{t}</button>)}</div>
              : view ? <div className="ta-row"><Button kind="primary" onClick={() => openChooser(stacked)} data-setup="choose-model">Choose a model</Button></div> : null}
          </li>
        ) : null}
        {shown.map((t, i) => <Turn key={`${t.at}-${i}`} t={t} />)}
        {live ? <LiveTurn turn={turn} theme={theme} saved={messageSaved} /> : null}
      </ol>
      {elsewhere.length ? <p className="ta-elsewhere" role="status">A turn of this project is running in {elsewhere.map((r) => `${surfaceWord(r.surface)} (since ${clock(r.since)})`).join(', ')}: Send here waits for it.</p> : null}
      <form className="ta-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea ref={input} className="ta-input" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} enterKeyHint={coarse ? 'enter' : 'send'}
          placeholder="Message Timmy" aria-label="Message Timmy" disabled={!view} />
        <div className="ta-composer-row">
          <p className="ta-route" title={route ? route.words : ''}>{!view ? 'Reading the route…' : ready ? route.label : ''}</p>
          {running ? <Button kind="primary" onClick={stop} disabled={turn.phase === 'stopping'} className="ta-send">{turn.phase === 'stopping' ? 'Stopping…' : '■ Stop'}</Button>
            : <Button kind="primary" type="submit" disabled={!ready || !draft.trim()} className="ta-send">Send</Button>}
        </div>
      </form>
    </div>
  );
}

const TABS = [['openrouter', 'OpenRouter'], ['ollama', 'Ollama'], ['cloudflare', 'Cloudflare']];

function ChooseModel() {
  const view = useApp((s) => s.view);
  const chosen = chosenOf(view);
  const [tab, setTab] = useState(chosen && chosen.source === 'openrouter' ? 'openrouter' : 'ollama');
  const cf = providerOf(view, 'cloudflare');
  return (
    <div className="ta-choose">
      <p className="ta-choose-title">Where the model runs</p>
      <div className="ta-seg ta-tabs" role="tablist" aria-label="Where the model runs">
        {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div role="tabpanel" className="ta-choose-panel">
        {tab === 'ollama' ? <LocalModels compact limit={6} /> : null}
        {tab === 'openrouter' ? <Catalog compact limit={6} /> : null}
        {tab === 'cloudflare' ? (
          <div className="ta-unavailable">
            <p><StateWord word={cf ? cf.state : 'not set up'} /> {cf ? cf.words : 'The companion listed no Cloudflare state.'}</p>
            <p className="ta-muted">Chat does not send through Cloudflare in this build: no model here is offered from it.</p>
          </div>
        ) : null}
        <ChooseResult />
      </div>
    </div>
  );
}

function Context({ theme }) {
  const view = useApp((s) => s.view);
  const turn = useApp((s) => s.turn);
  const c = view && view.choice ? view.choice : {};
  return (
    <>
      <div className="ta-context-face">
        <ConsoleFace size="wide" theme={theme} />
      </div>
      <Facts rows={[
        // (with no model chosen the chooser just below says it; the route's own words stay in the composer's line)
        ['next turn', view && view.route && view.route.ready ? (c.words || view.route.label) : null],
        ['chosen in', c.from || null],
        ['policy', view && view.policy ? `free only ${view.policy.freeOnly ? 'on' : 'off'} · local only ${view.policy.localOnly ? 'on' : 'off'}` : null],
        ['turn', turn && turn.id ? <code key="t">{turn.id}</code> : null],
        ['tools', turn && turn.tools.length ? turn.tools.map((x) => `${x.name} ${x.status}`).join(' · ') : null],
      ]} />
      <ChooseModel />
    </>
  );
}

export default function ChatPage() {
  const theme = useApp((s) => s.theme);
  const view = useApp((s) => s.view);
  const viewError = useApp((s) => s.viewError);
  const turn = useApp((s) => s.turn);
  const config = useApp((s) => s.config);
  const note = useApp((s) => s.note);
  const choice = view && view.choice;
  const ready = view && view.route && view.route.ready;
  const running = turn && ['running', 'stopping'].includes(turn.phase);
  const turns = view && view.conversation && Array.isArray(view.conversation.turns) ? view.conversation.turns : [];
  const sealed = turns.filter((t) => t.kind === 'timmy' && t.receipt);
  const last = sealed[sealed.length - 1];
  const elsewhere = view && view.conversation && Array.isArray(view.conversation.running) ? view.conversation.running : [];
  const project = config && config.project;
  const actions = running
    ? <Button kind="primary" onClick={stop} disabled={turn.phase === 'stopping'}>{turn.phase === 'stopping' ? 'Stopping…' : '■ Stop the turn'}</Button>
    : !ready ? null
      : <Button onClick={newConversation}>New conversation</Button>;
  return (
    <Page id="chat" fill note={note}
      actions={actions}
      band={[
        ['WORKSPACE', project ? <span title={project.display || project.name}>{project.name}</span> : <span className="ta-muted">no project named</span>],
        ['MODEL', !view ? <span className="ta-muted">{viewError || 'Reading…'}</span> : choice && choice.chosen ? <>{choice.model} <span className="ta-muted">· {whereOf(view.route)}</span></> : <span className="ta-muted">—</span>],
        ['AGENT', elsewhere.length && !running ? <><StateWord word="working" /> <span className="ta-muted">in {surfaceWord(elsewhere[0].surface)}</span></> : <StateWord word={activityOf(turn)} />],
        ['RECORDS', last ? <><span className={last.receipt.verified ? 'ta-verified' : 'ta-unverified'}>{last.receipt.verified ? '✓ verified' : '✕ not verified'}</span> <code>{last.receipt.id}</code> <span className="ta-muted">· {sealed.length} sealed</span></> : <span className="ta-muted">no sealed answer yet</span>],
      ]}
      context={<Context theme={theme} />} contextTitle="Agent & model"
      tools={<>
        <span className="ta-toolsrow-k">CHAT TOOLS</span>
        <Tool glyph="⎘" label="Attach" why="not in this build" />
        <Tool glyph="⚙" label="Tools" onClick={() => goTo('tools')} />
        <Tool glyph="⇶" label="Plan & run" onClick={() => goTo('workflows')} />
        <Tool glyph="⚑" label="Permissions" onClick={() => goTo('settings')} />
        <Tool glyph="$" label="Budget" onClick={() => goTo('models')} />
        <Tool glyph="☰" label="Records" onClick={() => goTo('runs')} />
      </>}>
      <Conversation theme={theme} />
      <ChooserSheet />
    </Page>
  );
}
