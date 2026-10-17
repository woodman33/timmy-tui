// R6 lead: the companion page's tab panels, page side (the server side is src/companion/panels.ts).
//
// Each panel's own file (panel-<tab>.js, loaded before companion.js) registers itself here for one workspace tab:
//
//   TimmyPanels.register('voxvision', { draw(host, frame, ctx) { … } });
//
// companion.js draws the panel of the tab on screen: when the tab is shown, and when a frame of another revision arrives
// while it is on screen. `host` is the tab's element marked data-panel-host="<tab>" (index.html); `frame` is the workspace
// frame the page drew (timmy.workspace/1); `ctx` gives:
//   ctx.own        true when the frame is the shown project's own (false: another project's frame; draw nothing of it)
//   ctx.project    the shown project's id ('' before the companion named one)
//   ctx.fetch      the companion's own fetch (the token in a header, never in the address; a 401 stops the page)
//   ctx.api(path)  `/api/panel/<tab>/<path>?project=<id>`, the panel's own routes for the shown project
//   ctx.h          the page's element helper, h(tag, attrs, ...children)
// A panel that throws is not left blank: its host says, in words, that it could not be drawn.
const TimmyPanels = (() => {
  const panels = new Map();
  const hostOf = (tab) => document.querySelector(`[data-panel-host="${CSS.escape(String(tab))}"]`);
  return {
    register(tab, panel) {
      if (!panel || typeof panel.draw !== 'function') throw new Error(`a panel for ${tab} needs draw(host, frame, ctx)`);
      panels.set(String(tab), panel);
    },
    has: (tab) => panels.has(String(tab)),
    /** Draws the panel of `tab` into its host, if both exist; returns whether one was drawn. */
    draw(tab, frame, base) {
      const panel = panels.get(String(tab));
      const host = hostOf(tab);
      if (!panel || !host) return false;
      const project = (base && base.project) || '';
      const ctx = Object.assign({}, base, {
        api: (p) => `/api/panel/${encodeURIComponent(String(tab))}/${String(p).replace(/^\/+/, '')}${project ? `${String(p).includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}` : ''}`,
      });
      try {
        const out = panel.draw(host, frame, ctx);
        if (out && typeof out.catch === 'function') out.catch((err) => failed(host, err));
      } catch (err) { failed(host, err); }
      return true;
    },
  };
  function failed(host, err) {
    const p = document.createElement('p');
    p.className = 'empty tone-failed';
    p.textContent = `This panel could not be drawn: ${err && err.message ? err.message : String(err)}. The rest of the page works.`;
    host.replaceChildren(p);
  }
})();

// R6 lead: a preview seen at size. A thumbnail the page draws small (the run detail's image, Home's newest images, a board
// artifact) sits in a button marked data-enlarge="<what it is>"; pressing it (a click, Enter or Space) opens the image it holds
// in a dialog over the page, as large as the window allows and never larger than its own pixels, with those words under it.
// Esc, Close or a click beside the image closes it, and the keyboard goes back to the thumbnail. The image is the one the page
// already holds (its data: address or blob): nothing is fetched again and nothing leaves the page.
const TimmyEnlarge = (() => {
  let dialog = null;
  let from = null;
  function build() {
    const d = document.createElement('dialog');
    d.className = 'enlarge';
    d.setAttribute('aria-label', 'The image at size');
    const fig = document.createElement('figure');
    fig.className = 'enlarge-fig';
    const img = document.createElement('img');
    img.className = 'enlarge-img';
    img.alt = '';
    const cap = document.createElement('figcaption');
    cap.className = 'enlarge-cap';
    fig.append(img, cap);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-action enlarge-close';
    close.textContent = 'Close (Esc)';
    close.addEventListener('click', () => d.close());
    d.append(fig, close);
    // a click on the dialog's own backdrop area (not on the image or its words) closes it
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    // the keyboard goes back to the thumbnail; the page may have drawn it again meanwhile (a new frame), so the one with the
    // same words is found when the first is gone
    d.addEventListener('close', () => {
      img.removeAttribute('src');
      const words = from ? from.getAttribute('data-enlarge') : null;
      const back = from && document.contains(from) ? from : (words !== null ? document.querySelector(`[data-enlarge="${CSS.escape(words)}"]`) : null);
      if (back) back.focus();
      from = null;
    });
    document.body.append(d);
    return d;
  }
  function open(src, words, trigger) {
    if (!src) return false;
    dialog = dialog || build();
    const img = dialog.querySelector('.enlarge-img');
    img.src = src;
    img.alt = words || 'the image at size';
    dialog.querySelector('.enlarge-cap').textContent = words || '';
    from = trigger || null;
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', '');
    dialog.querySelector('.enlarge-close').focus();
    return true;
  }
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-enlarge]') : null;
    if (!b) return;
    const img = b.matches('img') ? b : b.querySelector('img');
    if (!img || !img.getAttribute('src')) return;
    e.preventDefault();
    open(img.currentSrc || img.src, b.getAttribute('data-enlarge') || img.alt, b);
  });
  return { open };
})();
