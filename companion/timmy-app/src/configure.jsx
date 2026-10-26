// R12 (the operator's order of 2026-10-25, 20:38 PT): ONE configure aid for every integration, lane, tool and model row. A row
// says one thing, "Configured: Yes / No" (yes = its files are here AND its key, setting or address is set: the capability
// inventory's available + configured facts, GET /api/panel/tools/inventory; the three words stay apart in the Tools page's
// context column), and a not-configured row has ONE button, Configure. Pressing it starts the same aid every time:
//
//   aim     a ring draws itself around the pressed button (the UI holds for a beat, so the eye follows)
//   travel  a step set on another page (Models & accounts): the aid says where it goes, its native Rive ActionButton turns
//           Working, then the page opens and the ring lands on the exact control (scrolled into view, focused)
//   explain a step this page cannot take (a line for the .env file, a command for the terminal, a server for MCPorter's
//           config): the aid unfolds under the button with the words, the line or command to copy, and "Check again"
//   check   "Check again" re-reads this computer (?refresh=1): the Rive face goes Working; Configured → the row flips to Yes
//           and the face rests; still not → the face takes its NEEDS-YOU pose ("still waits on you"), the words say what is missing
//
// Nothing is set from this page that the companion does not already set itself: no key, address or command is written or run
// here (the inventory's rule: a key is set in Models & accounts, the environment or the .env file). The ring and the popover
// are this module's (CSS / SVG); the face is the operator's native ActionButton (timmy-ui.riv) through TimmyRive's mount API,
// its State fed only with what the check observed.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getJson } from './api.js';
import { goTo, projectQuery, useApp } from './store.js';
import '../../../src/companion/client/rive-bindings.js';

// ── the inventory, shared by every page that draws configure rows (one read; Check again re-reads it for all) ──
const INVENTORY = '/api/panel/tools/inventory';
let inv = null;
let invAt = 0;
let invFor = null;
let reading = null;
const invSubs = new Set();
const invEmit = () => { for (const f of invSubs) f(); };
const qs = (refresh) => { const p = projectQuery('').trim(); const all = [refresh ? 'refresh=1' : '', p].filter(Boolean).join('&'); return all ? `?${all}` : ''; };

/** Reads the inventory (refresh: re-read this computer, not the companion's kept answer). Every subscriber gets the answer. */
export async function readInventory(refresh = false) {
  const key = projectQuery('');
  if (reading && !refresh && invFor === key) return reading;
  invFor = key;
  reading = getJson(`${INVENTORY}${qs(refresh)}`).then((r) => { if (invFor === key) { inv = r; invAt = Date.now(); invEmit(); } return r; }).finally(() => { reading = null; });
  return reading;
}
export function useInventory() {
  const value = useSyncExternalStore((f) => { invSubs.add(f); return () => invSubs.delete(f); }, () => inv);
  const project = useApp((s) => (s.config && s.config.project ? s.config.project.root : ''));
  useEffect(() => { if (!inv || invFor !== projectQuery('') || Date.now() - invAt > 60_000) readInventory(false); }, [project]); // eslint-disable-line react-hooks/exhaustive-deps
  return value;
}

/** Yes: its files are here and its key, setting or address is set (two of the inventory's three facts; neither is a check that it works). */
export const isConfigured = (row) => Boolean(row && row.available && row.available.ok && row.configured && row.configured.ok);

/** Where a Models & accounts step lands: the exact control first, its card or panel if that control is not drawn. */
const MODELS_TARGETS = {
  'model:openrouter': ['[data-provider="openrouter"] .ta-row .ta-btn', '[data-provider="openrouter"]'],
  'model:ollama-local': ['[data-panel="local"] .ta-btn-primary', '[data-panel="local"] .ta-model .ta-btn', '[data-panel="local"]'],
  'model:ollama-cloud': ['[data-provider="ollama-cloud"] .ta-btn', '[data-provider="ollama-cloud"]', '[data-panel="local"]'],
  'model:cloudflare': ['[data-provider="cloudflare"]'],
};
const TOOLS = /\b(?:brew|npm|npx|pip3?|cargo|apt|uv tool|python3 -m venv|docker|ollama pull|timmy init|npm run build)\b/;

/**
 * The aid's plan for a row: page (another page holds the control), line (a line for the .env file), command (for the terminal),
 * config (a file's entry), words (the step in words), or none (configured: nothing to set). Built from the row's own `next`
 * (the inventory's sentence) and the page's step (inventoryNext: the step's words and where it is set), never invented.
 */
