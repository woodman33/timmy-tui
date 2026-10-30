// The unified Workspace order (2026-10-27): ONE dropdown for every display and node (the addendum's "Display controls and
// dropdowns"). Semantic HTML — a <button aria-haspopup="menu"> and a role="menu" of real buttons — composed with the Glacier
// look; never a painted imitation. What it guarantees, on the page and on the licensed tldraw canvas alike:
//   - keyboard: Enter / Space / ArrowDown open it on its first item, ArrowUp on its last; Up / Down / Home / End move; Escape
//     and Tab close it, and focus returns to the button; an outside press closes it;
//   - the canvas never sees it: pointer, wheel and key events stop at the menu (a press in it never drags its node, a wheel
//     never pans or zooms the camera, a key never reaches tldraw's shortcuts);
//   - readable at any zoom: the list is drawn in a layer over the page (a portal), at the button's place on the screen and
//     at the page's own size, kept inside the window (flipped above or moved in when it would run past an edge);
//   - on a phone's width it is a sheet at the foot of the screen, every item at least 44 px tall, never clipped.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const PHONE = 650;
const ITEMS = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';
const stop = (e) => e.stopPropagation();
/** Handlers that keep an event inside the menu (and out of the canvas under it). */
export const keepOut = { onPointerDown: stop, onPointerUp: stop, onPointerMove: stop, onMouseDown: stop, onClick: stop, onDoubleClick: stop, onWheel: stop, onTouchStart: stop, onKeyUp: stop };

function placeOf(anchor, menu) {
  const a = anchor.getBoundingClientRect();
  const w = window.innerWidth; const h = window.innerHeight;
  if (w < PHONE) return { sheet: true };
  const mw = menu ? menu.offsetWidth : 260; const mh = menu ? menu.offsetHeight : 200;
  let left = Math.min(Math.max(8, a.left), Math.max(8, w - mw - 8));
  let top = a.bottom + 6;
  if (top + mh > h - 8 && a.top - mh - 6 >= 8) top = a.top - mh - 6; // flip above
  top = Math.min(Math.max(8, top), Math.max(8, h - mh - 8));
  return { sheet: false, left: Math.round(left), top: Math.round(top), maxHeight: Math.max(120, h - 16) };
}

/**
 * A button that opens a menu. `children(close)` renders the menu's content: MenuItem rows and, where a menu needs one, a
 * small form (an input is reachable with Tab; the arrow keys move between the items only).
 */
export function MenuButton({ label, glyph = '', title, className = '', buttonClass = 'ta-tool', disabled = false, children, data = {}, menuLabel, onOpen }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);
  const close = useCallback((back = true) => { setOpen(false); if (back && btn.current) btn.current.focus(); }, []);
  const focusItem = (which) => {
    const items = menu.current ? [...menu.current.querySelectorAll(ITEMS)].filter((x) => !x.disabled) : [];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = which === 'first' ? 0 : which === 'last' ? items.length - 1 : which === 'next' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  };
  const first = useRef('first');
  const pending = useRef(false);
  const show = (from) => { first.current = from; pending.current = true; setOpen(true); if (onOpen) onOpen(); };
  // the first item takes the focus once the list is placed (a hidden list cannot hold it)
  useEffect(() => { if (open && at && pending.current) { pending.current = false; focusItem(first.current); } });
  // the list's place, while it is open (the button moves with the canvas camera): read each frame, set only when it changes
  useLayoutEffect(() => {
    if (!open) return undefined;
    let raf = 0; let last = '';
    const tick = () => {
      if (btn.current) { const p = placeOf(btn.current, menu.current); const k = JSON.stringify(p); if (k !== last) { last = k; setAt(p); } }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => { if (menu.current && !menu.current.contains(e.target) && btn.current && !btn.current.contains(e.target)) close(false); };
    document.addEventListener('pointerdown', off, true);
    return () => { document.removeEventListener('pointerdown', off, true); };
  }, [open, close]);
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key === 'Tab') { close(false); return; }
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (inField) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem('next'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem('prev'); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem('first'); }
    else if (e.key === 'End') { e.preventDefault(); focusItem('last'); }
  };
  const onButtonKey = (e) => {
    e.stopPropagation();
    if (open) { // the list is open and the focus still on its button: the keys move into the list
      if (e.key === 'ArrowDown') { e.preventDefault(); focusItem('first'); } else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem('last'); } else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show('first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); show('last'); }
  };
  const sheet = at && at.sheet;
  return (
    <span className={`ta-menu-wrap ${className}`} {...keepOut}>
      <button
        ref={btn} type="button" className={buttonClass} aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={title || label}
        onClick={(e) => { e.stopPropagation(); if (open) close(false); else show('first'); }} onKeyDown={onButtonKey} {...data}
      >
        {glyph ? <span className="ta-tool-glyph" aria-hidden="true">{glyph}</span> : null}<span className="ta-tool-label">{label}</span>
      </button>
      {open ? createPortal(
        <div
          ref={menu} role="menu" aria-label={menuLabel || label} className={`ta-menu-list${sheet ? ' is-sheet' : ''}`} onKeyDown={onKey} {...keepOut}
          style={sheet ? undefined : at ? { left: at.left, top: at.top, maxHeight: at.maxHeight } : { visibility: 'hidden' }}
          data-menu-for={data['data-menu'] || label}
        >
          {children(close)}
        </div>, document.body) : null}
    </span>
  );
}

/** One item of a menu: a real button; `checked` (true / false) makes it a radio item of a set. */
export function MenuItem({ children, onSelect, disabled = false, checked, hint, data = {}, close, keepOpen = false }) {
  const role = typeof checked === 'boolean' ? 'menuitemradio' : 'menuitem';
  return (
    <button
      type="button" role={role} aria-checked={typeof checked === 'boolean' ? checked : undefined} disabled={disabled} className="ta-menu-item" {...data}
      onClick={(e) => { e.stopPropagation(); if (disabled) return; if (onSelect) onSelect(); if (!keepOpen && close) close(true); }}
    >
      <span className="ta-menu-check" aria-hidden="true">{checked ? '✓' : ''}</span>
      <span className="ta-menu-words">{children}{hint ? <small className="ta-menu-hint">{hint}</small> : null}</span>
    </button>
  );
}

/** A heading between a menu's groups (not focusable; read by a screen reader as the group's name). */
export function MenuGroup({ label, children }) {
  return <div role="group" aria-label={label} className="ta-menu-group"><p className="ta-menu-label" aria-hidden="true">{label}</p>{children}</div>;
}
