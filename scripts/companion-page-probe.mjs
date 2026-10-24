// The browser companion's page, and the log companion's pages, in a real browser, workflow by workflow (round R4: H92, H95).
// The packed-install check runs it against the installed package (scripts/packed-install-check.mjs, step 6: the installed
// package's own server modules and its own playwright); tests/companion-page-probe.test.ts runs it against this checkout,
// and against a FAKE page that asks other sites, which it must fail.
//
// It starts the companion with the module it is given (port 0, a token made there; /chat's upstream a FAKE OpenRouter of its
// own on 127.0.0.1, so no model is asked and nothing is spent), reads the page's Content-Security-Policy, and opens the
// address the server gives (the token in its fragment) in a headless Chromium or Chrome whose name resolver answers
// 127.0.0.1 only. Every request of every frame is counted; one to another origin is recorded and aborted before it leaves.
// Then it goes through the workflows a person uses, each counted on its own (requests, those to the page's own server, those
// elsewhere, violations of the policy reported in any frame, page errors):
//   load                the page opened with its token; its socket connects
//   every tab           each tab opened in turn
//   live mirror         the check's own events from the running server: a chat turn sent as Timmy's TUI sends it (sync),
//                       and an event appended to the bus it tails; the mirror and the log show them
//   chat sample         ✨ Try it: the page's own sample streams (no model is asked): a highlighted code block, a drawn
//                       Mermaid diagram, a receipt card and an approval card; the receipt card's Copy copies `timmy verify`
//   chat send           a message sent to the FAKE upstream (POST /chat with the page's token): its answer drawn
//   slate 3d            Slate 3D's tab: its scene where it is built, else its words
//   proof, workspace    the Proof tab shows the run id and sha the mirror named, as received; the Workspace checks nothing
//   canvas              the Canvas tab reads Timmy Canvas's revision with the token
//   logs /, /mission, /browser, /chat   the log companion's pages (when its module is given), opened with its token; the
//                       chat mirror draws the check's own session turn with Streamdown
// It imports nothing: what it drives is given to it.
//
//   probeCompanionPage({ startCompanionServer, startManagedLogServer?, chromium, executablePath?, timeoutMs?, workDir? })
//     -> result (never throws)
//
// result.ok: every workflow passed (its own checks, no request elsewhere, no violation, no error), the companion's policy is
// the strict one it is served with, and its one socket is its own.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONNECTED = 'COMPANION SOCKET · CONNECTED';

