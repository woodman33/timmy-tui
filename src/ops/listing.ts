/**
 * Round R4 (H99, r24 gap 14): what an operation says of the server `/mcp tools` started for a listing. On the Mac (r24) the
 * operation of `/mcp tools -- <command>` said "it started nothing: the request was answered", though the listing's route had
 * started that server command, listed its tools and ended it. A listing has no record of its own (only /mcp call keeps one),
 * so the words are noted on the request's operation (src/ops/context.ts noteStartedProcess) and kept in its record.
 *
 * Only a listing whose route's process was started is said (src/connectors/mcp-cli.ts routeRan): a route that is missing or
 * could not be started, an unknown name or an empty command line started nothing, and the request's own lines say why. The
 * route starts a stdio server itself (MCPorter, or Timmy's SDK route) and reaches an HTTP one; when it ends, Timmy signals
 * its process group, so a server it left is signalled too (src/connectors/mcp-cli.ts runProcess). Whether that server's
 * process is gone afterwards is not checked, and not said.
 *
 * R4 (H99, the review): the route's or server's own words in them (an error, with a line of its stderr) are kept as Timmy
 * keeps any text from outside (src/connect/scrub.ts scrubShown): escape sequences and control characters out first, private-key
 * blocks and key and token shapes redacted, home folders from "~"; then addresses in their safe form (scrubUrls); the
 * operation's writer then writes the project's folder as "." (src/ops/operations.ts noteStarted).
 */
import { scrubShown } from '../connect/scrub.js';
import { scrubUrls, serverLabel, type McpRouteId, type McpServerRef, type McpToolsAnswer } from '../connectors/mcp-cli.js';
import type { StartedProcess } from './context.js';

/** A route's or a server's own words, as they are kept (see the module comment). */
const said = (t: string | undefined, none: string): string => (t ? scrubUrls(scrubShown(t)).slice(0, 600) : none);

/** The route by name, as the words say it. */
const ROUTE_WORDS: Record<McpRouteId, string> = { mcporter: 'MCPorter', sdk: "Timmy's SDK route" };
const STOP_WORDS = "as the listing ended, Timmy signalled the route's process group to stop (the server it started with it)";

/** How a tools listing that started its route reads in its operation; undefined when nothing was started. */
export function listingProcess(x: { route: McpRouteId; ref: McpServerRef; answer: McpToolsAnswer }): StartedProcess | undefined {
  const a = x.answer;
  if (!a.routeRan) return undefined;
  const via = ROUTE_WORDS[x.route];
  const what = 'command' in x.ref
    ? `a server command was started for a listing (/mcp tools -- ${serverLabel(x.ref)}, through ${via})`
    : `${via} was run to list the tools of the configured server ${x.ref.name} (it starts a stdio server, and reaches an HTTP one)`;
  if (a.ok) {
    const n = a.tools.length;
    return { what, ended: `it listed ${n} tool${n === 1 ? '' : 's'} in ${a.ms} ms${a.truncated ? ' (the list was cut to its bound)' : ''}; ${STOP_WORDS}`, failed: false };
  }
  // A server that wants a sign-in answered so: nothing failed in the listing, and the step is the person's (its words say it)
  if (a.needsAuth) return { what, ended: `it answered that the server ${said(a.error, 'needs authorization')}; ${STOP_WORDS}`, failed: false };
  if (a.timedOut) return { what, ended: `it ended without a tool list: ${said(a.error, 'no answer in time')}`, failed: true };
  return { what, ended: `it ended without a tool list: ${said(a.error, 'no reason was given')}; ${STOP_WORDS}`, failed: true };
}
