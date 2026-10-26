// R12: the small parts every card of the Timmy app is made of. A card has a head (its kicker and title: the part of a card on the
// board that moves it) and a body (what the person reads and acts on: it keeps the pointer, the wheel and the keys, so the board
// does not pan, zoom or take a shortcut while the person scrolls a list, presses a button or types).
import { useEffect, useRef } from 'react';

/**
 * Keeps the board's wheel out of an element (a native listener: tldraw listens for the wheel on its own container, inside the
 * page's React root, so only a listener on the element itself stops it before tldraw). The keys and the clipboard are kept with
 * React's handlers (keepKeys) instead: tldraw hears those on the document, after React's root, and a native stop here would keep
 * them from React too (the composer's ⌘/Ctrl + Enter never arrived).
 */
export function useIsolated() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const wheel = (e) => {
      // the wheel scrolls the body; ⌘/Ctrl + wheel stays the board's zoom
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
    };
    // a key on a button, a link or a list in the body is that control's (Space and Enter press it natively; tldraw would take
    // Space as its hand tool): stopped here, before tldraw's container hears it. Keys in a text field are left alone (tldraw
    // takes no shortcut while one is focused, and the composer's own React handler needs them).
    const key = (e) => { const t = e.target; if (t && t.closest && t.closest('button, a, select, [role="button"]')) e.stopPropagation(); };
    el.addEventListener('wheel', wheel, { passive: true });
    el.addEventListener('keydown', key);
    el.addEventListener('keyup', key);
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('keydown', key); el.removeEventListener('keyup', key); };
  }, []);
  return ref;
}

/** React's handlers that keep the keys and the clipboard of a card's body from the board's shortcuts (on the document). */
export const keepKeys = { onKeyDown: (e) => e.stopPropagation(), onKeyUp: (e) => e.stopPropagation(), onCopy: (e) => e.stopPropagation(), onCut: (e) => e.stopPropagation(), onPaste: (e) => e.stopPropagation() };

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
        {tools ? <div className="ta-card-tools" onPointerDown={keepPointer} {...keepKeys}>{tools}</div> : null}
      </header>
      <div className="ta-card-body" ref={body} onPointerDown={keepPointer} {...keepKeys}>
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
  const kind = live ? 'live' : /fail|refus|unreachable|denied|error|expired|stale/i.test(w) ? 'attention' : /check|wait|pending|asking|working|stopping|downloading/i.test(w) ? 'pending' : 'plain';
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
