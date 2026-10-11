/**
 * Round R4 (helper H93): God's Eye View, slice 2: the operator's computers (Timmy Connect), hosting (Timmy Cloud's backend,
 * as its client last read it), provider costs beside model spend, the new things that need a person, and the dependencies
 * they make (a remote job on its device; an order's step on a decision).
 *
 * Every word comes from the records' own readers: Connect's words (src/connect/words.ts, through readConnect) and the
 * backend's (services/cloud/views.ts, as the client kept them). What this module adds is where each record is, the commands
 * that open or settle it, and what the times mean:
 * - a probe's time is when it was true: a computer "answered its last probe" at a time, never "online now";
 * - a remote job is running only as its status file said when it was read (Connect's own state), with that time;
 * - the backend's answer is a cached file with its age: older than an hour is said to be old, with the command that reads it
 *   again; the overview builds synchronously and never calls the network;
 * - each order shows its eight steps, each with its own state; "simulated" is said on every item of a simulated provider;
 * - a provider cost is a number the backend reported, an order of unknown cost is counted and never summed as 0.
 * Times that change as the clock moves ("12 min ago") are only in `ago` fields, which the live board leaves out of its shape.
 * Nothing here contacts a computer or the backend, runs, writes or seals anything.
 */
import { limitsWords, money, orderName, parseOrders, parseOverview, routeIn, STEP_LABEL, type BackendNeed, type BackendOrder } from '../cloud/answer.js';
import { SETUP_COMMAND } from '../cloud/commands.js';
import type { ConnectDeviceView, ConnectJobView } from '../connect/read.js';
import {
  ITEMS_MAX, SECTION_TITLE,
  type CostsSection, type DeviceItem, type DevicesSection, type HistorySection, type HostingItem, type HostingSection, type MapNode,
  type NeedsItem, type OverviewMap, type OverviewNeedKind, type OverviewSectionId, type OverviewSource, type ProviderSpend, type RemoteJobItem,
  type SectionBase, type Tone,
} from './model.js';
import type { DeviceExtra, Sources } from './sources.js';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const HOUR_MS = 3_600_000;

/** A section's shared fields, `state` read unless said (as src/overview/sections.ts base, which imports this module). */
function base<T extends OverviewSectionId>(id: T, s: Pick<Sources, 'asOf'>): SectionBase & { id: T } {
  return { id, title: SECTION_TITLE[id], as_of: s.asOf, state: 'read', summary: '', counts: [], unreadable: [], notes: [] };
}

/** An id as a board element's id (letters, digits, _ and - only). */
export const boardId = (prefix: string, id: string): string => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;

/** "2026-10-11 09:24 UTC" from an ISO time; "an unknown time" otherwise. */
export function stampOf(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
}

/** A time as the first screen shows it: "18:34 UTC" on the day of `now` (UTC), else the whole stamp. */
export function shortStamp(now: number, iso: string | null | undefined): string {
  const full = stampOf(iso);
  return full.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? full.slice(11) : full;
}

/** How long before `now` a time was, in words ("45 s ago", "12 min ago", "3 h ago", "2 days ago"). */
export function agoWords(now: number, iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return 'at an unknown time';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'after this computer\'s clock (the clocks differ)';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 2 * 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} days ago`;
}

// ── devices ──────────────────────────────────────────────────────────────────

const SCOPE = 'This computer\'s Timmy home, not the project: the computers and remote jobs of connect/devices.json and jobs/r*.json there, the same for every project of this Timmy home.';
const OS_WORD: Readonly<Record<string, string>> = { macos: 'macOS', linux: 'Linux', windows: 'Windows', unknown: 'an unknown system' };
const SHELL_WORD: Readonly<Record<string, string>> = { posix: 'POSIX sh', powershell: 'PowerShell', cmd: 'cmd.exe (PowerShell sent encoded)', unknown: 'not known' };
const DEVICE_HOME = 'connect/devices.json';

/** Whether a device's address, as its record names it, is a tailnet's: a MagicDNS name (*.ts.net), or in Tailscale's ranges. */
export function tailnetOf(address: string): 'name' | 'address' | null {
  const a = address.toLowerCase();
  if (/\.ts\.net\.?$/.test(a)) return 'name';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127) return 'address';
  if (/^fd7a:115c:a1e0:/.test(a)) return 'address';
  return null;
}

/** What waits on a person for one device or job, each kind once (a changed key covers a probe it refused); `home`: its record. */
interface Attention { kind: OverviewNeedKind; title: string; needed: string; why: string; commands: string[]; home: string; detail: string; since?: string; ago?: string }

function deviceAttention(d: ConnectDeviceView, x: DeviceExtra | undefined, now: number, scrub: (t: string) => string): Attention[] {
  const out: Attention[] = [];
  const needWords = (re: RegExp): string | undefined => d.needs.find((n) => re.test(n));
  if (d.host_key_refused) {
    out.push({
      kind: 'host-key-changed', title: `${d.id}'s host key changed (${stampOf(d.host_key_refused.at)}): Timmy refuses it`,
      needed: 'check the computer itself; if its key was changed on purpose, fetch its keys again and confirm the new fingerprint',
      why: scrub(needWords(/host key changed/) ?? x?.refused_words ?? 'its host key differs from the confirmed one'),
      commands: [`/connect scan ${d.id}`, `/connect trust ${d.id}`], home: DEVICE_HOME, detail: boardId('ov-dev', d.id), since: d.host_key_refused.at, ago: agoWords(now, d.host_key_refused.at),
    });
  } else if (!d.host_key) {
    const fetched = x ? Boolean(x.scan?.keys.length) : Boolean(needWords(/^a host key to confirm/));
    out.push(fetched
      ? {
        kind: 'host-key', title: `${d.id}: a host key fetched${x?.scan ? ` ${stampOf(x.scan.at)}` : ''}, not confirmed`,
        needed: 'check its fingerprint on the computer itself (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub), then confirm it',
        why: scrub(needWords(/^a host key to confirm/) ?? 'a host key was fetched and waits for a person'), commands: [`/connect trust ${d.id}`], home: DEVICE_HOME, detail: boardId('ov-dev', d.id),
        ...(x?.scan ? { since: x.scan.at, ago: agoWords(now, x.scan.at) } : {}),
      }
      : { kind: 'host-key', title: `${d.id}: no host key fetched yet`, needed: 'fetch its host keys, then confirm one', why: scrub(needWords(/^no host key fetched/) ?? 'no host key was fetched for it'), commands: [`/connect scan ${d.id}`], home: DEVICE_HOME, detail: boardId('ov-dev', d.id) });
  }
  const p = d.probe;
  // a probe refused for a key already said above is not said twice
  if (p && p.outcome !== 'connected' && !(p.outcome === 'host-key-changed' && d.host_key_refused) && !(p.outcome === 'host-key-unconfirmed' && !d.host_key)) {
    out.push({
      kind: 'device-unreachable', title: `${d.id} did not connect at its last probe (${stampOf(p.at)}): ${p.outcome}${x?.probe_why ? `, ${x.probe_why}` : ''}`,
      needed: p.outcome === 'auth-refused' ? 'add Timmy\'s public key to its authorized_keys (docs/ui-cockpit/TIMMY-CONNECT.md), then probe it again' : 'check that the computer is on and can be reached, then probe it again',
      why: scrub(p.words), commands: [`/connect probe ${d.id}`], home: DEVICE_HOME, detail: boardId('ov-dev', d.id), since: p.at, ago: agoWords(now, p.at),
    });
  }
  return out;
}