/** Whether a policy is the strict one the page is served with (src/companion/page.ts pagePolicy). */
export function strictPolicy(csp, port) {
  const d = new Map(String(csp ?? '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...v] = x.split(/\s+/); return [k, v.join(' ')]; }));
  return d.get('default-src') === "'none'" && d.get('script-src') === "'self'" && d.get('style-src') === "'self' 'unsafe-inline'"
    && d.get('img-src') === "'self' data:" && d.get('font-src') === "'self'"
    && d.get('object-src') === "'none'" && d.get('frame-ancestors') === "'none'" && d.get('base-uri') === "'none'"
    && d.get('connect-src') === `'self' ws://127.0.0.1:${port}` && !/unsafe-eval|\*|https?:|blob:/.test(String(csp));
}

/** Whether a log companion page's policy runs only its own scripts: by this answer's nonce, or (its chat mirror) from itself. */
export function logsPolicyOk(csp, page) {
  const d = new Map(String(csp ?? '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...v] = x.split(/\s+/); return [k, v.join(' ')]; }));
  const script = d.get('script-src') ?? '';
  const scriptsOk = page === '/chat' ? script === "'self'" : /^'nonce-[A-Za-z0-9+/=]{16,}'$/.test(script);
  return d.get('default-src') === "'none'" && scriptsOk && d.get('connect-src') === "'self'" && d.get('frame-ancestors') === "'none'"
    && d.get('object-src') === "'none'" && !/unsafe-eval|script-src[^;]*unsafe-inline|https?:\/\//.test(String(csp));
}

/** A FAKE OpenRouter on 127.0.0.1: every request answered with the same short markdown, streamed; nothing leaves this computer. */
function fakeUpstream() {
  const answer = ['## FAKE answer', '', 'From the check\'s FAKE upstream on 127.0.0.1: **no model** was asked.', '', '```js', 'const fake = true;', '```'].join('\n');
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < answer.length; i += 24) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(i, i + 24) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 21 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export async function probeCompanionPage({ startCompanionServer, startManagedLogServer, chromium, executablePath, timeoutMs = 30_000, workDir }) {
  const out = { ok: false, base: null, csp: null, requests: 0, own: 0, outside: [], sockets: [], violations: [], errors: [], workflows: [], connected: false, sample: null, slate: null, error: null };
  let server;
  let logs;
  let upstream;
  let browser;
  const made = [];
  const saved = { TIMMY_REPO: process.env.TIMMY_REPO, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, OPENROUTER_MODEL: process.env.OPENROUTER_MODEL, cwd: process.cwd() };
  try {
    // the check's own workspace: the bus the companion tails, a session the log companion's chat mirror reads
    const work = workDir ?? mkdtempSync(join(tmpdir(), 'timmy-page-probe-'));
    if (!workDir) made.push(work);
    mkdirSync(join(work, '.timmy', 'runs'), { recursive: true });
    mkdirSync(join(work, '.sessions'), { recursive: true });
    const busFile = join(work, '.timmy', 'runs', 'timmy-events.jsonl');
    writeFileSync(busFile, `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: 'probe.seeded', payload: { note: 'SYNTHETIC' } })}\n`);
    writeFileSync(join(work, '.sessions', 'probe.jsonl'), [
      { role: 'user', content: 'SYNTHETIC: the check asks the chat mirror' },
      { role: 'assistant', content: '## SYNTHETIC answer\n\nDrawn by **Streamdown** in the log companion\'s chat mirror.\n\n- one\n- two' },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n');
    process.env.TIMMY_REPO = work;
    process.env.OPENROUTER_API_KEY = 'FAKE-key-for-the-page-probe';
    // R11 (H169, Phase 0 item 2): the page's Send asks the model chosen for this process (it has no fixed model of its own):
    // a FAKE name, so the FAKE upstream is asked and nothing is sent to a model nobody chose
    process.env.OPENROUTER_MODEL = 'fake-maker/fake-model-for-the-page-probe';
    process.chdir(work);
    upstream = await fakeUpstream();
    server = await startCompanionServer(0, { upstream: `http://127.0.0.1:${upstream.address().port}/chat/completions` });
    const base = `http://127.0.0.1:${server.port}`;
    out.base = base;
    out.csp = (await fetch(`${base}/`, { signal: AbortSignal.timeout(timeoutMs) })).headers.get('content-security-policy');
    const allowed = new Set([base]);
    if (startManagedLogServer) {
      logs = await startManagedLogServer({ port: 0, open: false });
      allowed.add(`http://127.0.0.1:${logs.port}`);
    }
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => undefined);
    context.on('request', (r) => {
      out.requests += 1;
      try { if (allowed.has(new URL(r.url()).origin)) out.own += 1; } catch { /* not a URL */ }
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (allowed.has(url.origin)) return route.continue();
      out.outside.push(url.origin);
      return route.abort('blockedbyclient');
    });
    await context.addInitScript(() => {
      window.__timmyViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => { window.__timmyViolations.push(`${e.effectiveDirective} ${e.blockedURI}`); });
    });
    context.setDefaultTimeout(timeoutMs);
    const page = await context.newPage();
    page.on('websocket', (ws) => out.sockets.push(ws.url()));
    page.on('pageerror', (e) => out.errors.push(String(e && e.message).split('\n')[0].slice(0, 200)));
    page.on('dialog', (d) => { void d.dismiss(); });

    // every violation reported so far, in every frame of every page (each frame's list is its own, kept in order)
    const pages = [page];
    const allViolations = async () => {
      const v = [];
      for (const p of pages) for (const f of p.frames()) { try { v.push(...await f.evaluate(() => window.__timmyViolations ?? [])); } catch { /* a frame gone */ } }
      return v;
    };
    /** One workflow, counted on its own. `fn` returns its details ({ ok: false, why } when its own checks failed). */
    const workflow = async (name, fn) => {
      const before = { requests: out.requests, own: out.own, outside: out.outside.length, errors: out.errors.length, violations: (await allViolations()).length };
      const w = { name, ok: false, requests: 0, own: 0, outside: [], violations: [], errors: [], detail: null, why: null };
      try {
        const d = await fn();
        w.detail = d ?? null;
        if (d && d.ok === false) w.why = d.why ?? 'its own check failed';
      } catch (e) { w.why = String((e && e.message) || e).split('\n')[0].slice(0, 160); }
      await new Promise((r) => setTimeout(r, 250));
      const v = await allViolations();
      w.requests = out.requests - before.requests;
      w.own = out.own - before.own;
      w.outside = out.outside.slice(before.outside);
      w.errors = out.errors.slice(before.errors);
      w.violations = v.slice(before.violations);
      w.ok = !w.why && w.outside.length === 0 && w.errors.length === 0 && w.violations.length === 0;
      out.workflows.push(w);
      return w;
    };
    const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: timeoutMs });
    // R5 (H132's layout): a panel lives under one of the workspace's ten tabs (its data-ws), and the chat's two views
    // under Chat's view switch; a package without workspace tabs keeps its flat buttons
    const tab = async (name) => {
      // R11 round 4 (H171): the page opens on the shell's landing screen (the account screen where no identity provider is
      // configured); the workspace is the Chat screen, which the shell shows on request (as a person's click would)
      await page.evaluate(() => { const sh = window.TimmyShell; if (sh && typeof sh.current === 'function' && sh.current() !== 'chat') sh.go('chat', 'probe'); }).catch(() => undefined);
      const ws = await page.getAttribute(`#tab-${name}`, 'data-ws').catch(() => null);
      // R10 CHAT (H171): the tab row is not drawn on Chat (where the page opens): there the shell's left menu opens the tab
      if (ws && (await page.getAttribute('body', 'data-dest').catch(() => null)) !== ws) {
        const row = page.locator(`#ws-tabs [data-ws-tab="${ws}"]`);
        if (await row.isVisible().catch(() => false)) await row.click();
        else {
          // (R11 round 4: a destination the rail does not list — Home, Control Room, Fleet — is found by the rail's finder)
          const item = page.locator(`#rail-menu .rail-item[data-dest="${ws}"]`);
          const found = !(await item.isVisible().catch(() => false));
          if (found) { await page.click('#rail-find-btn'); await page.fill('#rail-find', ws); }
          await item.click();
          // (the finder closed again, so the rail lists every destination for the next tab)
          if (found) await page.evaluate(() => { const b = document.getElementById('rail-find-btn'); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); });
        }
      }
      if (await page.locator(`.view-switch [data-tab="${name}"]`).count()) await page.click(`.view-switch [data-tab="${name}"]`);
      else if (!ws) await page.click(`[data-tab="${name}"]`);
      await until((n) => { const p = document.getElementById(`tab-${n}`); return Boolean(p && p.classList.contains('active') && getComputedStyle(p).opacity === '1' && p.getAnimations().length === 0); }, name);
    };

    await workflow('load', async () => {
      await page.goto(server.url, { timeout: timeoutMs });
      out.connected = await until((w) => document.getElementById('status-text')?.textContent === w, CONNECTED).then(() => true, () => false);
      return out.connected ? { connected: true } : { ok: false, why: 'its socket did not connect' };
    });

    // a page that is not the companion's (no tab deck) goes no further: its other workflows would only wait out their time
    const companionPage = await page.$('[data-tab]').then((el) => el !== null, () => false);
    if (!companionPage) throw new Error('the page has no tab deck: it is not the companion\'s page');

    await workflow('every tab', async () => {
      const seen = [];
      for (const name of ['workspace', 'logs', 'proof', 'streamdown', 'canvas', 'slate3d', 'chat']) { await tab(name); seen.push(name); }
      return { tabs: seen };
    });

    await workflow('live mirror', async () => {
      // a chat turn as Timmy's TUI sends it (src/tui/hooks/useCompanionSync.ts: sync), and an event on the bus the server tails
      server.sendUpdate('sync', [
        { role: 'user', content: 'SYNTHETIC: the check sends a turn', timestamp: Date.now() },
        { role: 'assistant', content: 'SYNTHETIC answer from the check: it sealed run_probe_check_1 with sha256_00c0ffee (made up for the check).', timestamp: Date.now() },
      ]);
      appendFileSync(busFile, `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: 'probe.check-event', payload: { note: 'SYNTHETIC' } })}\n`);
      await until(() => /SYNTHETIC answer from the check/.test(document.getElementById('console-logs')?.textContent ?? '') && document.getElementById('mirror-status')?.textContent === 'Local chat mirror: LIVE');
      await tab('logs');
      await until(() => /Event bus: probe\.check-event/.test(document.getElementById('logs-list')?.textContent ?? ''));
      await tab('chat');
      return { turns: 2, event: 'probe.check-event' };
    });

    await workflow('chat sample', async () => {
      await tab('streamdown');
      await page.waitForSelector('#sd-try', { timeout: timeoutMs });
      await page.click('#sd-try');
      const streamed = await until(() => /STREAMING/.test(document.getElementById('sd-status')?.textContent ?? '') || document.querySelector('[data-card="approval"]') !== null).then(() => true, () => false);
      await page.waitForSelector('[data-card="approval"]', { timeout: timeoutMs });
      await until(() => document.getElementById('sd-status')?.textContent === 'IDLE');
      await until(() => [...document.querySelectorAll('#sd-messages [data-streamdown="code-block"]')].some((b) => b.querySelectorAll('span[style*="--sdm-c"]').length > 3));
      await page.locator('#sd-messages [data-streamdown="mermaid-block"]').last().scrollIntoViewIfNeeded();
      await until(() => document.querySelector('#sd-messages [aria-label="Mermaid chart"] svg') !== null);
      await page.locator('[data-card="receipt"] button').click();
      const copied = await until(() => /^(Copied|Not copied)/.test(document.querySelector('[data-card="receipt"] button')?.textContent ?? '')).then(() => page.evaluate(() => document.querySelector('[data-card="receipt"] button')?.textContent ?? ''), () => '');
      out.sample = await page.evaluate(() => ({
        heading: document.querySelector('#sd-messages [data-streamdown="heading-2"]')?.textContent ?? null,
        highlighted: Math.max(0, ...[...document.querySelectorAll('#sd-messages [data-streamdown="code-block"]')].map((b) => b.querySelectorAll('span[style*="--sdm-c"]').length)),
        diagram: document.querySelector('#sd-messages [aria-label="Mermaid chart"] svg') !== null,
        receipt: document.querySelector('[data-card="receipt"] .sd-card-state')?.textContent ?? null,
        approval: document.querySelector('[data-card="approval"] .sd-card-state')?.textContent ?? null,
      }));
      out.sample.streamed = streamed;
      out.sample.copy = copied;
      const ok = Boolean(out.sample.heading && out.sample.highlighted > 3 && out.sample.diagram && out.sample.receipt === 'NOT VERIFIED HERE' && out.sample.approval && /timmy verify/.test(copied));
      return ok ? out.sample : { ...out.sample, ok: false, why: 'the sample was not drawn whole' };
    });

    await workflow('chat send (FAKE upstream)', async () => {
      // R11 round 4 (H169's contract C3): the legacy POST /chat is gone and the older Streamdown view sends nothing: its Send
      // says so in words, asks nothing of the FAKE upstream (the real turn is POST /api/chat/turn under a signed-in user)
      await page.fill('#sd-input', 'SYNTHETIC: a message for the FAKE upstream');
      await page.click('#sd-send');
      await until(() => /This older view sends nothing/.test(document.querySelector('.sd-error')?.textContent ?? '') && document.getElementById('sd-status')?.textContent === 'IDLE');
      const said = await page.textContent('.sd-error');
      return { answer: 'none (the older view sends nothing; it said so)', said };
    });

    await workflow('slate 3d', async () => {
      await tab('slate3d');
      await until(() => {
        const d = document.getElementById('slate3d-frame')?.contentDocument;
        return Boolean(d && d.readyState === 'complete' && d.location.pathname.startsWith('/slate3d') && d.body);
      });
      out.slate = await page.evaluate(() => {
        const doc = document.getElementById('slate3d-frame').contentDocument;
        const body = doc.body;
        const p = body.querySelector('p') ?? body;
        const rgb = (c) => (/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c) ?? [0, 0, 0, 0]).slice(1, 4).map(Number);
        const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const [hi, lo] = [lum(getComputedStyle(p).color), lum(getComputedStyle(body).backgroundColor)].sort((a, b) => b - a);
        return { words: (p.textContent ?? '').trim().slice(0, 80), contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10 };
      });
      return out.slate.contrast >= 4.5 ? out.slate : { ...out.slate, ok: false, why: `its words at contrast ${out.slate.contrast}` };
    });

    await workflow('proof, workspace', async () => {
      await tab('proof');
      const proof = await page.evaluate(() => ({ run: document.getElementById('proof-run-id')?.textContent, hash: document.getElementById('proof-hash')?.textContent, badge: document.querySelector('#tab-proof .status-badge')?.textContent }));
      await tab('workspace');
      const workspace = await page.evaluate(() => document.querySelector('#tab-workspace .status-badge')?.textContent ?? '');
      const ok = proof.run === 'run_probe_check_1' && proof.hash === 'sha256_00c0ffee' && /NOT CHECKED HERE/.test(proof.badge ?? '') && /NOT CHECKED/.test(workspace);
      return ok ? { proof, workspace } : { proof, workspace, ok: false, why: 'Proof or Workspace said something else' };
    });

    await workflow('canvas', async () => {
      await tab('canvas');
      await until(() => /Revision \d+|No canvas jobs yet|could not be read/.test(document.getElementById('canvas-summary')?.textContent ?? ''));
      return { summary: (await page.textContent('#canvas-summary'))?.slice(0, 60) };
    });

    if (logs) {
      const lbase = `http://127.0.0.1:${logs.port}`;
      const lpage = await context.newPage();
      pages.push(lpage);
      lpage.on('pageerror', (e) => out.errors.push(String(e && e.message).split('\n')[0].slice(0, 200)));
      lpage.on('dialog', (d) => { void d.dismiss(); });
      const token = /#t=([0-9a-f]{64})$/.exec(logs.url)?.[1] ?? '';
      for (const path of ['/', '/mission', '/browser', '/chat']) {
        await workflow(`logs ${path}`, async () => {
          const csp = (await fetch(`${lbase}${path}`, { signal: AbortSignal.timeout(timeoutMs) })).headers.get('content-security-policy');
          await lpage.goto(`${lbase}${path}#t=${token}`, { timeout: timeoutMs });
          if (path === '/') await lpage.waitForFunction(() => document.getElementById('conn')?.textContent === 'live', null, { timeout: timeoutMs });
          if (path === '/mission') await lpage.waitForFunction(() => /escrow/.test(document.getElementById('escrows')?.textContent ?? ''), null, { timeout: timeoutMs });
          if (path === '/browser') await lpage.waitForFunction(() => /receipts|no receipts match/.test(document.getElementById('chainstat')?.textContent + (document.getElementById('list')?.textContent ?? '')), null, { timeout: timeoutMs });
          let drawn = null;
          if (path === '/chat') {
            await lpage.waitForFunction(() => document.querySelector('#left [data-streamdown="heading-2"]') !== null, null, { timeout: timeoutMs });
            drawn = await lpage.evaluate(() => document.querySelector('#left [data-streamdown="heading-2"]')?.textContent ?? null);
          }
          const policy = logsPolicyOk(csp, path);
          return policy ? { policy: 'strict', ...(drawn ? { drawn } : {}) } : { ok: false, why: `its policy: ${csp}` };
        });
      }
    }

    await context.close();
    out.violations = out.workflows.flatMap((w) => w.violations);
    const port = server.port;
    out.ok = out.workflows.length > 0 && out.workflows.every((w) => w.ok) && out.outside.length === 0 && out.errors.length === 0
      && strictPolicy(out.csp, port) && out.sockets.length > 0 && out.sockets.every((s) => s === `ws://127.0.0.1:${port}/`);
  } catch (e) {
    out.error = String((e && e.message) || e).split('\n')[0].slice(0, 200);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await server.shutdown().catch(() => undefined);
    if (logs) await logs.stop().catch(() => undefined);
    if (upstream) await new Promise((r) => { upstream.close(() => r()); upstream.closeAllConnections?.(); });
    try { process.chdir(saved.cwd); } catch { /* the folder it started in is gone */ }
    for (const [k, v] of [['TIMMY_REPO', saved.TIMMY_REPO], ['OPENROUTER_API_KEY', saved.OPENROUTER_API_KEY], ['OPENROUTER_MODEL', saved.OPENROUTER_MODEL]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
  return out;
}