export function planOf(row, card) {
  const raw = String((row && row.next) || '').trim();
  const step = card && card.step ? card.step : null;
  const base = { id: row.id, name: row.name, optional: /^optional\b/i.test(raw), raw, words: step ? step.next : raw };
  if (isConfigured(row)) return { ...base, kind: 'none' };
  if (step && step.where === 'Models & accounts') return { ...base, kind: 'page', page: 'models', where: 'Models & accounts', targets: MODELS_TARGETS[row.id] || ['[data-panel="providers"]'] };
  const set = /\b(?:set|export) ([A-Z][A-Z0-9_]*)/.exec(raw);
  if (set) return { ...base, kind: 'line', line: `${set[1]}=`, file: 'the .env file in this project', why: 'Timmy reads its keys and settings from the environment or the project’s .env file; this page never writes one.' };
  if (/\bname .* in MCPorter|^Name a server in/i.test(raw)) return { ...base, kind: 'config', file: '~/.mcporter/mcporter.json (or config/mcporter.json in the project)', why: 'MCPorter lists the servers it can start from that file.' };
  const inParens = /\(([^()]*)\)/.exec(raw);
  const cmd = inParens && TOOLS.test(inParens[1]) ? inParens[1] : TOOLS.test(raw) ? raw.replace(/^(?:install it:|install)\s*/i, '').split(/,\s*then\b|;\s/)[0] : null;
  if (cmd) return { ...base, kind: 'command', command: cmd.trim(), why: 'This page runs no command: type it in a terminal on this computer.' };
  return { ...base, kind: 'words' };
}

// ── the one aid: which row, which phase, where its ring is ──
let aid = null;
const aidSubs = new Set();
const setAid = (next) => { aid = typeof next === 'function' ? next(aid) : next; for (const f of aidSubs) f(); };
const useAid = () => useSyncExternalStore((f) => { aidSubs.add(f); return () => aidSubs.delete(f); }, () => aid);
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const HOLD_MS = () => (reduced() ? 350 : 900);

/** Starts the aid on a row from the button the person pressed (the ring's first place). */
export function startConfigure(row, card, anchor) {
  const plan = planOf(row, card);
  setAid({ plan, phase: 'aim', anchor, target: anchor, said: '', face: 'idle', from: anchor });
}
export const closeConfigure = () => { const a = aid; setAid(null); if (a && a.from && a.from.isConnected) try { a.from.focus(); } catch { /* gone */ } };

/** Configured: Yes / No, and the one button. The same component on every page that lists capabilities. */
export function ConfigureRow({ row, card, compact = false, as: Tag = 'li', onPick, picked = false }) {
  const a = useAid();
  const yes = isConfigured(row);
  const plan = planOf(row, card);
  const on = a && a.plan.id === row.id;
  return (
    <Tag className={`ta-cfg${compact ? ' is-compact' : ''}${on ? ' is-aided' : ''}${picked ? ' is-picked' : ''}`} data-cfg={row.id} data-configured={yes ? 'yes' : 'no'}>
      <span className="ta-cfg-id">
        {onPick ? <button type="button" className="ta-cfg-name ta-cfg-pick" aria-pressed={picked} onClick={onPick}>{row.name}</button> : <span className="ta-cfg-name">{row.name}</span>}
        <span className="ta-cfg-group">{row.group}{plan.optional && !yes ? ' · optional' : ''}</span>
      </span>
      <span className="ta-cfg-state" title={yes ? 'Its files are here and its key, setting or address is set. Not a check that it works.' : plan.words || 'Not set up on this computer.'}>
        <span className="ta-cfg-k">Configured</span>
        <span className={`ta-cfg-yn ${yes ? 'is-yes' : 'is-no'}`}><span aria-hidden="true">{yes ? '✓' : '○'}</span> {yes ? 'Yes' : 'No'}</span>
      </span>
      {yes ? <span className="ta-cfg-slot" aria-hidden="true" /> : (
        <button type="button" className="ta-btn ta-cfg-go" aria-expanded={on} aria-controls={on ? 'ta-aid' : undefined}
          aria-label={`Configure ${row.name}`} onClick={(e) => (on ? closeConfigure() : startConfigure(row, card, e.currentTarget))}>Configure</button>
      )}
    </Tag>
  );
}