function jobAttention(j: ConnectJobView, now: number, scrub: (t: string) => string): Attention | undefined {
  const home = `jobs/${j.id}.json`;
  const detail = boardId('ov-job', j.id);
  if (j.state === 'unknown') {
    return { kind: 'remote-job', title: `remote job ${j.id} on ${j.device}: unknown`, needed: 'read its status on the computer again; nothing is started twice', why: scrub(j.words), commands: [`/connect status ${j.id}`], home, detail, ...(j.last_seen ? { since: j.last_seen, ago: agoWords(now, j.last_seen) } : {}) };
  }
  if (j.state === 'stop asked') {
    return { kind: 'remote-job', title: `remote job ${j.id} on ${j.device}: stop asked (${stampOf(j.stop?.asked_at)}), not confirmed`, needed: 'read its status: it says whether the stop reached the computer', why: scrub(j.words), commands: [`/connect status ${j.id}`, `/connect stop ${j.id}`], home, detail, ...(j.stop ? { since: j.stop.asked_at, ago: agoWords(now, j.stop.asked_at) } : {}) };
  }
  return undefined;
}

const JOB_ORDER: Readonly<Record<string, number>> = { unknown: 0, 'stop asked': 1, running: 2, submitted: 3, ended: 4, stopped: 5 };

function jobItem(j: ConnectJobView, known: boolean, scrub: (t: string) => string): RemoteJobItem {
  const live = j.state === 'running' || j.state === 'unknown' || j.state === 'stop asked' || j.state === 'submitted';
  return {
    id: j.id, device: j.device, device_known: known, label: scrub(j.label), state: j.state, words: scrub(j.words),
    read_at: j.remote?.read_at ?? null, submitted_at: j.submitted_at, last_seen: j.last_seen, stop: j.stop, fetched: j.fetched,
    commands: live ? [`/connect status ${j.id}`, `/connect stop ${j.id}`] : [`/connect status ${j.id}`, `/connect fetch ${j.id} out.log`],
    source: { record: null, home: `jobs/${j.id}.json`, command: `/connect status ${j.id}`, board: 'ov-devices', detail: boardId('ov-job', j.id) },
  };
}

function deviceItem(d: ConnectDeviceView, x: DeviceExtra | undefined, jobs: readonly ConnectJobView[], now: number, scrub: (t: string) => string): DeviceItem {
  const tailnet = tailnetOf(d.address);
  const reach = {
    address: d.address, port: d.port, user: d.user, tailnet,
    words: `${d.user}@${d.address}:${d.port} over SSH${tailnet === 'name' ? '; a tailnet name (*.ts.net), as its record\'s address says (Tailscale was not asked)' : tailnet === 'address' ? '; a tailnet address (in the range Tailscale gives, which carrier-grade NAT also uses), as its record\'s address says (Tailscale was not asked)' : ''}${d.ssh_config === 'account' ? '; ssh uses your own ssh config (~/.ssh/config)' : ''}`,
  };
  const p = d.probe;
  const probe = p ? {
    at: p.at, outcome: p.outcome, answered: p.outcome === 'connected', ago: agoWords(now, p.at), words: scrub(p.words),
    line: p.outcome === 'connected' ? `answered its last probe, ${stampOf(p.at)} (when it was true, not now)` : `did not connect at its last probe, ${stampOf(p.at)}: ${p.outcome}${x?.probe_why ? `, ${x.probe_why}` : ''}`,
  } : null;
  const f = p?.outcome === 'connected' ? x?.facts : undefined;
  const os = OS_WORD[d.os] ?? d.os;
  const known = d.os !== 'unknown' || d.shell !== 'unknown';
  // its facts beyond the view come from the same record only when its probe is the one shown (readConnectFor)
  const missing = f ? '' : p?.outcome === 'connected'
    ? '; its probe\'s other facts were not read this time (its record changed while it was read)'
    : '; as its last probe that connected found it (the newest did not connect, so its architecture is not known now)';
  const system = {
    os: d.os, ...(f?.os_version ? { os_version: scrub(f.os_version) } : {}), ...(f?.arch ? { arch: scrub(f.arch) } : {}), shell: d.shell, ...(f?.login_shell ? { login_shell: scrub(f.login_shell) } : {}),
    words: !known && !f ? `not known: ${p ? 'no probe has connected yet' : 'not probed yet'}`
      : `${os}${f?.os_version ? ` ${scrub(f.os_version)}` : ''}${f?.arch ? ` ${scrub(f.arch)}` : ''}, shell ${SHELL_WORD[d.shell] ?? d.shell}${f?.login_shell ? ` (login shell ${scrub(f.login_shell)})` : ''}${missing}`,
  };
  const found = p?.outcome === 'connected' ? [...(p.found_on_path ?? [])] : [];
  const found_words = p?.outcome === 'connected'
    ? (found.length ? `found on PATH: ${found.join(', ')} (found on PATH only: not proven supported or working)` : 'none of Timmy\'s list was found on PATH (not found on PATH never means not installed)')
    : `not known: ${p ? 'its last probe did not connect' : 'not probed yet'}`;
  const host_key: DeviceItem['host_key'] = d.host_key_refused
    ? { state: 'changed', words: `changed: Timmy refuses the key it offered (${stampOf(d.host_key_refused.at)}${d.host_key_refused.offered ? `: ${d.host_key_refused.offered}` : ''})${d.host_key ? `; the confirmed one is ${d.host_key.type} ${d.host_key.fingerprint}` : ''}` }
    : d.host_key ? { state: 'confirmed', words: `${d.host_key.type} ${d.host_key.fingerprint}, confirmed ${stampOf(d.host_key.confirmed_at)}` }
      : (x ? x.scan?.keys.length : d.needs.some((n) => /^a host key to confirm/.test(n)))
        ? { state: 'fetched, not confirmed', words: `fetched${x?.scan ? ` ${stampOf(x.scan.at)}` : ''}, not confirmed: ${x?.scan ? x.scan.keys.map((k) => `${k.type} ${k.fingerprint}`).join(', ') : 'its fingerprints are in Timmy Connect\'s words'}` }
        : { state: 'none fetched', words: 'none fetched yet' };
  const byState: Record<string, number> = {};
  for (const j of jobs) byState[j.state] = (byState[j.state] ?? 0) + 1;
  const commands = [`/connect probe ${d.id}`, ...(d.host_key_refused || !d.host_key ? [`/connect scan ${d.id}`, `/connect trust ${d.id}`] : []), '/connect devices'];
  return {
    id: d.id, name: scrub(d.name), reach, probe, system, found_on_path: found, found_words, host_key, needs: d.needs.map(scrub), words: scrub(d.words), jobs: byState, commands,
    source: { record: null, home: DEVICE_HOME, command: `/connect probe ${d.id}`, board: 'ov-devices', detail: boardId('ov-dev', d.id) },
  };
}

