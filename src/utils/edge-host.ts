// hosts-j4t1 — the edge host is site-specific identity: it is READ, never
// literalized. Resolution order (ORDER hosts-j4t1): the private overlay
// (.timmy/private/config.json via lanes/privacy/overlay.mjs) → TIMMY_EDGE_HOST
// env → inert placeholder. Callers that need a live URL use edgeUrl(), which
// fails with one legible line when nothing resolves; callers that only carry
// a value (manifests, headers) use edgeUrlOrNull() + isPlaceholder checks so
// the placeholder never silently stands in for a real endpoint.
import { readPrivateJson, isPlaceholder } from '../../lanes/privacy/overlay.mjs';

export { isPlaceholder };

export const EDGE_HOST_PLACEHOLDER = '<hostname>';
export const EDGE_INERT_LINE = 'set TIMMY_EDGE_HOST or the overlay';

const configHost = (): string | null => {
  try {
    const { data } = readPrivateJson('config.json');
    const v = (data as Record<string, unknown> | null)?.edge_host;
    if (typeof v === 'string' && v.trim() && !isPlaceholder(v)) return v.trim();
  } catch { /* overlay unreadable → fall through */ }
  return null;
};

const envHost = (): string | null => {
  const v = process.env.TIMMY_EDGE_HOST;
  return v && v.trim() && !isPlaceholder(v) ? v.trim() : null;
};

/** the resolved edge host, or null when only the inert placeholder remains */
export const edgeHost = (): string | null => configHost() ?? envHost();

/** `https://<host><path>`; throws the inert line when unresolved */
export function edgeUrl(path = ''): string {
  const h = edgeHost();
  if (!h) throw new Error(EDGE_INERT_LINE);
  return `https://${h}${path}`;
}

/** same, but null instead of throwing (for manifests/headers that store) */
export const edgeUrlOrNull = (path = ''): string | null => {
  const h = edgeHost();
  return h ? `https://${h}${path}` : null;
};

/** the placeholder stand-in, for fields that must carry something inert */
export const inertEdgeUrl = (path = ''): string => `https://${EDGE_HOST_PLACEHOLDER}${path}`;

/** operator identity for headers/payloads: overlay → env → neutral default */
export const operatorLabel = (): string => {
  try {
    const { data } = readPrivateJson('config.json');
    const v = (data as Record<string, unknown> | null)?.operator_label;
    if (typeof v === 'string' && v.trim() && !isPlaceholder(v)) return v.trim();
  } catch { /* overlay unreadable → fall through */ }
  return process.env.TIMMY_OPERATOR_LABEL?.trim() || 'operator';
};
