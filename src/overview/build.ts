/**
 * Round R4 (helper H78): `buildOverview(projectRoot, opts)`, Timmy God's Eye View's one model of the active project, from
 * the same records the Control Room, Workflows, VoxVision, Results and Memory read (src/overview/sources.ts). The REPL
 * gives what its board has gathered (opts.given), so the board's Overview section, `/overview` and the live board's
 * GET /overview show the same thing; any other caller (a test, Timmy Canvas later) names the project's folder, its jobs
 * folder and its receipts store, and everything is read here through the existing readers.
 *
 * Each section is built inside its own guard: one that throws becomes "unknown" with why, never a failed overview. The
 * model is plain JSON; every path in it is relative to the project, and free text has the project's folder as "." and the
 * home folder as "~". Nothing here runs, stops, writes or seals anything.
 */
import { buildMap } from './map.js';
import {
  ITEMS_MAX, MAP_LABEL, OVERVIEW_SCHEMA, SECTION_TITLE,
  type AgentsSection, type AppsSection, type HistorySection, type NeedsSection, type Overview, type OverviewSectionId,
  type ProjectSection, type SpatialSection, type WorkflowsSection,
} from './model.js';
import { agentsSection, appsSection, historySection, needsSection, projectSection, spatialSection, workflowsSection } from './sections.js';
import { message, readSources, type OverviewOptions, type Sources } from './sources.js';

/** A section that could not be built: unknown, with why, and nothing listed. */
function unknownSection(id: OverviewSectionId, s: Pick<Sources, 'asOf' | 'name' | 'pid'>, why: string): Overview[OverviewSectionId] {
  const b = { id, title: SECTION_TITLE[id], as_of: s.asOf, state: 'unknown' as const, why, summary: 'not known', counts: [], unreadable: [], notes: [] };
  switch (id) {
    case 'needs': return { ...b, id, total: 0, items: [], more: 0, tools: {} } satisfies NeedsSection;
    case 'agents': return { ...b, id, items: [], more: 0, operations: [], operations_more: 0 } satisfies AgentsSection;
    case 'workflows': return { ...b, id, items: [], more: 0, jobs: [], jobs_more: 0 } satisfies WorkflowsSection;
    case 'apps': return { ...b, id, runs: [], runs_more: 0, artifacts: [], artifacts_more: 0, results: [], results_more: 0 } satisfies AppsSection;
    case 'spatial': return { ...b, id, items: [], more: 0 } satisfies SpatialSection;
    case 'history': return { ...b, id, receipts: { known: false, why: 'not read', total: 0, project: 0, recent: [], recent_more: 0 }, head: null, costs: { unknown: { runs: 0 }, free: { runs: 0 }, words: 'not known: the costs could not be read' }, operations: { recorded: 0, running: 0, left: 0 }, lessons: {} } satisfies HistorySection;
    case 'project': return { ...b, id, name: s.name, project_id: s.pid, changed: { at: null, basis: 'not known' }, canvas: { state: 'unknown', words: 'not known' } } satisfies ProjectSection;
  }
}

function guarded<T extends Overview[OverviewSectionId]>(id: OverviewSectionId, s: Sources, build: () => T): T {
  try { return build(); } catch (e) { return unknownSection(id, s, `this section could not be built: ${s.scrub(message(e))}`) as T; }
}

/** God's Eye View of the project at `projectRoot`, now. */
export function buildOverview(projectRoot: string, opts: OverviewOptions = {}): Overview {
  const s = readSources(projectRoot, opts);
  const project = guarded('project', s, () => projectSection(s));
  const needs = guarded('needs', s, () => needsSection(s));
  const agents = guarded('agents', s, () => agentsSection(s));
  const workflows = guarded('workflows', s, () => workflowsSection(s));
  const apps = guarded('apps', s, () => appsSection(s));
  const spatial = guarded('spatial', s, () => spatialSection(s));
  const history = guarded('history', s, () => historySection(s));
  let map: Overview['map'];
  try { map = buildMap(s, agents, workflows, apps); } catch (e) {
    map = { label: MAP_LABEL, words: `The map could not be drawn: ${s.scrub(message(e))}`, columns: [], edges: [] };
  }
  return {
    schema: OVERVIEW_SCHEMA, as_of: s.asOf, project, needs, agents, workflows, apps, spatial, history, map,
    notes: [
      'God\'s Eye View reads the records the Control Room, Workflows, VoxVision, Results and Memory read; it runs, stops, writes and seals nothing.',
      `Every list shows at most ${ITEMS_MAX} items (the rest are counted); the board sections and commands named beside each item show it in full.`,
      ...s.notes,
    ],
  };
}

export type { OverviewGiven, OverviewOptions } from './sources.js';