export function devicesSection(s: Sources): DevicesSection {
  const out: DevicesSection = { ...base('devices', s), scope: SCOPE, items: [], more: 0, jobs: [], jobs_more: 0 };
  if (!s.connect.ok) return { ...out, state: 'unknown', summary: 'not known', why: `Timmy Connect's records could not be read: ${s.connect.error}`, notes: [SCOPE] };
  const { view, extra } = s.connect.value;
  const unreadable = view.unreadable.map((u) => ({ record: u.record, why: s.scrub(u.why) }));
  const devicesUnread = unreadable.find((u) => u.record === DEVICE_HOME);
  const ids = new Set(view.devices.map((d) => d.id));
  const jobs = [...view.jobs].sort((a, b) => (JOB_ORDER[a.state] ?? 9) - (JOB_ORDER[b.state] ?? 9));
  const items = view.devices.map((d) => deviceItem(d, extra.get(d.id), view.jobs.filter((j) => j.device === d.id), s.now, s.scrub));
  // those that need a person first, then those that answered, in the records' order
  const weight = (i: DeviceItem): number => (i.host_key.state === 'changed' ? 0 : i.probe && !i.probe.answered ? 1 : i.host_key.state !== 'confirmed' ? 2 : 3);
  items.sort((a, b) => weight(a) - weight(b));
  const jobItems = jobs.map((j) => jobItem(j, ids.has(j.device), s.scrub));
  const answered = items.filter((i) => i.probe?.answered).length;
  const notAnswered = items.filter((i) => i.probe && !i.probe.answered).length;
  const notProbed = items.filter((i) => !i.probe).length;
  const keys = items.filter((i) => i.host_key.state !== 'confirmed').length;
  const by = (st: string): number => jobs.filter((j) => j.state === st).length;
  // the most urgent: a changed key, a computer that did not connect, a job unknown or its stop unconfirmed, a key to confirm
  const attention = view.devices.flatMap((d) => deviceAttention(d, extra.get(d.id), s.now, s.scrub)).concat(jobs.flatMap((j) => { const a = jobAttention(j, s.now, s.scrub); return a ? [a] : []; }));
  const rank = (a: Attention): number => NEED_RANK[a.kind] ?? 9;
  const first = [...attention].sort((a, b) => rank(a) - rank(b))[0];
  const running = jobItems.find((j) => j.state === 'running');
  const urgent = first
    ? { text: first.title, tone: (first.kind === 'host-key-changed' ? 'failed' : 'attention') as Tone, source: { record: null, home: first.home, command: first.commands[0], board: 'ov-devices' as const, detail: first.detail }, ...(first.ago ? { ago: first.ago } : {}) }
    : running ? { text: `remote job ${running.id} on ${running.device}: ${running.words}`, tone: 'running' as Tone, source: running.source } : undefined;
  const state: DevicesSection['state'] = devicesUnread ? (items.length || jobItems.length ? 'partial' : 'unknown') : unreadable.length ? 'partial' : 'read';
  return {
    ...out, state, ...(state !== 'read' ? { why: unreadable.map((u) => `${u.record}: ${u.why}`).join('; ') } : {}),
    items: items.slice(0, ITEMS_MAX), more: Math.max(0, items.length - ITEMS_MAX),
    jobs: jobItems.slice(0, ITEMS_MAX), jobs_more: Math.max(0, jobItems.length - ITEMS_MAX),
    // short enough for the first screen's 80 columns; the counts below say each part in full
    summary: devicesUnread && !items.length ? 'not known'
      : items.length || jobItems.length
        ? `${plural(items.length, 'computer')}, ${answered} answered ${answered === 1 ? 'its' : 'their'} last probe; ${jobItems.length ? `${plural(jobItems.length, 'job')}, ${by('running')} running as read` : 'no remote jobs'}`
        : 'no computers yet (/connect add)',
    counts: [
      { n: items.length, of: items.length === 1 ? 'computer of this computer\'s Timmy home' : 'computers of this computer\'s Timmy home' },
      ...(answered ? [{ n: answered, of: answered === 1 ? 'answered its last probe (at its time, not now)' : 'answered their last probe (at its time, not now)' }] : []),
      ...(notAnswered ? [{ n: notAnswered, of: notAnswered === 1 ? 'did not connect at its last probe' : 'did not connect at their last probe' }] : []),
      ...(notProbed ? [{ n: notProbed, of: 'not probed yet' }] : []),
      ...(keys ? [{ n: keys, of: keys === 1 ? 'host key not confirmed or changed' : 'host keys not confirmed or changed' }] : []),
      { n: jobItems.length, of: jobItems.length === 1 ? 'remote job' : 'remote jobs' },
      ...(['running', 'unknown', 'stop asked', 'submitted', 'ended', 'stopped'] as const).filter((st) => by(st)).map((st) => ({ n: by(st), of: st === 'running' ? 'running as its status file said when read' : st === 'stop asked' ? 'stop asked, not confirmed' : st })),
    ],
    ...(urgent ? { urgent } : {}), unreadable,
    notes: [
      SCOPE,
      'A probe\'s time is when it was true, not now. Found on PATH is all that is said of a program, not that it is supported or works. A remote job is running only as its status file said when it was read.',
      'Probing, reading a job\'s status, stopping and fetching contact the computer: they stay typed commands in Timmy in this slice (/connect probe, /connect status, /connect stop, /connect fetch); the board shows them to copy.',
    ],
  };
}

