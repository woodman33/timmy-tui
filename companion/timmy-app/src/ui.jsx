// R12: the small parts every card of the Timmy app is made of. A card has a head (its kicker and title: the part of a card on the
// board that moves it) and a body (what the person reads and acts on: it keeps the pointer, the wheel and the keys, so the board
// does not pan, zoom or take a shortcut while the person scrolls a list, presses a button or types).
import { useEffect, useRef } from 'react';

/** Keeps the board's own gestures out of an element: the wheel scrolls it, the keys reach its controls (native listeners). */
export function useIsolated() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const stop = (e) => { e.stopPropagation(); };
    const wheel = (e) => {
      // the wheel scrolls the body when it can scroll; ⌘/Ctrl + wheel stays the board's zoom
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
    };
    el.addEventListener('wheel', wheel, { passive: true });
    el.addEventListener('keydown', stop);
    el.addEventListener('keyup', stop);
    el.addEventListener('copy', stop);
    el.addEventListener('paste', stop);
    el.addEventListener('cut', stop);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('keydown', stop);
      el.removeEventListener('keyup', stop);
      el.removeEventListener('copy', stop);
      el.removeEventListener('paste', stop);
      el.removeEventListener('cut', stop);
    };
  }, []);
  return ref;
}

/** React's pointer down, kept out of the board (the card's body is not a drag handle). */
export const keepPointer = (e) => { e.stopPropagation(); };

export function Card({ id, kicker, title, face, tools, children, className = '' }) {
  const body = useIsolated();
  return (
    <section className={`ta-card ${className}`} data-card={id} aria-labelledby={`ta-card-${id}-title`}>
      <header className="ta-card-head" title="Drag here to move the card">
        <div className="ta-card-titles">
          {kicker ? <p className="ta-kicker">{kicker}</p> : null}
          <h2 className="ta-card-title" id={`ta-card-${id}-title`}>{title}</h2>
        </div>
        {tools ? <div className="ta-card-tools" onPointerDown={keepPointer}>{tools}</div> : null}
      </header>
      <div className="ta-card-body" ref={body} onPointerDown={keepPointer}>
        {face ? <div className="ta-card-face">{face}</div> : null}
        {children}
      </div>
    </section>
  );
}

export function Button({ children, kind = 'quiet', onClick, disabled, title, type = 'button', className = '', ...rest }) {
  return <button type={type} className={`ta-btn ta-btn-${kind} ${className}`} onClick={onClick} disabled={disabled} title={title} {...rest}>{children}</button>;
}

/** A state word in its color: green only for an observed live connection or a passed check / verified receipt (B11). */
export function StateWord({ word, live = false }) {
  const w = String(word || 'unknown');
  const kind = live ? 'live' : /fail|refus|not set up|not installed|unreachable|denied|error/i.test(w) ? 'attention' : /check|wait|pending|asking|working|stopping|downloading/i.test(w) ? 'pending' : 'plain';
  return <span className={`ta-state ta-state-${kind}`} data-state-word={w}>{w}</span>;
}

export function Facts({ rows }) {
  const shown = rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '');
  if (!shown.length) return null;
  return (
    <dl className="ta-facts">
      {shown.map(([k, v]) => [<dt key={`${k}-k`}>{k}</dt>, <dd key={`${k}-v`}>{v}</dd>])}
    </dl>
  );
}

export function Empty({ children }) { return <p className="ta-empty">{children}</p>; }

/** An outside link (the provider's own page): opened in a new tab, nothing of this page sent with it. */
export function Out({ href, children }) {
  if (!/^https:\/\//.test(String(href || ''))) return <span>{children}</span>;
  return <a className="ta-out" href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
}

export const clock = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};
export const day = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};
