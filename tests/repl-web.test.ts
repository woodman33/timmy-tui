import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planWeb, receiptUrl, resolveWebTarget, type WebInputs } from '../src/repl/web.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { glyphSet } from '../src/term/glyphs.js';

// Web views (plan C-13): /web opens a page in carbonyl as a zellij floating pane or a tmux popup;
// pages must be on this machine unless explicitly allowed; with nowhere to draw it, a link.
const inputs = (over: Partial<WebInputs> & { bins?: string[] } = {}): WebInputs => ({
  url: 'http://127.0.0.1:4336/',
  has: (bin) => (over.bins ?? ['carbonyl']).includes(bin),
  env: { ZELLIJ: '0' },
  allowRemote: false,
  ...over,
});

describe('web view targets', () => {
  it('knows the Mission Map by name and keeps local addresses as they are', () => {
    expect(resolveWebTarget('map')).toBe('http://127.0.0.1:4336/');
    // C-13: a receipt's short hash (as its line shows it) opens its page on Timmy's own server.
    expect(resolveWebTarget('020b6885')).toBe('http://127.0.0.1:4337/receipts/020b6885');
    expect(receiptUrl('020b6885')).toBe('http://127.0.0.1:4337/receipts/020b6885');
    expect(resolveWebTarget('localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(resolveWebTarget('http://[::1]:8080/')).toBe('http://[::1]:8080/');
    expect(resolveWebTarget('/tmp/p.html')).toBe('file:///tmp/p.html');
    expect(resolveWebTarget('./p.html')).toBe(pathToFileURL(resolve('p.html')).href);
    expect(resolveWebTarget('~/p.html')).toBe(pathToFileURL(join(homedir(), 'p.html')).href);
  });
});

describe('web view routes', () => {
  it('opens carbonyl as a floating zellij pane inside zellij', () => {
    const p = planWeb(inputs());
    expect(p.route).toBe('zellij');
    // As big as the tmux popup (90% by 85%), centred, so a page is readable.
    expect([p.command, ...p.args]).toEqual(['zellij', 'run', '--floating', '--close-on-exit', '--name', 'Web', '--width', '90%', '--height', '85%', '--x', '5%', '--y', '8%', '--', 'carbonyl', 'http://127.0.0.1:4336/']);
  });
  it('opens carbonyl in a tmux popup inside tmux', () => {
    const p = planWeb(inputs({ env: { TMUX: '/tmp/s,1,0' } }));
    expect(p.route).toBe('tmux');
    // carbonyl and the page are separate arguments: tmux runs them with no shell in between.
    expect([p.command, ...p.args]).toEqual(['tmux', 'display-popup', '-E', '-w', '90%', '-h', '85%', '-T', ' Web ', 'carbonyl', 'http://127.0.0.1:4336/']);
    expect(planWeb(inputs({ env: { TMUX: '/tmp/s,1,0' }, url: "http://localhost/#A\\';id;" })).args.at(-1)).toBe("http://localhost/#A\\';id\\;");
  });
  it('gives a link when there is no carbonyl or no multiplexer to draw it in', () => {
    expect(planWeb(inputs({ bins: [] })).route).toBe('link');
    expect(planWeb(inputs({ env: {} })).route).toBe('link');
  });
  it('refuses a page that is not on this machine unless it is allowed', () => {
    const refused = planWeb(inputs({ url: 'https://example.com/' }));
    expect(refused.route).toBe('refused');
    expect(refused.note).toBe('Refused: example.com is not on this machine. Use /web --allow-remote <url> to open it anyway.');
    expect(planWeb(inputs({ url: 'https://example.com/', allowRemote: true })).route).toBe('zellij');
    expect(planWeb(inputs({ url: 'http://127.0.0.1.evil.example/' })).route).toBe('refused');
    // Userinfo trick (the host is after the @). Joined at run time so the source holds no address-like text.
    expect(planWeb(inputs({ url: ['http://127.0.0.1', 'evil.example/'].join('@') })).route).toBe('refused');
    expect(planWeb(inputs({ url: 'file://evil.example/share/page.html' })).route).toBe('refused');
    expect(planWeb(inputs({ url: 'file:///tmp/page.html' })).route).toBe('zellij');
    expect(planWeb(inputs({ url: 'http://127.0.0.2:8000/' })).route).toBe('zellij');
    for (const url of ['javascript://localhost/%0aalert(1)', 'chrome://localhost/', 'ftp://127.0.0.1/']) {
      expect(planWeb(inputs({ url })).route).toBe('refused');
    }
    expect(planWeb(inputs({ url: 'chrome://localhost/' })).note).toBe('Refused: only http, https and file pages open here.');
  });
});

describe('/web in the REPL', () => {
  const ctx = (opened: string[]): ReplContext => ({
    agent: { getModel: () => 'm', setModel: () => {}, startSession: () => 's' },
    print: (segments) => opened.push(segments.map((s) => s.text).join('')),
    glyphs: glyphSet(false),
    openWeb: (target, allow) => { opened.push(`open:${target}:${allow}`); return 'Opened in a floating zellij pane.'; },
  });
  it('opens the target it is given and says where', () => {
    const out: string[] = [];
    runSlash('/web map', ctx(out));
    expect(out).toEqual(['open:map:false', '  Opened in a floating zellij pane.']);
  });
  it('passes --allow-remote through, and shows usage with no target', () => {
    const out: string[] = [];
    runSlash('/web --allow-remote https://example.com/', ctx(out));
    expect(out[0]).toBe('open:https://example.com/:true');
    const none: string[] = [];
    runSlash('/web', ctx(none));
    // C-13: a receipt's short hash opens its page; within 60 columns.
    expect(none).toEqual(['  Usage: /web map | studio | <receipt> | <local url>', '         /web --allow-remote <url> for any other page']);
    const spaced: string[] = [];
    runSlash('/web file:///tmp/my page.html', ctx(spaced));
    expect(spaced[0]).toBe('open:file:///tmp/my page.html:false');
  });
});
