// R6 (H145): the Studio panel (tab 4; reference 06), drawn into data-panel-host="studio" (panels.js says how a panel registers
// and what it is given). Its routes are src/companion/panels/studio.ts; what they answer is read from the shown project's own
// board as Studio last saved it (src/studio/board-items.ts).
//
// What is on the board, in reading order (page by page, top to bottom, left to right): the artifact cards (a VoxVision record,
// an operation's run, a receipt), the reference images, Timmy's cards, and the words on it, each with its page, its draft mark
// (a draft of Timmy's waiting for Accept or Discard in Studio), its thumbnail and what it opens:
//   a VoxVision record    button data-open-vox="<id>": the page opens it in tab 5 (companion.js's own click handler)
//   an operation          button data-open-run="<op>": the page opens its run in Workflows (tab 3), at /run/<op>
//   a receipt             Studio's receipt page, linked on this computer only (from a phone, its address is said)
//   a thumbnail           button data-enlarge="<its words>" around it: the page shows the image at size (panels.js)
// Another project's card on this board is named as kept apart, and nothing of it is read. Thumbnails come through the panels'
// routes with the page's token in a header and are shown as data: images (the page's policy allows those). Every word drawn is
// the board's or the route's; nothing here invents a value. The panel reads again every few seconds while its tab is on screen,
// and drops an answer that comes back after the page changed project.
(() => {
  'use strict';
  if (typeof TimmyPanels === 'undefined') return;

  const EVERY_MS = 4000;
  const AT_LEAST_MS = 1500;
  const CACHE_MAX = 48;
  const HERE = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
  const SUB_WORDS = {
    vox: 'VoxVision record', run: 'operation', receipt: 'receipt', workflow: 'workflow', params: 'parameters', result: 'result', flow: 'flow',
    note: 'note', text: 'text', geo: 'shape', frame: 'frame',
  };

  const S = { project: null, host: null, root: null, ctx: null, at: 0, sig: '', answer: null, asking: null, ticket: 0, thumbs: new Map(), timer: null };

  const put = (el, ...kids) => { if (el) el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
  const q = (name) => (S.root ? S.root.querySelector(`[data-studio="${name}"]`) : null);
  const pageProject = () => document.getElementById('project')?.dataset.project || '';
  const when = (iso) => {
    const t = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return Number.isNaN(t.getTime()) ? String(iso || '') : `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** What kind of thing an item is, in words (its head line). */
  function kindWords(it) {
    const sub = SUB_WORDS[it.sub] || it.sub || '';
    if (it.kind === 'artifact') return `artifact · ${sub || 'record'}`;
    if (it.kind === 'reference') return 'reference image';
    if (it.kind === 'card') return `card · ${sub || 'card'}`;
    if (it.kind === 'words') return sub || 'words';
    if (it.kind === 'image') return 'image';
    if (it.kind === 'other-project') return 'kept apart';
    return it.kind;
  }

  /** The board's counts in words: "2 artifacts · 1 reference image · 3 notes and texts". */
  function countWords(c) {
    const parts = [];
    if (c.artifact) parts.push(plural(c.artifact, 'artifact', 'artifacts'));
    if (c.reference) parts.push(plural(c.reference, 'reference image', 'reference images'));
    if (c.card) parts.push(plural(c.card, 'card', 'cards'));
    if (c.image) parts.push(plural(c.image, 'image', 'images'));
    if (c.words) parts.push(`${c.words} with words (notes, texts, frames)`);
    if (c['other-project']) parts.push(`${c['other-project']} of another project, kept apart`);
    return parts.join(' · ');
  }

  function reset(project) {
    S.project = project; S.ticket += 1; S.answer = null; S.sig = ''; S.at = 0; S.root = null;
    S.thumbs.clear();
  }

  function skeleton(h) {
    return h('section', { class: 'box sb-box', 'aria-labelledby': 'studio-board-title', 'data-studio': 'root' },
      h('h2', { class: 'box-title', id: 'studio-board-title', 'data-studio': 'title' }, 'On the board'),
      h('div', { class: 'box-body' },
        h('p', { class: 'sb-summary', 'data-studio': 'summary', role: 'status' }, 'Reading the board…'),
        h('ol', { class: 'sb-list', 'data-studio': 'list' }),
        h('p', { class: 'sb-foot', 'data-studio': 'foot' })));
  }

  // ── reading ──
  async function read() {
    // one read at a time for the project shown; a read still out for the project before does not hold this one up
    if (S.asking && S.asking.ticket === S.ticket) return S.asking.promise;
    const ctx = S.ctx;
    const mine = S.ticket;
    const project = S.project;
    S.at = Date.now();
    const promise = (async () => {
      let body = null;
      let status = 0;
      try {
        const r = await ctx.fetch(ctx.api('board'));
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (e) { body = null; }
      // an answer that comes back after the page changed project is dropped: it is never drawn under another project's name
      if (mine !== S.ticket || (project && pageProject() && pageProject() !== project)) return;
      if (!body || body.ok !== true) {
        S.sig = '';
        put(q('summary'), `✕ The board could not be read: ${(body && body.error) || (status ? `the companion answered HTTP ${status}` : 'the companion did not answer')}.`);
        q('summary')?.classList.add('tone-failed');
        put(q('list'));
        return;
      }
      if (project && body.project && body.project.id !== project) return;
      const sig = JSON.stringify([body.project, body.board, body.items, body.counts, body.drafts, body.more, body.studio, body.oldLayout]);
      if (sig === S.sig) return;
      S.sig = sig;
      S.answer = body;
      draw();
    })().finally(() => { if (S.asking && S.asking.promise === promise) S.asking = null; });
    S.asking = { ticket: mine, promise };
    return promise;
  }

  /** A thumbnail as a data: URL (fetched with the token; kept for the next draw of this project). */
  async function thumbData(src) {
    if (S.thumbs.has(src)) return S.thumbs.get(src);
    const ctx = S.ctx;
    const project = S.project;
    const r = await ctx.fetch(`${src}${project ? `${src.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}` : ''}`);
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      throw new Error((body && body.error) || `the companion answered HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const url = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('the image could not be read in the page'));
      fr.readAsDataURL(blob);
    });
    if (project !== S.project) throw new Error('the page shows another project now');
    if (S.thumbs.size >= CACHE_MAX) S.thumbs.delete(S.thumbs.keys().next().value);
    S.thumbs.set(src, url);
    return url;
  }

  // ── drawing ──
  function thumbOf(it, h) {
    if (!it.thumb) return null;
    const words = `${it.title} · ${it.thumb.path} (${kindWords(it)} on ${S.answer.project.name}'s board)`;
    const img = h('img', { class: 'sb-img', alt: words, 'data-path': it.thumb.path });
    const btn = h('button', { type: 'button', class: 'sb-thumb', 'data-enlarge': words, title: `${words}: shown at size` }, img);
    const mine = S.ticket;
    thumbData(it.thumb.src).then((url) => { if (mine === S.ticket) img.src = url; }).catch((err) => {
      if (mine !== S.ticket) return;
      btn.replaceWith(h('span', { class: 'sb-thumb-failed', 'data-path': it.thumb.path, title: `not shown: ${err.message}` }, '✕ not shown'));
    });
    return btn;
  }

  function actsOf(it, h) {
    const t = it.target || {};
    const studio = String(S.answer.studio || '').replace(/\/+$/, '');
    const acts = [];
    if (t.vox) acts.push(h('button', { type: 'button', class: 'btn-action tiny sb-open', 'data-open-vox': t.vox, title: `Opens VoxVision record ${t.vox} in tab 5` }, `Open ${t.vox} in VoxVision`));
    if (t.run) acts.push(h('button', { type: 'button', class: 'btn-action tiny sb-open', 'data-open-run': t.run, title: `Opens run ${t.run} in Workflows` }, `Open run ${t.run}`));
    if (t.receipt) {
      const href = `${studio}/receipts/${encodeURIComponent(t.receipt)}`;
      acts.push(HERE
        ? h('a', { class: 'sb-link', 'data-receipt': t.receipt, href, target: '_blank', rel: 'noopener noreferrer' }, `Receipt ${t.receipt.slice(0, 8)} in Studio`)
        : h('span', { class: 'sb-addr', 'data-receipt': t.receipt }, `Receipt ${t.receipt.slice(0, 8)}: open ${href} on the computer that runs Timmy`));
    }
    return acts.length ? h('p', { class: 'sb-acts' }, acts) : null;
  }

  function itemOf(it, h) {
    return h('li', { class: `sb-item kind-${it.kind}${it.thumb ? '' : ' no-thumb'}`, 'data-shape': it.shape, 'data-kind': it.kind, 'data-sub': it.sub || '' },
      thumbOf(it, h),
      h('div', { class: 'sb-text' },
        h('p', { class: 'sb-head' },
          h('span', { class: 'sb-kind' }, kindWords(it)),
          it.fake ? [' ', h('span', { class: 'sb-fake', title: 'made by a test double, as its record says' }, 'FAKE')] : null,
          it.draft ? [' ', h('span', { class: 'sb-draft', 'data-draft': it.draft, title: `${it.draft}: Timmy's draft, waiting for Accept or Discard in Studio` }, 'draft · waiting in Studio')] : null),
        h('p', { class: 'sb-title' }, it.title),
        it.excerpt && it.excerpt !== it.title ? h('p', { class: 'sb-excerpt' }, it.excerpt) : null,
        h('p', { class: 'sb-where' }, `on ${it.page}`),
        actsOf(it, h)));
  }

  function draw() {
    const h = S.ctx.h;
    const a = S.answer;
    const name = a.project.name;
    const studio = String(a.studio || '').replace(/\/+$/, '');
    // focus kept across a redraw: the same item's same control
    const f = document.activeElement;
    const kept = f && S.root && S.root.contains(f) && f.closest('[data-shape]')
      ? { shape: f.closest('[data-shape]').dataset.shape, cls: ['sb-thumb', 'sb-open', 'sb-link'].find((c) => f.classList.contains(c)) || '', attr: f.getAttribute('data-open-vox') ?? f.getAttribute('data-open-run') ?? '' }
      : null;
    put(q('title'), `On ${name}'s board`);
    const summary = q('summary');
    summary?.classList.remove('tone-failed');
    if (a.board.unreadable) {
      put(summary, `${name}'s saved board could not be read, so nothing of it is listed here. Studio keeps such a file aside when it opens the board; nothing was changed here.`);
      summary?.classList.add('tone-failed');
    } else if (!a.board.revision && !a.items.length) {
      put(summary, `Nothing on ${name}'s board yet. In Studio, its side panel places the project's artifacts and reference images on it (each project has its own board).`);
    } else if (!a.items.length) {
      put(summary, `${name}'s own board, as Studio last saved it (revision ${a.board.revision}${a.board.savedAt ? `, ${when(a.board.savedAt)}` : ''}): nothing on it.`);
    } else {
      const waiting = a.drafts.length ? ` ${plural(a.drafts.length, 'draft', 'drafts')} of Timmy's waiting for Accept or Discard in Studio.` : '';
      put(summary, `${name}'s own board, as Studio last saved it (revision ${a.board.revision}${a.board.savedAt ? `, ${when(a.board.savedAt)}` : ''}): ${countWords(a.counts)}.${waiting}`);
    }
    put(q('list'), a.items.map((it) => itemOf(it, h)));
    put(q('foot'),
      a.more ? `${a.more} more on the board are not listed (the first ${a.items.length}, in reading order). ` : null,
      a.oldLayout ? `${a.oldLayout} ` : null,
      HERE ? h('a', { class: 'sb-link', 'data-studio-open': '1', href: `${studio}/`, target: '_blank', rel: 'noopener noreferrer' }, 'Open Timmy Studio') : `Studio: open ${studio}/ on the computer that runs Timmy.`);
    if (kept) {
      const li = S.root.querySelector(`[data-shape="${CSS.escape(kept.shape)}"]`);
      const el = li && (kept.cls ? [...li.querySelectorAll(`.${kept.cls}`)].find((e) => !kept.attr || e.getAttribute('data-open-vox') === kept.attr || e.getAttribute('data-open-run') === kept.attr) : null);
      if (el) el.focus({ preventScroll: true });
    }
  }

  /** Read again every few seconds while the tab is on screen and the page is visible (the frame alone may not change). */
  function ensureTimer() {
    if (S.timer) return;
    S.timer = setInterval(() => {
      if (!S.root || !S.host || !S.ctx || document.hidden || S.host.closest('[hidden]') || !S.host.contains(S.root)) return;
      read();
    }, EVERY_MS);
  }

  TimmyPanels.register('studio', {
    draw(host, frame, ctx) {
      S.ctx = ctx;
      S.host = host;
      if (!ctx.own) {
        reset(null);
        put(host, ctx.h('p', { class: 'empty', 'data-studio': 'not-own' }, 'Not shown: the frame is another project\'s, so no board is read here.'));
        return undefined;
      }
      if (S.project !== ctx.project || !S.root || !host.contains(S.root)) {
        reset(ctx.project);
        S.root = skeleton(ctx.h);
        put(host, S.root);
      }
      ensureTimer();
      if (S.answer && Date.now() - S.at < AT_LEAST_MS) return undefined;
      return read();
    },
  });
})();