// ── hosting ──────────────────────────────────────────────────────────────────

const CACHE_HOME = 'cloud/overview.json';
const STATUS_COMMAND = 'timmy cloud status';
const SET_UP_WORDS = 'No Timmy Cloud backend is set up on this computer (no cloud/config.json in its Timmy home).';
const ACTIONS_WORDS = 'Approving, reconciling and resolving are the backend\'s operator routes, sent by a person in this slice (each item names its route to copy); Timmy\'s client only reads (timmy cloud status, or /cloud).';

/** The backend's last answer as the overview may use it: or why not, as words and a state. */
interface CloudView {
  url?: string;
  set_up: boolean;
  /** why the answer is not known (null: it is) */
  why: string | null;
  read_at: string | null;
  failed?: { at: string; why: string };
  old: boolean;
  overview?: ReturnType<typeof parseOverview> & { ok: true };
  orders?: ReturnType<typeof parseOrders>;
}

function cloudView(s: Sources): CloudView {
  if (!s.cloud.ok) return { set_up: false, why: `Timmy Cloud's client's files could not be read: ${s.cloud.error}`, read_at: null, old: false };
  const { config, cache } = s.cloud.value;
  if (config.state === 'absent') return { set_up: false, why: null, read_at: null, old: false };
  if (config.state === 'unreadable') return { set_up: false, why: `cloud/config.json in this computer's Timmy home cannot be read: ${config.why}; ${SETUP_COMMAND} writes it again`, read_at: null, old: false };
  const url = config.config.url;
  if (cache.state === 'absent') return { url, set_up: true, why: `the backend at ${url} has not been read yet: ${STATUS_COMMAND} reads it`, read_at: null, old: false };
  if (cache.state === 'unreadable') return { url, set_up: true, why: `the backend's last answer (${CACHE_HOME} in this computer's Timmy home) cannot be read: ${cache.why}; ${STATUS_COMMAND} reads the backend again`, read_at: null, old: false };
  const c = cache.cache;
  if (c.backend !== url) return { url, set_up: true, why: `the answer kept is from another backend (${c.backend}), not ${url}: ${STATUS_COMMAND} reads this one`, read_at: null, old: false };
  if (!c.read_at) return { url, set_up: true, why: `the backend at ${url} has not been read: the last attempt (${stampOf(c.failed?.at)}) did not read: ${c.failed?.why ?? 'not said'}`, read_at: null, ...(c.failed ? { failed: c.failed } : {}), old: false };
  const ov = parseOverview(c.overview);
  const old = s.now - Date.parse(c.read_at) > HOUR_MS;
  if (!ov.ok) return { url, set_up: true, why: `the backend's overview, as kept, cannot be read: ${ov.why}`, read_at: c.read_at, old, ...(c.failed ? { failed: c.failed } : {}) };
  const orders = c.orders === null ? { ok: false as const, why: c.orders_why ?? 'its orders were not read' } : parseOrders(c.orders);
  return { url, set_up: true, why: null, read_at: c.read_at, old, overview: ov, orders, ...(c.failed ? { failed: c.failed } : {}) };
}

const ORDER_WEIGHT = (o: BackendOrder): number => (o.needs_person ? 0 : o.steps.some((st) => st.state === 'unknown') ? 1 : o.partial ? 2 : /^Done/.test(o.summary) ? 4 : 3);

function costWords(o: BackendOrder): HostingItem['cost'] {
  const c = o.cost;
  const quoted = c.quoted_cents === null ? 'not quoted' : `${money(c.quoted_cents, c.currency ?? 'USD')} quoted`;
  const charged = !('charged_cents' in c) ? 'no purchase went out (nothing charged)'
    : typeof c.charged_cents !== 'number' ? 'charged: unknown (a purchase went out and no amount came back; never summed as 0)'
      : `${money(c.charged_cents, c.currency ?? 'USD')} charged, as the provider reported it`;
  return { quoted_cents: c.quoted_cents, currency: c.currency, ...('charged_cents' in c ? { charged_cents: c.charged_cents ?? null } : {}), words: `${quoted}; ${charged}` };
}

