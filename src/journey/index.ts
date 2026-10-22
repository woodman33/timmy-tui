/**
 * R10 (H164): the journey's data, ONE source for each fact the journey's screens show, so the terminal Workbench, the browser
 * companion and Studio never disagree, and the route shown is the route actually taken (docs/ui-cockpit/R10-BRIEF.md, "The
 * data H164 gives H167"). No rendering here: each screen draws what these return.
 *
 *   routeNow(ctx)            the route the next chat turn takes, from the function the turn reads (./route.ts)
 *   routeTaken(receipt)      what a sealed chat turn took, from its receipt (./route.ts)
 *   openTarget(item)         where an item of the project's work opens: a companion tab with what it chooses, or Studio (./open.ts)
 *   openUrl(target, base)    that place's address on a server, never with a token (./open.ts)
 *   askedOf, shownFor        what an address asks for, and what a page shows for it with a notice when it differs (./open.ts)
 */
export { FAKE_NAME, routeNow, routeTaken } from './route.js';
export type { JourneyRoute, RouteAgent, RouteCtx, RoutePrice, RouteProvider, RouteStep, RouteTaken, RouteWhere } from './route.js';
export { askedOf, DRAFT_ID, hexOfPath, OPERATION_ID, openTarget, openUrl, pathOfHex, previewOf, projectPath, RECEIPT_ID, shownFor, VOX_ID } from './open.js';
export type { AskedAddress, Openable, OpenKind, OpenTarget, PageHas, SelectName } from './open.js';
