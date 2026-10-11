/**
 * Round R4 (helper H78): Timmy God's Eye View, the project overview (docs/ui-cockpit/GODS-EYE-VIEW.md). The model
 * (model.ts), how it is built from the existing records (sources.ts, sections.ts, proof.ts, map.ts, build.ts), and what
 * kind of file a run made (artifacts.ts). `/overview` prints it (src/repl/overview.ts); the board's Overview section draws
 * it (src/repl/board-overview.ts).
 */
export * from './model.js';
export { buildOverview, type OverviewGiven, type OverviewOptions } from './build.js';
export { artifactKind } from './artifacts.js';
export { flowLife, jobLife, operationLife } from './proof.js';
