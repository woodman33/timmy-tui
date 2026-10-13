/**
 * Round R4 (helper H90): `timmy connect tailnet [--json]`, read only: the peers `tailscale status --json` lists, when that
 * program is on PATH. Tailscale is only the network here: a peer's tailnet name or address can be a device's address, and
 * Timmy never adds a device by itself, never uses Tailscale SSH, and never changes the tailnet.
 */
import { runProgram } from './exec.js';
import { scrubShown } from './scrub.js';

export interface TailnetPeer { name: string; dns_name: string | null; addresses: string[]; os: string | null; online: boolean | null; self: boolean }
export interface TailnetRead { ok: boolean; words: string; peers: TailnetPeer[] }

/** A peer's own words (other computers name themselves): plain text, scrubbed, at most 120 characters; null when empty. */
const str = (v: unknown): string | null => {
  const text = typeof v === 'string' ? scrubShown(v).trim().slice(0, 120) : '';
  return text || null;
};
/** An address is kept only when it reads as an IPv4 or IPv6 address. */
const ADDRESS = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9A-Fa-f:]{2,39})$/;

function peerOf(raw: unknown, self: boolean): TailnetPeer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.HostName);
  if (!name) return null;
  const ips = Array.isArray(r.TailscaleIPs) ? r.TailscaleIPs.filter((x): x is string => typeof x === 'string' && ADDRESS.test(x)).slice(0, 4) : [];
  return { name, dns_name: str(r.DNSName)?.replace(/\.$/, '') ?? null, addresses: ips, os: str(r.OS), online: typeof r.Online === 'boolean' ? r.Online : null, self };
}

export async function readTailnet(): Promise<TailnetRead> {
  const r = await runProgram('tailscale', ['status', '--json'], { timeoutMs: 15_000, maxOut: 16 * 1024 * 1024 });
  if (r.spawnError === 'ENOENT') return { ok: false, peers: [], words: 'tailscale is not on PATH here: nothing was read (on a Mac, the app\'s command line may not be on PATH)' };
  if (r.spawnError) return { ok: false, peers: [], words: `tailscale could not be started (${r.spawnError})` };
  if (r.code !== 0) return { ok: false, peers: [], words: `tailscale status ended with exit ${r.code ?? r.signal}: ${scrubShown(r.stderr).trim().split('\n').at(-1) ?? ''}` };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(r.stdout.toString('utf8')) as Record<string, unknown>; } catch { return { ok: false, peers: [], words: 'tailscale status --json did not answer JSON' }; }
  const peers: TailnetPeer[] = [];
  const self = peerOf(raw.Self, true);
  if (self) peers.push(self);
  if (raw.Peer && typeof raw.Peer === 'object') for (const v of Object.values(raw.Peer as Record<string, unknown>)) { const peer = peerOf(v, false); if (peer) peers.push(peer); }
  const state = str(raw.BackendState);
  return { ok: true, peers, words: `${peers.length} node${peers.length === 1 ? '' : 's'} listed by tailscale status${state ? ` (backend ${state})` : ''}; none is added as a device by this: timmy connect add <id> <name or address> does that` };
}