/** The native Rive ActionButton the aid carries (one mount, reused): its State follows only what the aid observed. */
function AidFace({ label, word, onPress, disabled }) {
  const ref = useRef(null);
  const handle = useRef(null);
  const press = useRef(onPress);
  press.current = onPress;
  const theme = useApp((s) => s.theme);
  useEffect(() => {
    const R = window.TimmyRive;
    const host = ref.current;
    if (!R || !host) return undefined;
    host.replaceChildren();
    const h = R.mountActionButton(host, { label, name: 'configure-aid', size: 'card', place: 'app', theme, action: (ev) => { if (typeof press.current === 'function') press.current(ev); } });
    handle.current = h;
    return () => { handle.current = null; try { h.unmount(); } catch { /* gone */ } };
  }, [label, theme]);
  useEffect(() => {
    const R = window.TimmyRive;
    if (R && handle.current) { try { R.set(handle.current, 'activity', word, `the configure aid: ${word}`); } catch { /* the words stay */ } }
  }, [word, label]);
  useEffect(() => { if (handle.current && handle.current.setDisabled) handle.current.setDisabled(!!disabled); }, [disabled]);
  return <div ref={ref} className="ta-face ta-face-action ta-aid-face" data-face="action" data-aid-state={word} />;
}

const rectOf = (el) => { if (!el || !el.isConnected) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };

