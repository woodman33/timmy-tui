// Round R4, review M4: the private launch page an address with a secret opens through (src/utils/launch-page.ts),
// and how the web view's plan uses it (src/repl/web.ts). Real files, real modes, a real child process for the
// exit cleanup; no browser here (tests/board-live-token.test.ts drives one).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { carriesSecret, dropLaunchPages, LAUNCH_PAGE_NAME, LAUNCH_PAGE_TTL_MS, launchPageHtml, shownAddress, writeLaunchPage, type LaunchPage } from '../src/utils/launch-page.js';
import { planWeb, WEB_VIEW_SCRIPT, type WebInputs } from '../src/repl/web.js';

const TOKEN = createHash('sha256').update('a synthetic token for this test').digest('hex');
const BOARD = `http://127.0.0.1:43123/#t=${TOKEN}`;
const dirs: string[] = [];
const pages: LaunchPage[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const write = (target: string, opts: { parent?: string; ttlMs?: number } = {}): LaunchPage => { const p = writeLaunchPage(target, { parent: temp('timmy-launch-test-'), ...opts }); pages.push(p); return p; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
afterEach(() => {
  for (const p of pages.splice(0)) p.remove();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Where the page's script sends a browser (run in node:vm with a fake location: a FAKE, not a browser). */
function sendsTo(html: string): string | null {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  let sent: string | null = null;
  runInNewContext(script, { location: { replace: (u: string) => { sent = u; } } });
  return sent;
}

describe('a launch page', () => {
  it('is a 0600 page in a new 0700 folder, sends the browser to the address, and allows only its own script', () => {
    const p = write(BOARD);
    expect(p.target).toBe(BOARD);
    expect(p.path).toBe(join(p.dir, LAUNCH_PAGE_NAME));
    expect(fileURLToPath(p.href)).toBe(p.path);
    expect(p.href).not.toContain(TOKEN.slice(0, 8));
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
    expect(statSync(p.path).mode & 0o777).toBe(0o600);
    const html = readFileSync(p.path, 'utf8');
    expect(html).toBe(launchPageHtml(BOARD));
    expect(sendsTo(html)).toBe(BOARD);
    // The policy names the one script by its hash; no address is shown on the page.
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    const hash = createHash('sha256').update(script).digest('base64');
    expect(html).toContain(`script-src 'sha256-${hash}'`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html.replace(/<script>[\s\S]*?<\/script>/, '')).not.toContain(TOKEN);
  });

  it('keeps an address that holds markup inside its script', () => {
    const odd = 'http://127.0.0.1:1/#t=x</script><script>alert(1)</script>& ';
    const html = launchPageHtml(odd);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(sendsTo(html)).toBe(odd);
  });

  it('opens only http and https addresses', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not an address']) expect(() => write(bad)).toThrow(TypeError);
  });

  it('is removed by remove(), by dropLaunchPages for its address, and after its time', async () => {
    const a = write(BOARD);
    a.remove();
    expect(existsSync(a.dir)).toBe(false);
    expect(a.removed).toBe(true);
    a.remove();
    const b = write(BOARD);
    const c = write(BOARD);
    const other = write('http://127.0.0.1:43124/#t=cd');
    expect(dropLaunchPages(BOARD)).toBe(2);
    expect([existsSync(b.dir), existsSync(c.dir), existsSync(other.dir)]).toEqual([false, false, true]);
    expect(dropLaunchPages(BOARD)).toBe(0);
    const timed = write(BOARD, { ttlMs: 60 });
    expect(existsSync(timed.path)).toBe(true);
    await sleep(250);
    expect(existsSync(timed.dir)).toBe(false);
    expect(LAUNCH_PAGE_TTL_MS).toBe(60_000);
  });

  it('is removed when the process that wrote it exits (a real child process)', () => {
    const parent = temp('timmy-launch-exit-');
    const module = resolve('src/utils/launch-page.ts');
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `const { writeLaunchPage } = await import(${JSON.stringify(module)}); const p = writeLaunchPage(${JSON.stringify(BOARD)}, { parent: ${JSON.stringify(parent)} }); console.log(p.dir);`],
    { cwd: resolve('.'), encoding: 'utf8', timeout: 60_000 }).trim();
    expect(dirname(out)).toBe(parent);
    expect(existsSync(out)).toBe(false);
  });
});

describe('which addresses carry a secret', () => {
  it('the live board\'s, a credential parameter or a user name; not a plain page or a file', () => {
    for (const s of [BOARD, 'http://127.0.0.1:8888/lab?token=abc', 'http://localhost/#access_token=x', ['http://u:p', 'localhost/'].join('@'), 'https://localhost/?api_key=1', 'http://localhost/?sessionid=2']) {
      expect(carriesSecret(s), s).toBe(true);
    }
    for (const s of ['http://127.0.0.1:4336/', 'http://localhost/#section-2', "http://localhost/#A\\';id;", 'http://localhost/?page=2&author=x', 'file:///tmp/p.html#t=1', 'not a url']) {
      expect(carriesSecret(s), s).toBe(false);
    }
  });
  it('shows such an address without its secret, and any other as it is', () => {
    expect(shownAddress(BOARD)).toBe('http://127.0.0.1:43123/#…');
    expect(shownAddress('http://127.0.0.1:8888/lab?token=abc#x')).toBe('http://127.0.0.1:8888/lab?…#…');
    expect(shownAddress(['http://u:p', 'localhost/a'].join('@'))).toBe('http://localhost/a');
    expect(shownAddress('http://127.0.0.1:4336/#section')).toBe('http://127.0.0.1:4336/#section');
  });
});

describe('the web view plan with an address that carries a secret', () => {
  const written: string[] = [];
  const launch = (url: string): LaunchPage => { written.push(url); return write(url); };
  const inputs = (over: Partial<WebInputs> = {}): WebInputs => ({ url: BOARD, has: (b) => b === 'carbonyl', env: { ZELLIJ: '0' }, allowRemote: false, launch, ...over });
  afterEach(() => { written.length = 0; });

  it('gives carbonyl the launch page in a zellij pane and a tmux popup, never the address', () => {
    for (const env of [{ ZELLIJ: '0' }, { TMUX: '/tmp/s,1,0' }]) {
      const p = planWeb(inputs({ env, secret: true }));
      expect(p.page).toBeDefined();
      // The pane's sh runs carbonyl on the page's address ("$1"), not on the board's.
      expect(p.args.slice(-5)).toEqual(['sh', '-c', WEB_VIEW_SCRIPT, 'carbonyl', p.page!.href]);
      expect(p.args).not.toContain(BOARD);
      expect(p.args.some((a) => a.includes(TOKEN.slice(0, 8)))).toBe(false);
    }
    const z = planWeb(inputs({ secret: true }));
    expect(z.args.slice(z.args.indexOf('--') + 1)).toEqual(['sh', '-c', WEB_VIEW_SCRIPT, 'carbonyl', z.page!.href]);
    expect(z.url).toBe(BOARD);
    expect(z.note).toBe('Opened in a floating zellij pane. Ctrl+C there closes it.');
  });

  it('finds a credential in the address itself, without the flag (a link pasted into /web)', () => {
    const p = planWeb(inputs({ url: 'http://127.0.0.1:8888/lab?token=abc', env: { TMUX: '/tmp/s,1,0' } }));
    expect(p.page?.target).toBe('http://127.0.0.1:8888/lab?token=abc');
    expect(p.args.at(-1)).toBe(p.page!.href);
  });

  it('writes no page for a link, a refusal or a plain address, and the link keeps the whole address', () => {
    expect(planWeb(inputs({ env: {}, secret: true }))).toEqual({ route: 'link', args: [], url: BOARD, note: `Open ${BOARD} in your browser.` });
    expect(planWeb(inputs({ has: () => false, secret: true })).route).toBe('link');
    expect(planWeb(inputs({ url: `https://example.com/#t=${TOKEN}`, secret: true })).route).toBe('refused');
    expect(planWeb(inputs({ url: 'http://127.0.0.1:4336/' })).page).toBeUndefined();
    expect(written).toEqual([]);
  });

  it('gives the link, and says why, when the page cannot be written: never the address on a command line', () => {
    const p = planWeb(inputs({ secret: true, launch: () => { throw new Error('EACCES: permission denied'); } }));
    expect(p.route).toBe('link');
    expect(p.command).toBeUndefined();
    expect(p.args).toEqual([]);
    expect(p.why).toBe('the private page that keeps its secret off command lines could not be written (EACCES: permission denied)');
  });
});