function hostingItem(o: BackendOrder, simulated: boolean, scrub: (t: string) => string): HostingItem {
  const name = scrub(orderName(o));
  const route = routeIn(o.next_action);
  const steps = o.steps.map((st) => ({
    name: st.name, label: STEP_LABEL[st.name] ?? st.name, state: st.state, at: st.at, words: scrub(st.words),
    ...(st.needs_person ? { needs_person: scrub(st.needs_person) } : {}), ...(st.retry_at ? { retry_at: st.retry_at } : {}),
    ...(st.reference ? { reference: scrub(st.reference) } : {}), ...(st.provider_words ? { provider_words: scrub(st.provider_words) } : {}),
  }));
  const summary = scrub(o.summary);
  return {
    order: o.order_id, customer: o.customer_id, kind: o.kind, name, created_at: o.created_at, steps,
    steps_line: steps.map((st) => `${st.label} ${st.state.replace(/_/g, ' ')}`).join(' · '),
    summary, partial: o.partial, needs_person: o.needs_person ? scrub(o.needs_person) : null, next_action: scrub(o.next_action),
    cancel: o.cancel ? { ...o.cancel, words: scrub(o.cancel.words) } : null, cost: costWords(o),
    resources: o.resources.map((r) => ({ id: r.resource_id, kind: r.kind, name: scrub(r.name), state: r.state, expires_at: r.expires_at, retained_until: r.retained_until })),
    simulated, line: `${name}: ${summary}${simulated ? ' (simulated)' : ''}`,
    commands: [...(route ? [route] : []), STATUS_COMMAND],
    source: { record: null, home: CACHE_HOME, command: route ?? STATUS_COMMAND, board: 'ov-hosting', detail: boardId('ov-order', o.order_id) },
  };
}

export function hostingSection(s: Sources): HostingSection {
  const v = cloudView(s);
  const command = v.set_up ? STATUS_COMMAND : SETUP_COMMAND;
  const out: HostingSection = {
    ...base('hosting', s),
    backend: { set_up: v.set_up, ...(v.url ? { url: v.url } : {}), words: v.set_up ? `Timmy Cloud's backend: ${v.url}` : SET_UP_WORDS, command: v.set_up ? STATUS_COMMAND : SETUP_COMMAND },
    read: { at: v.read_at, old: v.old, words: '', command: STATUS_COMMAND, ...(v.failed ? { failed: { at: v.failed.at, why: s.scrub(v.failed.why) } } : {}) },
    provider: null, items: [], more: 0,
  };
  if (!s.cloud.ok || (!v.set_up && v.why)) return { ...out, state: 'unknown', summary: 'not known', why: s.scrub(v.why ?? ''), read: { ...out.read, words: 'not read' }, notes: [ACTIONS_WORDS] };
  if (!v.set_up) {
    return {
      ...out, summary: 'not set up', read: { ...out.read, words: 'nothing to read: no backend is set up' },
      urgent: { text: `${SETUP_COMMAND} sets one up`, tone: 'neutral', source: { record: null, home: 'cloud/config.json', command: SETUP_COMMAND, board: 'ov-hosting' } },
      notes: [SET_UP_WORDS, ACTIONS_WORDS],
    };
  }
  const ago = v.read_at ? agoWords(s.now, v.read_at) : undefined;
  const readWords = v.read_at
    ? `read ${stampOf(v.read_at)}${v.old ? ': old, older than an hour' : ''}${v.failed ? `; the newest attempt (${stampOf(v.failed.at)}) did not read: ${s.scrub(v.failed.why)}` : ''}`
    : 'not read';
  const read = { ...out.read, words: readWords, ...(ago ? { ago } : {}) };
  if (v.why || !v.overview) return { ...out, read, state: 'unknown', summary: 'not known', why: s.scrub(v.why ?? 'not read'), urgent: { text: `not read: ${STATUS_COMMAND} reads the backend`, tone: 'attention', source: { record: null, home: CACHE_HOME, command, board: 'ov-hosting' } }, notes: [ACTIONS_WORDS] };
  const ov = v.overview.value;
  const p = ov.provider;
  const simulated = p?.simulated === true;
  const provider = p ? { name: s.scrub(p.name), simulated: p.simulated, words: `${s.scrub(p.name)}: ${p.simulated === true ? 'simulated (nothing real is bought, registered or set up)' : p.simulated === false ? 'not simulated' : 'whether it is simulated is not said'}${p.paused_until ? `; its rate limit holds every call until ${stampOf(p.paused_until)}` : ''}` } : null;
  const problems = [...v.overview.problems];
  let items: HostingItem[] = [];
  let ordersWhy: string | undefined;
  if (v.orders?.ok) {
    items = [...v.orders.value.orders].sort((a, b) => ORDER_WEIGHT(a) - ORDER_WEIGHT(b) || b.created_at.localeCompare(a.created_at)).map((o) => hostingItem(o, simulated, s.scrub));
    problems.push(...v.orders.problems);
  } else ordersWhy = `each order's steps are not known: ${s.scrub(v.orders?.why ?? 'not read')}`;
  const kinds = (k: string): number => items.filter((i) => i.kind === k).length;
  const waiting = items.filter((i) => i.needs_person).length;
  const partial = items.filter((i) => i.partial).length;
  const total = ov.orders ?? items.length;
  const firstNeed = items.find((i) => i.needs_person);
  const urgent = v.old
    ? { text: `the backend's answer is old (read ${stampOf(v.read_at)}): ${STATUS_COMMAND} reads it again`, tone: 'attention' as Tone, source: { record: null, home: CACHE_HOME, command: STATUS_COMMAND, board: 'ov-hosting' as const }, ...(ago ? { ago } : {}) }
    : firstNeed ? { text: `${firstNeed.name}: ${firstNeed.needs_person}${simulated ? ' (simulated)' : ''}`, tone: 'attention' as Tone, source: firstNeed.source }
      : items[0] ? { text: items[0].line, tone: 'neutral' as Tone, source: items[0].source } : undefined;
  const state: HostingSection['state'] = ordersWhy || problems.length ? 'partial' : 'read';
  return {
    ...out, read, provider, state, ...(state === 'partial' ? { why: [ordersWhy, ...problems].filter(Boolean).join('; ') } : {}),
    items: items.slice(0, ITEMS_MAX), more: Math.max(0, items.length - ITEMS_MAX),
    // old first, with the command that reads it again: the first screen cuts the rest at 80 columns
    summary: v.old
      ? `old, read ${shortStamp(s.now, v.read_at)}: ${STATUS_COMMAND} reads it again; ${plural(total, 'order')}, ${waiting} need a person`
      : `${plural(total, 'order')}, ${waiting} need a person${partial ? `, ${partial} partial` : ''}${simulated ? ', simulated' : ''}; read ${shortStamp(s.now, v.read_at)}`,
    counts: [
      { n: total, of: total === 1 ? 'order of every customer, as the backend counts them' : 'orders of every customer, as the backend counts them' },
      ...(items.length ? [{ n: kinds('site'), of: kinds('site') === 1 ? 'site' : 'sites' }, { n: kinds('domain'), of: kinds('domain') === 1 ? 'domain' : 'domains' }, { n: kinds('vps'), of: 'VPS' }] : []),
      ...(waiting ? [{ n: waiting, of: waiting === 1 ? 'order waiting for a person' : 'orders waiting for a person' }] : []),
      ...(partial ? [{ n: partial, of: partial === 1 ? 'order partly provisioned' : 'orders partly provisioned' }] : []),
      { n: ov.needs_person.length, of: ov.needs_person.length === 1 ? 'item the backend says needs a person' : 'items the backend says need a person' },
    ],
    ...(urgent ? { urgent } : {}),
    notes: [
      `Read from ${CACHE_HOME} in this computer's Timmy home, as the backend at ${v.url} answered ${stampOf(v.read_at)}: the overview never calls the network (${STATUS_COMMAND} reads it again).`,
      ...(provider ? [`The provider: ${provider.words}.`] : ['The backend named no provider.']),
      ACTIONS_WORDS,
      ...(ov.unreadable_log_lines ? [`The backend's event log has ${plural(ov.unreadable_log_lines, 'line')} it could not read (it says so in what needs a person).`] : []),
    ],
  };
}