/** Mounted once (app.jsx): the ring, and the popover under whatever it points at. */
export function ConfigureAid() {
  const a = useAid();
  const page = useApp((s) => s.page);
  const [box, setBox] = useState(null);
  const [copied, setCopied] = useState('');
  const pop = useRef(null);
  // the ring follows its element (scroll, resize, layout) while the aid is open
  useLayoutEffect(() => {
    if (!a) { setBox(null); return undefined; }
    let raf = 0;
    const tick = () => { setBox((b) => { const r = rectOf(a.target); return r && b && r.x === b.x && r.y === b.y && r.w === b.w && r.h === b.h ? b : r; }); raf = requestAnimationFrame(tick); };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [a && a.target]); // eslint-disable-line react-hooks/exhaustive-deps
  // aim → travel / explain, after the beat
  useEffect(() => {
    if (!a || a.phase !== 'aim') return undefined;
    const t = setTimeout(() => setAid((x) => (x && x.phase === 'aim' ? { ...x, phase: x.plan.kind === 'page' ? 'travel' : 'explain', face: x.plan.kind === 'page' ? 'working' : 'idle' } : x)), HOLD_MS());
    return () => clearTimeout(t);
  }, [a && a.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // travel: the hold, then the page, then the ring lands on the control
  useEffect(() => {
    if (!a || a.phase !== 'travel') return undefined;
    const t = setTimeout(() => { setAid((x) => (x ? { ...x, phase: 'landing' } : x)); goTo(a.plan.page); }, HOLD_MS() + 300);
    return () => clearTimeout(t);
  }, [a && a.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!a || a.phase !== 'landing' || page !== a.plan.page) return undefined;
    let n = 0;
    let raf = 0;
    const find = () => {
      const el = a.plan.targets.map((s) => document.querySelector(s)).find(Boolean);
      if (el) {
        try { el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); } catch { /* no scroll */ }
        setAid((x) => (x ? { ...x, phase: 'landed', target: el, face: 'awaiting' } : x));
        setTimeout(() => { try { if (el.matches('button, a, input, select, textarea, [tabindex]')) el.focus({ preventScroll: true }); } catch { /* not focusable */ } }, reduced() ? 0 : 420);
        return;
      }
      if (++n < 180) raf = requestAnimationFrame(find);
      else setAid((x) => (x ? { ...x, phase: 'landed', target: null, face: 'awaiting', said: `The control is not drawn on ${x.plan.where} right now.` } : x));
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [a && a.phase, page]); // eslint-disable-line react-hooks/exhaustive-deps
  // a press on the landed control finishes the aid's part; Escape closes it anywhere
  useEffect(() => {
    if (!a) return undefined;
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeConfigure(); } };
    const click = (e) => { if (a.phase === 'landed' && a.target && a.target.contains(e.target)) setTimeout(() => setAid(null), 150); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('click', click, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('click', click, true); };
  }, [a]);
  // the page changed under an explaining aid (the person went elsewhere): it closes
  useEffect(() => { if (a && ['aim', 'explain', 'check', 'done', 'still'].includes(a.phase) && a.anchor && !a.anchor.isConnected) setAid(null); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!a) return null;
  const p = a.plan;
  const check = async () => {
    setAid((x) => (x ? { ...x, phase: 'check', face: 'working', said: '' } : x));
    const r = await readInventory(true);
    const row = r && r.ok && r.inventory ? (r.inventory.rows || []).find((x) => x.id === p.id) : null;
    if (!row) { setAid((x) => (x ? { ...x, phase: 'still', face: 'failed', said: (r && r.error) || 'This computer was not read again.' } : x)); return; }
    if (isConfigured(row)) setAid((x) => (x ? { ...x, phase: 'done', face: 'idle', said: `${p.name} is configured: ${row.configured.found || 'its setting is set'}.` } : x));
    else setAid((x) => (x ? { ...x, phase: 'still', face: 'awaiting', said: `Not yet: ${(!row.available.ok ? row.available.found : row.configured.found) || 'the step is still to do'}.` } : x));
  };
  const copy = async (text) => {
    try { if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard here'); await navigator.clipboard.writeText(text); setCopied('Copied.'); }
    catch (e) { setCopied(`Select it and copy it (${e instanceof Error ? e.message : String(e)}).`); }
  };
  const ring = box ? { left: box.x - 8, top: box.y - 8, width: box.w + 16, height: box.h + 16 } : null;
  const below = box ? Math.min(window.innerHeight - 24, box.y + box.h + 14) : 120;
  const left = box ? Math.max(12, Math.min(window.innerWidth - 372, box.x + box.w / 2 - 180)) : 12;
  const flip = box && box.y + box.h + 300 > window.innerHeight && box.y > 320;
  const label = p.kind === 'page' ? (a.phase === 'landed' ? 'Done' : 'Take me there') : a.phase === 'done' ? 'Done' : 'Check again';
  const pressFace = () => {
    if (p.kind === 'page') { if (a.phase === 'landed') closeConfigure(); else { setAid((x) => (x ? { ...x, phase: 'landing', face: 'working' } : x)); goTo(p.page); } return; }
    if (a.phase === 'done') closeConfigure(); else check();
  };
  const head = { aim: 'Configure', travel: `Taking you to ${p.where || 'its page'}`, landing: `Opening ${p.where || 'its page'}…`, landed: 'Here it is', explain: 'One step', check: 'Checking this computer…', done: 'Configured', still: 'Still waits on you' }[a.phase] || 'Configure';
  return (
    <>
      {ring ? (
        <svg className={`ta-aid-ring is-${a.phase}`} style={ring} viewBox={`0 0 ${ring.width} ${ring.height}`} aria-hidden="true">
          <rect className="ta-aid-ring-trace" x="2" y="2" width={ring.width - 4} height={ring.height - 4} rx={Math.min(18, ring.height / 2 - 2)} pathLength="100" />
          <rect className="ta-aid-ring-glow" x="2" y="2" width={ring.width - 4} height={ring.height - 4} rx={Math.min(18, ring.height / 2 - 2)} />
        </svg>
      ) : null}
      {a.phase === 'aim' ? null : (
        <section id="ta-aid" ref={pop} className={`ta-aid is-${a.phase}${flip ? ' is-above' : ''}`} role="dialog" aria-modal="false" aria-labelledby="ta-aid-title"
          style={flip ? { left, bottom: window.innerHeight - box.y + 14 } : { left, top: below }}>
          <header className="ta-aid-head">
            <p className="ta-aid-k">CONFIGURE · {p.name}</p>
            <button type="button" className="ta-aid-x" aria-label="Close the configure aid" onClick={closeConfigure}>✕</button>
          </header>
          <h2 id="ta-aid-title" className="ta-aid-title">{head}</h2>
          <p className="ta-aid-words" role="status">{a.said || (p.kind === 'page' ? (a.phase === 'landed' ? `On ${p.where}: ${p.words || 'its control is marked'}.${a.target ? ' The marked control finishes it.' : ''}` : `${p.words ? `${p.words[0].toUpperCase()}${p.words.slice(1)}` : 'Its step'} is on ${p.where}. The aid opens it and points at the control.`) : p.words ? `${p.words[0].toUpperCase()}${p.words.slice(1)}.` : 'Its step is in the inventory’s words below.')}</p>
          {p.kind === 'line' ? (
            <div className="ta-aid-code"><code>{p.line}<span className="ta-aid-caret">value</span></code><button type="button" className="ta-btn ta-btn-quiet" onClick={() => copy(p.line)}>Copy</button></div>
          ) : p.kind === 'command' ? (
            <div className="ta-aid-code"><code>{p.command}</code><button type="button" className="ta-btn ta-btn-quiet" onClick={() => copy(p.command)}>Copy</button></div>
          ) : null}
          {p.kind === 'line' || p.kind === 'config' ? <p className="ta-aid-where">In {p.file}. {p.why}</p> : p.kind === 'command' ? <p className="ta-aid-where">{p.why}</p> : null}
          {copied ? <p className="ta-aid-where" role="status">{copied}</p> : null}
          <div className="ta-aid-act">
            <AidFace label={label} word={a.face} onPress={pressFace} disabled={a.phase === 'check' || a.phase === 'landing'} />
            {p.kind !== 'page' && a.phase !== 'done' ? <button type="button" className="ta-btn ta-btn-quiet" onClick={closeConfigure}>Later</button> : null}
          </div>
          {p.raw && p.raw !== p.words ? <details className="ta-details ta-aid-raw"><summary>In the inventory’s words</summary><p>{p.raw}</p></details> : null}
        </section>
      )}
    </>
  );
}
