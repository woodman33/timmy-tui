/**
 * What the browser companion says when it starts, and what the monitor's pairing card (q on HOME) shows.
 *
 * R4 (H84): its address carries its token (after #t=), so the address is shown only where the operator started it: on the
 * terminal, or, while the monitor owns the screen (TIMMY_TUI_ACTIVE), on the monitor's pairing card; the companion's log
 * names the address without the token and says where to find it. A network address, and a QR code, only with --lan, and
 * then the words say plainly that it is plain HTTP on the local network, that the QR code holds the token, and to use it
 * only on a network the operator trusts.
 */
import qrcodeTerminal from 'qrcode-terminal';
import { screenQuiet, writeLog } from '../utils/logger.js';

/** What qr.ts needs of a running companion (src/companion/server.ts CompanionServer). */
export interface CompanionAddresses {
  /** On this computer, with the token in its fragment. */
  url: string;
  /** With --lan: on the network, each with the token in its fragment; else none. */
  lanUrls: string[];
  /** Where it listens: 0.0.0.0 when --lan was asked (even when this computer had no network address then). */
  host?: string;
}

/** --lan was asked, but this computer had no network address when the companion started. */
export const NO_NETWORK = 'Asked for the local network (--lan), but this computer had no network address when the companion started: connect it to a network you trust and start `timmy watch --lan` again.';

/** An address as a log may name it: without its fragment (the token). */
export const withoutToken = (url: string): string => url.replace(/#.*$/, '');

export const LAN_WORDS = [
  'This address is plain HTTP on your local network: anyone on it can see the traffic.',
  'The QR code holds the token: whoever scans it can use the companion, and spend through its chat.',
  'Use it only on a network you trust; stop `timmy watch` to end it.',
];

export function showCompanionQR(server: CompanionAddresses): void {
  const lan = server.lanUrls[0];
  if (screenQuiet()) {
    // The monitor (or the Workbench, R5) owns the screen; this log never holds the token.
    // R4 (H87): where it listens, as it was started: 127.0.0.1 only, or with --lan every network address of this computer
    const where = server.host === '0.0.0.0' ? 'listening on every network address of this computer (--lan)' : '127.0.0.1 only';
    writeLog('companion.log', 'info', `[Browser companion] On this computer at ${withoutToken(server.url)} (${where}). Its address carries a token, which is never written to a log: press q on the monitor's HOME to see the address with its token.`);
    if (lan) writeLog('companion.log', 'info', `[Browser companion] Also on your local network at ${withoutToken(lan)} (--lan, plain HTTP). Its QR code, which holds the token, is on the monitor's pairing card (q on HOME). Use it only on a network you trust.`);
    else if (server.host === '0.0.0.0') writeLog('companion.log', 'warn', `[Browser companion] ${NO_NETWORK}`);
    return;
  }
  console.error('');
  console.error('[Browser companion] Open this address in a browser on this computer (it carries the companion\'s token):');
  console.error(server.url);
  if (!lan) {
    console.error(server.host === '0.0.0.0' ? NO_NETWORK : 'A phone: start with `timmy watch --lan` (plain HTTP on your local network; only on a network you trust).');
    console.error('');
    return;
  }
  console.error('');
  console.error('[Browser companion] On your local network (--lan):');
  console.error(lan);
  for (const line of LAN_WORDS) console.error(line);
  console.error('');
  qrcodeTerminal.generate(lan, { small: true }, (qr: string) => {
    console.error(qr);
  });
  console.error('');
}

/**
 * R4 (H84): the monitor's pairing card (q on HOME) for the companion this process started: the lines to show and the address
 * to draw as a QR code (only with --lan: a phone cannot open this computer's 127.0.0.1); null when no companion runs here.
 */
export function companionPairing(server: Partial<CompanionAddresses> | null | undefined): { qr: string | null; lines: string[] } | null {
  if (!server || typeof server.url !== 'string') return null;
  const lan = Array.isArray(server.lanUrls) ? server.lanUrls[0] : undefined;
  if (lan) return { qr: lan, lines: ['Browser companion, a phone on this network (scan):', lan, ...LAN_WORDS, 'On this computer:', server.url] };
  return {
    qr: null,
    lines: [
      'Browser companion, on this computer:', server.url,
      server.host === '0.0.0.0' ? NO_NETWORK : 'A phone: start with `timmy watch --lan` (plain HTTP on your local network; only on a network you trust).',
      'Log companion: `timmy logs` prints and opens its address with its token.',
    ],
  };
}