// ── costs ────────────────────────────────────────────────────────────────────

export function costsSection(s: Sources, history: HistorySection): CostsSection {
  const model = { ...history.costs, scope: 'this project\'s runs, as the Control Room sums them (the same numbers as History)' };
  const v = cloudView(s);
  const ago = v.read_at ? agoWords(s.now, v.read_at) : undefined;
  // the first screen's line leads with the provider (the model spend is also on History's line)
  const modelLine = `model ${model.reported ? `$${model.reported.usd.toFixed(4)} reported` : 'none reported'}, ${model.unknown.runs} unknown`;
  const out: CostsSection = { ...base('costs', s), model, provider: { known: false, customers: [], more: 0, unknown_cost_orders: 0, words: '' } };
  const historyUnknown = history.state === 'unknown';
  if (!v.set_up && !v.why) {
    return {
      ...out, ...(historyUnknown ? { state: 'partial' as const, why: 'the model costs could not be read' } : {}),
      provider: { ...out.provider, why: SET_UP_WORDS, words: `not set up: ${SETUP_COMMAND}` },
      summary: `provider not set up; ${modelLine}`, counts: modelCounts(model),
      notes: [`Model spend: ${model.words || 'not known'}`, `Provider spend: ${SET_UP_WORDS}`],
    };
  }
  if (v.why || !v.overview) {
    const why = s.scrub(v.why ?? 'not read');
    return {
      ...out, state: 'partial', why: `the provider costs are not known: ${why}`,
      provider: { ...out.provider, why, words: `not known: ${why}` },
      summary: `provider not known; ${modelLine}`, counts: modelCounts(model),
      urgent: { text: `provider costs not known: ${STATUS_COMMAND} reads the backend`, tone: 'attention', source: { record: null, home: CACHE_HOME, command: STATUS_COMMAND, board: 'ov-costs' } },
      notes: [`Model spend: ${model.words || 'not known'}`],
    };
  }
  const ov = v.overview.value;
  const source: OverviewSource = { record: null, home: CACHE_HOME, command: STATUS_COMMAND, board: 'ov-costs' };
  const customers: ProviderSpend[] = ov.customers.map((c) => {
    const limits = c.limits;
    const approved = c.approved_this_month_cents;
    const paid = c.paid_this_month_cents;
    const spend = `${approved === null ? 'approved: not said' : `${money(approved)} approved${limits ? ` of ${money(limits.monthly_cents)}` : ''}`} in ${c.month || 'this month'} (UTC), ${paid === null ? 'paid: not said' : `${money(paid)} paid`}`;
    const unknown = c.orders_with_unknown_cost;
    return {
      customer: c.customer_id, subscription: c.subscription, month: c.month, approved_cents: approved, paid_cents: paid, limits,
      limits_words: limits ? limitsWords(limits) : 'its limits are not readable', unknown_cost_orders: unknown, orders: c.orders,
      words: `${spend}${unknown ? `; ${plural(unknown, 'order')} of unknown cost (a purchase went out and no amount came back), counted, never summed as 0` : ''}`,
      source,
    };
  });
  const sum = (k: 'approved_cents' | 'paid_cents'): number | undefined => (customers.some((c) => c[k] !== null) ? customers.reduce((n, c) => n + (c[k] ?? 0), 0) : undefined);
  const approved = sum('approved_cents');
  const paid = sum('paid_cents');
  const unknownOrders = customers.reduce((n, c) => n + (c.unknown_cost_orders ?? 0), 0);
  const notSaid = customers.filter((c) => c.approved_cents === null || c.paid_cents === null).length;
  const simulated = ov.provider?.simulated ?? null;
  const providerWords = `${paid === undefined ? 'paid: not said' : `${money(paid)} paid`}, ${approved === undefined ? 'approved: not said' : `${money(approved)} approved`} this month over ${plural(customers.length, 'customer')}${unknownOrders ? `; ${plural(unknownOrders, 'order')} of unknown cost, never summed as 0` : ''}${simulated ? ' (a simulated provider: its prices are no provider\'s real prices)' : ''}`;
  const over = customers.find((c) => c.limits && c.approved_cents !== null && c.approved_cents >= c.limits.monthly_cents);
  const urgent = v.old
    ? { text: `provider spend as read ${stampOf(v.read_at)} (old): ${STATUS_COMMAND} reads it again`, tone: 'attention' as Tone, source, ...(ago ? { ago } : {}) }
    : unknownOrders ? { text: `${plural(unknownOrders, 'order')} of unknown provider cost: counted, never summed as 0`, tone: 'attention' as Tone, source: { ...source, board: 'ov-hosting' as const } }
      : over ? { text: `${over.customer} reached its monthly limit: ${over.words}`, tone: 'attention' as Tone, source } : undefined;
  return {
    ...out, ...(historyUnknown || notSaid ? { state: 'partial' as const, why: [historyUnknown ? 'the model costs could not be read' : '', notSaid ? `${plural(notSaid, 'customer')} whose spend the backend did not say` : ''].filter(Boolean).join('; ') } : {}),
    provider: {
      known: true, read_at: v.read_at!, ...(ago ? { ago } : {}), old: v.old, simulated, customers: customers.slice(0, ITEMS_MAX), more: Math.max(0, customers.length - ITEMS_MAX),
      ...(approved !== undefined ? { approved_cents: approved } : {}), ...(paid !== undefined ? { paid_cents: paid } : {}), unknown_cost_orders: unknownOrders,
      words: providerWords,
    },
    summary: `provider ${paid === undefined ? 'paid not said' : `${money(paid)} paid`} this month, ${unknownOrders} unknown${v.old ? ' (old)' : ''}; ${modelLine}`,
    counts: [
      ...modelCounts(model),
      { n: customers.length, of: customers.length === 1 ? 'customer with provider spend this month, as the backend reports it' : 'customers with provider spend this month, as the backend reports it' },
      { n: unknownOrders, of: unknownOrders === 1 ? 'order of unknown provider cost (never summed as 0)' : 'orders of unknown provider cost (never summed as 0)' },
    ],
    ...(urgent ? { urgent } : {}),
    notes: [
      `Model spend: ${model.words || 'not known'} (${model.scope}).`,
      `Provider spend: as the backend at ${v.url} reported it ${stampOf(v.read_at)}${v.old ? ' (old: older than an hour)' : ''}; amounts in USD cents as the backend counts them; an order of unknown cost is counted apart and never summed as 0.`,
    ],
  };
}

