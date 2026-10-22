/**
 * R10 (H164): the journey's data, ONE source for each fact the journey's screens show, so the terminal Workbench, the browser
 * companion and Studio never disagree, and the route shown is the route actually taken (docs/ui-cockpit/R10-BRIEF.md, "The
 * data H164 gives H167"). No rendering here: each screen draws what these return.
 *
 *   routeNow(ctx)            the route the next chat turn takes, from the function the turn reads (./route.ts)
 *   routeTaken(receipt)      what a sealed chat turn took, from its receipt (./route.ts)
 */
export { FAKE_NAME, routeNow, routeTaken } from './route.js';
export type { JourneyRoute, RouteAgent, RouteCtx, RoutePrice, RouteProvider, RouteStep, RouteTaken, RouteWhere } from './route.js';
