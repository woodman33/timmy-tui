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
 *   recentWork(ctx, limit)   the project's newest turns, runs, files, observations, drafts and receipts, newest first, each
 *                            with its state, its receipt (verified here) and where it opens (./recent.ts)
 *   runSummary(ctx, runId)   a run's progress (steps done of total, state), result (exits, outputs, verdict) and receipt
 *                            (verified here), with its project, from the one run detail (./run.ts)
 *   projectFile(project, p)  a file of the project as the preview draws it: an image as a data URL with its width and height,
 *                            or a text file's first 64 KB; anything else, and any path not plainly in the project, refused
 *                            in words (./file.ts)
 *
 * The browser companion serves them read only, behind its token (./routes.ts, mounted by src/companion/server.ts):
 * GET /api/journey/route, /api/journey/recent, /api/journey/run/<operation id>, /api/journey/open and /api/journey/file.
 */
export { FAKE_NAME, routeNow, routeTaken } from './route.js';
export type { JourneyRoute, RouteAgent, RouteCtx, RoutePrice, RouteProvider, RouteStep, RouteTaken, RouteWhere } from './route.js';
export { askedOf, DRAFT_ID, hexOfPath, IMAGE_EXTENSIONS, OPERATION_ID, openTarget, openUrl, pathOfHex, previewOf, projectPath, RECEIPT_ID, shownFor, TEXT_EXTENSIONS, VOX_ID } from './open.js';
export { FILE_IMAGE_MAX, FILE_TEXT_MAX, imageHeader, projectFile } from './file.js';
export type { FileRefusal, ImageType, ProjectFileAnswer, ProjectFileImage, ProjectFileRefused, ProjectFileText } from './file.js';
export type { AskedAddress, Openable, OpenKind, OpenTarget, PageHas, SelectName } from './open.js';
export { RECENT_CAPS, receiptOutputs, recentWork, RESULTS_MAX, runState, runTitle, verifyMany } from './recent.js';
export type { RecentCaps, RecentWork, WorkCtx, WorkItem, WorkKind, WorkState } from './recent.js';
export { runSummary } from './run.js';
export type { RunCtx, RunProgressState, RunReceipt, RunSummary, RunSummaryAnswer } from './run.js';
