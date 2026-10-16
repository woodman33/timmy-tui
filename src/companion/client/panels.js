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