function modelCounts(m: CostsSection['model']): CostsSection['counts'] {
  return [
    ...(m.reported ? [{ n: m.reported.runs, of: m.reported.runs === 1 ? `run with a reported model cost, $${m.reported.usd.toFixed(4)}` : `runs with a reported model cost, $${m.reported.usd.toFixed(4)} in all` }] : []),
    { n: m.unknown.runs, of: m.unknown.runs === 1 ? 'run of unknown model cost (never summed as 0)' : 'runs of unknown model cost (never summed as 0)' },
  ];
}

// ── needs you: the new kinds ─────────────────────────────────────────────────

/**
 * How urgent each kind is beside the project's own (lower first; an item that blocks a request is 0). The project's kinds
 * keep Waiting on you's own order (src/room/decisions.ts TIER: approval, refused save, left, setup, failed, lesson).
 */
export const NEED_RANK: Readonly<Record<string, number>> = {
  approval: 0, 'stale-save': 0, 'host-key-changed': 1, left: 2, 'cloud-unknown_outcome': 2, 'remote-job': 2, setup: 3, 'cloud-cancel_asked': 3,
  'cloud-deletion_unknown': 3, 'cloud-event_log': 3, failed: 4, interrupted: 4, differs: 4, 'cloud-failed_step': 4, 'cloud-approval': 4,
  'cloud-stopped_mid_order': 5, 'cloud-purchase_blocked': 5, 'cloud-subscription_canceled': 5, 'device-unreachable': 5, 'host-key': 5,
  'cloud-deletion_approval': 7, 'cloud-domain_decision': 7, 'cloud-export': 8, lesson: 9,
};

function cloudNeedTitle(n: BackendNeed, order: BackendOrder | undefined, resources: ReadonlyMap<string, { kind: string; name: string; expires_at: string | null; retained_until: string | null }>): string {
  const what = order ? orderName(order) : n.resource_id && resources.get(n.resource_id) ? `${resources.get(n.resource_id)!.kind} ${resources.get(n.resource_id)!.name}` : n.order_id ? `order ${n.order_id}` : 'the backend';
  const r = n.resource_id ? resources.get(n.resource_id) : undefined;
  switch (n.kind) {
    // the quote as the backend words it ("$12.00 USD")
    case 'approval': return `${what}: waits for the operator's approval${order?.quote ? ` (quote ${money(order.quote.total_cents, order.quote.currency)}${order.quote.currency === 'USD' ? ' USD' : ''})` : ''}`;
    case 'unknown_outcome': return `${what}: a purchase or call whose outcome is unknown (the provider may have acted)`;
    case 'cancel_asked': return `${what}: cancel asked; the provider operation was NOT cancelled`;
    case 'failed_step': return `${what}: ${order ? order.steps.filter((st) => st.state === 'failed').map((st) => `${STEP_LABEL[st.name] ?? st.name} failed`).join(', ') || 'a step failed' : 'a step failed'}`;
    case 'export': return `${what}: export it for the customer (retained${r?.retained_until ? ` until ${stampOf(r.retained_until)}` : ''})`;
    case 'domain_decision': return `${what}: transfer, renew or let lapse (registration ends ${r?.expires_at ? stampOf(r.expires_at) : 'on a date not known'})`;
    case 'deletion_approval': return `${what}: a deletion waits for approval (irreversible)`;
    default: return `${what}: ${n.kind.replace(/_/g, ' ')}`;
  }
}

const attentionItem = (a: Attention): NeedsItem => ({
  title: a.title, kind: a.kind, blocks: false, needed: a.needed, why: a.why, commands: a.commands, from: 'connect',
  ...(a.since ? { since: a.since } : {}), ...(a.ago ? { ago: a.ago } : {}), source: { record: null, home: a.home, command: a.commands[0], board: 'ov-devices', detail: a.detail },
});

