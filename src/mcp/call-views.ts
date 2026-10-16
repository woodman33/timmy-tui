/**
 * R6 (H142): the light parts of the Tools & MCP inspector that every surface reads (the companion's tab 9 through
 * src/mcp/inspector.ts, the terminal Workbench's tab 9 through src/workbench/tools-tab.ts): Timmy's FAKE fixture as a
 * command line, the note a call made from the companion carries in its record, and a call's wire trace (wire.ndjson,
 * src/mcp/wire-tap.ts) read into its requests' spans. No schema validator and no MCP server code are loaded here.
 */
import { isAbsolute } from 'node:path';
import { ownScript } from './own-scripts.js';

/** The FAKE fixture server's name (src/mcp/fake-fixture-server.ts). */
export const FAKE_FIXTURE_NAME = 'timmy-fake-fixture';

/** The note a call made from the companion carries in its record (call.json notes). */
export const FROM_PAGE = 'made from the browser companion (tab 9, Tools & MCP)';

export type FixtureInfo = { ok: true; label: string; command: string[]; built: boolean; file: string } | { ok: false; label: string; why: string };

/**
 * Timmy's FAKE stdio server, as a command line both routes can run (src/mcp/fake-fixture-server.ts). A test that must see
 * which tools reached it names a file in TIMMY_FAKE_MCP_CALL_LOG (an absolute path) in the environment given: the command
 * line then carries it (`--call-log <file>`), since the routes hand a server a small base environment only.
 */
export function fixtureServer(env: Record<string, string | undefined> = {}): FixtureInfo {
  const s = ownScript('fake-fixture-server');
  const label = `FAKE · ${FAKE_FIXTURE_NAME} (Timmy's own test server: its tools and answers are made up)`;
  const log = env.TIMMY_FAKE_MCP_CALL_LOG?.trim();
  const extra = log && isAbsolute(log) ? ['--call-log', log] : [];
  return s.ok ? { ok: true, label, command: [...s.argv, ...extra], built: s.built, file: s.file } : { ok: false, label, why: s.why };
}

/** A call record's server name for the fixture, as the routes' serverLabel gives it ("node fake-fixture-server.js"). */
export const isFixtureLabel = (server: string): boolean => /^node fake-fixture-server\.(js|ts)$/.test(server);

export interface WireSpan { session: number; method: string; id: string | number; start: number; end: number | null; ms: number | null; error: boolean; bytesOut: number; bytesIn: number }
export interface WireView {
  /** the timeline's start and end (epoch ms): the call's own, widened to every frame */
  t0: number;
  t1: number;
  sessions: Array<{ session: number; start: number; end: number | null; exit?: { code: number | null; signal: string | null } }>;
  spans: WireSpan[];
  notifications: Array<{ session: number; method: string; t: number }>;
  /** the tools/call request and its answer, exactly as they passed (the last session's) */
  request?: string;
  response?: string;
  frames: number;
  dropped: number;
}

export interface TapLine { session?: number; seq?: number; t?: number; dir?: string; bytes?: number; kind?: string; id?: string | number; method?: string; line?: string; exit?: { code: number | null; signal: string | null }; dropped?: number }

/** A wire trace read into its sessions, its requests' spans (each from its line to the line that answers it) and its notifications. */
export function wireView(text: string, t0: number, t1: number): WireView {
  const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as TapLine; } catch { return null; } }).filter((l): l is TapLine => !!l && typeof l.t === 'number' && typeof l.session === 'number');
  const sessions = new Map<number, WireView['sessions'][number]>();
  const spans: WireSpan[] = [];
  const open = new Map<string, WireSpan>();
  const notifications: WireView['notifications'] = [];
  let request: string | undefined;
  let response: string | undefined;
  let frames = 0;
  let dropped = 0;
  for (const l of lines) {
    const s = l.session!;
    if (l.kind === 'start') { sessions.set(s, { session: s, start: l.t!, end: null }); continue; }
    if (l.kind === 'end') { const x = sessions.get(s) ?? { session: s, start: l.t!, end: null }; x.end = l.t!; if (l.exit) x.exit = l.exit; sessions.set(s, x); dropped += l.dropped ?? 0; continue; }
    frames += 1;
    if (!sessions.has(s)) sessions.set(s, { session: s, start: l.t!, end: null });
    const key = `${s}:${l.dir === 'to-server' ? 'c' : 's'}:${String(l.id)}`;
    if (l.kind === 'request' && l.id !== undefined && l.method) {
      const span: WireSpan = { session: s, method: l.method, id: l.id, start: l.t!, end: null, ms: null, error: false, bytesOut: l.bytes ?? 0, bytesIn: 0 };
      spans.push(span);
      open.set(key, span);
      if (l.method === 'tools/call' && l.dir === 'to-server' && l.line) request = l.line;
    } else if ((l.kind === 'result' || l.kind === 'error') && l.id !== undefined) {
      // an answer comes the other way from its request
      const back = `${s}:${l.dir === 'to-client' ? 'c' : 's'}:${String(l.id)}`;
      const span = open.get(back);
      if (span) { span.end = l.t!; span.ms = Math.round((l.t! - span.start) * 1000) / 1000; span.error = l.kind === 'error'; span.bytesIn = l.bytes ?? 0; open.delete(back); }
      if (l.method === 'tools/call' && l.dir === 'to-client' && l.line) response = l.line;
    } else if (l.kind === 'notification' && l.method) notifications.push({ session: s, method: l.method, t: l.t! });
  }
  const times = lines.map((l) => l.t!);
  const lo = Math.min(t0, ...times);
  const hi = Math.max(t1, ...times);
  return { t0: lo, t1: hi, sessions: [...sessions.values()], spans, notifications, ...(request ? { request } : {}), ...(response ? { response } : {}), frames, dropped };
}
