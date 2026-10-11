// The browser companion's page in a real browser (round R4, H92). The packed-install check runs it against the installed
// package (scripts/packed-install-check.mjs, step 6: its own server module and its own playwright); tests/companion-page-probe
// .test.ts runs it against this checkout, and against a FAKE page that asks other sites, which it must fail.
//
// It starts the companion with the module it is given (port 0, a token made there; /chat's upstream a closed port of
// 127.0.0.1, so no model is asked), reads the page's Content-Security-Policy, and opens the address the server gives (the
// token in its fragment) in a headless Chromium or Chrome whose name resolver answers 127.0.0.1 only. Every request of every
// frame is counted; one to another origin is recorded and aborted before it leaves. It waits for the page's socket to
// connect, draws the model chat's sample (the page's own text: nothing is sent), opens Slate 3D's tab, and collects the
// violations of the policy each frame reported and the page's errors. It imports nothing: what it drives is given to it.
//
//   probeCompanionPage({ startCompanionServer, chromium, executablePath?, timeoutMs? }) -> result (never throws)
//
// result.ok: the page connected, made no request elsewhere, reported no violation and no error, drew the sample (a heading,
// a list, a code block with its Copy button, a mermaid block as its source), and its policy allows scripts from itself only.

const CONNECTED = 'COMPANION SOCKET · CONNECTED';

/** Whether a policy is the strict one the page is served with (src/companion/page.ts pagePolicy). */
export function strictPolicy(csp, port) {
  const d = new Map(String(csp ?? '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...v] = x.split(/\s+/); return [k, v.join(' ')]; }));
  return d.get('default-src') === "'none'" && d.get('script-src') === "'self'" && d.get('style-src') === "'self'"
    && d.get('object-src') === "'none'" && d.get('frame-ancestors') === "'none'" && d.get('base-uri') === "'none'"
    && d.get('connect-src') === `'self' ws://127.0.0.1:${port}` && !/unsafe-inline|unsafe-eval|\*|https?:/.test(String(csp));
}

export async function probeCompanionPage({ startCompanionServer, chromium, executablePath, timeoutMs = 30_000 }) {
  const out = { ok: false, base: null, csp: null, requests: 0, own: 0, outside: [], sockets: [], violations: [], errors: [], connected: false, sample: null, slate: null, error: null };
  let server;
  let browser;
  try {
    server = await startCompanionServer(0, { upstream: 'http://127.0.0.1:9/' });
    const base = `http://127.0.0.1:${server.port}`;
    out.base = base;
    out.csp = (await fetch(`${base}/`, { signal: AbortSignal.timeout(timeoutMs) })).headers.get('content-security-policy');
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    context.on('request', (r) => {
      out.requests += 1;
      try { if (new URL(r.url()).origin === base) out.own += 1; } catch { /* not a URL */ }
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === base) return route.continue();
      out.outside.push(url.origin);
      return route.abort('blockedbyclient');
    });
    await context.addInitScript(() => {
      window.__timmyViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => { window.__timmyViolations.push(`${e.effectiveDirective} ${e.blockedURI}`); });
    });
    const page = await context.newPage();
    page.on('websocket', (ws) => out.sockets.push(ws.url()));
    page.on('pageerror', (e) => out.errors.push(String(e && e.message).split('\n')[0].slice(0, 200)));
    page.on('dialog', (d) => { void d.dismiss(); });
    await page.goto(server.url, { timeout: timeoutMs });
    out.connected = await page.waitForFunction((w) => document.getElementById('status-text')?.textContent === w, CONNECTED, { timeout: timeoutMs }).then(() => true, () => false);
    // the model chat's sample: the page's own text, drawn as an answer would be (nothing is sent)
    if (await page.locator('[data-tab="model"]').count()) {
      await page.click('[data-tab="model"]');
      await page.click('#model-sample');
      const drawn = await page.waitForFunction(() => document.getElementById('model-status')?.textContent === 'IDLE' && document.querySelector('#model-messages .md-diagram') !== null, null, { timeout: timeoutMs }).then(() => true, () => false);
      if (drawn) {
        out.sample = await page.evaluate(() => {
          const md = [...document.querySelectorAll('#model-messages .md')].pop();
          return {
            heading: md?.querySelector('h1, h2, h3')?.textContent ?? null,
            items: md ? md.querySelectorAll('li').length : 0,
            code: md?.querySelector('.md-code pre code')?.textContent?.split('\n')[0] ?? null,
            copy: md?.querySelector('.md-code .md-copy')?.textContent ?? null,
            diagram: md?.querySelector('.md-diagram .md-diagram-note')?.textContent ?? null,
          };
        });
      }
    }
    // Slate 3D's tab: its scene where it is built, else its words (their contrast on the frame, WCAG's ratio)
    if (await page.locator('[data-tab="slate3d"]').count()) {
      await page.click('[data-tab="slate3d"]');
      // its own document, loaded (the frame's first document, about:blank, is complete before Slate 3D's arrives)
      const loaded = await page.waitForFunction(() => {
        const d = document.getElementById('slate3d-frame')?.contentDocument;
        return Boolean(d && d.readyState === 'complete' && d.location.pathname.startsWith('/slate3d') && d.body);
      }, null, { timeout: timeoutMs }).then(() => true, () => false);
      if (loaded) {
        out.slate = await page.evaluate(() => {
          const doc = document.getElementById('slate3d-frame').contentDocument;
          const body = doc.body;
          const p = body.querySelector('p') ?? body;
          const rgb = (c) => (/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c) ?? [0, 0, 0, 0]).slice(1, 4).map(Number);
          const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
          const [hi, lo] = [lum(getComputedStyle(p).color), lum(getComputedStyle(body).backgroundColor)].sort((a, b) => b - a);
          return { words: (p.textContent ?? '').trim().slice(0, 80), contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10 };
        });
      }
    }
    await page.waitForTimeout(500);
    for (const f of page.frames()) {
      try { out.violations.push(...await f.evaluate(() => window.__timmyViolations ?? [])); } catch { /* a frame gone */ }
    }
    await context.close();
    const port = server.port;
    out.ok = out.connected && out.outside.length === 0 && out.violations.length === 0 && out.errors.length === 0
      && strictPolicy(out.csp, port) && out.sockets.every((s) => s === `ws://127.0.0.1:${port}/`)
      && Boolean(out.sample && out.sample.heading && out.sample.items > 0 && out.sample.code && out.sample.copy === 'Copy' && out.sample.diagram)
      && (out.slate === null || out.slate.contrast >= 4.5);
  } catch (e) {
    out.error = String((e && e.message) || e).split('\n')[0].slice(0, 200);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await server.shutdown().catch(() => undefined);
  }
  return out;
}