/** The new kinds of what waits on a person: Timmy Connect's (this Timmy home) and the Cloud backend's (as last read). */
export function remoteNeeds(s: Sources): { items: NeedsItem[]; notes: string[] } {
  const items: NeedsItem[] = [];
  const notes: string[] = [];
  if (s.connect.ok) {
    const { view, extra } = s.connect.value;
    for (const d of view.devices) {
      for (const a of deviceAttention(d, extra.get(d.id), s.now, s.scrub)) items.push(attentionItem(a));
    }
    for (const j of view.jobs) {
      const a = jobAttention(j, s.now, s.scrub);
      if (a) items.push(attentionItem(a));
    }
  } else notes.push(`Timmy Connect's records could not be read, so what they need is not known: ${s.connect.error}`);
  const v = cloudView(s);
  if (v.overview) {
    const orders = v.orders?.ok ? v.orders.value.orders : [];
    const byOrder = new Map(orders.map((o) => [o.order_id, o] as const));
    const resources = new Map([...orders.flatMap((o) => o.resources), ...(v.orders?.ok ? v.orders.value.resources : [])].map((r) => [r.resource_id, r] as const));
    for (const n of v.overview.value.needs_person) {
      const order = n.order_id ? byOrder.get(n.order_id) : undefined;
      const route = routeIn(n.next_action);
      const why = n.kind === 'cancel_asked' && order?.cancel ? `${n.reason} ${order.cancel.words}` : n.reason;
      items.push({
        title: s.scrub(cloudNeedTitle(n, order, resources)), kind: `cloud-${n.kind}`, blocks: false, needed: s.scrub(n.next_action), why: s.scrub(why),
        commands: [...(route ? [route] : []), STATUS_COMMAND], from: 'cloud', ...(n.since ? { since: n.since, ago: agoWords(s.now, n.since) } : {}),
        source: { record: null, home: CACHE_HOME, command: route ?? STATUS_COMMAND, board: 'ov-hosting', ...(n.order_id ? { detail: boardId('ov-order', n.order_id) } : {}) },
      });
    }
    if (v.overview.value.needs_person.length) notes.push(`Timmy Cloud's items are as its backend at ${v.url} answered ${stampOf(v.read_at)}${v.old ? ' (old: older than an hour)' : ''}: ${STATUS_COMMAND} reads it again.`);
  } else if (v.set_up && v.why) notes.push(`What Timmy Cloud's backend needs is not known: ${s.scrub(v.why)}`);
  return { items, notes };
}

/** The project's items in their own order, with the new kinds placed among them by how urgent each is. */
export function mergeNeeds(project: readonly NeedsItem[], extra: readonly NeedsItem[]): NeedsItem[] {
  const rank = (i: NeedsItem): number => (i.blocks ? 0 : NEED_RANK[i.kind] ?? 8);
  const queue = extra.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((e) => e.x);
  const out: NeedsItem[] = [];
  let k = 0;
  for (const p of project) {
    while (k < queue.length && rank(queue[k]) < rank(p)) out.push(queue[k++]);
    out.push(p);
  }
  return [...out, ...queue.slice(k)];
}

// ── the map's dependencies ───────────────────────────────────────────────────

export const REMOTE_MAP_MAX = { remote: 6, depends: 6 } as const;

/** Remote jobs and orders, and what they depend on: a remote job on its device, an order's step on a person's decision. */
export function dependencyColumns(devices: DevicesSection, hosting: HostingSection): { columns: OverviewMap['columns']; edges: OverviewMap['edges'] } {
  const cut = (t: string, n = 26): string => (Array.from(t).length > n ? `${Array.from(t).slice(0, n - 1).join('')}…` : t);
  const work: MapNode[] = [];
  const deps: MapNode[] = [];
  const edges: OverviewMap['edges'] = [];
  const dev = new Map(devices.items.map((d) => [d.id, d] as const));
  for (const j of devices.jobs) {
    work.push({ id: `r:${j.id}`, label: cut(`${j.id} ${j.label}`), kind: 'remote job', state: j.state, source: j.source });
    const d = dev.get(j.device);
    if (!deps.some((n) => n.id === `d:${j.device}`)) {
      deps.push({ id: `d:${j.device}`, label: cut(d ? `${d.id} (${d.reach.address})` : `${j.device} (not among the computers)`), kind: 'device', ...(d?.probe ? { state: d.probe.answered ? 'answered its last probe' : 'did not connect at its last probe' } : {}), source: d?.source ?? { record: null, home: DEVICE_HOME, command: '/connect devices', board: 'ov-devices' } });
    }
    edges.push({ from: `r:${j.id}`, to: `d:${j.device}`, why: `remote job ${j.id} runs on ${j.device}, as its record names it: it depends on ${j.device}${d ? ` (${d.probe ? d.probe.line : 'not probed yet'})` : ', which is not among the computers any more'}` });
  }
  for (const o of hosting.items.filter((i) => i.needs_person)) {
    work.push({ id: `o:${o.order}`, label: cut(o.name), kind: `${o.kind} order`, state: o.simulated ? 'simulated' : 'as the backend said', source: o.source });
    const step = o.steps.find((st) => st.needs_person) ?? o.steps.find((st) => ['waiting', 'unknown', 'failed'].includes(st.state));
    deps.push({ id: `n:${o.order}`, label: cut(`decision: ${step ? step.label : 'the order'}`), kind: 'decision', source: o.source });
    edges.push({ from: `o:${o.order}`, to: `n:${o.order}`, why: `${step ? `its ${step.label} step (${step.state.replace(/_/g, ' ')})` : 'the order'} waits on a person's decision: ${o.needs_person}` });
  }
  const columns: OverviewMap['columns'] = [
    { id: 'remote', title: 'Remote jobs and orders', nodes: work.slice(0, REMOTE_MAP_MAX.remote), more: Math.max(0, work.length - REMOTE_MAP_MAX.remote) },
    { id: 'depends', title: 'What they depend on', nodes: deps.slice(0, REMOTE_MAP_MAX.depends), more: Math.max(0, deps.length - REMOTE_MAP_MAX.depends) },
  ];
  return { columns, edges };
}
