/**
 * Whether a failed request certainly never left this computer (moved here from src/agent/tools.ts by the R4 lead, 2026-10-12,
 * so the chat's local route reads it too: src/agent/local-chat.ts). No module of Timmy's is imported.
 */
/** Error codes that mean the request never left this machine: no connection, no address, no TLS. */
const BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ERR_INVALID_URL', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Whether a failed request certainly never reached the service, so nothing can have run there (round
 * R1 review). A reset or a timeout after the request went out leaves the outcome unknown, and the tool
 * says so instead of "not run".
 */
export function neverSent(err: unknown): boolean {
  const codes: string[] = [];
  let e = err as { code?: unknown; errors?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 4; depth++) {
    if (typeof e.code === 'string') codes.push(e.code);
    if (Array.isArray(e.errors)) for (const x of e.errors as Array<{ code?: unknown }>) if (typeof x?.code === 'string') codes.push(x.code);
    e = e.cause as typeof e;
  }
  return codes.length > 0 && codes.every((c) => BEFORE_SEND.has(c) || /CERT|TLS|SSL/.test(c));
}
